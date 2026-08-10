# Refined Single-Run Eval Outputs

**Date:** 2026-08-10  
**Branch:** `codex/refine-eval-outputs`  
**Status:** Approved v3 visual direction and technical design

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
Can you build this as an Expo app based on the product brief below?
I want the core experience to feel complete, with the main actions easy to find and the important details handled thoughtfully.
It should feel polished enough to give to a real user, not like a demo or rough prototype.
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

The full E2E workflow fixes evaluator reasoning at `high` and iOS app mode at
`release` so its manual dispatch stays within EAS's ten-input limit. The
`eval-ios-app.yml` replay workflow retains the
`evaluator_reasoning_effort` (`low | medium | high`) and `ios_app_mode`
controls for focused diagnostics.

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
the artifact manifests, normalized summaries, and the HTML report. Unknown effort
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

The EAS artifact names are:

- `authored-app` from `author_app`
- `skill-eval-report` from `eval_skill`
- `ios-eval-report` from `eval_ios` (renamed from `eval-e2e-output`)
- `eval-report` from the final `report` job

## Artifact Contracts

All new artifact writers use a canonical v2 layout. Readers accept both the
existing layout and v2 during migration. Every artifact has one root
`manifest.json`, every result has one authoritative location, scratch data is
never archived, only the author artifact carries source, and only the producing
job carries its own detailed traces and logs.

Rename the runtime and artifact paths consistently:

| Current name | V2 name |
|---|---|
| `agent-workspace/` | `author-agent-workspace/` |
| author-side `eval-out/` | `author-agent-metadata/` |
| iOS-side `eval-out/` and EAS `eval-e2e-output` | `ios-eval-report/` |
| `skill-eval-report/` | unchanged |

Update active scripts, workflow packagers, replay workflows, documentation, and
tests to write the v2 names. Read-only artifact discovery retains compatibility
with the old names so prior artifacts remain replayable.

### Author transport artifact

The current `agent-workspace` directory is the app project itself. It does not
contain a separate app plus unrelated run metadata. Rename the two current
top-level concepts without introducing another `app/` copy:

```text
authored-app.tar.gz
  manifest.json
  author-agent-workspace/
    <run-id>/
      package.json
      app.json / app.config.js
      <authored project source and configuration>
  author-agent-metadata/
    <run-id>/
      author.env
      telemetry/
        anthropic.jsonl | openai.jsonl
        otel/
        traces/
          <selected author-harness trace>.json
      logs/
```

Do not create `bundle/app/`; the source under `author-agent-workspace/<run-id>/`
is authoritative and sufficient for iOS evaluation and skill analysis. Update
artifact discovery to prefer v2 while retaining read compatibility with
`agent-workspace/<run-id>` and `bundle/app`.

Do not create the inner `<run-id>.tgz`. EAS, iOS evaluation, and skill analysis
do not consume it; only the optional GCS mirror currently does. Package one
canonical `authored-app.tar.gz` and use that same archive for both EAS upload and
optional GCS mirroring.

### Skill artifact

Keep the replay-friendly outputs:

```text
skill-eval-report/
  manifest.json
  metrics.json
  report.html
```

`metrics.json` is the authoritative skill evaluator result. Artifact extraction
still occurs because the analyzer must inspect downloaded source and traces, but
it uses a `mktemp` scratch root outside `skill-eval-report/` and removes it on
exit. The current `unpacked/` tree has no unique evidence: it only repeats the
downloaded input artifacts. Eliminate it from the uploaded artifact entirely.

The directory and EAS artifact are both named `skill-eval-report`; the transport
file may remain `skill-eval-report.tar.gz` because it is a tar archive.

### iOS artifact

Rename the EAS artifact and archive from `eval-e2e-output` / `eval-out.tar.gz`
to `ios-eval-report` / `ios-eval-report.tar.gz`. Use one authoritative copy of
each file:

```text
ios-eval-report/
  manifest.json
  result.json
  report.html
  traces/
    agentic-evaluator.json
    test-plans/
      <plan-run>/
        summary.json
        conversation.jsonl
        console.log
        screenshots/
  telemetry/
    anthropic.jsonl
    otel/
  logs/
```

`traces/agentic-evaluator.json` is the one normalized overall evaluator trace.
`traces/test-plans/<plan-run>/` contains the evaluator-native trace for one test
plan invocation: its turn/tool conversation, score-and-usage summary, console
transcript, and screenshots. These serve different levels of inspection and are
not duplicate file formats.

Do not carry the author trace or authored source into `ios-eval-report`; those
belong to `authored-app`. The author trace is present today only because the iOS
worker inherits the author bundle and the generic collector preserves it while
rebuilding a stitched bundle.

Keep `telemetry/` and `logs/` separate. `telemetry/anthropic.jsonl` is the
redacted Anthropic request/response usage log and `telemetry/otel/` contains the
OTLP exports. `logs/` contains stage stdout/stderr such as dependency install,
Xcode build, launch, and evaluator logs. Do not copy any of these again under a
second `bundle/` directory.

