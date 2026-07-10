#!/usr/bin/env bash
# Author an Expo app from a PRD on a cheap Linux worker.
#
# This is the first half of eval-e2e.yml. It runs only the coding agent and
# telemetry sidecars, then lets collect_artifacts.sh package the authored app,
# reconstructed agent trace, raw proxy log, and stage logs. The workflow uploads
# agent-workspace/ + eval-out/ as the artifact consumed by the macOS eval job.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EVAL="$ROOT"
PY="$(command -v python3 || command -v python)"
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
AUTHORING_MODE="${AUTHORING_MODE:-prd}"
SKILL_CASE_SPEC="${SKILL_CASE_SPEC:-}"
SKILL_SCENARIO="${SKILL_SCENARIO:-skills_available_unmentioned}"
PRD="${PRD:-eval_harness/app_evaluator/prds/hot_chocolate/prd/mvp.txt}"
TEST_PLAN="${TEST_PLAN:-eval_harness/app_evaluator/test_plans/primitives}"
if [ "$AUTHORING_MODE" = "skill_case" ]; then
  if [ -z "$SKILL_CASE_SPEC" ]; then
    echo "  ❌ SKILL_CASE_SPEC is required when AUTHORING_MODE=skill_case"
    exit 2
  fi
  AUTHORING_ENV="$OUT/authoring.env"
  PYTHONPATH="$ROOT${PYTHONPATH:+:$PYTHONPATH}" \
    "$PY" -m eval_harness.skill_evaluator.main resolve-authoring-env \
      --case "$SKILL_CASE_SPEC" \
      --scenario "$SKILL_SCENARIO" \
      --out-env "$AUTHORING_ENV" >"$OUT/authoring-env.log" 2>&1
  rc=$?
  eval::gate $rc "resolve skill-case authoring PRD"
  if [ "$rc" != 0 ]; then
    cat "$OUT/authoring-env.log" | sed 's/^/    /'
    exit "$rc"
  fi
  # shellcheck disable=SC1090
  . "$AUTHORING_ENV"
fi
export AGENT AGENT_MODEL METRO_MODE AUTHORING_MODE PRD TEST_PLAN SKILL_CASE_SPEC SKILL_SCENARIO

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
  echo "AUTHORING_MODE=$AUTHORING_MODE"
  echo "PRD=$PRD"
  echo "TEST_PLAN=$TEST_PLAN"
  echo "METRO_MODE=$METRO_MODE"
  echo "SKILL_CASE_SPEC=${SKILL_CASE_SPEC:-}"
  echo "SKILL_SCENARIO=${SKILL_SCENARIO:-}"
  echo "SKILL_EVAL_CASE_ID=${SKILL_EVAL_CASE_ID:-}"
  echo "SKILL_EVAL_FEATURE_FOCUS=${SKILL_EVAL_FEATURE_FOCUS:-}"
  echo "SKILL_EVAL_EXPECTED_SKILLS=${SKILL_EVAL_EXPECTED_SKILLS:-}"
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

