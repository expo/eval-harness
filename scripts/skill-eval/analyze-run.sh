#!/usr/bin/env bash
# Thin wrapper around the Python skill-eval analyzer.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export PYTHONPATH="$ROOT/evaluator/src${PYTHONPATH:+:$PYTHONPATH}"

python3 -m agentic_evaluator.skill_eval.cli analyze-run "$@"