### Final collaborator-facing artifact

Upload one artifact named `eval-report`:

```text
eval-report/
  manifest.json
  report.html
  summary.json
  data/
    author-manifest.json
    skill-metrics.json
    ios-result.json
    build-health.json
  evidence/
    screenshots/
      <stable-relative-name>.png
```

Only copy files that the report directly consumes. Do not include an authored
app tree, raw provider credentials, Muse settings/data, duplicated transport
archives, or the original intermediate tars. All links in `report.html` are
relative so the extracted artifact works offline.

`data/skill-metrics.json` is an exact copy of the skill artifact's
`metrics.json`; `data/ios-result.json` is an exact copy of the iOS artifact's
`result.json`. `summary.json` normalizes those inputs for rendering and future
cross-run aggregation. `manifest.json` identifies and inventories this artifact.
`data/build-health.json` contains only the normalized ladder assembled from
producer manifests plus the structured syntax and Expo-export results.

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
  "build_health": [],
  "skills": [],
  "ios": { "test_plans": [] },
  "usage": { "author": {}, "evaluator": {} },
  "warnings": [],
  "artifacts": {}
}
```

The renderer consumes this schema rather than reading arbitrary logs. Source
adapters normalize the existing manifest, skill `metrics.json`, iOS
`result.json`, producer stage statuses, and author/evaluator traces into it. Unknown or
unavailable metrics stay `null`; they must never render as zero.

## Build and Evaluation Ladder

Do not add a separate append-only pipeline recorder. Most gates already run and
some already have structured outputs. Persist only the currently log-only stage
outcomes in the existing producer manifests, then normalize all sources into
the final `data/build-health.json`.

The sources are:

| Stage | Authoritative source |
|---|---|
| App authored | author manifest status plus required-output gate |
| Dependency install | iOS manifest status plus install log path |
| Source syntax | `skill-metrics.json.build_health.syntax` |
| Expo iOS bundle export | `skill-metrics.json.build_health.bundle` |
| Native iOS build | iOS manifest status plus Xcode log path |
| App install and launch | iOS manifest status plus launch log path |
| iOS evaluation | `ios-result.json` status plus iOS manifest status |

The shell stages already branch on these outcomes. Set manifest status fields at
those existing boundaries rather than parsing human logs after the fact. A
missing status means `not_run`; do not infer a pass from file existence alone.

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

The evaluator already receives `capture_screenshot` in its allowed MCP tool
list, but the current bridge ignores `EVAL_SCREENSHOT_DIR` and writes an
unscoped temporary PNG when no path is supplied. Correct the stale bridge
documentation, make agent-requested captures write under the active plan trace,
and explicitly tell the evaluator in its system prompt that the tool is
available for additional feature-relevant human evidence.

The tool currently returns a filesystem path as text. The evaluator's file-read
tools are blocked, and the MCP result does not contain image pixels, so the
evaluator cannot visually inspect the screenshot. State this limitation in the
system prompt: screenshots are for human postmortem review only and must not be
used as the basis for scoring. The evaluator continues to make decisions from
the accessibility tree and structured hard/soft assertion tools.

Do not depend on discretionary model tool use for the report. Make the primary
screenshot capture a harness responsibility:

- At the end of every formal step that reaches a terminal completed or aborted
  state, capture one best-effort final-state PNG under that plan trace's
  `screenshots/` directory.
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
to alter scoring. The report labels screenshots as final-state context rather
than proof that an assertion passed or failed. Do not add screenshot-count or
byte-size fields solely for monitoring; artifact contents and archive sizes can
be inspected after the first few runs. Revisit retention after those runs if
screenshots materially increase artifact size.

## HTML Report

The single static, offline `report.html` follows the approved v3 visual
direction on a pale blue canvas:

1. Dark slate hero with the product title and compact model, reasoning, prompt,
   scenario, and revision pills
2. Four rounded, softly tinted metric cards for iOS quality, skill recall,
   skill uptake, and run status
3. One rounded white horizontal build/evaluation ladder with CSS status dots,
   connectors, and explicit status text
4. Paired rounded Skill use and iOS behavior cards
5. Rounded screenshot-evidence grid, failed steps first
6. Compact Run details card for usage, tool calls, skill reads, versions,
   warnings, identity, and machine-data paths
7. Expandable skill-check, plan, assertion, and abort-diagnostic evidence

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
- The evaluator prompt identifies screenshots as human-only evidence and keeps
  scoring grounded in accessibility and assertion tools.
- Producer manifest statuses and existing structured checks normalize
  deterministically across pass/warn/fail/not-run states.
- Consolidation supports full, partial, failed, iOS-disabled, and skill-disabled
  inputs.
- HTML escapes controlled values, orders failed screenshots first, uses relative
  paths, and references only copied evidence.
- Skill output archives do not contain an unpacked authored tree.
- Author and iOS artifacts contain no duplicate source, result, report, trace,
  log, or nested archive copies.

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
- The EAS artifacts are named `authored-app`, `skill-eval-report`,
  `ios-eval-report`, and `eval-report`.

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
