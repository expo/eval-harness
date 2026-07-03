#!/usr/bin/env bash
# Shared, sourced library of evaluator-harness stages.
#
# Both scripts/setup-eval.sh (standalone eval against the checked-in reference
# app) and scripts/build-and-eval.sh (end-to-end: coding agent builds the app,
# then we evaluate it) source this file so the install/boot/serve/evaluate
# stages live in ONE place and can't drift apart.
#
# Design rules:
#   - Pure function definitions only. NO top-level side effects, NO `set -e`
#     (callers own their own shell options).
#   - Functions that produce a value the caller needs (chosen device, Metro PID)
#     set a GLOBAL (EVAL_DEVNAME, EVAL_METRO_PID, EVAL_PROXY_PIDS) rather than
#     echoing it — so that env vars they export (PATH, AGENT_DEVICE_*) survive
#     into the caller's shell instead of being lost in a $(...) subshell.
#   - Every stage prints `✅ STAGE OK` / `❌ STAGE FAIL` via eval::gate, matching
#     the original setup-eval.sh output so existing log-scraping keeps working.
#
# The functions never `exit`; they return the relevant rc so the caller decides.

# Guard against double-sourcing.
[ -n "${_EVAL_STAGES_SOURCED:-}" ] && return 0
_EVAL_STAGES_SOURCED=1
_EVAL_STAGES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ----------------------------------------------------------------------------
# Primitives
# ----------------------------------------------------------------------------

eval::gate() { # rc label
  local ts
  ts="$(date '+%Y-%m-%dT%H:%M:%S%z' 2>/dev/null || date)"
  if [ "${1}" = 0 ]; then
    echo "  [$ts] ✅ STAGE OK:   ${2}"
  else
    echo "  [$ts] ❌ STAGE FAIL: ${2} (rc=${1})"
  fi
}

eval::fix_java_home() {
  # Worker's JAVA_HOME points at a non-existent openjdk@21; Maestro needs a valid
  # JDK (worker has Java 17). Repoint it so the Maestro hybrid restart path works.
  export JAVA_HOME="$(/usr/libexec/java_home -v 17 2>/dev/null || /usr/libexec/java_home 2>/dev/null)"
  echo "JAVA_HOME=$JAVA_HOME"
}

eval::env_banner() {
  echo "================= ENV ================="
  sw_vers 2>/dev/null | tr '\n' ' '; echo
  xcodebuild -version 2>/dev/null | head -1
  echo "node: $(node --version 2>/dev/null)  npm: $(npm --version 2>/dev/null)"
  echo "java: $(java -version 2>&1 | head -1)"
  echo "python3: $(python3 --version 2>&1)"
}

# ----------------------------------------------------------------------------
# Install stages
# ----------------------------------------------------------------------------

eval::install_agent_device() { # out_dir
  local out="$1"
  echo "================= STAGE 1: agent-device (Callstack CLI) ================="
  npm install -g agent-device@0.17.6 >"$out/s1-agent-device.log" 2>&1
  agent-device --version; eval::gate $? "agent-device install (needs Node 22+)"
}

eval::install_maestro() { # out_dir
  local out="$1"
  echo "================= STAGE 2: maestro ================="
  curl -Ls "https://get.maestro.mobile.dev" | bash >"$out/s2-maestro.log" 2>&1
  export PATH="$PATH:$HOME/.maestro/bin"
  maestro --version >/dev/null 2>&1; eval::gate $? "maestro install"
}

eval::install_uv_and_evaluator() { # eval_dir out_dir
  local eval_dir="$1" out="$2"
  echo "================= STAGE 3: uv + python3.12 + evaluator deps ================="
  curl -LsSf https://astral.sh/uv/install.sh | sh >"$out/s3-uv.log" 2>&1
  [ -f "$HOME/.local/bin/env" ] && . "$HOME/.local/bin/env"
  export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
  ( cd "$eval_dir" && uv --version >>"$out/s3-uv.log" 2>&1 && uv sync --python 3.12 >>"$out/s3-uv.log" 2>&1 )
  local rc=$?; eval::gate $rc "uv sync (evaluator deps)"
  [ "$rc" != 0 ] && { echo "  --- s3-uv.log tail ---"; tail -25 "$out/s3-uv.log" | sed 's/^/    /'; }
  return $rc
}

