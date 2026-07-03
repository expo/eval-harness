#!/usr/bin/env bash
# Analyze an authored-app artifact for Expo skill-use evidence.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

CASE_SPEC="${CASE_SPEC:-eval_harness/skill_evaluator/skill_cases/core5/native-data-fetching.json}"
SCENARIO="${SCENARIO:-skills_available_unmentioned}"
OUT_DIR="${OUT_DIR:-skill-eval-report}"
AUTHORED_ARTIFACT="${AUTHORED_ARTIFACT:-}"
EVAL_ARTIFACT="${EVAL_ARTIFACT:-}"

if [ -z "$AUTHORED_ARTIFACT" ]; then
  echo "AUTHORED_ARTIFACT is required"
  exit 2
fi

mkdir -p "$OUT_DIR"

args=(
  --case "$CASE_SPEC"
  --authored-artifact "$AUTHORED_ARTIFACT"
  --scenario "$SCENARIO"
  --out-dir "$OUT_DIR"
)

if [ -n "$EVAL_ARTIFACT" ]; then
  args+=(--eval-artifact "$EVAL_ARTIFACT")
fi

PYTHONPATH="$ROOT${PYTHONPATH:+:$PYTHONPATH}" \
  python3 -m eval_harness.skill_evaluator.main analyze-artifacts "${args[@]}"
find "$OUT_DIR" -maxdepth 3 -type f -print | sort
