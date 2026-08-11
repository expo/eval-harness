eval::configure_ios_app_mode() {
  EVAL_IOS_APP_MODE="${EVAL_IOS_APP_MODE:-release}"
  case "$EVAL_IOS_APP_MODE" in
    release) ;;
    dev-client)
      # The authored app and Expo's development launcher share one container.
      # Clearing it deletes the launcher connection state as well as app data,
      # so preservation is the safe debug-mode default. An explicit 1 remains
      # available for focused lifecycle diagnostics.
      if [ -z "${EVAL_DEV_CLIENT_CLEAR_STATE+x}" ]; then
        EVAL_DEV_CLIENT_CLEAR_STATE=0
      fi
      export EVAL_DEV_CLIENT_CLEAR_STATE
      ;;
    *)
      echo "  ❌ invalid EVAL_IOS_APP_MODE=$EVAL_IOS_APP_MODE (expected release or dev-client)" >&2
      return 2
      ;;
  esac
  export EVAL_IOS_APP_MODE
}

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

eval::expo_run_ios_supports_output() { # app_dir help_log
  local app_dir="$1" help_log="$2"
  if ! ( cd "$app_dir" && npx expo run:ios --help ) >"$help_log" 2>&1; then
    return 2
  fi
  grep -Eq -- '(^|[[:space:]])--output([=,[:space:]<]|$)' "$help_log"
}

eval::ios_app_minimum_version() { # app_bundle
  python3 - "$1/Info.plist" <<'PY'
import plistlib
import sys

try:
    with open(sys.argv[1], "rb") as handle:
        value = plistlib.load(handle).get("MinimumOSVersion")
except (OSError, plistlib.InvalidFileException, AttributeError):
    value = None
if isinstance(value, str) and value.strip():
    print(value.strip())
PY
}

eval::ios_version_is_newer() { # required available
  python3 - "$1" "$2" <<'PY'
import re
import sys

def parse(value):
    match = re.fullmatch(r"[0-9]+(?:\.[0-9]+)*", value.strip())
    if not match:
        raise ValueError(value)
    parts = tuple(int(part) for part in value.split("."))
    return parts + (0,) * (4 - len(parts))

try:
    raise SystemExit(0 if parse(sys.argv[1]) > parse(sys.argv[2]) else 1)
except ValueError:
    raise SystemExit(2)
PY
}

eval::ios_available_runtime_detail() {
  python3 - "${EVAL_IOS_AVAILABLE_RUNTIME_VERSIONS_JSON:-[]}" <<'PY'
import json
import sys

try:
    values = json.loads(sys.argv[1])
except (TypeError, ValueError):
    values = []
print(", ".join(str(value) for value in values))
PY
}

eval::ios_runtime_mismatch_in_log() { # log
  grep -Eiq -- 'requires a newer version of iOS|Requires a Newer Version of iOS|MinimumOSVersion.{0,80}(newer|higher|unsupported)|deployment target.{0,160}(newer|higher|unsupported|range of supported deployment target)' "$1"
}

eval::ios_required_version_from_log() { # log
  python3 - "$1" <<'PY'
import re
import sys

try:
    with open(sys.argv[1], encoding="utf-8", errors="ignore") as handle:
        contents = handle.read()
except OSError:
    contents = ""
for pattern in (
    r"requires\s+iOS\s+([0-9]+(?:\.[0-9]+)*)",
    r"MinimumOSVersion[^0-9]{0,40}([0-9]+(?:\.[0-9]+)*)",
    r"deployment target.{0,120}?(?:is set to|=)\s*([0-9]+(?:\.[0-9]+)*)",
    r"deployment target[^0-9]{0,40}([0-9]+(?:\.[0-9]+)*)",
):
    match = re.search(pattern, contents, re.IGNORECASE)
    if match:
        print(match.group(1))
        break
PY
}

eval::ios_newer_required_version_from_log() { # log
  local log="$1" required_version
  eval::ios_runtime_mismatch_in_log "$log" || return 1
  required_version="$(eval::ios_required_version_from_log "$log")"
  [ -n "$required_version" ] || return 1
  [ -n "${EVAL_IOS_RUNTIME_VERSION:-}" ] || return 1
  eval::ios_version_is_newer "$required_version" "$EVAL_IOS_RUNTIME_VERSION" || return 1
  printf '%s\n' "$required_version"
}

