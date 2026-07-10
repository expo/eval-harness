# Expo Skill Eval Cases

Skill-eval case specs describe the initial v0 skill-use scenarios. They are not
runtime app code. The eval flow uses each spec to know:

- which skill IDs should trigger,
- which static context-uptake checks apply.

A case spec is independent of how the app was authored — analyze an artifact
produced from any PRD (a skill-focused PRD or a regular app PRD like Notes or
Hot Chocolate) by pairing it with whichever case spec's expected skills and
checks are relevant to what you're measuring.

V0 reports metrics per skill and overall only. It intentionally does not invent
skill-family aggregation, use screenshots, or run an LLM judge.

## Scenario labels

`--scenario` is a free-form label you attach at analysis time, used only to
group results (e.g. `aggregate_skill_results` treats `skills_off_tools_on` /
`plugin_off_baseline` / `skills_off` as a baseline group when computing an
outcome delta against other runs). It no longer selects which PRD to author
from — pick whatever label fits the comparison you're running, for example:

- `skills_off_tools_on`: a baseline run with the skill/plugin unavailable.
- `skills_available_unmentioned`: skill available, not explicitly named anywhere.
- `skills_available_mentioned`: skill available and explicitly named/relevant.

## Artifact Analysis

Analyze an EAS-authored app bundle:

```bash
PYTHONPATH=. python3 -m eval_harness.skill_evaluator.main analyze-artifacts \
  --case eval_harness/skill_evaluator/skill_cases/core5/expo-ui-lists.json \
  --authored-artifact /path/to/authored-app.tar.gz \
  --scenario skills_available_unmentioned \
  --out-dir skill-eval-report
```
