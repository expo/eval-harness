#!/usr/bin/env bash
# Author an Expo app from a PRD on a cheap Linux worker.
#
# This is the first half of eval-e2e.yml. It runs only the coding agent and
# telemetry sidecars, then constructs one canonical authored-app tree containing
# the sanitized workspace, reconstructed author trace, telemetry, and logs.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
EVAL="$ROOT"
# shellcheck source=eval_harness/utils/shell/eval_stages.sh
source "$ROOT/eval_harness/utils/shell/eval_stages.sh"

RUN_ID="${RUN_ID:-$(date +%Y%m%d-%H%M%S)-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')}"
RUN_START_MTIME="$(date +%s)"
WORKSPACE_ROOT="$ROOT/author-agent-workspace"
METADATA_ROOT="$ROOT/author-agent-metadata"
WORKSPACE="$WORKSPACE_ROOT/$RUN_ID"
OUT="$METADATA_ROOT/$RUN_ID"
ARTIFACT_ROOT="$ROOT/authored-app"
mkdir -p "$OUT" "$WORKSPACE"
TELEMETRY_DIR="$OUT/telemetry"; mkdir -p "$TELEMETRY_DIR/otel"
AUTHOR_APP_AUTHORED_STATUS=not_run
AUTHOR_EXPO_EXPORT_STATUS=not_run
AGENT="${AGENT:-claude-code}"
AGENT_MODEL="${AGENT_MODEL:-}"
AGENT_REASONING_EFFORT="${AGENT_REASONING_EFFORT:-}"
METRO_MODE="dev-build"
PRD="${PRD:-dataset/prds/hot_chocolate/prd/mvp.txt}"
SCENARIO="${SCENARIO:-skills_available_unmentioned}"
SKILL_MENTION="${SKILL_MENTION:-}"
REQUESTED_PROMPT_VARIANT="${PROMPT_VARIANT:-}"
PROMPT_VARIANT=""
PROMPT_FILE=""
EVAL_PROXY_PIDS=()
export RUN_ID RUN_START_MTIME OUT WORKSPACE TELEMETRY_DIR WORKSPACE_ROOT METADATA_ROOT ARTIFACT_ROOT \
  AUTHOR_APP_AUTHORED_STATUS AUTHOR_EXPO_EXPORT_STATUS AGENT AGENT_MODEL AGENT_REASONING_EFFORT \
  METRO_MODE PRD SCENARIO SKILL_MENTION PROMPT_VARIANT PROMPT_FILE
export REQUESTED_PROMPT_VARIANT

write_author_env() {
  {
    printf 'RUN_ID=%q\n' "$RUN_ID"
    printf 'RUN_START_MTIME=%q\n' "$RUN_START_MTIME"
    printf 'AGENT=%q\n' "$AGENT"
    printf 'AGENT_MODEL=%q\n' "$AGENT_MODEL"
    printf 'AGENT_REASONING_EFFORT=%q\n' "$AGENT_REASONING_EFFORT"
    printf 'PRD=%q\n' "$PRD"
    printf 'METRO_MODE=%q\n' "$METRO_MODE"
    printf 'SCENARIO=%q\n' "$SCENARIO"
    printf 'PROMPT_VARIANT=%q\n' "$PROMPT_VARIANT"
    printf 'REQUESTED_PROMPT_VARIANT=%q\n' "$REQUESTED_PROMPT_VARIANT"
    printf 'PROMPT_FILE=%q\n' "$PROMPT_FILE"
  } >"$OUT/author.env"
}

# Install diagnostic collection before any provider/prompt preflight. A bad
# dispatch input must remain a reportable failed author run.
AUTHOR_APP_AUTHORED_STATUS=failed
write_author_env
author_app_cleanup() {
  local author_status=$? collection_status=0
  eval::stop_proxies || true
  eval::cleanup_muse_settings || true
  bash "$ROOT/eval_harness/utils/artifacts/collect_author_artifact.sh" \
    "$ROOT" "$RUN_ID" "$WORKSPACE_ROOT" "$METADATA_ROOT" "$ARTIFACT_ROOT" \
    || collection_status=$?
  if [ "$author_status" -ne 0 ]; then
    exit "$author_status"
  fi
  exit "$collection_status"
}
trap author_app_cleanup EXIT

