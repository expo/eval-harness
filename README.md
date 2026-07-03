# eval-experiments

EAS-native evaluation harness for comparing coding agents on Expo app-building
tasks. The normal path is one Workflow run: a coding agent authors an Expo app
from a PRD, the app evaluator can drive it on an iOS simulator, and the v0 skill
evaluator can inspect whether Expo skills were triggered and reflected in code.

The Notes app is the canonical first target because it is small, known-good, and
has a stable primitive test plan.

## Layout

```text
.eas/workflows/
  eval-e2e.yml                # full author -> optional iOS eval -> optional skill eval
  author-app.yml              # Linux authoring replay/debug workflow
  eval-ios-app.yml            # macOS iOS evaluator replay/debug workflow
  eval-skill-use.yml          # Linux skill-use report replay/debug workflow
  smoke-*.yml                 # narrow infrastructure smoke tests

eval_harness/
  app_evaluator/
    agent_device/             # agent-device bridge and tools
    maestro/                  # Maestro bridge and tools
    core/                     # evaluator scoring, prompts, and tracing internals
    prds/                     # Notes, Hot Chocolate, and Wiki Reader app PRDs
    test_plans/primitives/    # app-agnostic primitive plans
    reference_apps/notes/     # checked-in Notes reference app
  skill_evaluator/
    prds/                     # skill-eval PRDs used by authoring_mode=skill_case
    skill_cases/core5/        # skill case specs
    main.py                   # analyze-artifacts and resolve-authoring-env CLI
    analysis.py               # scoring, aggregation, metrics.json, report.html
    static_checks.py          # source checks and trace skill detection
    utils.py                  # case loading, artifact unpacking, small helpers
    tests/                    # skill evaluator unit tests
  scripts/                    # Workflow entrypoints
  prompts/                    # coding-agent prompt templates
  utils/                      # artifacts, iOS, shell, and telemetry helpers
```

## Setup

Install the EAS CLI, authenticate with Expo, copy `env.default` to `.env`, and
push secrets to the EAS `production` environment:

```bash
eas env:push production --path .env
```

Required for Claude Code authoring and evaluator runs: `ANTHROPIC_API_KEY`.
Required for Codex authoring: `OPENAI_API_KEY`.
Optional: `BRAINTRUST_API_KEY` plus `BRAINTRUST_PROJECT` for trace pushes.

Expo project routing is controlled by `app.config.js`. Override these env vars
when running the same branch under another Expo account:

```bash
EAS_PROJECT_ID=<project-uuid>
EXPO_SLUG=<project-slug>
EXPO_OWNER=<account-name>
```

## Run The Full Flow

Run the full modular E2E workflow for Notes:

```bash
eas workflow:run .eas/workflows/eval-e2e.yml \
  -F agent=claude-code \
  -F authoring_mode=prd \
  -F prd=eval_harness/app_evaluator/prds/notes/prd/mvp.txt \
  -F test_plan=eval_harness/app_evaluator/test_plans/primitives/test_insert.txt \
  -F run_eval_ios=true \
  -F run_eval_skill=false
```

Use Codex by changing the agent and ensuring `OPENAI_API_KEY` is present:

```bash
eas workflow:run .eas/workflows/eval-e2e.yml \
  -F agent=codex \
  -F authoring_mode=prd \
  -F prd=eval_harness/app_evaluator/prds/notes/prd/mvp.txt \
  -F test_plan=eval_harness/app_evaluator/test_plans/primitives/test_insert.txt \
  -F run_eval_ios=true \
  -F run_eval_skill=false
```

Run a skill-case scenario through the same authoring workflow by switching
`authoring_mode` to `skill_case`. In this mode `skill_case_spec` and
`skill_scenario` resolve the PRD passed to the coding agent; the `prd` input is
ignored for authoring. `test_plan` belongs to the app evaluator only, so it is
only needed when `run_eval_ios=true`.