# ----------------------------------------------------------------------------
# Simulator + runner
# ----------------------------------------------------------------------------

# Picks an available iPhone simulator, boots it via agent-device, installs the
# XCTest runner (required for snapshots). Sets globals EVAL_DEVNAME and exports
# the AGENT_DEVICE_* env vars the evaluator's subprocesses inherit.
eval::boot_sim_and_runner() { # out_dir
  local out="$1"
  echo "================= STAGE 4: device select + agent-device boot + prepare ios-runner ================="
  local dev_line devname dev_udid
  dev_line=$(xcrun simctl list devices available 2>/dev/null | grep -E "iPhone" | head -1)
  devname=$(echo "$dev_line" | sed -E 's/^[[:space:]]*//; s/[[:space:]]*\([0-9A-Fa-f-]+\).*$//')
  dev_udid=$(echo "$dev_line" | sed -E 's/.*\(([0-9A-Fa-f-]+)\).*/\1/')
  echo "  device: '$devname'  udid='$dev_udid'  (line: $dev_line)"
  export EVAL_DEVNAME="$devname"
  export AGENT_DEVICE_IOS_DEVICE="$devname"
  export AGENT_DEVICE_DAEMON_TIMEOUT_MS=180000
  export AGENT_DEVICE_IOS_BOOT_TIMEOUT_MS=180000
  : >"$out/s4-boot.log"
  local rc=1 attempt max_attempts="${EVAL_IOS_BOOT_ATTEMPTS:-3}"
  for attempt in $(seq 1 "$max_attempts"); do
    echo "  agent-device boot attempt $attempt/$max_attempts"
    {
      echo "--- boot attempt $attempt/$max_attempts ---"
      xcrun simctl boot "$dev_udid" || true
      xcrun simctl bootstatus "$dev_udid" -b || true
      python3 "$_EVAL_STAGES_DIR/timeout_exec.py" "${EVAL_IOS_BOOT_TIMEOUT_SEC:-240}" \
        agent-device boot --platform ios --device "$devname"
    } >>"$out/s4-boot.log" 2>&1
    rc=$?
    [ "$rc" = 0 ] && break
    tail -20 "$out/s4-boot.log" | sed 's/^/    /'
    sleep 10
  done
  eval::gate $rc "agent-device boot ($devname)"
  if [ "$rc" != 0 ]; then
    tail -30 "$out/s4-boot.log" | sed 's/^/    /'
    return "$rc"
  fi
  local runner_timeout="${EVAL_IOS_RUNNER_TIMEOUT_SEC:-420}"
  echo "  preparing ios-runner (timeout ${runner_timeout}s)"
  python3 "$_EVAL_STAGES_DIR/timeout_exec.py" "$runner_timeout" \
    agent-device prepare ios-runner --platform ios --device "$devname" --timeout "$AGENT_DEVICE_DAEMON_TIMEOUT_MS" \
    >"$out/s4-runner.log" 2>&1
  rc=$?; eval::gate $rc "agent-device prepare ios-runner"
  [ "$rc" != 0 ] && tail -25 "$out/s4-runner.log" | sed 's/^/    /'
  return $rc
}

# ----------------------------------------------------------------------------
# App deps + serve
# ----------------------------------------------------------------------------

eval::npm_install() { # app_dir out_dir
  local app_dir="$1" out="$2"
  echo "================= STAGE 5: app deps ($app_dir) ================="
  ( cd "$app_dir" && npm install ) >"$out/s5-npm.log" 2>&1
  local rc=$?
  eval::gate $rc "npm install ($app_dir)"
  [ "$rc" != 0 ] && { echo "  --- s5-npm.log tail ---"; tail -60 "$out/s5-npm.log" | sed 's/^/    /'; }
  return $rc
}

# Serve via Expo Go + Metro (no native modules). Sets EVAL_METRO_PID.
eval::start_metro_expo_go() { # app_dir out_dir
  local app_dir="$1" out="$2"
  echo "================= STAGE 6: Metro + load app in Expo Go ================="
  ( cd "$app_dir" && npx expo start --ios ) >"$out/s6-metro.log" 2>&1 &
  export EVAL_METRO_PID=$!
  local up=1 _
  for _ in $(seq 1 60); do
    if curl -s http://localhost:8081/status >/dev/null 2>&1; then up=0; break; fi
    sleep 2
  done
  eval::gate $up "metro up on :8081"
  echo "  (giving Expo Go ~25s to install + load the bundle)"; sleep 25
  return $up
}

