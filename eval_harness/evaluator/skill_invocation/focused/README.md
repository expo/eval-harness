# Focused skill evaluation

A small companion to the existing PRD app evaluator. It runs real Claude Code tasks
against the unchanged local plugin in an isolated fixture, then reports routing and
source evidence separately. JSON cases reuse this repository's dataset conventions.

## Validate without a model

From the harness root:

```sh
bun eval_harness/evaluator/skill_invocation/focused/main.ts validate --plugin /path/to/skills/plugins/expo
bun run test:all
```

Case fields: `id`, `family`, `split`, `fixture`, `prompt`, `expect`, `before_edit`,
`unchanged`, `review`, optional `read_only` and `checks`. Required/optional/forbidden skill lists must be disjoint. Unlisted
skills default to `observe`; `forbid` enables closed-set scoring. `before_edit` requires
all required bodies before the first edit request, a conservative deadline suitable
for these small tasks. Read-only cases omit this deadline by setting it to false.

The CLI rejects unknown names, duplicate IDs, missing fixture files and task families
spread across splits. Authoring only receives the prompt and fixture, never labels or
review assertions. Case files and manifests remain outside the working directory.

## Run in CI

In the Expo skills repository, submit `.eas/workflows/skill-eval-focused.yml`. It uses
that project's `production` credentials and defaults to four `signal` cases, with and
without the candidate Expo catalog, at three trials per condition. The optional catalog-change
experiment compares main against the candidate with the same pinned runtime and fixtures. The `case_id=all` input runs a complete selected split. Increase
`repetitions` explicitly; counts are descriptive, not reliability guarantees.

The underlying CI-only command (normally called by the workflow):

```sh
bun eval_harness/evaluator/skill_invocation/focused/main.ts run \
  --plugin /path/to/plugin --out /path/to/report --model 'sonnet[1m]' \
  --case signal --split development --repetitions 3 --skill-mode both \
  --judge-model 'sonnet[1m]'
```

`run` requires `CI` and `SKILL_EVAL_REMOTE=1`. Authentication comes from the CI environment.
Every attempt gets a fresh workspace, plugin copy and Claude config directory. The source plugin is
frozen once, tool/MCP/hook settings are explicit, and attempts are sequential. No user
configuration or credentials are copied into artifacts. Parent catalog visibility is
recorded as unverified: installation alone does not prove descriptions were exposed.
Runtime registration is checked separately: with-Expo runs must advertise every intended
Expo skill; without-Expo runs must advertise none. Missing init evidence or an incomplete
catalog invalidates the comparison, rather than becoming an apparent tie.

## Interpret results

- `passed`: the entire source skill body appeared in parent-agent user/tool input,
  before the edit deadline when required.
- `not_selected`: a completed observable run contains no request or body for a required skill.
- `load_failed`: the relevant tool returned an error and no successful delivery followed.
- `loaded_late`: the body arrived after an edit request.
- `forbidden_load`: a forbidden body was delivered.
- `unobservable`: a request lacks body evidence, the stream is incomplete/invalid,
  or an unsupported tool prevents establishing the necessary ordering.

The parser handles both separate Skill body messages and line-numbered Read results.
It ignores assistant claims and child-agent messages. An acknowledgement such as
"Launching skill" never proves delivery. The full-body detector is intentionally
conservative; transformed or partially read skill text can yield `unobservable`.
Raw JSONL makes that limitation inspectable without another model call.
Each report also retains the frozen plugin under `catalog/`, so hashes can be traced
back to the exact source files even when a skill was never loaded.

The HTML report shows routing counts, each expectation, trace-line links, source checks,
review assertions, timing and final responses. Manifests record runtime, requested model,
fixture/case contents, tool policy and plugin hash; metrics also record the observed
model and token usage. Timeouts, nonzero exits and incomplete streams are infrastructure
errors, never ordinary misses. Behavioral failures are advisory; infrastructure errors
fail the CI job. Artifacts contain raw agent output; keep them in the private CI artifact
store and inspect before sharing.

## Compare without rerunning agents

```sh
bun eval_harness/evaluator/skill_invocation/focused/main.ts compare \
  --baseline /path/to/main/metrics.json --candidate /path/to/pr/metrics.json \
  --out /path/to/comparison
```

Changed task, fixture, runtime, model, tool settings or limits make a comparison
inconclusive. Skill content may differ. Unequal attempt counts and infrastructure or
observation gaps are inconclusive. Routing changes are reported separately from failed
source checks; pending reviews cannot become task-success claims. This version
has no automatic description rewriting. The optional signing-only judge is described below. The older
`skills_unavailable` scenario disables both skills and MCP and measures that combined
intervention, not an isolated skill effect.

## Scored coverage and exploratory cases

Five cases have automated outcome grading: the four `signal` cases and `fetch-correct`.
The other fourteen are exploratory routing/source probes. Reports label them `exploratory`;
a clean run remains pending until its review assertions are evaluated. `case_id=all`
includes these probes and is not a fully scored benchmark. The CLI has no manual-review
import yet; use the default signal suite for automated outcome comparisons.

## Outcome pilot