resolved_agent="$(eval::normalize_authoring_agent "$AGENT")" || exit $?
AGENT="$resolved_agent"
resolved_model="$(eval::resolve_authoring_model "$AGENT" "$AGENT_MODEL")" || exit $?
AGENT_MODEL="$resolved_model"
resolved_effort="$(eval::resolve_reasoning_effort "$AGENT_REASONING_EFFORT")" || exit $?
AGENT_REASONING_EFFORT="$resolved_effort"
# Authoring-time enforced skill scenario (see eval::run_coding_agent in
# agents.sh): skills_unavailable | skills_available_unmentioned |
# skills_available_mentioned. SKILL_MENTION only matters for the "mentioned"
# scenario. Recorded into manifest.json below as the ground truth for
# skill_invocation's analysis to score against.
# Base authoring prompt, selected by short id from dataset/prompts.json (see
# eval::run_coding_agent in agents.sh for how it's assembled with the PRD).
# Resolved and validated here, before any expensive stage: an unknown id or an
# unreadable/empty prompt file must abort the run rather than silently author
# from a bare PRD and still get built, evaluated, and scored.
# Deliberately not defaulted here: resolve_prompt.sh owns the fallback, so it
# can tell "nobody picked one" from "someone picked baseline" and log which.
# Ask it for the effective id too, so author.env and manifest.json record what
# actually ran rather than an empty string (and without assuming the id matches
# the filename -- the registry doesn't require that).
_resolve_prompt="$ROOT/eval_harness/utils/shell/resolve_prompt.sh"
resolved_prompt_file="$(ROOT="$ROOT" PROMPT_VARIANT="$REQUESTED_PROMPT_VARIANT" bash "$_resolve_prompt")" || exit 1
resolved_prompt_variant="$(ROOT="$ROOT" PROMPT_VARIANT="$REQUESTED_PROMPT_VARIANT" bash "$_resolve_prompt" --variant)" || exit 1
PROMPT_FILE="$resolved_prompt_file"
PROMPT_VARIANT="$resolved_prompt_variant"
export AGENT AGENT_MODEL AGENT_REASONING_EFFORT METRO_MODE PRD SCENARIO SKILL_MENTION PROMPT_VARIANT PROMPT_FILE
write_author_env

# Lets the agent's own `eas init --id "$EAS_PROJECT_ID"` (see the prompt) link
# its freshly authored project to the same EAS project the harness uses, rather
# than minting a new one per run. There is no committed project id; set this in
# `.env` and the EAS `production` environment (see .env.default).
if [ -n "${EAS_PROJECT_ID:-}" ]; then
  export EAS_PROJECT_ID
fi

ANTHROPIC_PROXY_PORT=8082
OPENAI_PROXY_PORT=8083
OTLP_PORT=4318
export OPENAI_PROXY_PORT OTLP_PORT

export CI=1 EXPO_NO_TELEMETRY=1
eval::env_banner
echo "RUN_ID=$RUN_ID  AGENT=$AGENT  WORKSPACE=$WORKSPACE"

echo "================= STAGE A: coding-agent CLI install ================="
eval::require_authoring_credentials "$AGENT" "$ROOT" || exit $?

echo "================= STAGE A2: uv + trace deps ================="
eval::install_uv_and_evaluator "$EVAL" "$OUT"

case "$AGENT" in
  claude-code)
    npm install -g @anthropic-ai/claude-code >"$OUT/a-cc-install.log" 2>&1
    claude --version >/dev/null 2>&1; eval::gate $? "claude-code CLI install"
    claude auth status --text >"$OUT/a-cc-auth.log" 2>&1
    eval::gate $? "claude-code OAuth auth status"
    ;;
  codex)
    npm install -g @openai/codex >"$OUT/a-codex-install.log" 2>&1
    codex --version >/dev/null 2>&1; eval::gate $? "codex CLI install"
    ;;
  muse-code)
    # Settings include the Expo MCP bearer token, so they must be outside the
    # workspace and uploaded run output even if EXIT cleanup is interrupted.
    export MUSE_SETTINGS_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/muse-settings.${RUN_ID}.XXXXXX")"
    export MUSE_SETTINGS_OWNED=1
    export XDG_CONFIG_HOME="$MUSE_SETTINGS_ROOT"
    export XDG_DATA_HOME="$OUT/muse-xdg-data"
    export MUSE_DATA_ROOT="$XDG_DATA_HOME"
    eval::install_muse_cli "$OUT"
    ;;
esac

npm install -g eas-cli >"$OUT/a-eas-cli-install.log" 2>&1
eas --version >/dev/null 2>&1; eval::gate $? "eas-cli install"
if [ -n "${EXPO_TOKEN:-}" ]; then echo "  EXPO_TOKEN bound (len ${#EXPO_TOKEN}); eas build available to the agent"; else echo "  EXPO_TOKEN unset: agent's own eas build self-verification step will fail"; fi
if [ -n "${EAS_PROJECT_ID:-}" ]; then echo "  EAS_PROJECT_ID bound; agent can eas init against this project"; else echo "  EAS_PROJECT_ID unset: agent's eas init self-verification will fail"; fi

