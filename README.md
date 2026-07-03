# eval-experiments

EAS-native evaluation harness for comparing coding agents on Expo app-building tasks.
The primary way to use this repo is to run the full E2E workflow: a coding agent
authors an Expo app from a PRD, the app evaluator drives it on an iOS simulator,
and optional skill-use analysis inspects whether Expo skills were available,
triggered, and reflected in the generated code.

The Notes app is the canonical first target because it is small, known-good, and
has a stable primitive test plan.

## Layout

```text
.eas/workflows/
  author-app.yml              # Linux: PRD -> authored Expo app artifact
  eval-ios-app.yml            # macOS: authored app artifact -> iOS evaluator result
  eval-skill-use.yml          # Linux: authored/eval artifacts -> skill-use report
  eval-e2e.yml                # author + optional iOS eval + optional skill-use eval
  smoke-agent-skill.yml       # quick agent skill visibility check
  smoke-eval-standalone.yml   # Notes reference app evaluator smoke
  smoke-telemetry.yml         # agent telemetry capture smoke

eval_harness/
  app_evaluator/
    agent_device/             # agent-device bridge and tools
    maestro/                  # Maestro bridge and tools
    core/                     # shared evaluator scoring/prompt/tracing internals
    test_plans/primitives/    # app-agnostic primitive plans
    reference_apps/notes/     # checked-in Notes reference app
  skill_evaluator/
    skill_cases/core5/        # skill-use case specs
    *.py                      # skill-use analyzer, reports, metrics
  prds/notes/prd/mvp.txt      # Notes PRD
  scripts/                    # workflow entrypoints
  prompts/                    # coding-agent prompt templates
  utils/
    artifacts/                # artifact bundle collector
    ios/                      # iOS/dev-client helpers
    shell/                    # sourced workflow shell modules
    telemetry/                # logging proxy, OTLP receiver, trace reconstruction
```

## Setup

1. Install the EAS CLI and authenticate with Expo.
2. Copy `env.default` to `.env` and fill the provider keys you need.
3. Push secrets to the EAS `production` environment:

```bash
eas env:push production --path .env
```

Required for Claude Code authoring and evaluator runs: `ANTHROPIC_API_KEY`.
Required for Codex authoring: `OPENAI_API_KEY`.
Optional: `BRAINTRUST_API_KEY` plus `BRAINTRUST_PROJECT` for trace pushes.

Expo project routing is controlled by `app.config.js`. By default it points at the current Georgian test project. Override these env vars when running the same branch under another Expo account:

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
  -F prd=eval_harness/prds/notes/prd/mvp.txt \
  -F test_plan=eval_harness/app_evaluator/test_plans/primitives/test_insert.txt \
  -F run_eval_ios=true \
  -F run_eval_skill=false
```

That command is the normal app-evaluation path. It runs authoring on Linux,
downloads the authored app into a macOS job, builds/runs the iOS app, drives the
agentic evaluator, and uploads EAS artifacts for the authored app and eval output.

To run a skill-case authoring scenario, set `materialize_skill_case=true`.
In that mode the case spec supplies the PRD variant, such as “build an app that
does native data fetching.” The explicit `prd` input is not combined with the
case PRD; it is bypassed for the authored app. The `test_plan` still controls
which app-evaluator primitives run against the generated app.

```bash
eas workflow:run .eas/workflows/eval-e2e.yml \
  -F agent=claude-code \
  -F materialize_skill_case=true \
  -F test_plan=eval_harness/app_evaluator/test_plans/primitives/test_insert.txt \
  -F run_eval_ios=true \
  -F run_eval_skill=true \
  -F skill_case_spec=eval_harness/skill_evaluator/skill_cases/core5/native-data-fetching.json \
  -F skill_scenario=skills_available_unmentioned
