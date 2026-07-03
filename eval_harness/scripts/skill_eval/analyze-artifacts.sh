#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PYTHONPATH="$ROOT${PYTHONPATH:+:$PYTHONPATH}" \
  python3 -m eval_harness.skill_evaluator.cli analyze-artifacts "$@"
