#!/usr/bin/env bash
# Extract artifact references from EAS workflow logs using the local eas CLI.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
export PYTHONPATH="$ROOT${PYTHONPATH:+:$PYTHONPATH}"

python3 -m eval_harness.skill_evaluator.cli eas-artifacts "$@"
