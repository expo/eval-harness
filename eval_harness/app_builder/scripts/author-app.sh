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
export AGENT AGENT_MODEL METRO_MODE PRD SCENARIO SKILL_MENTION

# Lets the agent's own `eas init --id "$EAS_PROJECT_ID"` (see author_app.md) link its freshly
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
} >"$OUT/author.env"

EVAL_PROXY_PIDS=()
trap 'eval::stop_proxies; bash "$ROOT/eval_harness/utils/artifacts/collect_artifacts.sh" "$ROOT" "$RUN_ID" "$OUT" "$WORKSPACE" "$EVAL" "$TELEMETRY_DIR"' EXIT

echo "================= STAGE A: coding-agent CLI install ================="
if [ -z "${ANTHROPIC_API_KEY:-}" ]; then echo "  ❌ ANTHROPIC_API_KEY unset"; else echo "  ANTHROPIC_API_KEY bound (len ${#ANTHROPIC_API_KEY})"; fi
ac=$(curl -sS --max-time 20 -o /dev/null -w '%{http_code}' https://api.anthropic.com/v1/messages \
  -H "x-api-key: ${ANTHROPIC_API_KEY:-}" -H "anthropic-version: 2023-06-01" -H "content-type: application/json" \
  -d '{"model":"claude-haiku-4-5","max_tokens":8,"messages":[{"role":"user","content":"hi"}]}' 2>/dev/null || echo "curl-fail")
echo "  direct anthropic (no proxy): $ac"

echo "================= STAGE A2: uv + trace deps ================="
eval::install_uv_and_evaluator "$EVAL" "$OUT"

npm install -g @anthropic-ai/claude-code >"$OUT/a-cc-install.log" 2>&1
claude --version >/dev/null 2>&1; eval::gate $? "claude-code CLI install"
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

# The Expo MCP access token is refreshed once per workflow run by the
# provision_mcp_token job (see .eas/workflows/eval-e2e.yml and
# provision-mcp-token.sh) and handed to this job as EXPO_MCP_BEARER_TOKEN /
# EXPO_MCP_AUTH_STATUS env vars -- this job no longer refreshes it itself,
# since concurrent author_app jobs (e.g. one per PRD) each calling
# eval::refresh_expo_mcp_token independently was a real race on the shared EAS
# refresh_token secret. "none" is the workflow's non-empty placeholder for "no
# token" (EAS's set-output rejects an empty VALUE); normalize it back to unset.
[ "${EXPO_MCP_BEARER_TOKEN:-}" = "none" ] && EXPO_MCP_BEARER_TOKEN=""
export EXPO_MCP_BEARER_TOKEN
export EXPO_MCP_AUTH_STATUS="${EXPO_MCP_AUTH_STATUS:-unconfigured}"
echo "  Expo MCP: auth_status=$EXPO_MCP_AUTH_STATUS bearer_token_len=${#EXPO_MCP_BEARER_TOKEN}"

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

exit 0
