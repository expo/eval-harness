# Refined Single-Run Eval Outputs

**Date:** 2026-08-10  
**Branch:** `codex/refine-eval-outputs`  
**Status:** Approved visual direction; technical design awaiting review

## Goal

Make one `eval-e2e.yml` dispatch produce one clear, durable report for its
single author harness/model × PRD × prompt × skill-scenario cell. The report
must combine authoring provenance, skill invocation and uptake, build health,
iOS behavior, screenshots, usage, and diagnostics without re-archiving the
authored workspace.

This change also adds the realistic middle-ground prompt requested for the
experiment and makes author/evaluator model and reasoning choices explicit.

Experiment-wide comparison is deliberately separate. Comparing Claude Code,
Codex, and Muse Code will require three or more E2E dispatches and a later
aggregator over their `summary.json` files. This design makes that future
aggregator straightforward but does not implement it in the first release.

## Accepted Product Decisions

- One E2E dispatch remains one evaluation cell and produces one consolidated
  single-run report.
- The consolidated report is the collaborator-facing end result. Author, skill,
  and iOS artifacts remain as structured intermediate/diagnostic inputs.
- The report starts with compact outcome cards, not an AI-written prose verdict.
- Build and evaluation stages appear as a green/yellow/red/grey ladder backed by
  structured stage outcomes.
- iOS failures show screenshot evidence first. Representative passing-step
  screenshots follow.
- Useful trace data such as token usage, duration, tool calls, skill reads,
  model/effort, CLI versions, and warnings appears in secondary run details.
- We will not label a lint check as part of build health because the harness does
  not currently run one.
- The first live validation cell is Notes × Muse Code × realistic prompt ×
  skills available/unmentioned, with both skill and iOS evaluation enabled.

## Prompt Variant

Register a new `realistic` prompt between `baseline` and `minimal`:

```text
Build me an Expo app based on the product brief below.
Include all the described features, and make the main flows intuitive and easy to discover.
Pay attention to the empty, loading, error, and confirmation states a real user would encounter.
It should feel like a polished iPhone product I could genuinely try, not a rough prototype.
```

The PRD remains appended by the existing prompt assembler, so the variant stays
generic and product-oriented rather than duplicating app-specific requirements.
Add it to `dataset/prompts.json` and document it in `dataset/prompts/README.md`.

## Model and Reasoning Configuration

### Workflow inputs

Retain the existing optional `agent_model` input and current defaults:

- Claude Code: `sonnet`
- Codex: `gpt-5-mini`
- Muse Code: `muse-spark-1.2`

Add:

- `agent_reasoning_effort`: choice `low | medium | high`, default `high`
- `evaluator_model`: string, default `claude-opus-4-8`
- `evaluator_reasoning_effort`: choice `low | medium | high`, default `high`

The first comparative experiment will override `agent_model` with:

- Claude Code: `claude-opus-5`
- Codex: `gpt-5.6-sol`
- Muse Code: `muse-spark-1.2`

The evaluator remains fixed at `claude-opus-4-8` so author-model comparisons do
not also vary the judge.

### Harness mapping

- Claude Code: `claude ... --model "$AGENT_MODEL" --effort "$AGENT_REASONING_EFFORT"`
- Codex: write `model_reasoning_effort = "$AGENT_REASONING_EFFORT"` alongside
  `model` in the run-specific `CODEX_HOME/config.toml`
- Muse Code: `muse exec ... --model "$AGENT_MODEL" --reasoning-effort "$AGENT_REASONING_EFFORT"`
- iOS evaluator: pass `model=EVALUATOR_MODEL`,
  `effort=EVALUATOR_REASONING_EFFORT`, and adaptive thinking to
  `ClaudeAgentOptions`

Record resolved author model/effort and evaluator model/effort in `author.env`,
the bundle manifest, normalized summaries, and the HTML report. Unknown effort
values fail before an expensive run rather than falling through to a CLI.

## E2E Job Topology

```text
author_app
   ├── eval_skill ──┐
   └── eval_ios ────┼── report
                    └── eval-report artifact
```

`eval_skill` and `eval_ios` continue in parallel. The new Linux `report` job
uses EAS `after`, not `needs`, so it waits for both terminal states and can emit
a partial postmortem when an evaluator fails. The evaluator jobs should likewise
use failure-tolerant sequencing from `author_app` while retaining their existing
`if` inputs and `always()` packaging steps, ensuring intended jobs upload a
diagnostic artifact even when evaluation fails.

