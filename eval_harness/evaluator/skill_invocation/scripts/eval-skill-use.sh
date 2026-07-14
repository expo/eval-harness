#!/usr/bin/env bash
# Analyze an authored-app artifact for Expo skill-use evidence.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"

SCENARIO="${SCENARIO:-skills_available_unmentioned}"
OUT_DIR="${OUT_DIR:-skill-eval-report}"
AUTHORED_ARTIFACT="${AUTHORED_ARTIFACT:-}"
EVAL_ARTIFACT="${EVAL_ARTIFACT:-}"
# Which skill(s) are expected, and their static_uptake_checks, are now
# resolved automatically from the artifact's authored PRD -- no more manual
# case-spec selection. Override only for local debugging against a custom map.
PRD_SKILLS="${PRD_SKILLS:-}"
CASE_DIR="${CASE_DIR:-}"

if [ -z "$AUTHORED_ARTIFACT" ]; then
  echo "AUTHORED_ARTIFACT is required"
  exit 2
fi

mkdir -p "$OUT_DIR"

args=(
  --authored-artifact "$AUTHORED_ARTIFACT"
  --scenario "$SCENARIO"
  --out-dir "$OUT_DIR"
)

if [ -n "$EVAL_ARTIFACT" ]; then
  args+=(--eval-artifact "$EVAL_ARTIFACT")
fi
if [ -n "$PRD_SKILLS" ]; then
  args+=(--prd-skills "$PRD_SKILLS")
fi
if [ -n "$CASE_DIR" ]; then
  args+=(--case-dir "$CASE_DIR")
fi

PYTHONPATH="$ROOT${PYTHONPATH:+:$PYTHONPATH}" \
  python3 -m eval_harness.evaluator.skill_invocation.main analyze-artifacts "${args[@]}"
find "$OUT_DIR" -maxdepth 3 -type f -print | sort
