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
[ "$AGENT" = "claude" ] && AGENT="claude-code"
AGENT_MODEL="${AGENT_MODEL:-}"
if [ -z "$AGENT_MODEL" ]; then
  if [ "$AGENT" = "codex" ]; then AGENT_MODEL="${CODEX_MODEL:-gpt-5-mini}"; else AGENT_MODEL="sonnet"; fi
fi
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
PROMPT_VARIANT="${PROMPT_VARIANT:-baseline}"
PROMPT_FILE="$(ROOT="$ROOT" PROMPT_VARIANT="$PROMPT_VARIANT" bash "$ROOT/eval_harness/utils/shell/resolve_prompt.sh")" || exit 1
export AGENT AGENT_MODEL METRO_MODE PRD SCENARIO SKILL_MENTION PROMPT_VARIANT PROMPT_FILE

# Lets the agent's own `eas init --id "$EAS_PROJECT_ID"` (see the prompt) link its freshly
# authored project to the same EAS project the harness itself uses, rather than needing to mint
# a new one per run. Same default/override convention as app.config.js.
EAS_PROJECT_ID="${EAS_PROJECT_ID:-338f6455-57a3-49c9-a2e0-36e5a0577c77}"
export EAS_PROJECT_ID

ANTHROPIC_PROXY_PORT=8082
OPENAI_PROXY_PORT=8083
OTLP_PORT=4318
export OPENAI_PROXY_PORT OTLP_PORT

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
trap 'eval::stop_proxies; bash "$ROOT/eval_harness/utils/artifacts/collect_artifacts.sh" "$ROOT" "$RUN_ID" "$OUT" "$WORKSPACE" "$EVAL" "$TELEMETRY_DIR"' EXIT

echo "================= STAGE A: coding-agent CLI install ================="
bash "$ROOT/eval_harness/utils/shell/check_claude_auth.sh" || exit 1

echo "================= STAGE A2: uv + trace deps ================="
eval::install_uv_and_evaluator "$EVAL" "$OUT"

npm install -g @anthropic-ai/claude-code >"$OUT/a-cc-install.log" 2>&1
claude --version >/dev/null 2>&1; eval::gate $? "claude-code CLI install"
claude auth status --text >"$OUT/a-cc-auth.log" 2>&1
eval::gate $? "claude-code OAuth auth status"
if [ "$AGENT" = "codex" ]; then
  npm install -g @openai/codex >"$OUT/a-codex-install.log" 2>&1
  codex --version >/dev/null 2>&1; eval::gate $? "codex CLI install"
fi

npm install -g eas-cli >"$OUT/a-eas-cli-install.log" 2>&1
eas --version >/dev/null 2>&1; eval::gate $? "eas-cli install"
if [ -n "${EXPO_TOKEN:-}" ]; then echo "  EXPO_TOKEN bound (len ${#EXPO_TOKEN}); eas build available to the agent"; else echo "  EXPO_TOKEN unset: agent's own eas build self-verification step will fail"; fi

echo "================= STAGE B: telemetry sidecars ================="
eval::launch_proxy "$ROOT" anthropic https://api.anthropic.com "$ANTHROPIC_PROXY_PORT" "$TELEMETRY_DIR/anthropic.jsonl"
eval::wait_for_port "$ANTHROPIC_PROXY_PORT" && echo "  ✅ anthropic proxy on :$ANTHROPIC_PROXY_PORT"
if [ "$AGENT" = "codex" ]; then
  eval::launch_proxy "$ROOT" openai https://api.openai.com "$OPENAI_PROXY_PORT" "$TELEMETRY_DIR/openai.jsonl"
  eval::wait_for_port "$OPENAI_PROXY_PORT" && echo "  ✅ openai proxy on :$OPENAI_PROXY_PORT"
fi
eval::launch_otlp_receiver "$ROOT" "$OTLP_PORT" "$TELEMETRY_DIR/otel"
eval::wait_for_port "$OTLP_PORT" && echo "  ✅ OTLP receiver on :$OTLP_PORT"

eval::configure_expo_mcp || true

echo "================= STAGE C: coding agent authors app ================="
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
else BH_TO="python3 $ROOT/eval_harness/utils/shell/timeout_exec.py 240"; fi
( cd "$ROOT" && $BH_TO uv run python -m eval_harness.evaluator.skill_invocation.build_health.bundle_check "$WORKSPACE" ) \
  || echo "  ⚠️  build-health bundle check failed to run (continuing; non-blocking)"

exit 0
