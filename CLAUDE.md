# eval-experiments

EAS-native harness for evaluating coding agents (Claude Code, Codex) against the Expo ecosystem. Shared asset between **Georgian AI Lab** and **Expo** (D-26, Jun 2026).

## Repository layout

```
.eas/workflows/
  eval-standalone.yml   macOS-medium — boots iOS sim, runs agentic evaluator
  telemetry-smoke.yml   linux        — captures Claude Code + Codex telemetry
  eval-e2e.yml          author job + macOS eval job — END-TO-END pipeline
scripts/
  setup-eval.sh         eval runner (sources lib; standalone Expo Go path)
  run-smoke.sh          telemetry runner (sources lib for sidecars)
  author-app.sh         e2e authoring half (coding agent on linux)
  eval-authored-app.sh  e2e iOS half (downloaded app → native iOS build → eval)
  build-and-eval.sh     monolithic local/debug orchestrator (agent→build→eval)
  collect-artifacts.sh  bundles app + telemetry + result.json + manifest
  lib/eval-stages.sh    shared, sourced stage functions (install/boot/serve/eval/agent)
  agent/author-prompt.md  instruction template prepended to the PRD for the coding agent
  trace/codex_rollout.py  offline Codex rollout → normalized turns/steps/tools (vendored)
  trace/cc_transcript.py  offline Claude Code transcript → same normalized shape
  trace/bt_emit.py        optional Braintrust push of reconstructed agent/evaluator sessions
  trace/eval_trace_bt.py  gated legacy Braintrust mirror of evaluator trace dirs
proxy/
  logging-proxy.mjs     transparent base_url proxy — logs full prompt/completion I/O
  otlp-receiver.mjs     OTLP receiver for Codex tool-call events
evaluator/              vendored subset of georgian-io/expo-evals
  src/agentic_evaluator/
  prds/hot_chocolate/prd/mvp.txt
  prds/notes/prd/mvp.txt
  test_plans/primitives/  app-agnostic primitive suite
  reference_apps_notes/   notes reference app (standalone regression target)
env.default             template for secret env vars
```

## Current state

| Workflow | Status |
|---|---|
| `eval-standalone.yml` (macOS) | Validated end-to-end: `notes × test_insert → 6/6` |
| `telemetry-smoke.yml` (linux) | Smoke-captures agent telemetry |
| `eval-e2e.yml` (author + macOS eval) | **NEW** — modular EH I / T-1: coding-agent job authors the app on Linux → macOS job downloads it, builds a native iOS simulator app, evaluator scores the primitive suite → EAS artifacts, correlated by `run_id`. Default benchmark is Hot Chocolate on Expo SDK 57.x; no SDK image pin. |

`eval-standalone.yml` and `telemetry-smoke.yml` remain **independent** building blocks; `setup-eval.sh` and `run-smoke.sh` now source `scripts/lib/eval-stages.sh` so their stages are shared, not duplicated. `eval-e2e.yml` is the wired end-to-end pipeline built on top — see "Workstream D" below.

---

## Workstream A — Agentic evaluator

### Architecture

```
main.py (CLI)
  → AgentDeviceEvaluator (evaluator/src/agentic_evaluator/agent_device/evaluator.py)
      AgentDeviceBridge   (bridge.py)        xcrun simctl + agent-device CLI
      build_tools(ctx)    (tools.py)         MCP tools exposed to the LLM
      build_system_prompt (prompt_agent.py)  scoring contract + iOS rules
      score_step()        (scoring.py)       partial credit over assertions
```

**Execution flow:**
1. `restart_app(clear_state=True)` — terminate/clear the target app, relaunch via the active bridge mode, then poll for readiness. Expo Go/hybrid mode uses `exp://localhost:8081`; native E2E mode launches the generated bundle id directly.
2. **Seed phase** (unscored): PRD injected once here; agent sets up app state per `<seeding_and_precondition>`. N/A short-circuit: if seed `complete_step` starts with "N/A:", skip formal steps entirely.
3. **Formal steps loop** (scored): one `client.query()` per `<step>`; agent uses MCP tools, records assertions, calls `complete_step`.
4. **`score_step()`** → `StepResult` → `result.json`