echo "================= STAGE B: telemetry sidecars ================="
case "$AGENT" in
  claude-code)
    eval::launch_proxy "$ROOT" anthropic https://api.anthropic.com "$ANTHROPIC_PROXY_PORT" "$TELEMETRY_DIR/anthropic.jsonl"
    eval::wait_for_port "$ANTHROPIC_PROXY_PORT" && echo "  ✅ anthropic proxy on :$ANTHROPIC_PROXY_PORT"
    eval::launch_otlp_receiver "$ROOT" "$OTLP_PORT" "$TELEMETRY_DIR/otel"
    eval::wait_for_port "$OTLP_PORT" && echo "  ✅ OTLP receiver on :$OTLP_PORT"
    ;;
  codex)
    eval::launch_proxy "$ROOT" openai https://api.openai.com "$OPENAI_PROXY_PORT" "$TELEMETRY_DIR/openai.jsonl"
    eval::wait_for_port "$OPENAI_PROXY_PORT" && echo "  ✅ openai proxy on :$OPENAI_PROXY_PORT"
    eval::launch_otlp_receiver "$ROOT" "$OTLP_PORT" "$TELEMETRY_DIR/otel"
    eval::wait_for_port "$OTLP_PORT" && echo "  ✅ OTLP receiver on :$OTLP_PORT"
    ;;
esac

if [ "$SCENARIO" = "skills_unavailable" ]; then
  unset EXPO_MCP_BEARER_TOKEN
  export EXPO_MCP_AUTH_STATUS="not_attempted"
  echo "  Expo MCP not configured: skills_unavailable scenario"
else
  eval::configure_expo_mcp || true
fi
if [ "$AGENT" = "muse-code" ]; then
  eval::configure_muse_settings "$SCENARIO" || exit $?
fi

echo "================= STAGE C: coding agent authors app ================="
if [ "$AGENT" = "claude-code" ]; then
  export ANTHROPIC_BASE_URL="http://127.0.0.1:$ANTHROPIC_PROXY_PORT"
  export CLAUDE_CODE_ENABLE_TELEMETRY=1
  export ANTHROPIC_MODEL="$AGENT_MODEL"
fi
if [ "$AGENT" = "claude-code" ] || [ "$AGENT" = "codex" ]; then
  export OTEL_EXPORTER_OTLP_ENDPOINT="http://127.0.0.1:$OTLP_PORT"
  export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
  export OTEL_METRICS_EXPORTER=otlp OTEL_LOGS_EXPORTER=otlp OTEL_TRACES_EXPORTER=otlp
  export OTEL_METRIC_EXPORT_INTERVAL=2000 OTEL_LOGS_EXPORT_INTERVAL=2000
  export OTEL_RESOURCE_ATTRIBUTES="run.id=$RUN_ID,phase=agent-build,service.name=eval-harness"
fi

eval::run_coding_agent "$AGENT" "$ROOT" "$WORKSPACE" "$EVAL/$PRD" "$OUT" "$AGENT_MODEL" "$AGENT_REASONING_EFFORT" "${MUSE_API_KEY:-}"
AGENT_RC=$?
eval::require_authored_app "$AGENT_RC" "$WORKSPACE" || exit $?
AUTHOR_APP_AUTHORED_STATUS=passed

echo "================= STAGE D: build-health bundle check ================="
# Needs the authored app's own node_modules (a real `expo export`), so this
# can only run now, at authoring time, not later at skill-eval analysis
# time -- the packaged artifact excludes node_modules before upload. Result
# is persisted as a small JSON file inside $WORKSPACE itself (which DOES
# survive into the artifact) for analyze_artifacts to read later. Best-
# effort only: never blocks or fails this script.
BH_TO=""
if command -v gtimeout >/dev/null 2>&1; then BH_TO="gtimeout 240";
elif command -v timeout >/dev/null 2>&1; then BH_TO="timeout 240";
else BH_TO="bun $ROOT/eval_harness/utils/shell/timeout_exec.ts 240"; fi
AUTHOR_EXPO_EXPORT_STATUS=warning
if ( cd "$ROOT" && $BH_TO bun eval_harness/evaluator/skill_invocation/build_health/bundle_check.ts "$WORKSPACE" ) \
  >"$OUT/d-expo-export.log" 2>&1; then
  if "$(command -v python3 || command -v python)" - "$WORKSPACE/.eval-build-health-bundle.json" <<'PYEOF'
import json
import sys

try:
    with open(sys.argv[1], encoding="utf-8") as handle:
        result = json.load(handle)
except (OSError, UnicodeError, json.JSONDecodeError):
    raise SystemExit(1)

raise SystemExit(0 if isinstance(result, dict) and result.get("ok") is True else 1)
PYEOF
  then
    AUTHOR_EXPO_EXPORT_STATUS=passed
  else
    echo "  ⚠️  build-health Expo export did not pass (continuing; see d-expo-export.log)"
  fi
else
  echo "  ⚠️  build-health bundle check failed to run (continuing; see d-expo-export.log)"
fi

exit 0
