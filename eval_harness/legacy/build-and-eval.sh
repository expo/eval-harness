#!/usr/bin/env bash
# End-to-end Evaluation Harness I, inside one EAS macOS workflow job.
#
#   PRD ──▶ coding agent authors an Expo app ──▶ harness dev-builds + serves it
#       ──▶ agentic evaluator scores it ──▶ collect app + all telemetry
#
# Everything is correlated by a single RUN_ID. The reusable install/boot/serve/
# evaluate/agent stages live in scripts/lib/eval-stages.sh (shared with
# setup-eval.sh). Like setup-eval.sh this never exits non-zero mid-way and ends
# `exit 0`; the EXIT trap always runs the collector so a failed run is still
# diagnosable.
#
# Knobs (env): AGENT={claude|codex} (default claude), AGENT_MODEL (default depends on agent),
#   GCS_BUCKET + GCP_SA_KEY (optional mirror), BRAINTRUST_API_KEY (optional trace push),
#   BRAINTRUST_PROJECT / *_PROJECT overrides (default expo-evals),
#   RUN_ID (pin a run id), PRD / TEST_PLAN (override the defaults).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EVAL="$ROOT/evaluator"
# shellcheck source=scripts/lib/eval-stages.sh
source "$ROOT/scripts/lib/eval-stages.sh"

# ---- run identity + layout ----
RUN_ID="${RUN_ID:-$(date +%Y%m%d-%H%M%S)-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')}"
RUN_START_MTIME="$(date +%s)"
OUT="$ROOT/eval-out/$RUN_ID"; mkdir -p "$OUT"
WORKSPACE="$ROOT/agent-workspace/$RUN_ID"; mkdir -p "$WORKSPACE"
TELEMETRY_DIR="$OUT/telemetry"; mkdir -p "$TELEMETRY_DIR/otel"
export RUN_ID RUN_START_MTIME OUT WORKSPACE TELEMETRY_DIR

AGENT="${AGENT:-claude}"
AGENT_MODEL="${AGENT_MODEL:-}"
if [ -z "$AGENT_MODEL" ]; then
  if [ "$AGENT" = "codex" ]; then AGENT_MODEL="${CODEX_MODEL:-gpt-5-mini}"; else AGENT_MODEL="sonnet"; fi
fi
METRO_MODE="dev-build"
PRD="${PRD:-prds/hot_chocolate/prd/mvp.txt}"
TEST_PLAN="${TEST_PLAN:-test_plans/primitives}"
export AGENT AGENT_MODEL METRO_MODE

ANTHROPIC_PROXY_PORT=8082   # 8081 is Metro's; Anthropic proxy moves to 8082
OPENAI_PROXY_PORT=8083
OTLP_PORT=4318
export OPENAI_PROXY_PORT OTLP_PORT

export CI=1 EXPO_NO_TELEMETRY=1
eval::fix_java_home
eval::env_banner
echo "RUN_ID=$RUN_ID  AGENT=$AGENT  WORKSPACE=$WORKSPACE"

# ============================================================================
# Stage A — install toolchain + secret diagnostics
# ============================================================================
if [ -z "${ANTHROPIC_API_KEY:-}" ]; then echo "  ❌ ANTHROPIC_API_KEY unset"; else echo "  ANTHROPIC_API_KEY bound (len ${#ANTHROPIC_API_KEY})"; fi
# Direct (no-proxy) reachability check — isolates an EAS-injected bad secret
# from a wiring bug before we burn the whole run.
ac=$(curl -sS --max-time 20 -o /dev/null -w '%{http_code}' https://api.anthropic.com/v1/messages \
  -H "x-api-key: ${ANTHROPIC_API_KEY:-}" -H "anthropic-version: 2023-06-01" -H "content-type: application/json" \
  -d '{"model":"claude-haiku-4-5","max_tokens":8,"messages":[{"role":"user","content":"hi"}]}' 2>/dev/null || echo "curl-fail")
echo "  direct anthropic (no proxy): $ac"

eval::install_agent_device "$OUT"
eval::install_maestro "$OUT"
eval::install_uv_and_evaluator "$EVAL" "$OUT"
echo "================= STAGE A: coding-agent CLI install ================="
npm install -g @anthropic-ai/claude-code >"$OUT/a-cc-install.log" 2>&1
claude --version >/dev/null 2>&1; eval::gate $? "claude-code CLI install"
if [ "$AGENT" = "codex" ]; then
  npm install -g @openai/codex >"$OUT/a-codex-install.log" 2>&1
  codex --version >/dev/null 2>&1; eval::gate $? "codex CLI install"