### Key architectural patterns

**Bridge pattern** — evaluator calls `ctx.bridge.*`, never the CLI directly. Swapping drivers = swap the bridge. Don't break this.

**Generic test plans + PRD injection** — test plans are app-agnostic (e.g. `test_insert.txt` works for any app with creatable records). PRD is injected via `--prd`; the LLM maps abstract `Verify:` lines onto the app's actual UI using the PRD.

**Hard vs soft assertions**
- Hard: `assert_visible`/`assert_not_visible` — engine actually calls `agent-device is visible id="..."`. Use when a stable React Native `testID` exists.
- Soft: `record_soft_assertion` — LLM reads the AT and judges. Use when no driver tool can structurally check the property (element type/value, geometry, color/styling).

**Scoring contract**
- Fatal failure (any hard or soft assertion with `fatal=true` fails) → **0 pts** for the step
- Otherwise: `earned = max_points × (passing_assertions / total_assertions)` (rounded)
- `max_points` for a step = count of `Verify:` lines (1 point per verify line)

**1:1 assertion rule** — one assertion per `Verify:` line. Splitting a bullet into two assertions or merging two into one corrupts partial credit. Total assertions recorded must equal total `Verify:` lines. This is a scoring invariant.

**N/A short-circuit** — seed phase `complete_step("N/A: ...")` triggers `result.not_applicable = True`; formal steps are skipped. Prevents structural zeros for primitives the app doesn't implement.

**Restart modes** — `--hybrid-restart` uses Maestro for Expo Go lifecycle and agent-device for interactions. Native restart uses agent-device/simctl with `EVAL_APP_BUNDLE_ID` and is the default E2E path for authored native apps.

**claude_agent_sdk** — the evaluator uses `ClaudeSDKClient` + `ClaudeAgentOptions` from `claude_agent_sdk`, not the raw Anthropic API. Tools are exposed as an MCP server via `create_sdk_mcp_server()`. The `permission_mode="bypassPermissions"` is intentional.

### Test plan format

```xml
<test_plan>
  <purpose>...</purpose>
  <seeding_and_precondition>
    Instructions for setting up app state. Use "N/A" if no setup needed.
    If the primitive doesn't apply: complete_step("N/A: reason")
  </seeding_and_precondition>
  <steps>
    <step>
      <name>snake_case_step_name</name>
      Description of what to do and verify.
      Verify:
      - The primary thing that must be true (fatal by default)
      - (non-fatal) A secondary check worth partial credit
      <points>3</points>
    </step>
  </steps>
  <full_points>6</full_points>
</test_plan>
```

`<points>` is the max for partial credit. Set it equal to the count of `Verify:` bullets (1 point per verify). The evaluator derives partial credit from the Verify line count, not the points value — these should match.

### Load-bearing prompt rules

These are in `prompt_agent.py` for hard-earned reasons. Violating them causes scoring bugs:

1. **One assertion per Verify line** — splitting or merging corrupts partial credit
2. **Prefer hard over soft** — soft only when no driver tool can structurally check the property
3. **Justify every soft** — `evidence` must include a why-soft reason (not just the AT content)
4. **Hard-then-soft is NOT two assertions** — pick ONE strategy per Verify line; a failed hard attempt doesn't get a soft companion
5. **Snapshot refs (`@eN`) are fragile** — use stable `id=` testIDs; fall back to soft for iOS native UI (UIAlertController, system sheets)
6. **Never call `complete_step` early** — all verifications must be recorded first; the orchestrator cannot go back

### result.json shape

```json
{
  "test_overview": "Adaptive evaluation: 1 test plan(s), macro avg 83.33% (micro 83.33%, 5/6 points)",
  "score": 5,
  "full_points": 6,
  "macro_avg_pct": 83.33,
  "micro_pct": 83.33,
  "n_not_applicable": 0,
  "test_plans": [
    {
      "test_plan": "test_insert.txt",
      "run_index": 1,
      "score": 5,
      "full_points": 6,
      "macro_pct": 83.33,
      "steps": [
        {
          "description": "PASSED: test_create_affordance_opens_creation_surface",
          "points": 3,
          "max_points": 3,
          "iterations": 8,
          "hard_assertions": 2,
          "soft_assertions": 1
        }
      ]
    }
  ]
}
```

