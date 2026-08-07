#!/usr/bin/env bash
# Author an Expo app from a PRD on a cheap Linux worker.
#
# This is the first half of eval-e2e.yml. It runs only the coding agent and
# telemetry sidecars, then lets collect_artifacts.sh package the authored app,
# reconstructed agent trace, raw proxy log, and stage logs. The workflow uploads
# agent-workspace/ + eval-out/ as the artifact consumed by the macOS eval job.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
EVAL="$ROOT"
# shellcheck source=eval_harness/utils/shell/eval_stages.sh
source "$ROOT/eval_harness/utils/shell/eval_stages.sh"

RUN_ID="${RUN_ID:-$(date +%Y%m%d-%H%M%S)-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')}"
RUN_START_MTIME="$(date +%s)"
OUT="$ROOT/eval-out/$RUN_ID"; mkdir -p "$OUT"
WORKSPACE="$ROOT/agent-workspace/$RUN_ID"; mkdir -p "$WORKSPACE"
TELEMETRY_DIR="$OUT/telemetry"; mkdir -p "$TELEMETRY_DIR/otel"
export RUN_ID RUN_START_MTIME OUT WORKSPACE TELEMETRY_DIR

AGENT="${AGENT:-claude-code}"
AGENT="$(eval::normalize_authoring_agent "$AGENT")" || exit $?
AGENT_MODEL="${AGENT_MODEL:-}"
AGENT_MODEL="$(eval::resolve_authoring_model "$AGENT" "$AGENT_MODEL")" || exit $?
METRO_MODE="dev-build"
PRD="${PRD:-dataset/prds/hot_chocolate/prd/mvp.txt}"
# Authoring-time enforced skill scenario (see eval::run_coding_agent in
# agents.sh): skills_unavailable | skills_available_unmentioned |
# skills_available_mentioned. SKILL_MENTION only matters for the "mentioned"
# scenario. Recorded into manifest.json below as the ground truth for
# skill_invocation's analysis to score against.
SCENARIO="${SCENARIO:-skills_available_unmentioned}"
SKILL_MENTION="${SKILL_MENTION:-}"
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
PROMPT_VARIANT="${PROMPT_VARIANT:-}"
_resolve_prompt="$ROOT/eval_harness/utils/shell/resolve_prompt.sh"
PROMPT_FILE="$(ROOT="$ROOT" PROMPT_VARIANT="$PROMPT_VARIANT" bash "$_resolve_prompt")" || exit 1
PROMPT_VARIANT="$(ROOT="$ROOT" PROMPT_VARIANT="$PROMPT_VARIANT" bash "$_resolve_prompt" --variant)" || exit 1
export AGENT AGENT_MODEL METRO_MODE PRD SCENARIO SKILL_MENTION PROMPT_VARIANT PROMPT_FILE

# Lets the agent's own `eas init --id "$EAS_PROJECT_ID"` (see the prompt) link its freshly
# authored project to the same EAS project the harness itself uses, rather than needing to mint
# a new one per run. Same default/override convention as app.config.js.
EAS_PROJECT_ID="${EAS_PROJECT_ID:-338f6455-57a3-49c9-a2e0-36e5a0577c77}"
export EAS_PROJECT_ID

ANTHROPIC_PROXY_PORT=8082
OPENAI_PROXY_PORT=8083
META_PROXY_PORT=8084
OTLP_PORT=4318
export OPENAI_PROXY_PORT META_PROXY_PORT OTLP_PORT

export CI=1 EXPO_NO_TELEMETRY=1
eval::env_banner
echo "RUN_ID=$RUN_ID  AGENT=$AGENT  WORKSPACE=$WORKSPACE"
{
  echo "RUN_ID=$RUN_ID"
  echo "RUN_START_MTIME=$RUN_START_MTIME"
  echo "AGENT=$AGENT"
  echo "AGENT_MODEL=$AGENT_MODEL"
  echo "PRD=$PRD"
  echo "METRO_MODE=$METRO_MODE"
  echo "SCENARIO=$SCENARIO"
  echo "PROMPT_VARIANT=$PROMPT_VARIANT"
  echo "PROMPT_FILE=$PROMPT_FILE"
} >"$OUT/author.env"

EVAL_PROXY_PIDS=()
trap 'eval::stop_proxies; eval::cleanup_muse_settings; bash "$ROOT/eval_harness/utils/artifacts/collect_artifacts.sh" "$ROOT" "$RUN_ID" "$OUT" "$WORKSPACE" "$EVAL" "$TELEMETRY_DIR"' EXIT

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
    export MUSE_INSTALL_DIR="$OUT/muse-bin"
    export MUSE_NO_MODIFY_PATH=1
    # Settings include the Expo MCP bearer token, so they must be outside the
    # workspace and uploaded run output even if EXIT cleanup is interrupted.
    export MUSE_SETTINGS_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/muse-settings.${RUN_ID}.XXXXXX")"
    export XDG_CONFIG_HOME="$MUSE_SETTINGS_ROOT"
    export XDG_DATA_HOME="$OUT/muse-xdg-data"
    export MUSE_DATA_ROOT="$XDG_DATA_HOME"
    curl -fsSL https://dev.meta.ai/install.sh | bash >"$OUT/a-muse-install.log" 2>&1
    eval::gate ${PIPESTATUS[1]} "muse-code CLI install"
    export PATH="$MUSE_INSTALL_DIR:$PATH"
    export MUSE_NO_AUTO_UPDATE=1
    muse --version >"$OUT/a-muse-version.log" 2>&1
    eval::gate $? "muse-code CLI version"
    MUSE_CLI_VERSION="$(head -n 1 "$OUT/a-muse-version.log")"
    export MUSE_CLI_VERSION
    printf 'MUSE_CLI_VERSION=%s\n' "$MUSE_CLI_VERSION" >>"$OUT/author.env"
    ;;
esac

npm install -g eas-cli >"$OUT/a-eas-cli-install.log" 2>&1
eas --version >/dev/null 2>&1; eval::gate $? "eas-cli install"
if [ -n "${EXPO_TOKEN:-}" ]; then echo "  EXPO_TOKEN bound (len ${#EXPO_TOKEN}); eas build available to the agent"; else echo "  EXPO_TOKEN unset: agent's own eas build self-verification step will fail"; fi

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
  muse-code)
    eval::launch_proxy "$ROOT" meta https://api.meta.ai/v1 "$META_PROXY_PORT" "$TELEMETRY_DIR/meta.jsonl"
    eval::wait_for_port "$META_PROXY_PORT" && echo "  ✅ meta proxy on :$META_PROXY_PORT"
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

eval::run_coding_agent "$AGENT" "$ROOT" "$WORKSPACE" "$EVAL/$PRD" "$OUT" "$AGENT_MODEL"

if [ ! -f "$WORKSPACE/package.json" ]; then
  echo "  ❌ coding agent did not produce package.json; downstream eval will collect diagnostics only"
else
  echo "  ✅ authored package.json present"
fi

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
( cd "$ROOT" && $BH_TO bun eval_harness/evaluator/skill_invocation/build_health/bundle_check.ts "$WORKSPACE" ) \
  || echo "  ⚠️  build-health bundle check failed to run (continuing; non-blocking)"

exit 0
