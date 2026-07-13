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

## Scenarios

Scenario is an authoring-time *enforced configuration*, not just an
analysis-time label: `author-app.sh`'s `SCENARIO` env var controls what
`eval::run_coding_agent` actually makes available to the coding agent, and the
value that ran is recorded into `manifest.json` as ground truth. Analysis
(`--scenario`) prefers that recorded value over whatever was passed in, so a
mismatched flag can't silently corrupt results.

- `skills_unavailable`: skill install and Expo MCP are both skipped entirely
  during authoring. This is the negative control — `expected_skills` is
  forced to `[]` regardless of the case spec, so any skill that still shows
  up in the trace is a genuine false-positive trigger.
- `skills_available_unmentioned`: skill available; the PRD/prompt never names
  it. Tests whether the agent discovers it unprompted.
- `skills_available_mentioned`: skill available and explicitly named via
  `SKILL_MENTION` (appended to the authoring prompt). The easier bar — if
  this doesn't trigger, the skill itself is likely broken, not just
  under-discovered.

## Artifact Analysis

Analyze an EAS-authored app bundle:

```bash
PYTHONPATH=. python3 -m eval_harness.evaluator.skill_invocation.main analyze-artifacts \
  --case eval_harness/evaluator/skill_invocation/skill_cases/core5/expo-ui-lists.json \
  --authored-artifact /path/to/authored-app.tar.gz \
  --scenario skills_available_unmentioned \
  --out-dir skill-eval-report
```