`macro_avg_pct` = mean of per-step percentages. `micro_pct` = total_score/total_full_points. `n_not_applicable` counts N/A short-circuit plans.

### Running locally

Prerequisites: iOS simulator booted, Metro running on `:8081`, app loaded in Expo Go.

```bash
cd evaluator
uv run python -m agentic_evaluator.main \
    test_plans/primitives \
    --prd prds/hot_chocolate/prd/mvp.txt \
    -d agent-device --hybrid-restart \
    --seed-iterations 200 --max-iterations 50 \
    -o /tmp/result.json --verbose
```

The evaluator accepts either one test-plan file or a directory. Directory mode runs sorted `test*.txt` files, with N/A short-circuit for primitives that do not apply. The evaluator does NOT start Metro. It assumes the app is already Metro-served. The initial `restart_app(clear_state=True)` relaunches via `exp://localhost:8081` and waits up to 30s for app readiness in the Expo Go path.

### bridge.py gotchas

- **`fill()` does explicit focus first**: `agent-device press id=` → 0.3s sleep → `agent-device fill id= text`. This is intentional — without the explicit tap, `fill` sometimes types into the wrong field.
- **`assert_not_visible` on absent elements**: when the element is absent from the tree (not just hidden), `agent-device is hidden id=` returns error "Selector did not match". The bridge treats this as a PASS. Don't fight this behavior.
- **`erase_text`**: long-press → Select All → Cut. `fill` with empty string is NOT supported by agent-device; always use `erase_text` to clear a field.
- **AgentDeviceRunner foregrounded**: if agent-device's helper process takes over the foreground, `capture_hierarchy()` detects it and calls `agent-device open host.exp.Exponent` to rebind. Don't terminate the WDA xctrunner manually — it disrupts the session.

---

## Workstream B — EAS workflows + eval infrastructure

### eval-standalone.yml (macOS)

Trigger: `eas workflow:run .eas/workflows/eval-standalone.yml` (use ≥480s client timeout)

`setup-eval.sh` runs 7 gated stages:
1. Install `agent-device@0.17.6`
2. Install Maestro
3. Install `uv` + Python 3.12 + evaluator deps
4. `agent-device boot` + `prepare ios-runner` (installs XCTest runner — required for snapshots)
5. Notes app `npm install`
6. Start Metro + load in Expo Go + probe snapshot (stage 6b)
7. Run evaluator (notes × test_insert, hybrid-restart, seed=200, max=50)

**JAVA_HOME fix** (critical): the EAS worker's `JAVA_HOME` points at a nonexistent openjdk@21 path. `setup-eval.sh` re-points it: `export JAVA_HOME="$(/usr/libexec/java_home -v 17 2>/dev/null || /usr/libexec/java_home 2>/dev/null)"`. Without this, Maestro hybrid restart fails entirely.

Stage output is written to `eval-out/`; the workflow packages it as `eval-out.tar.gz` and uploads it as a generic EAS artifact.

The script never exits non-zero mid-stage (intentional — learns as much as possible per run). Each stage prints `✅ STAGE OK` or `❌ STAGE FAIL`.

### portability patch

`evaluator/maestro/bridge.py` respects `JAVA_HOME` from env instead of a hardcoded local path. This is a delta from `georgian-io/expo-evals` that enables the EAS workflow. Worth upstreaming.

---

## Workstream C — Telemetry (telemetry-smoke.yml)

`telemetry-smoke.yml` (linux) runs Claude Code + Codex headless and captures telemetry:
- `proxy/logging-proxy.mjs` — transparent `base_url` passthrough, logs full prompt/completion I/O, strips API keys
- `proxy/otlp-receiver.mjs` — OTLP receiver for Codex tool-call events

Output: packaged as `telemetry.tar.gz` and uploaded as a generic EAS artifact; the job log remains a quick text backstop.

---

## Workstream D — End-to-end harness (eval-e2e.yml)

The wired EH I pipeline (T-1). `eval-e2e.yml` is now a two-job workflow, all correlated by one `RUN_ID`:

```
author_app (linux-medium)
A. install coding-agent CLI + uv trace deps + secret diag
B. launch authoring telemetry sidecars + set EXIT trap (collector always runs)
       anthropic logging proxy :8082   (8081 is Metro's — note the move from run-smoke)
       openai logging proxy   :8083    (only when AGENT=codex)
       OTLP receiver          :4318    (best-effort native OTEL)
C. coding agent authors the app into agent-workspace/$RUN_ID
       claude -p "<author-prompt + PRD>"  (AGENT=codex → codex exec)
       Expo skills+MCP via:  claude plugin marketplace add anthropics/claude-plugins-official
                              claude plugin install expo@claude-plugins-official
                              codex npx -y skills add expo/skills
                              optional Codex Expo MCP if EXPO_MCP_BEARER_TOKEN is set
       model I/O → :8082 proxy; OTEL → :4318; OTEL_RESOURCE_ATTRIBUTES=run.id=…,phase=agent-build
D. author-side validation runs `npm install`, `npx expo install --check`,
       an artifact-like clean `npm install`, and `npx expo config --json`; if it fails,
       the same agent gets the validation logs and up to 2 repair passes before upload
E. workflow uploads authored-app artifact (agent-workspace/ + eval-out/, excluding node_modules)

eval_ios (macos-medium)
F. download authored-app artifact
G. install iOS/evaluator toolchain (agent-device, Maestro, uv+evaluator)
H. HARNESS (not the agent) builds + launches the workspace
       npm install → resolve bundleId+scheme via `expo config`
       → expo run:ios --configuration Release → probe snapshot
       (dev-client mode remains available as an opt-in fallback)
I. evaluator scores it  (phase=evaluate)
       NATIVE restart (not --hybrid-restart) so EVAL_APP_BUNDLE_ID / EVAL_APP_DEEP_LINK apply
J. collect (via trap): app tree + proxy JSONL + reconstructed traces + eval traces
       + result.json + manifest.json → tar; workflow uploads eval-out.tar.gz; optional GCS mirror
```

### Key design points

