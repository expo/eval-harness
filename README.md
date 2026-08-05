# eval-experiments

EAS-native evaluation harness for comparing coding agents on Expo app-building
tasks. The normal path is one Workflow run: a coding agent authors an Expo app
from a PRD, the app evaluator can drive it on an iOS simulator, and the v0 skill
evaluator can inspect whether Expo skills were triggered and reflected in code.

The Notes app is the canonical first target because it is small, known-good, and
has a stable primitive test plan.

## How It Fits Together

![Evaluation harness flow from dataset inputs through app authoring and the skill and iOS evaluators](eval_harness/evaluation-harness.png)

The diagram includes the repository paths for each stage. Its
[editable Excalidraw source](eval_harness/evaluation-harness.excalidraw) is kept
next to the rendered image.

## Layout

```text
.eas/workflows/
  eval-e2e.yml                # full author -> optional iOS eval -> optional skill eval
  author-app.yml              # Linux authoring replay/debug workflow
  eval-ios-app.yml            # macOS iOS evaluator replay/debug workflow
  eval-skill-use.yml          # Linux skill-use report replay/debug workflow

eval_harness/
  app_builder/
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
      main.ts                 # Bun analyze-artifacts CLI
      analysis.ts             # scoring, aggregation, metrics.json, report.html
      utils.ts                # artifact unpacking, prd_skills loading, small helpers
      tests/                  # skill evaluator unit tests
      scripts/                # skill-use analysis entrypoint
  utils/                      # artifacts, iOS, shell, and telemetry helpers (shared)

dataset/
  prompts/                    # coding-agent authoring prompt variants
  prompts.json               # prompt-variant id -> prompt file registry
  prds/                       # Notes, Hot Chocolate, Wiki Reader, and Pool app PRDs (shared)
  test_plans/primitives/      # app-agnostic primitive plans
  prd_skills.json             # app -> expected skill ids (skill-eval ground truth)
  prd_test_plans.json         # app -> relevant test-plan filenames (iOS-eval ground truth)
```

## One-time Collaborator Setup

The shared harness is already linked to Georgian's Expo project and its EAS
`production` environment already contains the required credentials. If your
Expo account has been invited to that project, install the EAS CLI and sign in:

```bash
npm install -g eas-cli
eas login
eas whoami
```

From the repository root, verify that EAS resolves the shared project:

```bash
eas project:info
```

It should show:

- owner: `georgian-team`
- slug: `adi-test-project`
- project ID: `338f6455-57a3-49c9-a2e0-36e5a0577c77`

You do not need to install this repository's Bun, TypeScript, or Python
dependencies locally to submit a Workflow. EAS uploads the current checkout and
installs the required runtimes and dependencies on its remote workers.

### Project secret setup (maintainers only)

Invited collaborators can skip this subsection. When configuring a new EAS
project, copy `.env.default` to `.env` and push the required values to the EAS
`production` environment:

```bash
eas env:push production --path .env
```

Claude Code authoring and evaluation use `CLAUDE_CODE_OAUTH_TOKEN`, generated
locally with `claude setup-token`. Do not also set `ANTHROPIC_API_KEY` or
`ANTHROPIC_AUTH_TOKEN`; Claude Code gives those credentials higher priority than
subscription OAuth, and the harness rejects them to prevent accidentally
bypassing the intended Claude subscription. Codex authoring requires
`OPENAI_API_KEY`. Muse Code authoring uses `META_API_KEY` with provider `meta`
and defaults to `muse-spark-1.2`. Create that EAS secret with the interactive
prompt—never an inline value:

```bash
eas env:create production --name META_API_KEY --visibility secret --scope project
```

`EXPO_TOKEN` is optional and lets the coding agent run its own `eas build`
self-verification and use Expo MCP. `BRAINTRUST_API_KEY` and
`BRAINTRUST_PROJECT` are optional trace-export settings; see `.env.default`.

Muse author-only runs need `META_API_KEY`. A Muse E2E run that enables iOS
evaluation (`-F run_eval_ios=true`) also needs `CLAUDE_CODE_OAUTH_TOKEN`, because
the downstream iOS evaluator is always Claude-based.

Expo project routing is controlled by `app.config.js`. Override these variables
when running the same branch under another Expo account:

```bash
EAS_PROJECT_ID=<project-uuid>
EXPO_SLUG=<project-slug>
EXPO_OWNER=<account-name>
```

## Run The Full Flow

The current end-to-end workflow is intentionally hybrid:

```text
author app
├── iOS app evaluation: Python
└── skill evaluation: TypeScript executed by Bun
```

Bun is pinned and installed automatically on the EAS workers; there is no
separate `use_bun` input.

First pull the branch you want to evaluate and inspect the checkout. EAS uploads
the entire current local project directory, including uncommitted files, unless
you use its `--ref` option.

```bash
git status --short
```

Start with the canonical Notes evaluation. Notes is the small, known-good
target for proving harness changes. This runs Claude Code authoring, the Python
iOS evaluator, and the Bun skill evaluator:

```bash
eas workflow:run .eas/workflows/eval-e2e.yml \
  -F agent=claude-code \
  -F prd=dataset/prds/notes/prd/mvp.txt \
  -F run_eval_ios=true \
  -F run_eval_skill=true \
  -F skill_scenario=skills_available_unmentioned \
  --wait
```

