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
`unchanged`, `review`. Required/optional/forbidden skill lists must be disjoint. Unlisted
skills default to `observe`; `forbid` enables closed-set scoring. `before_edit` requires
all required bodies before the first edit request, a conservative deadline suitable
for these small tasks. Read-only cases omit this deadline by setting it to false.

The CLI rejects unknown names, duplicate IDs, missing fixture files and task families
spread across splits. Authoring only receives the prompt and fixture, never labels or
review assertions. Case files and manifests remain outside the working directory.

## Run in CI

In the Expo skills repository, submit `.eas/workflows/skill-eval-focused.yml`. It uses
that project's `production` credentials and runs main and the candidate with the same
pinned Claude CLI, model selection, fixtures and tools. Start with its default one-case
smoke comparison. The `case_id=all` input runs a complete selected split. Increase
`repetitions` explicitly; counts are descriptive, not reliability guarantees.

The underlying CI-only command (normally called by the workflow):

```sh
bun eval_harness/evaluator/skill_invocation/focused/main.ts run \
  --plugin /path/to/plugin --out /path/to/report --model 'sonnet[1m]' \
  --case native-form-advice --split development --repetitions 3
```

`run` requires `CI` and `SKILL_EVAL_REMOTE=1`. Authentication comes from the CI environment.
Every attempt gets a fresh workspace, plugin copy and Claude config directory. The source plugin is
frozen once, tool/MCP/hook settings are explicit, and attempts are sequential. No user
configuration or credentials are copied into artifacts. Parent catalog visibility is
recorded as unverified: installation alone does not prove descriptions were exposed.

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
source checks; pending reviews cannot become task-success claims. This first version
has no LLM judge, automatic description rewriting or no-skill ablation. The older
`skills_unavailable` scenario disables both skills and MCP and measures that combined
intervention, not an isolated skill effect.