The report job conditionally downloads the iOS and skill artifacts according to
`run_eval_ios` and `run_eval_skill`, then invokes a new Bun CLI under
`eval_harness/evaluator/reporting/`. Missing result files are data: the report
marks the relevant sections `not_run`, `partial`, or `failed` and points to the
available diagnostic stage. A missing optional evaluator must not crash report
generation.

## Artifact Contracts

### Intermediate skill artifact

Keep the replay-friendly outputs:

```text
skill-eval-report/
  metrics.json
  report.html
```

Artifact extraction moves to a temporary scratch root outside
`skill-eval-report/`. Remove the scratch root after analysis. The final tar must
not contain `unpacked/authored`, the authored source tree, or the iOS bundle.

### Intermediate iOS artifact

Keep the current diagnostic bundle, but extend its structured data:

```text
eval-out/<run-id>/bundle/
  manifest.json
  pipeline.jsonl
  eval/
    result.json
    report.html
    traces/
      <plan-run>/
        summary.json
        conversation.jsonl
        screenshots/
```

### Final collaborator-facing artifact

Upload one artifact named `eval-report`:

```text
eval-report/
  report.html
  summary.json
  data/
    author-manifest.json
    skill-metrics.json
    ios-result.json
    pipeline.json
  evidence/
    screenshots/
      <stable-relative-name>.png
```

Only copy files that the report directly consumes. Do not include an authored
app tree, raw provider credentials, Muse settings/data, duplicated transport
archives, or the original intermediate tars. All links in `report.html` are
relative so the extracted artifact works offline.

## Consolidated Summary Schema

`summary.json` is the stable machine-readable result for one cell:

```json
{
  "schema_version": 1,
  "status": "complete | partial | failed",
  "run": {
    "run_id": "...",
    "git_sha": "...",
    "prd": "...",
    "prompt_variant": "realistic",
    "skill_scenario": "skills_available_unmentioned",
    "author": { "agent": "muse-code", "model": "muse-spark-1.2", "effort": "high" },
    "evaluator": { "model": "claude-opus-4-8", "effort": "high" }
  },
  "scores": {
    "ios_macro_pct": 0,
    "skill_trigger_recall": 0,
    "skill_uptake_rate": 0
  },
  "pipeline": [],
  "skills": [],
  "ios": { "test_plans": [] },
  "usage": { "author": {}, "evaluator": {} },
  "warnings": [],
  "artifacts": {}
}
```

The renderer consumes this schema rather than reading arbitrary logs. Source
adapters normalize the existing manifest, skill `metrics.json`, iOS
`result.json`, pipeline events, and author/evaluator traces into it. Unknown or
unavailable metrics stay `null`; they must never render as zero.

## Build and Evaluation Ladder

Add a small append-only, JSON-escaped pipeline recorder used by shell stages.
Each event has `stage`, `status`, `detail`, `timestamp`, and optional `duration`.
The reporter reduces to the latest event for each stage and combines it with the
skill analyzer's syntax result.

Display these actual gates in order:

1. App authored / required output present
2. Dependency install
3. Source syntax parse
4. Expo iOS bundle export
5. Native iOS build
6. App install and launch readiness
7. iOS evaluation completion

Statuses are `passed`, `warning`, `failed`, and `not_run`. A partial behavioral
score is a yellow evaluation rung; infrastructure failure is red; a disabled
stage is grey. Lint is absent until the harness really executes and structures
such a check.

## Screenshot Evidence

The current screenshot tool can return temporary paths but does not guarantee a
durable, step-associated image. Make screenshot capture a harness responsibility:

- At the end of every formal scored step, capture one best-effort final-state
  PNG under that plan trace's `screenshots/` directory.
- Use deterministic names such as `step-01-final.png`.
- Add the screenshot's trace-relative path to the step's trace summary and the
  public serialized step in `result.json`.
- Preserve detailed hard and soft assertion results in `result.json`, including
  pass/fail, fatality, command/check text, and soft evidence.
- The consolidated renderer copies referenced PNGs to stable relative paths,
  displays failed-step screenshots first, then representative passed steps, and
  links each image to its plan, run index, step, and assertion list.
- Capture failure is non-fatal and becomes a warning on that step.

This first version associates one screenshot with a scored step, not a separate
image with every assertion. That is reliable with the current driver and still
provides both failed and passed previews without allowing screenshot collection
to alter scoring.

## HTML Report

The single static, offline `report.html` follows the approved visual direction:

