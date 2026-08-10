#!/usr/bin/env bash
# Finalize the canonical ios-eval-report directory for one evaluator run.
#
# Positional args: repository_root run_id ios_artifact_root
# Trace reconstruction is best-effort so failed evaluations keep diagnostics.
set -uo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: $0 <repository_root> <run_id> <ios_artifact_root>" >&2
  exit 2
fi

ROOT="$1"
RUN_ID="$2"
OUT="$3"
PY="$(command -v python3 || command -v python)"
TRACE_SINCE="${TRACE_SINCE_MTIME:-${EVAL_PHASE_START_MTIME:-${RUN_START_MTIME:-0}}}"
PLAN_TRACES_ROOT="${EVALUATOR_TRACES_ROOT:-$ROOT/traces}"

case "$OUT" in
  ""|/|"$ROOT")
    echo "refusing unsafe iOS artifact root: $OUT" >&2
    exit 2
    ;;
esac
if [ ! -d "$OUT" ]; then
  echo "missing iOS artifact root: $OUT" >&2
  exit 2
fi

echo "================= COLLECT: ios-eval-report for run $RUN_ID ================="
rm -rf -- "$OUT/bundle" "$OUT/author-agent-workspace" "$OUT/author-agent-metadata"
rm -rf -- "$OUT/traces/test-plans"
mkdir -p "$OUT/traces/test-plans" "$OUT/logs"

run_trace_ts() {
  (cd "$ROOT" && bun "$@")
}

set -- "$ROOT/eval_harness/utils/telemetry/tracing/cc_transcript.ts" \
  --projects-dir "${CLAUDE_PROJECTS_DIR:-$HOME/.claude/projects}" \
  --out "$OUT/traces/agentic-evaluator.json.tmp" \
  --since-mtime "$TRACE_SINCE" \
  --run-id "$RUN_ID" --source "agentic-evaluator" \
  --session-name "Agentic Evaluator Session"
if [ -n "${BRAINTRUST_API_KEY:-}" ]; then
  set -- "$@" --braintrust
fi
run_trace_ts "$@" >"$OUT/collect-evaluator-trace.log" 2>&1 \
  || echo "  ⚠️  evaluator trace reconstruction failed (see collect-evaluator-trace.log)"
if [ -f "$OUT/traces/agentic-evaluator.json.tmp" ]; then
  mv -f "$OUT/traces/agentic-evaluator.json.tmp" "$OUT/traces/agentic-evaluator.json"
fi

if [ -d "$PLAN_TRACES_ROOT" ]; then
  find "$PLAN_TRACES_ROOT" -mindepth 1 -maxdepth 1 -type d -print 2>/dev/null | while IFS= read -r trace_dir; do
    trace_mtime="$(stat -f %m "$trace_dir" 2>/dev/null || stat -c %Y "$trace_dir" 2>/dev/null || echo 0)"
    if [ -n "$TRACE_SINCE" ] && [ "$trace_mtime" -lt "$TRACE_SINCE" ]; then
      continue
    fi
    cp -R "$trace_dir" "$OUT/traces/test-plans/" 2>/dev/null
  done
fi

if [ -f "$OUT/result.html" ]; then
  mv -f "$OUT/result.html" "$OUT/report.html"
fi

# Author traces can only arrive through stale/downloaded input. They are never
# evaluator-owned evidence and must not survive this producer boundary.
rm -rf -- "$OUT/telemetry/traces" "$OUT/telemetry/openai.jsonl" "$OUT/telemetry/meta.jsonl"

find "$OUT" -mindepth 1 -maxdepth 1 -type f -name '*.log' -exec mv -f {} "$OUT/logs/" \; 2>/dev/null

GIT_SHA="$(cd "$ROOT" && git rev-parse --short HEAD 2>/dev/null || echo unknown)"
RESULT_JSON="$OUT/result.json" RUN_ID="$RUN_ID" GIT_SHA="$GIT_SHA" \
AGENT="${AGENT:-claude-code}" AGENT_MODEL="${AGENT_MODEL:-}" \
AGENT_REASONING_EFFORT="${AGENT_REASONING_EFFORT:-}" \
EVALUATOR_MODEL="${EVALUATOR_MODEL:-}" EVALUATOR_REASONING_EFFORT="${EVALUATOR_REASONING_EFFORT:-}" \
PRD="${PRD:-}" TEST_PLAN="${TEST_PLAN:-}" METRO_MODE="${METRO_MODE:-}" \
EVAL_IOS_APP_MODE="${EVAL_IOS_APP_MODE:-}" EVAL_APP_BUNDLE_ID="${EVAL_APP_BUNDLE_ID:-}" \
"$PY" - "$OUT/manifest.json" <<'PYEOF'
import json
import os
import sys

score = full_points = macro = micro = None
result_path = os.environ.get("RESULT_JSON", "")
if result_path and os.path.isfile(result_path):
    try:
        with open(result_path, encoding="utf-8") as handle:
            result = json.load(handle)
        score = result.get("score")
        full_points = result.get("full_points")
        macro = result.get("macro_avg_pct")
        micro = result.get("micro_pct")
    except (OSError, UnicodeError, json.JSONDecodeError):
        pass

agent = os.environ.get("AGENT") or "claude-code"
if agent == "claude":
    agent = "claude-code"
manifest = {
    "schema_version": 2,
    "artifact_type": "ios-eval-report",
    "run_id": os.environ["RUN_ID"],
    "git_sha": os.environ.get("GIT_SHA"),
    "agent": agent,
    "agent_model": os.environ.get("AGENT_MODEL") or None,
    "agent_reasoning_effort": os.environ.get("AGENT_REASONING_EFFORT") or None,
    "evaluator_model": os.environ.get("EVALUATOR_MODEL") or None,
    "evaluator_reasoning_effort": os.environ.get("EVALUATOR_REASONING_EFFORT") or None,
    "metro_mode": os.environ.get("METRO_MODE") or "dev-build",
    "ios_app_mode": os.environ.get("EVAL_IOS_APP_MODE") or None,
    "eval_app_bundle_id": os.environ.get("EVAL_APP_BUNDLE_ID") or None,
    "test_plan": os.environ.get("TEST_PLAN") or "auto-resolved from dataset/prd_test_plans.json",
    "prd": os.environ.get("PRD") or "dataset/prds/hot_chocolate/prd/mvp.txt",
    "score": score,
    "full_points": full_points,
    "macro_avg_pct": macro,
    "micro_pct": micro,
    "artifacts": {
        "result": "result.json",
        "report": "report.html",
        "evaluator_trace": "traces/agentic-evaluator.json",
        "test_plan_traces": "traces/test-plans/",
        "proxy_anthropic": "telemetry/anthropic.jsonl",
        "otel": "telemetry/otel/",
        "logs": "logs/",
    },
}
with open(sys.argv[1], "w", encoding="utf-8") as handle:
    json.dump(manifest, handle, indent=2)
    handle.write("\n")
PYEOF

echo "  iOS artifact: $OUT"
exit 0