# Serve via a dev build (expo run:ios). Compiles + installs a dev-client .app,
# then starts Metro. The build can take several minutes, so the readiness poll
# budget is much larger than the Expo Go path. Sets EVAL_METRO_PID.
eval::start_metro_dev_build() { # app_dir out_dir device
  local app_dir="$1" out="$2" device="$3"
  echo "================= STAGE 6 (dev build): expo run:ios + Metro ================="
  ( cd "$app_dir" && npx expo run:ios --device "$device" ) >"$out/s6-devbuild.log" 2>&1 &
  export EVAL_METRO_PID=$!
  local up=1 _
  # Up to ~15 min: build (compile + install) must finish before Metro serves :8081.
  for _ in $(seq 1 450); do
    if curl -s http://localhost:8081/status >/dev/null 2>&1; then up=0; break; fi
    if ! kill -0 "$EVAL_METRO_PID" >/dev/null 2>&1; then
      wait "$EVAL_METRO_PID"; local rc=$?
      echo "  expo run:ios exited before Metro became ready (rc=$rc)"
      [ "$rc" = 0 ] && up=1 || up=$rc
      break
    fi
    sleep 2
  done
  eval::gate $up "dev build up + metro on :8081"
  [ "$up" != 0 ] && { echo "  --- s6-devbuild.log tail ---"; tail -40 "$out/s6-devbuild.log" | sed 's/^/    /'; }
  echo "  (giving the dev client ~20s to settle)"; sleep 20
  return $up
}

eval::build_release_ios_app() { # app_dir out_dir device
  local app_dir="$1" out="$2" device="$3"
  echo "================= STAGE 6 (release app): expo run:ios --configuration Release ================="
  mkdir -p "$HOME/.expo"
  ( cd "$app_dir" && python3 "$_EVAL_STAGES_DIR/timeout_exec.py" 1800 npx expo run:ios --configuration Release --device "$device" ) >"$out/s6-release.log" 2>&1
  local rc=$?
  if [ "$rc" != 0 ] \
    && grep -q "Build Succeeded" "$out/s6-release.log" \
    && grep -q "Installing on" "$out/s6-release.log" \
    && grep -q "osascript .*System Events" "$out/s6-release.log"; then
    echo "  expo run:ios hit a post-install Simulator AppleScript activation error; continuing"
    rc=0
  fi
  eval::gate $rc "release app build + install"
  [ "$rc" != 0 ] && { echo "  --- s6-release.log tail ---"; tail -80 "$out/s6-release.log" | sed 's/^/    /'; }
  echo "  (giving the release app ~10s to settle)"; sleep 10
  return $rc
}

eval::capture_dev_client_deep_link() { # out_dir
  local out="$1" log="$1/s6-devbuild.log" deep_link
  [ -f "$log" ] || return 1
  deep_link="$(python3 - "$log" <<'PY'
import re
import sys

path = sys.argv[1]
ansi = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
pattern = re.compile(r"([A-Za-z][A-Za-z0-9+.-]*://expo-development-client/\?url=\S+)")

with open(path, "r", encoding="utf-8", errors="ignore") as f:
    lines = [ansi.sub("", line).strip() for line in f]

for line in reversed(lines):
    if "expo-development-client/?url=" not in line:
        continue
    match = pattern.search(line)
    if match:
        print(match.group(1))
        break
PY
)"
  if [ -n "$deep_link" ]; then
    export EVAL_APP_DEEP_LINK="$deep_link"
    echo "  dev-client deep link from Expo CLI: $EVAL_APP_DEEP_LINK"
    return 0
  fi
  echo "  ⚠️  could not find Expo dev-client deep link in $log"
  return 1
}