1. Navy run header with PRD, harness/model, reasoning, prompt, scenario, and SHA
2. Outcome cards for iOS quality, skill recall, skill uptake, and run status
3. Build/evaluation ladder
4. Side-by-side skill-use and iOS product-flow summaries
5. Screenshot gallery, failed steps first
6. Expandable skill-check and assertion-level evidence
7. Secondary run details: token/cache usage, cost when known, durations, tool
   calls, skill reads, CLI/SDK versions, warnings, and machine-data paths

The report contains no generated narrative verdict. It uses semantic HTML,
escaped artifact-controlled values, accessible color-plus-text statuses,
responsive layouts, and no remote assets or JavaScript dependency.

## Failure and Security Behavior

- A failed author/evaluator remains a reportable outcome, not a missing report.
- Missing optional data renders `not available`, never a misleading pass or zero.
- Report generation itself fails only for invalid input paths, unsafe archives,
  or an invalid consolidated schema.
- Reuse the evaluator's safe artifact extraction rules; never follow archive
  paths or links outside the scratch directory.
- Copy only referenced PNG files after validating their resolved path remains
  under the extracted evaluator artifact.
- HTML-escape every field derived from an artifact.
- Do not copy `.env`, MCP settings, raw Muse XDG data, provider keys, bearer
  tokens, or proxy request headers into the report artifact.

## Tests and Validation

### Automated tests

- Prompt resolution recognizes `realistic` and rejects unknown variants.
- Agent effort defaults to `high`, maps to every harness, is recorded, and
  rejects unknown values.
- Author model defaults remain unchanged; explicit Opus 5, GPT-5.6 Sol, and
  Muse Spark values pass through unchanged.
- Evaluator model/effort reaches `ClaudeAgentOptions` and is serialized.
- Step-result serialization preserves assertion detail and screenshot paths.
- Screenshot capture succeeds, fails non-fatally, and cannot escape its trace.
- Pipeline events reduce deterministically across pass/warn/fail/not-run states.
- Consolidation supports full, partial, failed, iOS-disabled, and skill-disabled
  inputs.
- HTML escapes controlled values, orders failed screenshots first, uses relative
  paths, and references only copied evidence.
- Skill output archives do not contain an unpacked authored tree.

Run:

```bash
bun run test:all
find eval_harness -name '*.sh' -print0 | xargs -0 bash -n
bun test eval_harness/evaluator/skill_invocation/tests
PYTHONPATH=. uv run python -m unittest eval_harness.evaluator.ios_agentic.tests.test_test_plan_resolution
node /Users/adityashukla/.codex/plugins/cache/openai-curated-remote/expo/1.0.2/skills/expo-cicd-workflows/scripts/validate.js .eas/workflows/*.yml
```

Render a fixture report locally and inspect it at desktop and narrow widths.

### Live EAS validation

After pushing the branch, run:

```bash
eas workflow:run .eas/workflows/eval-e2e.yml \
  --ref codex/refine-eval-outputs \
  -F agent=muse-code \
  -F agent_model=muse-spark-1.2 \
  -F agent_reasoning_effort=high \
  -F evaluator_model=claude-opus-4-8 \
  -F evaluator_reasoning_effort=high \
  -F prd=dataset/prds/notes/prd/mvp.txt \
  -F prompt_variant=realistic \
  -F skill_scenario=skills_available_unmentioned \
  -F run_eval_ios=true \
  -F run_eval_skill=true
```

Confirm:

- `eval-report/report.html` opens offline and matches the approved structure.
- `summary.json` reconciles with skill `metrics.json` and iOS `result.json`.
- The ladder distinguishes every actual stage outcome.
- Failed screenshots appear before passing previews and all image links work.
- The artifact contains no copied authored tree, temporary extraction root,
  provider credential, Expo bearer token, Muse settings/data, or nested tar.
- The report records Muse Spark 1.2/high and evaluator Opus 4.8/high exactly.

## Documentation

Update the root README and prompt README with:

- the new `realistic` prompt
- author/evaluator model and effort inputs
- the one-dispatch/one-cell model
- the new final `eval-report` artifact layout
- the distinction between a single-run report and a future cross-run comparison
- the exact first Muse validation command

Do not add private workspace paths or ephemeral validation URLs to shared docs.

## Out of Scope

- A multi-run/model comparison report
- Automatically dispatching the full PRD × harness matrix
- AI-authored narrative conclusions
- Adding lint as a new build-health gate
- Screenshot-per-assertion capture
- Changing the default author models to the one-off experiment models
