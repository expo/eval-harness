#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: eval_harness/scripts/skill_eval/run-scenario.sh --case PATH --scenario SCENARIO [--agent claude-code|codex] [--agent-model MODEL] [--script PATH]

Materializes the PRD variant for one skill-eval scenario, exports the
corresponding harness environment, then runs the requested script. The default
script is eval_harness/scripts/author_app.sh.
EOF
}

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CASE_SPEC=""
SCENARIO=""
AGENT_VALUE="claude-code"
AGENT_MODEL_VALUE=""
RUN_SCRIPT="$ROOT/eval_harness/scripts/author_app.sh"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --case)
      CASE_SPEC="${2:-}"; shift 2 ;;
    --scenario)
      SCENARIO="${2:-}"; shift 2 ;;
    --agent)
      AGENT_VALUE="${2:-}"; shift 2 ;;
    --agent-model)
      AGENT_MODEL_VALUE="${2:-}"; shift 2 ;;
    --script)
      RUN_SCRIPT="${2:-}"; shift 2 ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2 ;;
  esac
done

if [ -z "$CASE_SPEC" ] || [ -z "$SCENARIO" ]; then
  usage >&2
  exit 2
fi

[ "$AGENT_VALUE" = "claude" ] && AGENT_VALUE="claude-code"

ENV_FILE="$ROOT/eval-out/skill-eval-scenario-env-${SCENARIO}.sh"
mkdir -p "$(dirname "$ENV_FILE")"

PYTHONPATH="$ROOT${PYTHONPATH:+:$PYTHONPATH}" \
python3 - "$ROOT" "$CASE_SPEC" "$SCENARIO" "$AGENT_VALUE" "$AGENT_MODEL_VALUE" "$ENV_FILE" <<'PY'
from __future__ import annotations

import shlex
import sys
from pathlib import Path

from eval_harness.skill_evaluator.manifest import load_case_spec
from eval_harness.skill_evaluator.runner import plan_case_runs

repo_root = Path(sys.argv[1]).resolve()
case_spec = Path(sys.argv[2])
scenario = sys.argv[3]
agent = sys.argv[4]
agent_model = sys.argv[5]
env_file = Path(sys.argv[6])

case = load_case_spec(case_spec)
runs = plan_case_runs(case, repo_root, agent=agent)
try:
    planned = next(run for run in runs if run.scenario == scenario)
except StopIteration as exc:
    valid = ", ".join(run.scenario for run in runs)
    raise SystemExit(f"Scenario {scenario!r} is not declared by {case.id}; valid scenarios: {valid}") from exc

env = dict(planned.env)
if agent_model:
    env["AGENT_MODEL"] = agent_model

with env_file.open("w", encoding="utf-8") as fh:
    for key, value in env.items():
        fh.write(f"export {key}={shlex.quote(value)}\n")

print(env_file)
PY

# shellcheck source=/dev/null
source "$ENV_FILE"

echo "Running skill-eval scenario: case=$SKILL_EVAL_CASE_ID scenario=$SKILL_EVAL_SCENARIO agent=$AGENT"
case "$RUN_SCRIPT" in
  /*) ;;
  *) RUN_SCRIPT="$ROOT/$RUN_SCRIPT" ;;
esac
bash "$RUN_SCRIPT"
