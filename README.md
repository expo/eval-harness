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

eval_harness/
  app_builder/
    prompts/                  # coding-agent authoring prompt template
    scripts/                  # authoring + agent-skill-visibility entrypoints
  evaluator/
    ios_agentic/
      agent_device/           # agent-device bridge and tools
      maestro/                # Maestro bridge and tools
      core/                   # evaluator scoring and tracing internals
      prompts/                # agentic evaluator's system prompt
      scripts/                # iOS build+eval entrypoints
    skill_invocation/
      uptake_checks/          # atomic check registry + skill_map.json (skill -> checks)
      build_health/           # app-wide (not per-skill) syntax/bundle signals
      main.py                 # analyze-artifacts CLI
      analysis.py             # scoring, aggregation, metrics.json, report.html
      utils.py                # artifact unpacking, prd_skills loading, small helpers
      tests/                  # skill evaluator unit tests
      scripts/                # skill-use analysis entrypoint
  utils/                      # artifacts, iOS, shell, and telemetry helpers (shared)

dataset/
  prds/                       # Notes, Hot Chocolate, Wiki Reader, and Pool app PRDs (shared)
  test_plans/primitives/      # app-agnostic primitive plans
  prd_skills.json             # app -> expected skill ids (skill-eval ground truth)
  prd_test_plans.json         # app -> relevant test-plan filenames (iOS-eval ground truth)
```

## Setup

Install the EAS CLI, authenticate with Expo, copy `.env.default` to `.env`, and
push secrets to the EAS `production` environment:

```bash
eas env:push production --path .env
```

Required for Claude Code authoring and evaluator runs: `ANTHROPIC_API_KEY`.
Required for Codex authoring: `OPENAI_API_KEY`.
Optional: `EXPO_TOKEN` (an Expo Robot User access token) so the coding agent can
run its own `eas build` self-verification step during authoring, and so the
harness can wire up Expo MCP access for it (mcp.expo.dev accepts this token
directly as its bearer token now -- no separate OAuth login needed); see
`.env.default` for details. Optional: `BRAINTRUST_API_KEY` plus
`BRAINTRUST_PROJECT` for trace pushes.

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
  -F prd=dataset/prds/notes/prd/mvp.txt \
  -F run_eval_ios=true \
  -F run_eval_skill=false
```

Use Codex by changing the agent and ensuring `OPENAI_API_KEY` is present:

```bash
eas workflow:run .eas/workflows/eval-e2e.yml \
  -F agent=codex \
  -F prd=dataset/prds/notes/prd/mvp.txt \
  -F run_eval_ios=true \
  -F run_eval_skill=false
```

Run the focused iOS 27 native navigation and glass fixture by changing the PRD:

```bash
eas workflow:run .eas/workflows/eval-e2e.yml \
  -F agent=codex \
  -F prd=dataset/prds/pool/prd/mvp.txt \
  -F run_eval_ios=true \
  -F run_eval_skill=true
```

Authoring always uses a direct PRD path. Which test plans run in `eval_ios`,
and which skill(s) are expected in `eval_skill` (`run_eval_skill=true`), are
both resolved automatically from that same PRD — via
`dataset/prd_test_plans.json` and `dataset/prd_skills.json` respectively, no
manual test-plan or case-spec selection needed. `skill_scenario` feeds both
the authoring step (it's an enforced config, not just a label — see
`uptake_checks/README.md`) and the analysis step; `skill_mention` only matters
for the `skills_available_mentioned` scenario:

```bash
eas workflow:run .eas/workflows/eval-e2e.yml \
  -F agent=claude-code \
  -F prd=dataset/prds/notes/prd/mvp.txt \
  -F run_eval_ios=false \
  -F run_eval_skill=true \
  -F skill_scenario=skills_available_unmentioned
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
  -F prd=dataset/prds/notes/prd/mvp.txt
```

Use `eval-ios-app.yml` to replay the iOS/evaluator half against a previously
uploaded `authored-app` artifact after changing evaluator, build, restart, or
probe logic.

Use `eval-skill-use.yml` to replay the skill-use analyzer against a prior
`authored-app` artifact, optionally with an eval output artifact. It uploads the
same `skill-eval-report` artifact described above.

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
uv run python -m eval_harness.evaluator.ios_agentic.main \
  dataset/test_plans/primitives/test_insert.txt \
  --prd dataset/prds/notes/prd/mvp.txt \
  -d agent-device \
  --hybrid-restart \
  -o /tmp/notes-result.json \
  --verbose
```

Run shell parse checks after touching harness scripts:

```bash
find eval_harness -name '*.sh' -print0 | xargs -0 bash -n
```

Run skill evaluator and iOS test-plan-resolution tests:

```bash
PYTHONPATH=. uv run python -m unittest eval_harness.evaluator.skill_invocation.tests.test_skill_eval_core
PYTHONPATH=. uv run python -m unittest eval_harness.evaluator.ios_agentic.tests.test_test_plan_resolution
```

To add static uptake coverage for another Expo skill, follow the
[uptake-check contributor guide](eval_harness/evaluator/skill_invocation/uptake_checks/README.md#contributor-guide-add-coverage-for-another-skill).

Validate EAS workflows:

```bash
node /Users/adityashukla/.codex/plugins/cache/openai-curated-remote/expo/1.0.2/skills/expo-cicd-workflows/scripts/validate.js .eas/workflows/*.yml
```