eval::mark_ios_runtime_unsupported() { # required
  local required="$1" available_detail
  available_detail="$(eval::ios_available_runtime_detail)"
  EVAL_IOS_NATIVE_BUILD_OUTCOME=passed
  EVAL_IOS_INSTALL_OUTCOME=warning
  EVAL_IOS_RESULT_STATUS=unsupported_environment
  EVAL_IOS_REQUIRED_VERSION="$required"
  EVAL_IOS_FAILURE_REASON="authored app requires iOS ${required:-newer than the evaluator runtime}; available iOS simulator runtimes: ${available_detail:-none}"
  export EVAL_IOS_NATIVE_BUILD_OUTCOME EVAL_IOS_INSTALL_OUTCOME EVAL_IOS_RESULT_STATUS \
    EVAL_IOS_REQUIRED_VERSION EVAL_IOS_FAILURE_REASON
  echo "  ⚠️  $EVAL_IOS_FAILURE_REASON"
  return 42
}

eval::build_release_ios_app() { # app_dir out_dir device_udid
  local app_dir="$1" out="$2" device="$3"
  echo "================= STAGE 6 (release app): capability-adaptive simulator build + install ================="
  mkdir -p "$HOME/.expo"
  local build_scratch build_output release_app rc required_version="" help_rc
  build_scratch="$(mktemp -d "${TMPDIR:-/tmp}/eval-ios-release.XXXXXX")" || return 1
  build_output="$build_scratch/build"
  EVAL_IOS_NATIVE_BUILD_OUTCOME=not_run
  EVAL_IOS_INSTALL_OUTCOME=not_run
  EVAL_IOS_RESULT_STATUS=""
  EVAL_IOS_REQUIRED_VERSION=""
  EVAL_IOS_FAILURE_REASON=""
  export EVAL_IOS_NATIVE_BUILD_OUTCOME EVAL_IOS_INSTALL_OUTCOME EVAL_IOS_RESULT_STATUS \
    EVAL_IOS_REQUIRED_VERSION EVAL_IOS_FAILURE_REASON

  if eval::expo_run_ios_supports_output "$app_dir" "$out/d-expo-run-ios-help.log"; then
    EVAL_IOS_RELEASE_MODE=generic_output
    export EVAL_IOS_RELEASE_MODE
    ( cd "$app_dir" && bun "$_EVAL_STAGES_DIR/timeout_exec.ts" 1800 npx expo run:ios \
        --configuration Release --device generic --output "$build_output" ) >"$out/s6-release.log" 2>&1
    rc=$?
    if [ "$rc" != 0 ]; then
      if required_version="$(eval::ios_newer_required_version_from_log "$out/s6-release.log")"; then
        eval::mark_ios_runtime_unsupported "$required_version"
        rc=$?
      else
        EVAL_IOS_NATIVE_BUILD_OUTCOME=failed
        export EVAL_IOS_NATIVE_BUILD_OUTCOME
      fi
    else
      release_app="$(find "$build_output" -maxdepth 3 -type d -name '*.app' -print -quit 2>/dev/null)"
      if [ -z "$release_app" ]; then
        echo "expo run:ios completed without producing a simulator .app" >>"$out/s6-release.log"
        EVAL_IOS_NATIVE_BUILD_OUTCOME=failed
        export EVAL_IOS_NATIVE_BUILD_OUTCOME
        rc=1
      else
        EVAL_IOS_NATIVE_BUILD_OUTCOME=passed
        export EVAL_IOS_NATIVE_BUILD_OUTCOME
        required_version="$(eval::ios_app_minimum_version "$release_app")"
        if [ -n "$required_version" ] && [ -n "${EVAL_IOS_RUNTIME_VERSION:-}" ] && \
            eval::ios_version_is_newer "$required_version" "$EVAL_IOS_RUNTIME_VERSION"; then
          eval::mark_ios_runtime_unsupported "$required_version"
          rc=$?
        else
          agent-device install "$EVAL_APP_BUNDLE_ID" "$release_app" \
            --platform ios --device "$device" >>"$out/s6-release.log" 2>&1
          rc=$?
          if [ "$rc" = 0 ]; then
            EVAL_IOS_INSTALL_OUTCOME=passed
            export EVAL_IOS_INSTALL_OUTCOME
          elif required_version="$(eval::ios_newer_required_version_from_log "$out/s6-release.log")"; then
            eval::mark_ios_runtime_unsupported "$required_version"
            rc=$?
          else
            EVAL_IOS_INSTALL_OUTCOME=failed
            export EVAL_IOS_INSTALL_OUTCOME
          fi
        fi
      fi
    fi
  else
    help_rc=$?
    if [ "$help_rc" = 2 ]; then
      EVAL_IOS_NATIVE_BUILD_OUTCOME=failed
      EVAL_IOS_RELEASE_MODE=unknown
      export EVAL_IOS_NATIVE_BUILD_OUTCOME EVAL_IOS_RELEASE_MODE
      echo "could not inspect project-local expo run:ios capabilities" >"$out/s6-release.log"
      rc=1
    else
      EVAL_IOS_RELEASE_MODE=direct_install
      export EVAL_IOS_RELEASE_MODE
      ( cd "$app_dir" && bun "$_EVAL_STAGES_DIR/timeout_exec.ts" 1800 npx expo run:ios \
          --configuration Release --device "$device" ) >"$out/s6-release.log" 2>&1
      rc=$?
      release_app="$(find "$app_dir/ios/build" -maxdepth 8 -type d -name '*.app' -print -quit 2>/dev/null)"
      [ -n "$release_app" ] && required_version="$(eval::ios_app_minimum_version "$release_app")"
      if [ -n "$required_version" ] && [ -n "${EVAL_IOS_RUNTIME_VERSION:-}" ] && \
          eval::ios_version_is_newer "$required_version" "$EVAL_IOS_RUNTIME_VERSION"; then
        eval::mark_ios_runtime_unsupported "$required_version"
        rc=$?
      elif [ "$rc" = 0 ]; then
        EVAL_IOS_NATIVE_BUILD_OUTCOME=passed
        EVAL_IOS_INSTALL_OUTCOME=passed
        export EVAL_IOS_NATIVE_BUILD_OUTCOME EVAL_IOS_INSTALL_OUTCOME
      elif required_version="$(eval::ios_newer_required_version_from_log "$out/s6-release.log")"; then
        eval::mark_ios_runtime_unsupported "$required_version"
        rc=$?
      elif [ -n "$release_app" ] && [ -f "$release_app/Info.plist" ] && \
          grep -Eiq -- '(^|[^[:alpha:]])BUILD[[:space:]]+SUCCEEDED([^[:alpha:]]|$)' "$out/s6-release.log"; then
        EVAL_IOS_NATIVE_BUILD_OUTCOME=passed
        EVAL_IOS_INSTALL_OUTCOME=failed
        export EVAL_IOS_NATIVE_BUILD_OUTCOME EVAL_IOS_INSTALL_OUTCOME
      else
        EVAL_IOS_NATIVE_BUILD_OUTCOME=failed
        export EVAL_IOS_NATIVE_BUILD_OUTCOME
      fi
    fi
  fi
  rm -rf -- "$build_scratch"
  if [ "$rc" = 42 ]; then
    echo "  ⚠️  STAGE UNSUPPORTED: release app cannot run on installed simulator runtimes"
  else
    eval::gate $rc "release app build + install ($EVAL_IOS_RELEASE_MODE)"
  fi
  [ "$rc" != 0 ] && { echo "  --- s6-release.log tail ---"; tail -80 "$out/s6-release.log" | sed 's/^/    /'; }
  if [ "$rc" = 0 ]; then
    echo "  (giving the release app ~10s to settle)"; sleep 10
  fi
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
  local sim_device="${EVAL_DEV_UDID:-booted}"
  echo "================= STAGE 6b: agent-device probe (open $app_id + snapshot) ================="
  local rc open_label
  if [ "${EVAL_APP_USE_SIMCTL_LAUNCH:-}" = "1" ]; then
    xcrun simctl launch "$sim_device" "$app_id" >"$out/s6b-open.log" 2>&1
    rc=$?
    open_label="simctl launch $app_id + agent-device session bind"
    if [ "$rc" = 0 ]; then
      agent-device open "$app_id" --platform ios --session adaptive >>"$out/s6b-open.log" 2>&1
      rc=$?
    fi
  elif [ -n "${EVAL_APP_DEEP_LINK:-}" ]; then
    xcrun simctl openurl "$sim_device" "$EVAL_APP_DEEP_LINK" >"$out/s6b-open.log" 2>&1
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
      [ -n "${EVAL_APP_DEEP_LINK:-}" ] && xcrun simctl openurl "$sim_device" "$EVAL_APP_DEEP_LINK" >>"$out/s6b-open.log" 2>&1 || true
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
