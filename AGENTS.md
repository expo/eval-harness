# Agent Operating Notes

This repo is an EAS-native Expo evaluation harness shared with Expo collaborators.
Keep changes boring, traceable, and easy to run from the root README.

Default to the EAS workflow path when validating behavior. Local CLI runs are
useful for tight debugging loops, but the real product surface is the Workflow
runner plus uploaded artifacts.

## Current Shape

- `eval_harness/app_builder/`: authoring side. `scripts/` holds its workflow
  entrypoint (`author-app.sh`). The coding-agent prompt itself lives in
  `dataset/prompts/`, selected by id via `dataset/prompts.json`.
- `eval_harness/evaluator/ios_agentic/`: mobile app evaluator package. It drives
  iOS apps with `agent-device` and scores app-agnostic primitive test plans
  against a PRD. `prompts/prompt_agent.py` is its system prompt; `scripts/`
  holds `eval-ios-app.sh`.
- `eval_harness/evaluator/skill_invocation/`: v0 skill-use analyzer package. It
  inspects authored app artifacts, authoring traces, static uptake checks, and
  optional evaluator outcomes. `scripts/` holds `eval-skill-use.sh`.
- `eval_harness/utils/`: shared artifacts, iOS, shell, and telemetry helpers
  used by both app_builder and evaluator.
- `dataset/prds/`: shared app PRDs — used by
  app_builder (authoring input) and evaluator/ios_agentic (injected scoring
  context via `--prd`). Lives at the repo root rather than under
  `eval_harness/` since it's a dataset, not runtime code.
- `dataset/test_plans/`: app-agnostic primitive test plans — evaluator-only,
  also at the repo root alongside `dataset/prds/` for the same reason.

## Important Invariants

- `eval-e2e.yml` is the front door. One dispatch is one author harness/model ×
  PRD × prompt × skill-scenario cell: `author_app` fans out to `eval_ios`
  and `eval_skill`, then a failure-aware `report` job consolidates both terminal
  states. The smaller workflows are replay/debug entrypoints, not the primary
  user journey. EAS has no matrix here; cross-cell comparison requires separate
  dispatches and external/future aggregation of their `summary.json` files.
- The app evaluator CLI is `python -m eval_harness.evaluator.ios_agentic.main`.
- The skill evaluator CLI is
  `bun eval_harness/evaluator/skill_invocation/main.ts`.
- Notes canonical input paths (the small, known-good target used first when
  proving harness changes):
  - PRD: `dataset/prds/notes/prd/mvp.txt`
  - plan: `dataset/test_plans/primitives/test_insert.txt`
- EAS artifact names are `authored-app`, `ios-eval-report`,
  `skill-eval-report`, and final `eval-report`. Their transport archives use the
  same names with `.tar.gz`; every extracted artifact keeps its root index named
  `manifest.json`.
- Every producer result has one authoritative location: author source under
  `author-agent-workspace/<run-id>/`, iOS `result.json`, skill `metrics.json`,
  and consolidated `summary.json`. Scratch roots, duplicated source/results/
  logs, stitched duplicate trees, and nested per-run transport tars must not
  enter new artifacts.
- Author runtime metadata belongs under `author-agent-metadata/<run-id>/`.
  Only `authored-app` carries source and the author trace. The iOS producer owns
  its evaluator traces, telemetry, and logs; the skill producer owns only its
  manifest, `metrics.json`, and standalone `report.html`.
- `eval_harness/utils/artifacts/collect_author_artifact.sh` and
  `collect_ios_artifact.sh` are phase-specific helpers called from shell traps,
  not workflow jobs. The skill analyzer writes its own canonical artifact.
- Model selection is configurable. Default author models are `sonnet`,
  `gpt-5-mini`, and `muse-spark-1.2` for Claude Code, Codex, and Muse Code.
  Author effort defaults to `high`. The iOS evaluator defaults to
  `claude-opus-4-8`; the full E2E workflow fixes its effort at `high` and app
  mode at `release` to stay within EAS's ten-input dispatch limit. The iOS
  replay workflow retains both controls. Keep the judge fixed when comparing
  author models unless the experiment explicitly varies it.
