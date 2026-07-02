#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PYTHONPATH="$ROOT/evaluator/src${PYTHONPATH:+:$PYTHONPATH}" \
  python3 -m agentic_evaluator.skill_eval.cli run-matrix --repo-root "$ROOT" "$@"