fi

# ============================================================================
# Stage B — telemetry sidecars + collection trap
# ============================================================================
EVAL_PROXY_PIDS=()
EVAL_METRO_PID=""
# The trap runs the collector no matter how we exit (success, agent crash,
# build failure). It reads RUN_ID/OUT/etc from the exported env.
trap 'eval::stop_proxies; kill "${EVAL_METRO_PID:-}" 2>/dev/null || true; bash "$ROOT/scripts/collect-artifacts.sh" "$ROOT" "$RUN_ID" "$OUT" "$WORKSPACE" "$EVAL" "$TELEMETRY_DIR"' EXIT

echo "================= STAGE B: telemetry sidecars ================="
eval::launch_proxy "$ROOT" anthropic https://api.anthropic.com "$ANTHROPIC_PROXY_PORT" "$TELEMETRY_DIR/anthropic.jsonl"
eval::wait_for_port "$ANTHROPIC_PROXY_PORT" && echo "  ✅ anthropic proxy on :$ANTHROPIC_PROXY_PORT"
if [ "$AGENT" = "codex" ]; then
  eval::launch_proxy "$ROOT" openai https://api.openai.com "$OPENAI_PROXY_PORT" "$TELEMETRY_DIR/openai.jsonl"
  eval::wait_for_port "$OPENAI_PROXY_PORT" && echo "  ✅ openai proxy on :$OPENAI_PROXY_PORT"
fi
eval::launch_otlp_receiver "$ROOT" "$OTLP_PORT" "$TELEMETRY_DIR/otel"
eval::wait_for_port "$OTLP_PORT" && echo "  ✅ OTLP receiver on :$OTLP_PORT"

# ============================================================================
# Stage C — coding agent authors the app (model I/O → proxy; OTEL → receiver)
# ============================================================================
# Telemetry env for the agent. Native OTLP is best-effort (CC's exporter can
# no-op on CI); the proxy + offline transcript reconstruction are the truth.
export ANTHROPIC_BASE_URL="http://127.0.0.1:$ANTHROPIC_PROXY_PORT"
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_EXPORTER_OTLP_ENDPOINT="http://127.0.0.1:$OTLP_PORT"
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_METRICS_EXPORTER=otlp OTEL_LOGS_EXPORTER=otlp OTEL_TRACES_EXPORTER=otlp
export OTEL_METRIC_EXPORT_INTERVAL=2000 OTEL_LOGS_EXPORT_INTERVAL=2000
export OTEL_RESOURCE_ATTRIBUTES="run.id=$RUN_ID,phase=agent-build,service.name=eval-harness"
[ -n "$AGENT_MODEL" ] && export ANTHROPIC_MODEL="$AGENT_MODEL"

eval::run_coding_agent "$AGENT" "$ROOT" "$WORKSPACE" "$EVAL/$PRD" "$OUT" "$AGENT_MODEL"

if [ ! -f "$WORKSPACE/package.json" ]; then
  echo "  ❌ coding agent did not produce package.json; skipping build/eval and collecting diagnostics"
  exit 0
fi

# ============================================================================
# Stage D — harness dev-builds + serves the authored app (NOT the agent)
# ============================================================================
# Resolve the app's bundle id + scheme from its (possibly dynamic) Expo config
# so the evaluator's NATIVE restart can launch the dev-client build directly.
echo "================= STAGE D: npm install + resolve app config + dev build ================="
eval::npm_install "$WORKSPACE" "$OUT"