# Direct agent-device probe with the SAME session the evaluator uses ("adaptive").
# If this snapshots the app, the evaluator will too; if it fails we see the REAL
# agent-device error (vs the evaluator's swallowed "snapshot failed").
eval::probe_blocking_app_shell_error() { # snapshot_file
  local snap="$1"
  if grep -Eq 'expo-router-unmatched|Unmatched Route|Page could not be found' "$snap"; then
    echo "Expo Router unmatched route"
    return 0
  fi
  if grep -Eq 'Application has not been registered|No component registered|Invariant Violation|React Native version mismatch' "$snap"; then
    echo "React Native app registration/runtime error"
    return 0
  fi
  if grep -Eq 'ReferenceError:|TypeError:|SyntaxError:|Cannot find module|Unable to resolve module' "$snap"; then
    echo "JavaScript runtime/module error"
    return 0
  fi
  return 1
}

eval::probe_snapshot() { # out_dir app_id
  local out="$1" app_id="${2:-host.exp.Exponent}"
  echo "================= STAGE 6b: agent-device probe (open $app_id + snapshot) ================="
  local rc open_label
  if [ "${EVAL_APP_USE_SIMCTL_LAUNCH:-}" = "1" ]; then
    xcrun simctl launch booted "$app_id" >"$out/s6b-open.log" 2>&1
    rc=$?
    open_label="simctl launch $app_id + agent-device session bind"
    if [ "$rc" = 0 ]; then
      agent-device open "$app_id" --platform ios --session adaptive >>"$out/s6b-open.log" 2>&1
      rc=$?
    fi
  elif [ -n "${EVAL_APP_DEEP_LINK:-}" ]; then
    xcrun simctl openurl booted "$EVAL_APP_DEEP_LINK" >"$out/s6b-open.log" 2>&1
    rc=$?
    open_label="simctl openurl dev-client deep link + agent-device session bind"
    if [ "$rc" = 0 ]; then
      agent-device open "$app_id" --platform ios --session adaptive >>"$out/s6b-open.log" 2>&1
      rc=$?
    fi
    if [ "$rc" = 0 ]; then
      if agent-device alert get --platform ios --session adaptive >"$out/s6b-alert.log" 2>&1; then
        cat "$out/s6b-alert.log" >>"$out/s6b-open.log"
        if grep -q "Open in" "$out/s6b-alert.log"; then
          agent-device press 'label="Open"' --platform ios --session adaptive >>"$out/s6b-open.log" 2>&1 || true
        fi
      fi
    fi
  else
    agent-device open "$app_id" --platform ios --session adaptive >"$out/s6b-open.log" 2>&1
    rc=$?
    open_label="agent-device open $app_id"
  fi
  eval::gate $rc "$open_label"
  [ "$rc" != 0 ] && tail -20 "$out/s6b-open.log" | sed 's/^/    /'
  sleep "${EVAL_APP_LAUNCH_SETTLE_SEC:-8}"
  local i
  for i in $(seq 1 30); do
    agent-device snapshot -i --platform ios --session adaptive >"$out/s6b-snap.log" 2>&1
    rc=$?
    [ "$rc" != 0 ] && break
    if grep -Eq 'Bundling [0-9]+%|Loading JavaScript bundle|Downloading JavaScript bundle' "$out/s6b-snap.log"; then
      echo "  App bundle is still loading; waiting (attempt $i)" >>"$out/s6b-open.log"
      sleep 2
      continue
    fi
    if grep -Eq 'Runtime version:|Source code explorer|Open DevTools|Toggle performance monitor|dev-tools|Go home|Reload' "$out/s6b-snap.log"; then
      echo "  Expo dev launcher/dev tools are visible; dismissing (attempt $i)" >>"$out/s6b-open.log"
      agent-device press 'label="Close"' --platform ios --session adaptive >>"$out/s6b-open.log" 2>&1 \
        || agent-device press "200" "80" --platform ios --session adaptive >>"$out/s6b-open.log" 2>&1 \
        || true
      sleep 2
      continue
    fi
    if grep -Eq 'Recently opened|Development servers|Enter URL manually|Scan QR code' "$out/s6b-snap.log"; then
      echo "  Expo dev-client launcher is visible; re-opening dev-client URL (attempt $i)" >>"$out/s6b-open.log"
      [ -n "${EVAL_APP_DEEP_LINK:-}" ] && xcrun simctl openurl booted "$EVAL_APP_DEEP_LINK" >>"$out/s6b-open.log" 2>&1 || true
      sleep 2
      continue
    fi
    local blocking_error=""
    blocking_error="$(eval::probe_blocking_app_shell_error "$out/s6b-snap.log" || true)"
    if [ -n "$blocking_error" ]; then
      echo "  ❌ snapshot probe sees app shell error: $blocking_error" >>"$out/s6b-open.log"
      break
    fi
    break
  done
  rc=$?; eval::gate $rc "agent-device snapshot probe"
  echo "  --- snapshot head (first 25 lines) ---"; head -25 "$out/s6b-snap.log" | sed 's/^/    /'
  local blocking_error=""
  blocking_error="$(eval::probe_blocking_app_shell_error "$out/s6b-snap.log" || true)"
  if [ "$rc" = 0 ] && [ -n "$blocking_error" ]; then
    echo "  ❌ snapshot probe sees app shell error: $blocking_error"
    return 1
  fi
  if [ "$rc" = 0 ] && grep -Eq 'Runtime version:|Source code explorer|Open DevTools|Toggle performance monitor|dev-tools|Go home|Reload' "$out/s6b-snap.log"; then
    echo "  ❌ snapshot probe still sees Expo dev launcher/dev tools, not the authored app"
    return 1
  fi
  if [ "$rc" = 0 ] && grep -Eq 'Bundling [0-9]+%|Loading JavaScript bundle|Downloading JavaScript bundle|Recently opened|Development servers|Enter URL manually|Scan QR code' "$out/s6b-snap.log"; then
    echo "  ❌ snapshot probe did not reach the authored app content"
    return 1
  fi
  return $rc
}