```bash
eas workflow:run .eas/workflows/eval-e2e.yml \
  -F agent=claude-code \
  -F authoring_mode=skill_case \
  -F skill_case_spec=eval_harness/skill_evaluator/skill_cases/core5/native-data-fetching.json \
  -F skill_scenario=skills_available_unmentioned \
  -F run_eval_ios=false \
  -F run_eval_skill=true
```

## Workflow Artifacts

Open the EAS Workflow run and download artifacts from the run’s artifact list.
Untar them locally with `tar -xzf <file>.tar.gz`.

`eval-ios-app.yml` and the iOS evaluation job in full E2E runs upload app-eval
output:

- artifact name in full E2E runs: `eval-e2e-output`
- artifact name in replay runs: `eval-ios-replay-output`
- archive: `eval-out.tar.gz`
- contains: `eval/result.json`, evaluator traces, logs, and `manifest.json`

`eval-skill-use.yml` and the skill evaluation job in full E2E runs upload
skill-eval output:

- artifact name: `skill-eval-report`
- archive: `skill-eval-report.tar.gz`
- contains: `metrics.json` and `report.html`

Open `report.html` for the human-readable skill-eval report. Inspect
`metrics.json` for machine-readable results.

The skill evaluator is an initial v0. Current signal is trace trigger detection,
static code uptake checks, and optional app-evaluator score if an eval artifact
is provided. It does not use an LLM judge, screenshots, or production-calibrated
classification yet.

## Debug Workflows

Use `author-app.yml` when you only want to test coding-agent setup, Expo skill
availability, or trace capture without spending macOS build minutes. No test
plan is needed for author-only runs.

```bash
eas workflow:run .eas/workflows/author-app.yml \
  -F agent=claude-code \
  -F authoring_mode=prd \
  -F prd=eval_harness/app_evaluator/prds/notes/prd/mvp.txt
```

Use `eval-ios-app.yml` to replay the iOS/evaluator half against a previously
uploaded `authored-app` artifact after changing evaluator, build, restart, or
probe logic.

Use `eval-skill-use.yml` to replay the skill-use analyzer against a prior
`authored-app` artifact, optionally with an eval output artifact. It uploads the
same `skill-eval-report` artifact described above.

Use `smoke-eval-standalone.yml` as a preflight for evaluator machinery. It runs
the checked-in Notes reference app, which separates evaluator/device problems
from coding-agent/authored-app problems.

Use `smoke-agent-skill.yml` to check whether Claude Code or Codex can see and
invoke Expo skills in the Workflow environment. Use `smoke-telemetry.yml` to
check proxy capture and trace reconstruction without authoring an app.

## Braintrust

If `BRAINTRUST_API_KEY` is set, reconstructed authoring and evaluator sessions
are pushed to Braintrust. The default project is `expo-evals`; override with
`BRAINTRUST_PROJECT`, `BRAINTRUST_CC_PROJECT`, or `BRAINTRUST_EVAL_PROJECT`.
The legacy evaluator-trace mirror is disabled unless `PUSH_EVAL_TRACE_BT=1`.

## Development

The app evaluator can still be run locally against an already served app when
debugging driver behavior, but collaborators should start with EAS workflows
because they match the runner environment.

```bash
uv run python -m eval_harness.app_evaluator.main \
  eval_harness/app_evaluator/test_plans/primitives/test_insert.txt \
  --prd eval_harness/app_evaluator/prds/notes/prd/mvp.txt \
  -d agent-device \
  --hybrid-restart \
  -o /tmp/notes-result.json \
  --verbose
```

Run shell parse checks after touching harness scripts:

```bash
find eval_harness/scripts eval_harness/utils -name '*.sh' -print0 | xargs -0 bash -n
```

Run skill evaluator tests:

```bash
PYTHONPATH=. uv run python -m unittest eval_harness.skill_evaluator.tests.test_skill_eval_core
```

Validate EAS workflows:

```bash
node /Users/adityashukla/.codex/plugins/cache/openai-curated-remote/expo/1.0.2/skills/expo-cicd-workflows/scripts/validate.js .eas/workflows/*.yml
```
