#!/usr/bin/env bash
# Extract artifact references from EAS workflow logs using the local eas CLI.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export PYTHONPATH="$ROOT/evaluator/src${PYTHONPATH:+:$PYTHONPATH}"

python3 -m agentic_evaluator.skill_eval.cli eas-artifacts "$@"