# ----------------------------------------------------------------------------
# Evaluator
# ----------------------------------------------------------------------------

# Runs the agentic evaluator. The restart mode is NOT hardcoded: pass
# `--hybrid-restart` as an extra arg for the Expo Go path (Maestro lifecycle),
# or pass nothing for the native simctl restart (which honors the EVAL_APP_*
# overrides — required for the dev-build target). macOS workers have neither GNU
# `timeout` nor `gtimeout`; use whichever exists, else run bare (the evaluator
# has its own 60-min watchdog).
eval::run_evaluator() { # eval_dir test_plan prd out_json out_dir [extra args...]
  local eval_dir="$1" test_plan="$2" prd="$3" out_json="$4" out="$5"; shift 5
  echo "================= STAGE 7: agentic evaluator ================="
  case "$test_plan" in
    "$eval_dir"/*) test_plan="${test_plan#"$eval_dir"/}" ;;
    evaluator/*) test_plan="${test_plan#evaluator/}" ;;
  esac
  case "$prd" in
    "$eval_dir"/*) prd="${prd#"$eval_dir"/}" ;;
    evaluator/*) prd="${prd#evaluator/}" ;;
  esac
  echo "  test_plan=$test_plan"
  echo "  prd=$prd"
  if [ -z "${ANTHROPIC_API_KEY:-}" ]; then echo "  ❌ ANTHROPIC_API_KEY unset"; fi
  local TO=""
  if command -v gtimeout >/dev/null 2>&1; then TO="gtimeout 1800";
  elif command -v timeout >/dev/null 2>&1; then TO="timeout 1800";
  else TO="python3 $_EVAL_STAGES_DIR/timeout_exec.py 1800"; fi
  local rc
  if [ "${EVAL_STREAM_LOGS:-1}" = "1" ]; then
    ( cd "$eval_dir" && $TO uv run python -m agentic_evaluator.main \
        "$test_plan" \
        --prd "$prd" \
        -d agent-device \
        --seed-iterations 200 --max-iterations 50 \
        -o "$out_json" --verbose "$@" ) 2>&1 | tee "$out/s7-eval.log"
    rc=${PIPESTATUS[0]}
  else
    ( cd "$eval_dir" && $TO uv run python -m agentic_evaluator.main \
        "$test_plan" \
        --prd "$prd" \
        -d agent-device \
        --seed-iterations 200 --max-iterations 50 \
        -o "$out_json" --verbose "$@" ) >"$out/s7-eval.log" 2>&1
    rc=$?
  fi
  eval::gate $rc "evaluator run"
  [ "$rc" != 0 ] && { echo "  --- s7-eval.log tail ---"; tail -40 "$out/s7-eval.log" | sed 's/^/    /'; }
  return $rc
}

# ----------------------------------------------------------------------------
# Coding agent (authors the app from a PRD)
# ----------------------------------------------------------------------------
# The agent runs with its CWD = the (empty) workspace and writes the app there.
# The orchestrator is responsible for exporting the telemetry env BEFORE calling
# this (ANTHROPIC_BASE_URL / OTEL_* for Claude; the function writes Codex's
# config.toml itself from OPENAI_PROXY_PORT / OTLP_PORT). The prompt is the
# author-prompt template with the PRD appended verbatim — the same PRD the
# evaluator scores against, so agent and judge share one spec.

eval::_agent_timeout() {
  if command -v gtimeout >/dev/null 2>&1; then echo "gtimeout 2400";
  elif command -v timeout >/dev/null 2>&1; then echo "timeout 2400";
  else echo "python3 $_EVAL_STAGES_DIR/timeout_exec.py 2400"; fi
}

# Writes Codex's user-level config.toml (model_provider routed through the
# logging proxy + [otel] pointed at the OTLP receiver). Mirrors run-smoke.sh.
eval::_write_codex_config() { # codex_home model openai_proxy_port otlp_port
  local codex_home="$1" model="$2" oport="$3" otlp="$4"
  mkdir -p "$codex_home"
  cat > "$codex_home/config.toml" <<EOF
model = "$model"
model_provider = "proxy"
approval_policy = "never"
sandbox_mode = "danger-full-access"

[model_providers.proxy]
name = "OpenAI via local logging proxy"
base_url = "http://127.0.0.1:$oport/v1"
wire_api = "responses"
env_key = "OPENAI_API_KEY"
supports_websockets = false

[otel]
environment = "eas-e2e"
log_user_prompt = true
exporter = { otlp-http = { endpoint = "http://127.0.0.1:$otlp", protocol = "binary" } }
trace_exporter = { otlp-http = { endpoint = "http://127.0.0.1:$otlp", protocol = "binary" } }
metrics_exporter = "none"
EOF
  if [ -n "${EXPO_MCP_BEARER_TOKEN:-}" ]; then
    cat >> "$codex_home/config.toml" <<EOF

[mcp_servers.expo]
url = "https://mcp.expo.dev/mcp"
bearer_token_env_var = "EXPO_MCP_BEARER_TOKEN"
enabled = true
EOF
  fi
}

# Runs the selected coding agent. Globals it reads when agent=codex:
#   CODEX_HOME, OPENAI_PROXY_PORT, OTLP_PORT, CODEX_MODEL
eval::run_coding_agent() { # agent root workspace prd_file out_dir [model]
  local agent="$1" root="$2" workspace="$3" prd_file="$4" out="$5" model="${6:-}"
  echo "================= STAGE C: coding agent ($agent) authors the app ================="
  local prompt TO
  prompt="$(cat "$root/scripts/agent/author-prompt.md")"$'\n\n## App PRD\n\n'"$(cat "$prd_file")"
  TO="$(eval::_agent_timeout)"

  if [ "$agent" = "codex" ]; then
    if ! command -v codex >/dev/null 2>&1; then echo "  ❌ codex not on PATH"; return 127; fi
    export CODEX_HOME="${CODEX_HOME:-$out/codex-home}"
    eval::_write_codex_config "$CODEX_HOME" "${model:-${CODEX_MODEL:-gpt-5-mini}}" \
      "${OPENAI_PROXY_PORT:-8082}" "${OTLP_PORT:-4318}"
    # Install Expo skills into the authored workspace. A fresh CI CODEX_HOME
    # does not have the reserved openai-curated marketplace configured, so use
    # Expo's generic skills installer. Expo MCP requires OAuth; wire it only
    # when a dedicated MCP bearer token has been provided.
    {
      if [ -n "${EXPO_MCP_BEARER_TOKEN:-}" ]; then
        echo "Expo MCP configured with EXPO_MCP_BEARER_TOKEN"
      else
        echo "Expo MCP not configured: set EXPO_MCP_BEARER_TOKEN to enable it"
      fi
      codex mcp list --json || true
      ( cd "$workspace" && npx -y skills add expo/skills --yes )
    } >"$out/c-plugin.log" 2>&1 || \
      echo "  ⚠️  npx skills add expo/skills failed (continuing; see c-plugin.log)"
    ( cd "$workspace" && $TO codex exec "$prompt" ) 2>&1 | tee "$out/c-agent.log"
    local rc=${PIPESTATUS[0]}
    eval::gate $rc "codex authored app"
    return $rc
  else
    if ! command -v claude >/dev/null 2>&1; then echo "  ❌ claude not on PATH"; return 127; fi
    # Install the official Expo plugin: bundles the Expo skills AND the Expo MCP
    # server, so we don't hand-wire `claude mcp add`. EAS workers start with a
    # clean Claude home, so seed the marketplace before installing the plugin.
    claude plugin marketplace add anthropics/claude-plugins-official >"$out/c-plugin.log" 2>&1 || \
      claude plugin marketplace update claude-plugins-official >>"$out/c-plugin.log" 2>&1 || \
      echo "  ⚠️  claude plugin marketplace setup failed (continuing; see c-plugin.log)"
    claude plugin install expo@claude-plugins-official >>"$out/c-plugin.log" 2>&1 || \
      echo "  ⚠️  claude plugin install expo@claude-plugins-official failed (continuing; see c-plugin.log)"
    # Branch on model rather than expanding a possibly-empty array — macOS ships
    # bash 3.2, where "${arr[@]}" on an empty array trips `set -u`.
    if [ -n "$model" ]; then
      ( cd "$workspace" && $TO claude -p "$prompt" --model "$model" \
          --dangerously-skip-permissions --add-dir "$workspace" ) 2>&1 | tee "$out/c-agent.log"
      local rc=${PIPESTATUS[0]}
    else
      ( cd "$workspace" && $TO claude -p "$prompt" \
          --dangerously-skip-permissions --add-dir "$workspace" ) 2>&1 | tee "$out/c-agent.log"
      local rc=${PIPESTATUS[0]}
    fi
    eval::gate $rc "claude authored app"
    return $rc
  fi
}

eval::run_coding_agent_repair() { # agent workspace prompt_file out_dir attempt [model]
  local agent="$1" workspace="$2" prompt_file="$3" out="$4" attempt="$5" model="${6:-}"
  echo "================= STAGE C repair $attempt: coding agent fixes validation failures ================="
  local prompt TO
  prompt="$(cat "$prompt_file")"
  TO="$(eval::_agent_timeout)"
  if [ "$agent" = "codex" ]; then
    ( cd "$workspace" && $TO codex exec "$prompt" ) 2>&1 | tee "$out/c-repair-$attempt.log"
    local rc=${PIPESTATUS[0]}
    eval::gate $rc "codex repair pass $attempt"
    return $rc
  else
    if [ -n "$model" ]; then
      ( cd "$workspace" && $TO claude -p "$prompt" --model "$model" \
          --dangerously-skip-permissions --add-dir "$workspace" ) 2>&1 | tee "$out/c-repair-$attempt.log"
      local rc=${PIPESTATUS[0]}
    else
      ( cd "$workspace" && $TO claude -p "$prompt" \
          --dangerously-skip-permissions --add-dir "$workspace" ) 2>&1 | tee "$out/c-repair-$attempt.log"
      local rc=${PIPESTATUS[0]}
    fi
    eval::gate $rc "claude repair pass $attempt"
    return $rc
  fi
}

# ----------------------------------------------------------------------------
# Telemetry sidecars (shared with run-smoke.sh)
# ----------------------------------------------------------------------------
# EVAL_PROXY_PIDS accumulates every sidecar PID; eval::stop_proxies kills them.

eval::launch_proxy() { # root label upstream port logfile
  local root="$1"
  PROXY_LABEL="$2" PROXY_UPSTREAM="$3" PROXY_PORT="$4" PROXY_LOG="$5" \
    node "$root/proxy/logging-proxy.mjs" &
  EVAL_PROXY_PIDS+=($!)
}

eval::launch_otlp_receiver() { # root port out_dir
  local root="$1" port="$2" out="$3"
  OTLP_PORT="$port" OTLP_OUT="$out" node "$root/proxy/otlp-receiver.mjs" &
  EVAL_PROXY_PIDS+=($!)
}

eval::wait_for_port() { # port
  local _
  for _ in $(seq 1 30); do
    if node -e "require('net').connect($1,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))" 2>/dev/null; then
      return 0
    fi
    sleep 0.2
  done
  echo "!! proxy on port $1 never came up" >&2; return 1
}

eval::stop_proxies() {
  local p
  for p in "${EVAL_PROXY_PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done
}