- **SDK policy.** New benchmark PRDs should name the intended stable Expo SDK explicitly (currently SDK 57.x). The notes PRD now targets SDK 57.x, so `eval-e2e.yml` no longer pins the old SDK 52 image and lets the macOS workflow use the current default image. If we evaluate older SDK PRDs later, choose an SDK-compatible image per benchmark rather than silently floating.
- **Native app only.** The agent may add native modules, so the harness always does `expo run:ios` (not Expo Go). The default E2E path now uses a release simulator app (`ios_app_mode=release`) because it launches like the final app and avoids dev-client launcher state. Dev-client mode remains available for debugging and uses `EVAL_APP_BUNDLE_ID` / `EVAL_APP_DEEP_LINK` overrides to launch by bundle id plus the captured dev-client URL. The Maestro hybrid path stays Expo-Go-specific and is unused here.
- **Author validation first.** The author job now catches bad generated dependency sets before macOS eval spends minutes in CocoaPods/Xcode. It runs `npm install`, `npx expo install --check`, an artifact-like clean `npm install`, and `npx expo config --json`; failures are fed back to the same coding agent for bounded repair passes. The clean reinstall exists because an in-place author install can pass while the uploaded app's lockfile fails immediately on the eval worker (observed as `npm error Invalid Version:`). The artifact excludes `node_modules`, so the eval job still performs its own clean install before the native build and stops early with diagnostics if that fails.
- **Dev-client restart handshake.** In opt-in `ios_app_mode=dev-client`, do not synthesize the dev-client URL from `scheme` + localhost. `expo run:ios` prints the URL it actually opens (for example `exp+notes-app://expo-development-client/?url=http%3A%2F%2F192.168.x.x%3A8081`); the harness captures that from `s6-devbuild.log` and exports it as `EVAL_APP_DEEP_LINK`. Because lifecycle uses `simctl openurl` but UI uses agent-device, the dev-client path must bind the agent-device session back to the app (`agent-device open <bundle-id>` / `_rebind_session()`) after opening the deep link and before snapshotting/readiness polling. iOS may also show an `Open in ...?` confirmation for the dev-client URL; the probe and bridge readiness loop dismiss it by pressing `Open`. `EVAL_APP_READY_TIMEOUT_SEC=120` remains set for EAS.
- **Telemetry = proxy + offline reconstruction (native OTEL is best-effort).** The logging proxy on :8082 captures both the authoring agent's and evaluator-judge's Anthropic I/O (the judge inherits `ANTHROPIC_BASE_URL`); evaluator collection is separated by `TRACE_PHASE=evaluate` plus trace file mtimes. Execution structure (turns→steps→tools) is reconstructed at **collection time** from session logs — `trace/cc_transcript.py` (Claude Code `~/.claude/projects/**`) and `trace/codex_rollout.py` (Codex `$CODEX_HOME/sessions/**`, vendored from `codex_bt_hook.py`). Run offline, not as a live hook — nothing left running on the worker. If `BRAINTRUST_API_KEY` is set, authoring traces are named `Claude Code Authoring Session` / `Codex Authoring Session`, evaluator Claude SDK conversations are named `Agentic Evaluator Session`, and all default to Braintrust project `expo-evals` (`BRAINTRUST_PROJECT`, `BRAINTRUST_CC_PROJECT`, `BRAINTRUST_EVAL_PROJECT` override). The separate `eval_trace_bt.py` "Evaluator Run" mirror is gated by `PUSH_EVAL_TRACE_BT=1` and is off by default to avoid duplicate traces.
- **Modular worker split.** The boundary is the `authored-app` EAS artifact, then final `eval-e2e-output`. Authoring runs on `linux-medium`; iOS build/eval stays on `macos-medium`.
- **Exfil.** The workflow uploads `authored-app` after the authoring job and `eval-e2e-output` after the iOS evaluation job as EAS generic artifacts (`type: other`). GCS via `GCS_BUCKET`/`GCP_SA_KEY` remains an optional mirror keyed by `RUN_ID`; a capped stdout dump of `manifest.json`+`result.json`+trace indexes is the always-on text backstop.
- **Artifact download quirk.** `eas/download_artifact` may expose `artifact_path` as an already-extracted directory rather than the uploaded tar file. Keep unpack steps robust for three shapes: tar file, directory containing the tar file, or directory already containing `agent-workspace/` + `eval-out/`.
- **Shared stages.** `build-and-eval.sh`, `setup-eval.sh`, and `run-smoke.sh` all source `scripts/lib/eval-stages.sh`. `eval::run_evaluator` no longer hardcodes `--hybrid-restart` — callers pass it (Expo Go path) or omit it (native release/dev-client paths).

### Running

```bash
eas env:push production --path .env     # ANTHROPIC_API_KEY (+ optional OPENAI/GCS/Braintrust)
eas workflow:run .eas/workflows/eval-e2e.yml
# local: RUN_ID=local AGENT=claude EVAL_IOS_APP_MODE=release bash scripts/build-and-eval.sh
```

Env knobs: `AGENT={claude|codex}` (default claude), `AGENT_MODEL` (default `sonnet` for Claude Code, `gpt-5-mini` for Codex), `PRD`, `TEST_PLAN`, `GCS_BUCKET`, `GCP_SA_KEY`, `BRAINTRUST_API_KEY`, `BRAINTRUST_PROJECT`, `BRAINTRUST_CC_PROJECT`, `BRAINTRUST_EVAL_PROJECT`, `PUSH_EVAL_TRACE_BT`, `RUN_ID`.

### Flagged uncertainties (validate on first real run)

- `expo run:ios --configuration Release` time on `macos-medium` with SDK 57 generated apps (may need `ios/` caching). The Hot Chocolate primitive-suite runs on 2026-07-02 are the first broad benchmark attempt.
- Cross-job artifact handoff (`authored-app` upload/download) works for the Codex Hot Chocolate run `019f2111-e1f7-715c-97be-7d7bc3329743`; keep validating final `eval-e2e-output` upload on failed and successful eval jobs.
- Linux authoring is usable on the Enterprise plan; keep watching queue behavior and job startup latency.
- Release-app restart with agent-device is validated by Notes control run `019f243c-4a7c-7ee0-bb23-0e8be8a73343`, which scored 6/6 and uploaded both authored-app and eval-e2e-output artifacts. Dev-client deep-link/scheme handshake is validated by replay `019f2043-80a8-7b37-b869-224ae14ded3d`.
- Whether the Expo plugin attaches to a headless `claude -p` run on the worker (else the agent works from prompt+PRD alone). Codex Expo skills install now uses `npx -y skills add expo/skills`; Expo MCP is auth-gated and only configured when `EXPO_MCP_BEARER_TOKEN` is set.
- Whether long Claude Code authoring runs need an explicit timeout/heartbeat; the first Hot Chocolate Claude run entered authoring at 2026-07-02T04:24:45Z with no further log output at last check.

