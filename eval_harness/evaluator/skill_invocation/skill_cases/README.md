# Expo Skill Eval Cases

Case specs are not runtime app code. Each one is scoped to a single skill and
declares:

- `id`: the skill id this case covers (`load_case_specs_by_skill` indexes
  every case spec in this directory by its `id`; one file per skill),
- `static_uptake_checks`: the static source-code checks that verify the
  resulting app actually followed that skill's guidance.

Case specs answer "how do I verify skill X was used correctly" — they say
nothing about which skill(s) are relevant to a given app. That's a separate,
PRD-level question answered by `dataset/prd_skills.json` (app name -> expected
skill ids). `analyze_artifacts` reads the `prd` recorded in the authored
artifact's `manifest.json`, looks up that app's expected skills there, and
only then pulls in each skill's case spec for its `static_uptake_checks` —
there is no manual case-spec selection.

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
  forced to `[]` regardless of the app's ground truth, so any skill that
  still shows up in the trace is a genuine false-positive trigger.
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
  --authored-artifact /path/to/authored-app.tar.gz \
  --scenario skills_available_unmentioned \
  --out-dir skill-eval-report
```

`--prd-skills` and `--case-dir` default to `dataset/prd_skills.json` and this
directory respectively; pass them explicitly only to point at a different
ground-truth map or case set for local debugging.
