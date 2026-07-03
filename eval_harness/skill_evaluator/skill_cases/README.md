# Expo Skill Eval Cases

Skill-eval case specs describe the initial v0 skill-use scenarios. They are not
runtime app code. The authoring/eval flow uses each spec to know:

- which skill IDs should trigger,
- which scenario-specific PRD file to author from,
- which static context-uptake checks apply.

V0 reports metrics per skill and overall only. It intentionally does not invent
skill-family aggregation, use screenshots, or run an LLM judge.

## Scenarios

- `skills_off_tools_on`: requested isolation baseline. Today this is recorded as
  `plugin_off_baseline` unless a MCP-only Expo install path is configured.
- `skills_available_unmentioned`: Expo plugin available; PRD does not explicitly
  name the skill.
- `skills_available_mentioned`: Expo plugin available; PRD explicitly points at
  the skill or package.

## Artifact Analysis

Analyze an EAS-authored app bundle:

```bash
PYTHONPATH=. python3 -m eval_harness.skill_evaluator.main analyze-artifacts \
  --case eval_harness/skill_evaluator/skill_cases/core5/expo-ui-lists.json \
  --authored-artifact /path/to/authored-app.tar.gz \
  --scenario skills_available_unmentioned \
  --out-dir skill-eval-report
```
