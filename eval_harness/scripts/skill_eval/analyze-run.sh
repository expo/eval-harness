#!/usr/bin/env bash
# Thin wrapper around the Python skill-eval analyzer.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
export PYTHONPATH="$ROOT${PYTHONPATH:+:$PYTHONPATH}"

python3 -m eval_harness.skill_evaluator.cli analyze-run "$@"