`--case pilot` selects native-form-advice, signing-diagnosis, fetch-error, and
fetch-correct. `--skill-mode both` runs with and without the Expo catalog in fresh
attempts, alternating condition order across repetitions. Three repetitions means
24 attempts. Other runtime-provided skills and the tool profile stay the same;
this measures Expo catalog presence, not the marginal effect of one skill.
The absence control requires an init skill list and rejects exposed Expo names or
bodies. Routing is not applicable in the absence control, rather than a failed
required-load score. Catalog presence is an experimental variable; the shared
condition hash covers the task, fixture, runtime/model, tool profile, and verifier.

`checks: ["http-response-contract"]` runs a trusted verifier after authoring. It
imports the output helper in a separate five-second process without CI API-key
environment variables. This process is not a security sandbox. It checks error
responses before JSON parsing, successful parsed data, and network rejection.
Tests include a known-correct fixture and incorrect mutations/no-op repairs.
Read-only cases use `read_only: true` to check the entire fixture tree. Advice
assertions remain pending; syntax and preserved files alone never imply task success.

`summary.json` and `report.html` lead with evaluated task outcomes, pending and
unavailable counts, routing, median time, and model-reported cost (excluding EAS).
`metrics.json` retains every attempt and trace-backed detail. Behavioral failures
are advisory; invalid absence controls or unavailable HTTP verification fail the
CI invocation while preserving artifacts. Optional skills with no delivery are
reported as `not_loaded`, which is neutral.

The generic HTTP family is now development data because it is used in the pilot.
Its optional routing labels do not require skill use to solve an ordinary code fix.
The remaining holdout contains negative families only; it is not yet a balanced
release benchmark. These file-edit tasks intentionally retain the restricted
Read/Glob/Grep/Skill/Write/Edit profile. They do not test agent-run shell checks,
dependency installation, or native execution. Those require a later pinned runnable
fixture and tool profile, held constant across conditions.

## Signal experiment

`--case signal --skill-mode both --judge-model 'sonnet[1m]'` runs signing diagnosis,
Expo config repair, the already-correct config control, and HTTP repair (24 author attempts
at three trials). `pilot` still selects the original four cases for replay.

The config verifier resolves `app.config.js` through pinned `@expo/config` in a bounded
Node child without CI API-key environment variables. It tests unset, empty, and supplied
API URL values and preserves every fixture-owned config key except the requested changes.
Known-good, no-op, shallow-merge, missing-fallback and hardcoded-environment variants test
the verifier. This is a config-loader test, not a native build or UI runtime test. The
fixture has no installed Expo app runtime. Verifier Node and dependency-lock identity are
included in the comparison condition. Authored config execution is not security sandboxing.

Signing review uses three explicit criteria grounded in the synthetic diagnostic: cause,
corrective action, and no invented execution. One fixed Claude judge receives only the
task, rubric, original diagnostic and answer, with no tools, skills, condition labels or routing traces.
The rubric is the signing case's `review` list in `dataset/skill-cases.json`. Before
authoring, the runner freezes the case prompt, rubric and fixture diagnostic in the
manifest. Both calibration and judging use that frozen context, never the authored log
or a second hardcoded diagnostic. Missing or inconsistent contexts make grading unavailable.
Before grading, it must correctly classify three hand-authored calibration answers (correct,
generic wrong advice, and fabricated execution). Calibration failure makes advice grading unavailable
and fails the invocation. This tiny gate is not expert validation; all model judgments are
provisional. Other advice tasks still require review. Invalid/missing judgments are unavailable and their error reasons appear in the summary;
semantic unknown judgments stay pending. Neither is a pass. Quoted evidence must match the answer exactly or after removing paired Markdown bold markers and collapsing whitespace; changed wording is rejected. No candidate
skill text is used as ground truth. Judge input, raw output, model identity, per-answer cost
and calibration results are retained. Calibration cost lives in `judge-calibration.json`;
per-answer judge costs are in `summary.json`, separate from author cost.

`findings.json` and the HTML report explain graded coverage, observed with/without counts,
failed criteria, delivered/missing required skills and suggested next investigations. They
never turn a small sample into a causal claim or automatically rewrite a skill. Do not tune
against these cases and present them as unseen validation. Current cases are synthetic
and the restricted author tool profile remains a controlled file-edit experiment.

## Replay saved judge output without model calls

After materializing a focused artifact, revalidate its saved responses into a new directory:

```sh
bun eval_harness/evaluator/skill_invocation/focused/main.ts replay-judgments \
  --report /path/to/focused-skill-eval --out /path/to/replayed-report
```

This reads calibration, answers, raw judge output and manifests; it does not execute authored
code or run a model. Calibration, input-answer correspondence and original condition hashes
must validate. New artifacts also verify the frozen task, diagnostic and rubric against
the saved judge input. Original artifacts without that context remain replayable with
the original rubric. The source artifact is preserved. `replay.json` records its metrics hash,
recovered attempts and quote-validation version. Recovered judge model/cost metadata restores
matched comparisons. The derived report does not change the original workflow's error status.

PR summaries use one row per task with both conditions, explicit ungraded counts, and
collapsible author time/cost and skill-delivery details. Judge failures print their case,
condition, trial and error in CI logs instead of leaving only an unexplained exit code.
