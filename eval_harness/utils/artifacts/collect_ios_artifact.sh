#!/usr/bin/env bash
# Finalize the canonical ios-eval-report directory for one evaluator run.
#
# Positional args: repository_root run_id ios_artifact_root
# Trace reconstruction is best-effort so failed evaluations keep diagnostics.
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: $0 <repository_root> <run_id> <ios_artifact_root>" >&2
  exit 2
fi

ROOT="$1"
RUN_ID="$2"
OUT="$3"
TRACE_SINCE="${TRACE_SINCE_MTIME:-${EVAL_PHASE_START_MTIME:-${RUN_START_MTIME:-0}}}"

canonical_existing_dir() { (cd "$1" && pwd -P); }

ROOT="$(canonical_existing_dir "$ROOT")"
OUT="$(canonical_existing_dir "$OUT")"
if [ "$OUT" != "$ROOT/ios-eval-report" ]; then
  echo "iOS artifact root must be the canonical repository child" >&2
  exit 2
fi
if [ ! -d "$OUT" ]; then
  echo "missing iOS artifact root: $OUT" >&2
  exit 2
fi
PY="$(command -v python3 || command -v python)"
PLAN_TRACES_ROOT="${EVALUATOR_TRACES_ROOT:-$ROOT/traces}"

echo "================= COLLECT: ios-eval-report for run $RUN_ID ================="
rm -rf -- "$OUT/bundle" "$OUT/author-agent-workspace" "$OUT/author-agent-metadata"
rm -rf -- "$OUT/traces/test-plans"
mkdir -p "$OUT/traces/test-plans" "$OUT/logs"
rm -f -- "$OUT/traces/agentic-evaluator.json" "$OUT/traces/agentic-evaluator.json.tmp"

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