- `eval_harness/legacy/` is archival. Do not wire new workflows or docs to files there.
- Do not add new root-level folders unless there is a strong reason. Runtime
  code should live under `eval_harness/app_builder/`, `eval_harness/evaluator/`,
  or `eval_harness/utils/`. `dataset/` (PRDs, test plans, `prd_skills.json`
  and `prd_test_plans.json` ground truth) is the one intentional exception,
  since it's data/fixtures rather than runtime code.
- Expo project routing belongs in `app.config.js` and should remain configurable
  through `EAS_PROJECT_ID`, `EXPO_SLUG`, `EXPO_OWNER`, and `EXPO_APP_NAME`.
- Authoring always uses a direct `prd` input, passed straight to `author-app.sh`.
  `skill_scenario` (default `skills_available_unmentioned`) is an *authoring-time
  enforced config*, not just an analysis label: it controls whether
  `eval::run_coding_agent` installs skills/wires Expo MCP at all, and
  `skill_mention` names a skill explicitly in the prompt for the
  `skills_available_mentioned` scenario.
- Which skill(s) are expected for a given authored app, and how to verify
  their uptake, is resolved automatically: `analyzeArtifacts` reads the `prd`
  recorded in the artifact's `manifest.json`, looks up the app's expected
  skill set in `dataset/prd_skills.json`, and resolves each expected skill's
  uptake checks via `uptake_checks/skill_map.json` (skill id -> check ids)
  against the declarative lexical + structural checks in `checks_data.json`
  plus code-driven checks (including syntax-tree, see `uptake_checks/code_checks.ts`)
  registered via `register`; route-graph checks still don't exist -- see
  `uptake_checks/README.md`. 9 of 21 Expo skills are currently mapped; the
  rest are either CLI/cloud-ops skills with no source-tree footprint at all
  (deferred to a future trace-based checking axis, not this static-check
  registry) or assume a pre-existing app this harness doesn't produce -- see
  `SKILL_UPTAKE_COVERAGE_ANALYSIS.md` (repo root, untracked) for the
  full-ecosystem gap analysis. Checks are deliberately
  skill-agnostic atomic facts about the code; `skill_map.json` is the only
  file coupled to the current skill taxonomy, so a skill rename/merge/split
  only touches that one mapping. See `uptake_checks/README.md`. There is no
  manual case-spec selection anymore. Trigger and uptake are scored per
  expected skill independently (`analysis.computeSkillResults`,
  `metrics.json`'s `skills` key) -- a shared check contributes its result to
  every skill it's mapped to without being re-run, but one skill triggering
  never affects another skill's own trigger/uptake numbers, and an expected
  skill absent from `skill_map.json` is marked `unsupported`, not scored as
  a trivial zero-check pass.
- Which test plans run for a given authored app is resolved automatically the
  same way: the `ios_agentic` CLI reads the `prd` recorded in `author.env`,
  looks up the app's relevant test-plan filenames in
  `dataset/prd_test_plans.json`, and resolves them against
  `dataset/test_plans/primitives/`. There is no manual `test_plan` workflow
  input anymore; pass an explicit test-plan file/directory positionally to
  the CLI only for local debugging (overrides auto-resolution).

## Evaluator Scoring Rules

- One assertion per `Verify:` line.
- Prefer hard assertions with stable test IDs; use soft assertions only when driver tools cannot structurally check the claim.
- Do not call `complete_step` before all verifications are recorded.
- If a primitive does not apply, the seed phase should call `complete_step("N/A: ...")` so the plan is skipped rather than scored as a failure.
- The evaluator scores from the accessibility tree and structured hard/soft
  assertion tools. `capture_screenshot` returns a filesystem path, not image
  pixels, and Claude file-reading is blocked; screenshots are human evidence
  only and must never determine an assertion score.
- The harness, not discretionary model behavior, captures one best-effort
  deterministic `step-NN-final.png` after each formal scored step completes or
  aborts. Capture failures are non-fatal and attach to the step as diagnostics.

## Workflow Guidance

- Active workflows are the YAML files directly under `.eas/workflows/`.
- Use `eas/upload_artifact` and `eas/download_artifact` for job artifacts.
- Prefer the full `eval-e2e.yml` workflow for collaborator-facing examples.
- Use `author-app.yml` for coding-agent setup, skill visibility, and trace
  capture debugging.
- Use `eval-ios-app.yml` to replay evaluator/build/restart changes against a
  prior authored app artifact.
- Use `eval-skill-use.yml` to replay skill-use analysis against prior artifacts.
- Replay workflows emit their canonical producer artifacts but no consolidated
  `eval-report`; use `eval-e2e.yml` for the collaborator-facing offline report.
- Use EAS `after` for the parallel evaluator/final-report topology so terminal
  evaluator failures remain reportable. Pass actual job statuses into the
  reporter and keep `always()` diagnostic packaging/upload steps.
- Keep workflow logs compact; detailed logs belong in uploaded artifacts.
- Validate workflow YAMLs with the Expo workflow validator after edits.

## Trace And Artifact Guidance

- EAS generic artifacts are the primary download path. GCS mirroring is optional.
- Keep the run index named `manifest.json`.
- New artifact writers emit only the canonical layouts. Readers remain
  compatible with prior layouts for replay, but compatibility paths are
  read-only and must not leak back into workflow output names or documentation.
- Materialize downloaded artifacts with
  `eval_harness/utils/artifacts/materialize.ts`, never raw `tar -xzf`. It
  handles EAS directories, direct archives, nested roots, and supported legacy
  layouts through clean staging while rejecting traversal, escaping links,
  unsafe file types, and ambiguous roots.
- The final `eval-report` contains only `manifest.json`, offline `report.html`,
  `summary.json`, exact consumed producer JSON under `data/`, normalized
  `data/build-health.json`, and referenced PNGs under `evidence/screenshots/`.
  It contains no app source, raw traces/logs, credentials/settings, or input
  archives.
- Build health is reduced from producer outcomes, not a generic pipeline event
  recorder: app authored, dependency install, source syntax, Expo iOS export,
  native iOS build, install/launch readiness, and evaluation completion.
- Authoring traces should be named as Claude Code, Codex, or Muse Code authoring
  sessions.
- Muse talks directly to its native Meta endpoint. Do not route it through the
  generic logging proxy: the custom base-URL path caused model-catalog failures
  on EAS, while direct requests from the same worker succeeded. Muse authoring
  artifacts retain the normalized native
  `telemetry/traces/muse-code-authoring.json`; raw Muse XDG session data and
  installed Muse binaries must not enter the authored-app transport archive.
- Evaluator Claude SDK traces should be named and tagged as agentic evaluator
  sessions.
- Avoid enabling duplicate Braintrust pushes unless intentionally comparing two
  trace formats.
- The skill evaluator is v0: trace trigger detection, static code uptake checks,
  optional app-evaluator score, no LLM judge, and no screenshot evidence of its
  own. The downstream consolidated report may pair its metrics with iOS
  screenshot evidence without changing skill scoring.

## PRD And Prompt Guidance

- PRDs should describe product behavior, not patch over framework mistakes.
  Framework-specific guardrails belong in `dataset/prompts/` only when they are
  part of the experimental condition.
- The `realistic` prompt is the cross-platform middle ground: a three-line,
  product-oriented request to build "as an Expo app" with no iPhone-only
  wording or technical implementation directions.
- Notes is the stable reference target. Use it first when proving harness changes.
- Hot Chocolate and other richer PRDs are better for product realism, but expect
  authored-app defects to be part of the signal.

## Verification Commands

Run the canonical local type-check and test suite after changing harness code:

```bash
bun run test:all
```

Run focused and configuration checks when working in the corresponding area:

```bash
find eval_harness -name '*.sh' -print0 | xargs -0 bash -n
bun test eval_harness/evaluator/skill_invocation/tests
PYTHONPATH=. uv run python -m unittest eval_harness.evaluator.ios_agentic.tests.test_test_plan_resolution
node /Users/adityashukla/.codex/plugins/cache/openai-curated-remote/expo/1.0.2/skills/expo-cicd-workflows/scripts/validate.js .eas/workflows/*.yml
```