`--wait` keeps the terminal attached until the workflow finishes. It is
optional; the EAS dashboard continues the run if you disconnect.

Authoring uses the `baseline` prompt variant by default. To compare another
registered prompt, add `-F prompt_variant=minimal`; the available ids and their
files are documented in [`dataset/prompts/README.md`](dataset/prompts/README.md).

For the richer iOS 27 native-navigation and glass fixture, change the agent to
Codex and the PRD to Pool:

```bash
eas workflow:run .eas/workflows/eval-e2e.yml \
  -F agent=codex \
  -F prd=dataset/prds/pool/prd/mvp.txt \
  -F run_eval_ios=true \
  -F run_eval_skill=true \
  -F skill_scenario=skills_available_unmentioned \
  --wait
```

Use Muse Code with the Meta provider by changing the authoring agent. Its
default model is `muse-spark-1.2`; provide `-F agent_model=<model>` only to
override it:

```bash
eas workflow:run .eas/workflows/eval-e2e.yml \
  -F agent=muse-code \
  -F prd=dataset/prds/pool/prd/mvp.txt \
  -F run_eval_ios=true \
  -F run_eval_skill=true \
  -F skill_scenario=skills_available_unmentioned \
  --wait
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

## Download And Interpret Results

Open the EAS Workflow run and download artifacts from the run’s artifact list.
The iOS and skill jobs run independently after authoring, so one report can be
available even when the other job fails. Failed jobs still upload diagnostic
archives. A successful iOS job requires a `result.json` with numeric score
fields; a diagnostics-only archive does not satisfy that completion check.
If Claude Max has reached its session limit, authoring or iOS evaluation fails
with an explicit subscription-usage message; wait for the stated reset before
retrying.

`eval-ios-app.yml` and the iOS evaluation job in full E2E runs upload app-eval
output:

- artifact name in full E2E runs: `eval-e2e-output`
- artifact name in replay runs: `eval-ios-replay-output`
- archive: `eval-out.tar.gz`
- primary result after extraction: `eval-out/<RUN_ID>/result.json`
- also contains evaluator traces, logs, the evidence bundle, and `manifest.json`

Because the run ID is generated dynamically, locate the result with:

```bash
tar -xzf eval-out.tar.gz
find eval-out -name result.json -print
```

Start with `macro_avg_pct`, then inspect individual test-plan scores,
assertions, and traces. Agent-driven evaluation can expose driver limitations as
well as application defects, so do not rely only on the headline score.

`eval-skill-use.yml` and the skill evaluation job in full E2E runs upload
skill-eval output:

- artifact name: `skill-eval-report`
- archive: `skill-eval-report.tar.gz`
- contains: `metrics.json` and `report.html`

Extract and inspect it with:

```bash
tar -xzf skill-eval-report.tar.gz
open skill-eval-report/report.html
```

Open `report.html` for the easiest human-readable summary. In `metrics.json`,
check whether every expected skill triggered, review each skill's uptake rate
and failed-check evidence, and confirm syntax and bundle build health. Checks
marked `not_applicable` are excluded rather than counted as failures.

In a full E2E run, iOS and skill evaluation run in parallel. The skill report's
optional app-evaluator outcome therefore normally remains `pending`/`null` even
when `run_eval_ios=true`; read the iOS score from `eval-out` separately.

The skill evaluator is an initial v0. Current signal is trace trigger detection,
static code uptake checks, and optional app-evaluator score if an eval artifact
is provided. It does not use an LLM judge, screenshots, or production-calibrated
classification yet.

### Muse authoring artifacts

The `authored-app` artifact contains `authored-app.tar.gz`. For a Muse Code run,
its normalized author trace is
`eval-out/<RUN_ID>/bundle/telemetry/traces/muse-code-authoring.json`. Muse talks
directly to its native Meta endpoint: routing it through the harness's generic
logging proxy caused model-catalog failures on EAS, while direct requests from
the same worker succeeded. The normalized native Muse session is therefore the
supported trace source. The bundle manifest records the `muse-code` agent,
selected model, and Muse CLI version. Raw Muse XDG session data and the installed
Muse binary are transient worker inputs and are excluded from the transport
archive.

## Debug Workflows

Use `author-app.yml` when you only want to test coding-agent setup, Expo skill
availability, or trace capture without spending macOS build minutes. No test
plan is needed for author-only runs.

```bash
eas workflow:run .eas/workflows/author-app.yml \
  -F agent=claude-code \
  -F prd=dataset/prds/notes/prd/mvp.txt
```

For Muse Code authoring only (no macOS evaluator), use:

```bash
eas workflow:run .eas/workflows/author-app.yml \
  -F agent=muse-code \
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

Language-independent behavioral properties live in
[the property catalog](test_properties.json), whose structure is defined by
[the catalog schema](test_properties.schema.json).

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

Run the canonical local type-check and test suite after changing harness code:

```bash
bun run test:all
```

For focused debugging, run the skill evaluator and iOS test-plan-resolution
tests separately:

```bash
bun test eval_harness/evaluator/skill_invocation/tests
PYTHONPATH=. uv run python -m unittest eval_harness.evaluator.ios_agentic.tests.test_test_plan_resolution
```

Validate EAS workflows:

```bash
node /Users/adityashukla/.codex/plugins/cache/openai-curated-remote/expo/1.0.2/skills/expo-cicd-workflows/scripts/validate.js .eas/workflows/*.yml
```