validate_authored_app() {
  local label="$1" rc TO="" clean_dir=""
  echo "================= STAGE C2: validate authored app ($label) ================="
  if command -v gtimeout >/dev/null 2>&1; then TO="gtimeout 900";
  elif command -v timeout >/dev/null 2>&1; then TO="timeout 900"; fi
  ( cd "$WORKSPACE" && $TO npm install ) >"$OUT/c-validate-npm-$label.log" 2>&1
  rc=$?
  eval::gate $rc "authored app npm install ($label)"
  if [ "$rc" != 0 ]; then
    echo "  --- c-validate-npm-$label.log tail ---"
    tail -60 "$OUT/c-validate-npm-$label.log" | sed 's/^/    /'
    return "$rc"
  fi

  ( cd "$WORKSPACE" && npx expo install --check ) >"$OUT/c-validate-expo-deps-$label.log" 2>&1
  rc=$?
  eval::gate $rc "authored app Expo dependency check ($label)"
  if [ "$rc" != 0 ]; then
    echo "  --- c-validate-expo-deps-$label.log tail ---"
    tail -80 "$OUT/c-validate-expo-deps-$label.log" | sed 's/^/    /'
    return "$rc"
  fi

  clean_dir="$OUT/clean-install-$label"
  rm -rf "$clean_dir"
  mkdir -p "$clean_dir"
  ( cd "$WORKSPACE" && tar \
      --exclude='./node_modules' \
      --exclude='./.expo' \
      --exclude='./ios' \
      --exclude='./android' \
      -cf - . ) | ( cd "$clean_dir" && tar -xf - )
  ( cd "$clean_dir" && $TO npm install ) >"$OUT/c-validate-clean-npm-$label.log" 2>&1
  rc=$?
  rm -rf "$clean_dir"
  eval::gate $rc "authored app clean npm install ($label)"
  if [ "$rc" != 0 ]; then
    echo "  --- c-validate-clean-npm-$label.log tail ---"
    tail -80 "$OUT/c-validate-clean-npm-$label.log" | sed 's/^/    /'
    return "$rc"
  fi

  ( cd "$WORKSPACE" && npx expo config --json ) >"$OUT/c-validate-expo-config-$label.json" 2>"$OUT/c-validate-expo-config-$label.err"
  rc=$?
  eval::gate $rc "authored app expo config ($label)"
  if [ "$rc" != 0 ]; then
    echo "  --- c-validate-expo-config-$label.err tail ---"
    tail -60 "$OUT/c-validate-expo-config-$label.err" | sed 's/^/    /'
    return "$rc"
  fi

  "$PY" - "$OUT/c-validate-expo-config-$label.json" >"$OUT/c-validate-required-config-$label.log" 2>&1 <<'PY'
import json
import sys

data = json.load(open(sys.argv[1]))
ios = data.get("ios") or {}
bundle = ios.get("bundleIdentifier")
scheme = data.get("scheme")
if isinstance(scheme, list):
    scheme = scheme[0] if scheme else None
missing = []
if not bundle:
    missing.append("ios.bundleIdentifier")
if not scheme:
    missing.append("scheme")
if missing:
    print("Missing required Expo config field(s): " + ", ".join(missing))
    sys.exit(1)
print(f"bundleIdentifier={bundle}")
print(f"scheme={scheme}")
PY
  rc=$?
  eval::gate $rc "authored app required config ($label)"
  if [ "$rc" != 0 ]; then
    echo "  --- c-validate-required-config-$label.log ---"
    cat "$OUT/c-validate-required-config-$label.log" | sed 's/^/    /'
  fi
  return "$rc"
}

write_repair_prompt() {
  local attempt="$1" failed_label="$2" prompt_file="$OUT/c-repair-$attempt-prompt.md"
  {
    cat <<'EOF'
The Expo app you just authored failed the harness validation step.

Repair the existing project in the current working directory. Do not ask for
confirmation. Modify package.json/source/config as needed, then run `npm install`
yourself and keep fixing until it succeeds. Preserve the original PRD behavior
and testIDs.

Use Expo tooling for dependency compatibility. Do not hand-pin guessed Expo,
React, React Native, or native-module versions.
EOF
    echo
    echo "Failed validation label: $failed_label"
    echo
    echo "Tail of npm install log:"
    echo '```'
    tail -160 "$OUT/c-validate-npm-$failed_label.log" 2>/dev/null || true
    echo '```'
    echo
    echo "Tail of clean npm install log:"
    echo '```'
    tail -160 "$OUT/c-validate-clean-npm-$failed_label.log" 2>/dev/null || true
    echo '```'
    echo
    echo "Expo dependency compatibility check:"
    echo '```'
    cat "$OUT/c-validate-expo-deps-$failed_label.log" 2>/dev/null || true
    echo '```'
    echo
    echo "Expo config validation output, if any:"
    echo '```'
    cat "$OUT/c-validate-required-config-$failed_label.log" 2>/dev/null || true
    tail -80 "$OUT/c-validate-expo-config-$failed_label.err" 2>/dev/null || true
    echo '```'
  } >"$prompt_file"
  echo "$prompt_file"
}

if [ ! -f "$WORKSPACE/package.json" ]; then
  echo "  ❌ coding agent did not produce package.json; downstream eval will collect diagnostics only"
else
  echo "  ✅ authored package.json present"
  validation_label="initial"
  if ! validate_authored_app "$validation_label"; then
    max_repairs="${AUTHOR_REPAIR_ATTEMPTS:-2}"
    for attempt in $(seq 1 "$max_repairs"); do
      prompt_file="$(write_repair_prompt "$attempt" "$validation_label")"
      eval::run_coding_agent_repair "$AGENT" "$WORKSPACE" "$prompt_file" "$OUT" "$attempt" "$AGENT_MODEL"
      validation_label="repair-$attempt"
      validate_authored_app "$validation_label" && break
    done
  fi
fi

exit 0
