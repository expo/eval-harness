# Agent Operating Notes

This repo is an EAS-native Expo evaluation harness shared with Expo collaborators.
Keep changes boring, traceable, and easy to run from the root README.

Default to the EAS workflow path when validating behavior. Local CLI runs are
useful for tight debugging loops, but the real product surface is the Workflow
runner plus uploaded artifacts.

## Current Shape

- `eval_harness/app_builder/`: authoring side. `prompts/author_app.md` is the
  coding-agent prompt template; `scripts/` holds its workflow entrypoint
  (`author-app.sh`).
- `eval_harness/evaluator/ios_agentic/`: mobile app evaluator package. It drives
  iOS apps with `agent-device` and scores app-agnostic primitive test plans
  against a PRD. `prompts/prompt_agent.py` is its system prompt; `scripts/`
  holds `eval-ios-app.sh`.
- `eval_harness/evaluator/skill_invocation/`: v0 skill-use analyzer package. It
  inspects authored app artifacts, authoring traces, static uptake checks, and
  optional evaluator outcomes. `scripts/` holds `eval-skill-use.sh`.
- `eval_harness/utils/`: shared artifacts, iOS, shell, and telemetry helpers
  used by both app_builder and evaluator.
- `dataset/prds/`: Notes/Hot Chocolate/Wiki Reader PRDs — shared between
  app_builder (authoring input) and evaluator/ios_agentic (injected scoring
  context via `--prd`). Lives at the repo root rather than under
  `eval_harness/` since it's a dataset, not runtime code.
- `dataset/test_plans/`: app-agnostic primitive test plans — evaluator-only,
  also at the repo root alongside `dataset/prds/` for the same reason.

## Important Invariants

- `eval-e2e.yml` is the front door. The smaller workflows are replay/debug
  entrypoints, not the primary user journey.
- The app evaluator CLI is `python -m eval_harness.evaluator.ios_agentic.main`.
- The skill evaluator CLI is
  `bun eval_harness/evaluator/skill_invocation/main.ts`.
- Notes canonical input paths (the small, known-good target used first when
  proving harness changes):
  - PRD: `dataset/prds/notes/prd/mvp.txt`
  - plan: `dataset/test_plans/primitives/test_insert.txt`
- Artifact bundles keep their index file named `manifest.json`.
- Skill-eval report artifacts are named `skill-eval-report` and contain
  `metrics.json` plus `report.html`.
- `eval_harness/utils/artifacts/collect_artifacts.sh` is a helper called from shell traps, not a workflow job.
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

## Workflow Guidance

- Active workflows are the YAML files directly under `.eas/workflows/`.
- Use `eas/upload_artifact` and `eas/download_artifact` for job artifacts.
- Prefer the full `eval-e2e.yml` workflow for collaborator-facing examples.
- Use `author-app.yml` for coding-agent setup, skill visibility, and trace
  capture debugging.
- Use `eval-ios-app.yml` to replay evaluator/build/restart changes against a
  prior authored app artifact.
- Use `eval-skill-use.yml` to replay skill-use analysis against prior artifacts.
- Keep workflow logs compact; detailed logs belong in uploaded artifacts.
- Validate workflow YAMLs with the Expo workflow validator after edits.

## Trace And Artifact Guidance

- EAS generic artifacts are the primary download path. GCS mirroring is optional.
- Keep the run index named `manifest.json`.
- Authoring traces should be named as Claude Code or Codex authoring sessions.
- Evaluator Claude SDK traces should be named and tagged as agentic evaluator
  sessions.
- Avoid enabling duplicate Braintrust pushes unless intentionally comparing two
  trace formats.
- The skill evaluator is v0: trace trigger detection, static code uptake checks,
  optional app-evaluator score, no LLM judge, and no screenshot evidence.

## PRD And Prompt Guidance

- PRDs should describe product behavior, not patch over framework mistakes.
  Framework-specific guardrails belong in `eval_harness/app_builder/prompts/`
  only when they are part of the experimental condition.
- Notes is the stable reference target. Use it first when proving harness changes.
- Hot Chocolate and other richer PRDs are better for product realism, but expect
  authored-app defects to be part of the signal.

## Verification Commands

```bash
find eval_harness -name '*.sh' -print0 | xargs -0 bash -n
bun test eval_harness/evaluator/skill_invocation/tests
PYTHONPATH=. uv run python -m unittest eval_harness.evaluator.ios_agentic.tests.test_test_plan_resolution
node /Users/adityashukla/.codex/plugins/cache/openai-curated-remote/expo/1.0.2/skills/expo-cicd-workflows/scripts/validate.js .eas/workflows/*.yml
```