for log_file in "$OUT"/*.log; do
  [ -f "$log_file" ] || continue
  mv -f "$log_file" "$OUT/logs/"
done
if [ -f "$OUT/d-ios-identity-adjustments.json" ]; then
  mv -f "$OUT/d-ios-identity-adjustments.json" "$OUT/logs/d-ios-identity-adjustments.json"
fi

# The EXIT trap reaches this collector even when evaluator setup/build fails
# before main.py can write its normal result. A canonical producer artifact
# must never advertise authoritative files that do not exist.
if [ ! -f "$OUT/result.json" ] || [ ! -f "$OUT/report.html" ]; then
  FAILURE_STAGE="${IOS_FAILURE_STAGE:-preflight}"
  FAILURE_REASON="${IOS_FAILURE_REASON:-}"
  if [ -z "$FAILURE_REASON" ]; then
    if [ -n "${IOS_EVALUATOR_EXIT_STATUS:-}" ]; then
      FAILURE_REASON="iOS evaluator exited before producing result.json (exit status ${IOS_EVALUATOR_EXIT_STATUS})"
    else
      FAILURE_REASON="iOS evaluator exited before producing result.json"
    fi
  fi
  "$PY" "$ROOT/eval_harness/utils/artifacts/create_diagnostic_artifact.py" \
    --kind ios \
    --author-artifact-root "${AUTHORED_ARTIFACT_ROOT:-$ROOT}" \
    --out-dir "$OUT" \
    --stage "$FAILURE_STAGE" \
    --reason "$FAILURE_REASON" \
    --run-id "$RUN_ID" \
    --evaluator-model "${EVALUATOR_MODEL:-}" \
    --evaluator-reasoning-effort "${EVALUATOR_REASONING_EFFORT:-}" \
    --preserve-existing
fi

GIT_SHA="$(cd "$ROOT" && git rev-parse --short HEAD 2>/dev/null || echo unknown)"
RESULT_JSON="$OUT/result.json" RUN_ID="$RUN_ID" GIT_SHA="$GIT_SHA" \
AGENT="${AGENT:-claude-code}" AGENT_MODEL="${AGENT_MODEL:-}" \
AGENT_REASONING_EFFORT="${AGENT_REASONING_EFFORT:-}" \
EVALUATOR_MODEL="${EVALUATOR_MODEL:-}" EVALUATOR_REASONING_EFFORT="${EVALUATOR_REASONING_EFFORT:-}" \
PRD="${PRD:-}" TEST_PLAN="${TEST_PLAN:-}" METRO_MODE="${METRO_MODE:-}" \
EVAL_IOS_APP_MODE="${EVAL_IOS_APP_MODE:-}" EVAL_APP_BUNDLE_ID="${EVAL_APP_BUNDLE_ID:-}" \
AUTHOR_MANIFEST="${AUTHOR_MANIFEST:-}" \
IOS_DEPENDENCY_INSTALL_STATUS="${IOS_DEPENDENCY_INSTALL_STATUS:-not_run}" \
IOS_NATIVE_BUILD_STATUS="${IOS_NATIVE_BUILD_STATUS:-not_run}" \
IOS_NATIVE_BUILD_LOG="${IOS_NATIVE_BUILD_LOG:-}" \
IOS_APP_LAUNCH_STATUS="${IOS_APP_LAUNCH_STATUS:-not_run}" \
IOS_EVALUATION_STATUS="${IOS_EVALUATION_STATUS:-not_run}" \
IOS_FAILURE_STAGE="${IOS_FAILURE_STAGE:-}" IOS_FAILURE_REASON="${IOS_FAILURE_REASON:-}" \
IOS_IDENTITY_ADJUSTMENTS_LOG="${IOS_IDENTITY_ADJUSTMENTS_LOG:-}" \
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
allowed_statuses = {"passed", "warning", "failed", "not_run"}


failure_stage = os.environ.get("IOS_FAILURE_STAGE")
failure_reason = os.environ.get("IOS_FAILURE_REASON") or None


def stage(name, status, log):
    normalized_status = status if status in allowed_statuses else "not_run"
    return {
        "status": normalized_status,
        "detail": failure_reason
        if normalized_status == "failed" and name == failure_stage
        else None,
        "log": log if normalized_status != "not_run" else None,
    }


def preserved_author_stage(name):
    path = os.environ.get("AUTHOR_MANIFEST")
    if not path:
        return None
    try:
        with open(path, encoding="utf-8") as handle:
            candidate = json.load(handle).get("build_health", {}).get(name)
    except (OSError, UnicodeError, json.JSONDecodeError, AttributeError):
        return None
    if not isinstance(candidate, dict):
        return None
    status = candidate.get("status")
    detail = candidate.get("detail")
    log = candidate.get("log")
    if status not in allowed_statuses or not isinstance(detail, (str, type(None))) or not isinstance(log, (str, type(None))):
        return None
    return {"status": status, "detail": detail, "log": log}


build_health = {
    "dependency_install": stage(
        "dependency_install",
        os.environ.get("IOS_DEPENDENCY_INSTALL_STATUS"), "logs/s5-npm.log"
    ),
    "native_build": stage(
        "native_build",
        os.environ.get("IOS_NATIVE_BUILD_STATUS"),
        os.environ.get("IOS_NATIVE_BUILD_LOG") or None,
    ),
    "app_launch": stage(
        "app_launch", os.environ.get("IOS_APP_LAUNCH_STATUS"), "logs/s6b-open.log"
    ),
    "evaluation": stage(
        "evaluation", os.environ.get("IOS_EVALUATION_STATUS"), "logs/s7-eval.log"
    ),
}
for author_stage in ("app_authored", "expo_export"):
    preserved = preserved_author_stage(author_stage)
    if preserved is not None:
        build_health[author_stage] = preserved

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
    "build_health": build_health,
    "artifacts": {
        "result": "result.json",
        "report": "report.html",
        "evaluator_trace": "traces/agentic-evaluator.json",
        "test_plan_traces": "traces/test-plans/",
        "proxy_anthropic": "telemetry/anthropic.jsonl",
        "otel": "telemetry/otel/",
        "logs": "logs/",
        "identity_adjustments": "logs/d-ios-identity-adjustments.json"
        if os.environ.get("IOS_IDENTITY_ADJUSTMENTS_LOG")
        else None,
    },
}
with open(sys.argv[1], "w", encoding="utf-8") as handle:
    json.dump(manifest, handle, indent=2)
    handle.write("\n")
PYEOF

echo "  iOS artifact: $OUT"
exit 0
