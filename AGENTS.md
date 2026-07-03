# Agent Operating Notes

This repo is an EAS-native Expo evaluation harness shared with Expo collaborators.
Keep changes boring, traceable, and easy to run from the root README.

Default to the EAS workflow path when validating behavior. Local CLI runs are
useful for tight debugging loops, but the real product surface is the Workflow
runner plus uploaded artifacts.

## Current Shape

- `eval_harness/app_evaluator/`: mobile app evaluator package. It drives iOS apps with `agent-device` and scores app-agnostic primitive test plans against a PRD.
- `eval_harness/skill_evaluator/`: v0 skill-use analyzer package. It inspects authored app artifacts, authoring traces, static uptake checks, and optional evaluator outcomes.
- `eval_harness/scripts/`: workflow entrypoints called by `.eas/workflows/*.yml`.
- `eval_harness/prompts/`: coding-agent prompt templates.
- `eval_harness/utils/`: shared artifacts, iOS, shell, and telemetry helpers.
- `eval_harness/app_evaluator/reference_apps/notes/`: known-good reference app for smoke testing.

## Important Invariants

- `eval-e2e.yml` is the front door. The smaller workflows are replay/debug
  entrypoints, not the primary user journey.
- The app evaluator CLI is `python -m eval_harness.app_evaluator.main`.
- The skill evaluator CLI is `python -m eval_harness.skill_evaluator.main`.
- Notes smoke input paths:
  - PRD: `eval_harness/app_evaluator/prds/notes/prd/mvp.txt`
  - plan: `eval_harness/app_evaluator/test_plans/primitives/test_insert.txt`
  - app: `eval_harness/app_evaluator/reference_apps/notes/`
- Artifact bundles keep their index file named `manifest.json`.
- Skill-eval report artifacts are named `skill-eval-report` and contain
  `metrics.json` plus `report.html`.
- `eval_harness/utils/artifacts/collect_artifacts.sh` is a helper called from shell traps, not a workflow job.
- `eval_harness/legacy/` is archival. Do not wire new workflows or docs to files there.
- Do not add new root-level harness folders unless there is a strong reason.
  Runtime/evaluator code should live under `eval_harness/app_evaluator/`,
  `eval_harness/skill_evaluator/`, `eval_harness/scripts/`,
  `eval_harness/prompts/`, or `eval_harness/utils/`.
- Expo project routing belongs in `app.config.js` and should remain configurable
  through `EAS_PROJECT_ID`, `EXPO_SLUG`, `EXPO_OWNER`, and `EXPO_APP_NAME`.
- `authoring_mode=prd` passes the `prd` input directly to `author_app.sh`.
- `authoring_mode=skill_case` resolves a PRD from `skill_case_spec` and
  `skill_scenario`, then still calls the same `author_app.sh` path.
- `test_plan` is an app-evaluator input. It is not part of skill-use analysis.

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
- Use smoke workflows only to isolate infrastructure: known-good app evaluator,
  agent skill visibility, or telemetry capture.
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
  Framework-specific guardrails belong in `eval_harness/prompts/` only when they
  are part of the experimental condition.
- Notes is the stable reference target. Use it first when proving harness changes.
- Hot Chocolate and other richer PRDs are better for product realism, but expect
  authored-app defects to be part of the signal.

## Verification Commands

```bash
find eval_harness/scripts eval_harness/utils -name '*.sh' -print0 | xargs -0 bash -n
PYTHONPATH=. uv run python -m unittest eval_harness.skill_evaluator.tests.test_skill_eval_core
node /Users/adityashukla/.codex/plugins/cache/openai-curated-remote/expo/1.0.2/skills/expo-cicd-workflows/scripts/validate.js .eas/workflows/*.yml
```
