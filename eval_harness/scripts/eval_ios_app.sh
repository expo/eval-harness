#!/usr/bin/env bash
# Build, run, and evaluate an app authored by eval_harness/scripts/author_app.sh.
#
# This is the macOS half of eval-e2e.yml. The workflow downloads and extracts the
# authored-app artifact first, so this script expects agent-workspace/<RUN_ID> and
# eval-out/<RUN_ID>/author.env to already exist.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EVAL="$ROOT"
# shellcheck source=eval_harness/utils/shell/eval_stages.sh
source "$ROOT/eval_harness/utils/shell/eval_stages.sh"

AUTHOR_ENV="${AUTHOR_ENV:-}"
if [ -z "$AUTHOR_ENV" ]; then
  for f in "$ROOT"/eval-out/*/author.env; do
    [ -f "$f" ] || continue
    AUTHOR_ENV="$f"
    break
  done
fi

if [ -z "$AUTHOR_ENV" ] || [ ! -f "$AUTHOR_ENV" ]; then
  echo "  ❌ missing author.env from authored-app artifact"
  exit 0
fi

# shellcheck disable=SC1090
. "$AUTHOR_ENV"

OUT="$ROOT/eval-out/$RUN_ID"
WORKSPACE="$ROOT/agent-workspace/$RUN_ID"
TELEMETRY_DIR="$OUT/telemetry"; mkdir -p "$TELEMETRY_DIR/otel"
METRO_MODE="${METRO_MODE:-dev-build}"
AGENT="${AGENT:-claude-code}"
[ "$AGENT" = "claude" ] && AGENT="claude-code"
AGENT_MODEL="${AGENT_MODEL:-}"
if [ -z "$AGENT_MODEL" ]; then
  if [ "$AGENT" = "codex" ]; then AGENT_MODEL="${CODEX_MODEL:-gpt-5-mini}"; else AGENT_MODEL="sonnet"; fi
fi
PRD="${PRD_OVERRIDE:-${PRD:-eval_harness/prds/hot_chocolate/prd/mvp.txt}}"
TEST_PLAN="${TEST_PLAN_OVERRIDE:-${TEST_PLAN:-eval_harness/app_evaluator/test_plans/primitives}}"
export RUN_ID RUN_START_MTIME OUT WORKSPACE TELEMETRY_DIR METRO_MODE AGENT AGENT_MODEL PRD TEST_PLAN

ANTHROPIC_PROXY_PORT=8082
OTLP_PORT=4318
export OTLP_PORT

export CI=1 EXPO_NO_TELEMETRY=1
# Keep workflow logs readable by default. The evaluator still writes the complete
# verbose transcript to eval-out/<RUN_ID>/s7-eval.log, which is uploaded as an
# artifact. Set EVAL_STREAM_LOGS=1 for live evaluator token/tool logs.
export EVAL_STREAM_LOGS="${EVAL_STREAM_LOGS:-0}"
eval::fix_java_home
eval::env_banner
echo "RUN_ID=$RUN_ID  WORKSPACE=$WORKSPACE"

EVAL_PROXY_PIDS=()
EVAL_METRO_PID=""
trap 'eval::stop_proxies; kill "${EVAL_METRO_PID:-}" 2>/dev/null || true; bash "$ROOT/eval_harness/utils/artifacts/collect_artifacts.sh" "$ROOT" "$RUN_ID" "$OUT" "$WORKSPACE" "$EVAL" "$TELEMETRY_DIR"' EXIT

echo "================= STAGE D0: macOS eval toolchain ================="
eval::install_agent_device "$OUT"
eval::install_maestro "$OUT"
eval::install_uv_and_evaluator "$EVAL" "$OUT"

echo "================= STAGE D1: evaluator telemetry sidecars ================="
eval::launch_proxy "$ROOT" anthropic https://api.anthropic.com "$ANTHROPIC_PROXY_PORT" "$TELEMETRY_DIR/anthropic.jsonl"
eval::wait_for_port "$ANTHROPIC_PROXY_PORT" && echo "  ✅ anthropic proxy on :$ANTHROPIC_PROXY_PORT"
eval::launch_otlp_receiver "$ROOT" "$OTLP_PORT" "$TELEMETRY_DIR/otel"
eval::wait_for_port "$OTLP_PORT" && echo "  ✅ OTLP receiver on :$OTLP_PORT"

export ANTHROPIC_BASE_URL="http://127.0.0.1:$ANTHROPIC_PROXY_PORT"
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_EXPORTER_OTLP_ENDPOINT="http://127.0.0.1:$OTLP_PORT"
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_METRICS_EXPORTER=otlp OTEL_LOGS_EXPORTER=otlp OTEL_TRACES_EXPORTER=otlp
export OTEL_RESOURCE_ATTRIBUTES="run.id=$RUN_ID,phase=evaluate,service.name=eval-harness"

if [ ! -f "$WORKSPACE/package.json" ]; then
  echo "  ❌ authored workspace has no package.json; skipping build/eval and collecting diagnostics"
  exit 0
fi

echo "================= STAGE D: npm install + resolve app config + native iOS build ================="
if ! eval::npm_install "$WORKSPACE" "$OUT"; then
  echo "  ❌ authored app failed a clean npm install on the eval worker; skipping build/eval and collecting diagnostics"
  exit 0
fi

EVAL_IOS_APP_MODE="${EVAL_IOS_APP_MODE:-dev-client}"
echo "  iOS app mode: $EVAL_IOS_APP_MODE"
if [ "$EVAL_IOS_APP_MODE" = "dev-client" ]; then
  echo "  ensuring expo-dev-client is installed (dev-build deep-link handshake)"
  ( cd "$WORKSPACE" && npx --yes expo install expo-dev-client ) >"$OUT/d-devclient.log" 2>&1 \
    || echo "  ⚠️  expo install expo-dev-client failed (see d-devclient.log)"

  DEV_CLIENT_DEFAULT_URL="${DEV_CLIENT_DEFAULT_URL:-http://localhost:8081}"
  node "$ROOT/eval_harness/utils/ios/patch_dev_client_default_url.mjs" "$WORKSPACE" "$DEV_CLIENT_DEFAULT_URL" >"$OUT/d-devclient-config.log" 2>&1 \
    || echo "  ⚠️  dev-client defaultLaunchURL patch failed (see d-devclient-config.log)"
  cat "$OUT/d-devclient-config.log"
  export EVAL_DEV_CLIENT_CLEAR_STATE="${EVAL_DEV_CLIENT_CLEAR_STATE:-1}"
fi

BUNDLE_ID=""; SCHEME=""
if ( cd "$WORKSPACE" && npx --yes expo config --json >"$OUT/d-expo-config.json" 2>"$OUT/d-expo-config.err" ); then
  BUNDLE_ID="$(python3 -c "import json; d=json.load(open('$OUT/d-expo-config.json')); print((d.get('ios') or {}).get('bundleIdentifier') or '')" 2>/dev/null)"
  SCHEME="$(python3 -c "import json; d=json.load(open('$OUT/d-expo-config.json')); s=d.get('scheme'); print((s[0] if isinstance(s,list) else s) or '')" 2>/dev/null)"
fi
echo "  resolved bundleIdentifier='$BUNDLE_ID'  scheme='$SCHEME'"
if [ -z "$BUNDLE_ID" ] || [ -z "$SCHEME" ]; then
  echo "  ❌ authored app is missing required Expo config (ios.bundleIdentifier and scheme are required); skipping build/eval"
  exit 0
fi
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

export TRACE_PHASE=evaluate
export TRACE_SINCE_MTIME="$(date +%s)"
if ! eval::run_evaluator "$EVAL" "$TEST_PLAN" "$PRD" "$OUT/result.json" "$OUT"; then
  echo "  ❌ evaluator failed; artifacts will still be collected by the EXIT trap"
  exit 1
fi

echo "================= RESULT ================="
if [ -f "$OUT/result.json" ]; then cat "$OUT/result.json"; else echo "(no result.json produced)"; fi
exit 0
