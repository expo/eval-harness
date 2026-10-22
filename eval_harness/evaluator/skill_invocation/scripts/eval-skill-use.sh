#!/usr/bin/env bash
# Analyze an authored-app artifact for Expo skill-use evidence.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd -P)"

SCENARIO="${SCENARIO:-skills_available_unmentioned}"
OUT_DIR="${OUT_DIR:-skill-eval-report}"
AUTHORED_ARTIFACT="${AUTHORED_ARTIFACT:-}"
EVAL_ARTIFACT="${EVAL_ARTIFACT:-}"
# Which skill(s) are expected is resolved automatically from the artifact's
# authored PRD; each expected skill's uptake checks are resolved from
# uptake_checks/skill_map.json. Override only for local debugging.
PRD_SKILLS="${PRD_SKILLS:-$ROOT/dataset/prd_skills.json}"
CHECKS_DIR="${CHECKS_DIR:-}"

if [ -z "$AUTHORED_ARTIFACT" ]; then
  echo "AUTHORED_ARTIFACT is required"
  exit 2
fi

if [[ "$OUT_DIR" = /* ]]; then
  out_candidate="$OUT_DIR"
else
  out_candidate="$ROOT/$OUT_DIR"
fi
out_parent="$(cd "$(dirname "$out_candidate")" && pwd -P)" || {
  echo "OUT_DIR parent does not exist: $OUT_DIR" >&2
  exit 2
}
out_target="$out_parent/${out_candidate##*/}"
expected_out="$ROOT/skill-eval-report"
if [ "$out_target" != "$expected_out" ]; then
  echo "OUT_DIR must resolve to $expected_out" >&2
  exit 2
fi
if [ -L "$out_target" ]; then
  echo "OUT_DIR must not be a symbolic link: $out_target" >&2
  exit 2
fi
OUT_DIR="$out_target"

rm -rf -- "$OUT_DIR"
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
if [ -n "$CHECKS_DIR" ]; then
  args+=(--checks-dir "$CHECKS_DIR")
fi

bun "$ROOT/node_modules/.bin/skill-analyzer" \
  analyze-artifacts "${args[@]}"
find "$OUT_DIR" -maxdepth 3 -type f -print | sort