---

## Dataset

Current PRD: `evaluator/prds/hot_chocolate/prd/mvp.txt` (festival guide — flavours, locations, map, favourites/tasted state, filters, native sharing)

Current test plans: `evaluator/test_plans/primitives/` (app-agnostic primitive suite; non-applicable primitives should N/A-skip in seed)

Regression PRD: `evaluator/prds/notes/prd/mvp.txt` (notes reference app — password gate + notes list + CRUD + search + delete)

PRD design follows the **spectrum** principle (D-32): from high-level (no expo guidance) to explicit-expo-direction. This establishes ground truth for how the Expo plugin performs across different user types.

---

## Shared ownership

- **Georgian**: ML/analysis, eval metrics, scoring contracts, dataset construction (PRDs + test plans), evaluator evolution
- **Expo**: EAS workflows, macOS runners, simulator service, Harbor (long-term parallel)
- Repo is at `github.com/expo/eval-experiments` — owned by Expo, open to both teams (D-26)

---

## Don't do these

- **Don't hardcode `JAVA_HOME` as a fixed path** — use `$(/usr/libexec/java_home -v 17)`. The EAS worker Java version can change.
- **Don't call `complete_step` before all Verify lines have assertions** — the orchestrator won't go back
- **Don't record more assertions than Verify lines** — the 1:1 rule is a scoring invariant
- **Don't record both a failed hard assertion AND a soft assertion for the same Verify line** — that double-counts
- **Don't invoke the app yourself in a step** — call `restart_app`; let the bridge handle lifecycle
- **Don't use snapshot refs (`@eN`) for hard assertions when a stable `id=` testID exists** — refs are transient
- **Don't run the evaluator against an app that isn't Metro-served** — `restart_app` polls for testIDs; an app without the bundle just never becomes "ready"
- **Don't terminate `com.facebook.WebDriverAgentRunner.xctrunner` manually** — this invalidates agent-device's session state, causing a 15-20s rebuild

---

## Glossary

| Term | Meaning |
|------|---------|
| `agent-device` | Callstack CLI for iOS simulator UI interaction (AT snapshot, tap, fill, assert). Session: `adaptive`. |
| Maestro | YAML-based mobile test runner. Used only for Expo Go lifecycle path (`restart_app`, clearState) in hybrid mode. |
| `hybrid-restart` | `--hybrid-restart` flag: Maestro handles Expo Go `restart_app`, agent-device handles all interactions. Native E2E release mode does not use it. |
| Bridge | The `AgentDeviceBridge` class — abstraction between evaluator and CLI tools. Swap it to change drivers. |
| Seed phase | Unscored pre-flight that sets up app state. PRD injected here once for the conversation. |
| N/A short-circuit | Seed phase signals `complete_step("N/A: ...")` → formal steps skipped, plan marked not_applicable. |
| Hard assertion | Engine-verified: `assert_visible`/`assert_not_visible`. Requires a stable testID. |
| Soft assertion | LLM-judged: `record_soft_assertion`. Used for type/value/geometry/style checks. |
| PRD | Product Requirements Document — gives the LLM app-specific context for a generic test plan. |
| PRD spectrum | D-32: range from no-expo-guidance to explicit-expo-direction as dataset design axis. |
| testID | React Native `testID` prop → iOS accessibilityIdentifier → shows as `id="..."` in AT snapshot. |
| `eval-out/` | Job output directory. Packaged as `eval-out.tar.gz` and uploaded as a generic EAS artifact. |
| EH I / EH II / EH III | Evaluation Harness phases: I=ad-hoc offline, II=CI/CD, III=agent OTEL in user environment. |