```

Use Codex instead of Claude Code by changing the agent and ensuring `OPENAI_API_KEY`
is present in the EAS `production` environment:

```bash
eas workflow:run .eas/workflows/eval-e2e.yml \
  -F agent=codex \
  -F prd=eval_harness/prds/notes/prd/mvp.txt \
  -F test_plan=eval_harness/app_evaluator/test_plans/primitives/test_insert.txt \
  -F run_eval_ios=true \
  -F run_eval_skill=false
```

## Debug Workflows

The smaller workflows exist to isolate failures or replay one half of a run. They
are not the default collaborator path.

Use `author-app.yml` when you only want to test coding-agent setup, Expo skill
availability, or trace capture without spending macOS build minutes. You do not
need to pass a test plan for this author-only flow unless you want that value
recorded in the artifact metadata for a later replay.

```bash
eas workflow:run .eas/workflows/author-app.yml \
  -F agent=claude-code \
  -F prd=eval_harness/prds/notes/prd/mvp.txt
```

Use `eval-ios-app.yml` to replay the iOS/evaluator half against a previously
uploaded `authored-app` artifact after changing evaluator, build, restart, or
probe logic.

Use `eval-skill-use.yml` to replay the skill-use analyzer against a prior
authored-app artifact, optionally with an eval output artifact.

Use `smoke-eval-standalone.yml` only as a preflight for the evaluator machinery.
It runs the checked-in Notes reference app, so it answers “can the macOS worker
build, launch, restart, and drive a known-good app?” without involving a coding
agent. If full E2E is failing, this helps separate evaluator/device problems
from authored-app problems.

Use `smoke-agent-skill.yml` to check whether Claude Code or Codex can see and
invoke Expo skills in the Workflow environment.

Use `smoke-telemetry.yml` to check proxy capture and trace reconstruction
without authoring an app.

## Artifacts

Workflow jobs upload EAS generic artifacts. The author/eval collectors assemble a run bundle with:

- `app/`: authored Expo app source, excluding heavy generated folders,
- `telemetry/traces/`: reconstructed Claude Code or Codex sessions,
- `telemetry/*.jsonl`: raw proxied model traffic,
- `eval/result.json`: app evaluator score when iOS evaluation ran,
- `eval/traces/`: evaluator trace directories and screenshots,
- `logs/`: stage logs,
- `manifest.json`: the per-run index tying agent, model, PRD, test plan, commit, score, and artifact paths together.

GCS mirroring is optional. EAS artifacts are the primary download path.

## Braintrust

If `BRAINTRUST_API_KEY` is set, reconstructed authoring and evaluator sessions are pushed to Braintrust.
The default project is `expo-evals`; override with `BRAINTRUST_PROJECT`, `BRAINTRUST_CC_PROJECT`, or `BRAINTRUST_EVAL_PROJECT`.
The legacy evaluator-trace mirror is disabled unless `PUSH_EVAL_TRACE_BT=1`.

## Development

The app evaluator can still be run locally against an already served app when
debugging driver behavior, but collaborators should start with the EAS workflows
above because they match the production runner environment.

```bash
uv run python -m eval_harness.app_evaluator.main \
  eval_harness/app_evaluator/test_plans/primitives/test_insert.txt \
  --prd eval_harness/prds/notes/prd/mvp.txt \
  -d agent-device \
  --hybrid-restart \
  -o /tmp/notes-result.json \
  --verbose
```

Run shell parse checks after touching harness scripts:

```bash
bash -n eval_harness/scripts/*.sh eval_harness/scripts/skill_eval/*.sh eval_harness/utils/shell/*.sh eval_harness/utils/artifacts/*.sh
```

Run skill evaluator tests:

```bash
PYTHONPATH=. uv run python -m unittest eval_harness.tests.skill_evaluator.test_skill_eval_core
```

Validate EAS workflows:

```bash
node /Users/adityashukla/.codex/plugins/cache/openai-curated-remote/expo/1.0.2/skills/expo-cicd-workflows/scripts/validate.js .eas/workflows/*.yml
```