# A dev build connects to Metro via the dev-client deep link, which requires the
# expo-dev-client package. Ensure it's present even if the agent didn't add it.
EVAL_IOS_APP_MODE="${EVAL_IOS_APP_MODE:-dev-client}"
echo "  iOS app mode: $EVAL_IOS_APP_MODE"
if [ "$EVAL_IOS_APP_MODE" = "dev-client" ]; then
  echo "  ensuring expo-dev-client is installed (dev-build deep-link handshake)"
  ( cd "$WORKSPACE" && npx --yes expo install expo-dev-client ) >"$OUT/d-devclient.log" 2>&1 \
    || echo "  ⚠️  expo install expo-dev-client failed (see d-devclient.log)"

  DEV_CLIENT_DEFAULT_URL="${DEV_CLIENT_DEFAULT_URL:-http://localhost:8081}"
  node "$ROOT/scripts/patch-dev-client-default-url.mjs" "$WORKSPACE" "$DEV_CLIENT_DEFAULT_URL" >"$OUT/d-devclient-config.log" 2>&1 \
    || echo "  ⚠️  dev-client defaultLaunchURL patch failed (see d-devclient-config.log)"
  cat "$OUT/d-devclient-config.log"
  export EVAL_DEV_CLIENT_CLEAR_STATE="${EVAL_DEV_CLIENT_CLEAR_STATE:-1}"
fi

# Resolve the app's bundle id + scheme from its (possibly dynamic) Expo config —
# after npm install so an app.config.js that requires deps can evaluate.
BUNDLE_ID=""; SCHEME=""
if ( cd "$WORKSPACE" && npx --yes expo config --json >"$OUT/d-expo-config.json" 2>"$OUT/d-expo-config.err" ); then
  BUNDLE_ID="$(python3 -c "import json; d=json.load(open('$OUT/d-expo-config.json')); print((d.get('ios') or {}).get('bundleIdentifier') or '')" 2>/dev/null)"
  SCHEME="$(python3 -c "import json; d=json.load(open('$OUT/d-expo-config.json')); s=d.get('scheme'); print((s[0] if isinstance(s,list) else s) or '')" 2>/dev/null)"
fi
echo "  resolved bundleIdentifier='$BUNDLE_ID'  scheme='$SCHEME'"
if [ -n "$BUNDLE_ID" ]; then
  export EVAL_APP_BUNDLE_ID="$BUNDLE_ID"
  export EVAL_APP_READY_TIMEOUT_SEC="${EVAL_APP_READY_TIMEOUT_SEC:-120}"
fi

eval::boot_sim_and_runner "$OUT"
if [ "$EVAL_IOS_APP_MODE" = "release" ]; then
  export EVAL_APP_USE_SIMCTL_LAUNCH=1
  unset EVAL_APP_DEEP_LINK
  eval::build_release_ios_app "$WORKSPACE" "$OUT" "$EVAL_DEVNAME" || {
    echo "  ❌ release app build/install failed; skipping eval and collecting diagnostics"
    exit 0
  }
else
  eval::start_metro_dev_build "$WORKSPACE" "$OUT" "$EVAL_DEVNAME"
  eval::capture_dev_client_deep_link "$OUT" || {
    DEV_CLIENT_URL="${DEV_CLIENT_URL:-http://127.0.0.1:8081}"
    ENCODED_DEV_CLIENT_URL="$(DEV_CLIENT_URL="$DEV_CLIENT_URL" python3 -c 'import os, urllib.parse; print(urllib.parse.quote(os.environ["DEV_CLIENT_URL"], safe=""))')"
    [ -n "$SCHEME" ] && export EVAL_APP_DEEP_LINK="$SCHEME://expo-development-client/?url=$ENCODED_DEV_CLIENT_URL"
  }
fi
if ! eval::probe_snapshot "$OUT" "${EVAL_APP_BUNDLE_ID:-host.exp.Exponent}"; then
  echo "  ❌ authored app failed launch readiness probe; skipping evaluator"
  exit 1
fi

# ============================================================================
# Stage E — evaluator scores the dev build (native restart honors EVAL_APP_*)
# ============================================================================
export EVAL_PHASE_START_MTIME="$(date +%s)"
export OTEL_RESOURCE_ATTRIBUTES="run.id=$RUN_ID,phase=evaluate,service.name=eval-harness"
if ! eval::run_evaluator "$EVAL" "$TEST_PLAN" "$PRD" "$OUT/result.json" "$OUT"; then
  echo "  ❌ evaluator failed; artifacts will still be collected by the EXIT trap"
  exit 1
fi

# ============================================================================
# Stage F — collect (runs via the EXIT trap)
# ============================================================================
echo "================= RESULT ================="
if [ -f "$OUT/result.json" ]; then cat "$OUT/result.json"; else echo "(no result.json produced)"; fi
exit 0
