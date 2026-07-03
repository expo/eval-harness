# Expo Skill Eval Cases

Skill-eval case specs are the v1 ground truth for measuring Expo skill value.
They are not runtime app code. The runner/analyzer uses each spec to know:

- which skill IDs should trigger,
- which PRD variants to run,
- which scenarios to compare,
- which static context-uptake checks apply,
- which evaluator test plan and screenshots are relevant.

V1 reports metrics per skill and overall only. It intentionally does not invent
skill-family aggregation.

## Scenarios

- `skills_off_tools_on`: requested isolation baseline. Today this is recorded as
  `plugin_off_baseline` unless a MCP-only Expo install path is configured.
- `skills_available_unmentioned`: Expo plugin available; PRD does not explicitly
  name the skill.
- `skills_available_mentioned`: Expo plugin available; PRD explicitly points at
  the skill or package.

## Offline Analysis

Analyze one generated app bundle:

```bash
PYTHONPATH=. python3 -m eval_harness.skill_evaluator.cli analyze-run \
  --case eval_harness/skill_evaluator/skill_cases/core5/expo-ui-lists.json \
  --trace eval-out/<run>/bundle/telemetry/traces/claude-code-authoring.json \
  --app eval-out/<run>/bundle/app \
  --result eval-out/<run>/bundle/eval/result.json \
  --build-success \
  --scenario skills_available_unmentioned \
  --out eval-out/<run>/skill-eval.json \
  --html eval-out/<run>/skill-eval.html
```

Extract artifact references from EAS workflow logs:

```bash
PYTHONPATH=. python3 -m eval_harness.skill_evaluator.cli eas-artifacts \
  --workflow eval-e2e.yml \
  --limit 10 \
  --out /tmp/eas-artifacts.json
```
