# eval-experiments

EAS-native harness for evaluating coding agents (Claude Code, Codex) against the
Expo ecosystem. Two **independent** EAS workflows.

## Workflows

### 1. Coding-agent telemetry — `.eas/workflows/telemetry-smoke.yml` (linux)
Runs Claude Code + Codex headless and captures their telemetry:
- `proxy/logging-proxy.mjs` — transparent `base_url` passthrough proxy: full
  prompt/completion I/O, token usage, SSE streams (both agents; API key redacted in logs).
- Claude Code native OTEL (console exporter → file) + Codex native OTLP
  (`proxy/otlp-receiver.mjs`, captures tool-call events).

Orchestrated by `scripts/run-smoke.sh`. Telemetry is dumped to the job log
(EAS custom workflow jobs have no artifact channel).

### 2. Agentic evaluator — `.eas/workflows/eval-standalone.yml` (macOS)
Runs the agentic evaluator (`evaluator/`) against an app on a booted iOS simulator:
**agent-device** for UI interaction + **Maestro** for app lifecycle, scoring a
generic primitive plan against its `Verify:` lines (PRD injected at runtime).

Orchestrated by `scripts/setup-eval.sh`: installs agent-device + Maestro + uv,
`agent-device boot` + **`prepare ios-runner`**, starts Metro + Expo Go, runs the
REPL. Validated end-to-end: `notes × test_insert` → **6/6**.

## Layout
```
.eas/workflows/   telemetry-smoke.yml · eval-standalone.yml
scripts/          run-smoke.sh · setup-eval.sh
proxy/            logging-proxy.mjs · otlp-receiver.mjs
evaluator/        vendored subset of georgian-io/expo-evals (one primitive + notes app)
app.json·eas.json·package.json   minimal EAS-project anchor
env.default       template for the secret env vars
```

## Setup
1. **Link an EAS project**: `eas init` under your Expo account — writes
   `extra.eas.projectId` into `app.json` (intentionally absent here so the repo
   stands independent).
2. **Secrets**: copy `env.default` → `.env`, fill in keys, then push as **Secret**
   env vars: `eas env:push production --path .env`.
3. **Trigger** (use a **≥480s** client timeout — the upload-finalize step can be slow;
   call the `eas` binary directly if an `npx` wrapper hangs):
   ```
   eas workflow:run .eas/workflows/telemetry-smoke.yml
   eas workflow:run .eas/workflows/eval-standalone.yml
   ```

## Notes
- `evaluator/` is a **point-in-time vendored subset** of `georgian-io/expo-evals`
  (the `agentic_evaluator` package, the `notes` reference app, `test_insert`, the
  notes PRD). It carries a portability patch to `maestro/bridge.py` (respect env
  `JAVA_HOME` instead of a hardcoded local path) worth upstreaming.
- The two workflows are independent; wiring "agent builds app → evaluator scores it"
  is future work.
