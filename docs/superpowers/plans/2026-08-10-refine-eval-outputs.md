# Refined Single-Run Eval Outputs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one EAS E2E dispatch produce clean author, skill, iOS, and consolidated artifacts with configurable high-effort models, deterministic human screenshot evidence, structured build health, and one polished offline report.

**Architecture:** Preserve `eval-e2e.yml` as a one-cell orchestrator: author once, run skill and iOS evaluation in parallel, then normalize their artifacts in a final Linux report job. Migrate writers to canonical v2 artifact layouts while keeping readers compatible with old artifacts. Keep scoring and screenshots independent: the evaluator scores accessibility/assertion evidence, while the harness captures screenshots after terminal steps for human review.

**Tech Stack:** EAS Workflows YAML, Bash 3.2-compatible shell, Bun/TypeScript, Python 3.12, Claude Agent SDK, Expo/React Native iOS tooling, static offline HTML/CSS.

## Global Constraints

- One `eval-e2e.yml` dispatch remains one harness/model × PRD × prompt × skill-scenario cell.
- Author model defaults stay `sonnet`, `gpt-5-mini`, and `muse-spark-1.2`; explicit experiment models pass through unchanged.
- Author and evaluator reasoning default to `high`; accepted workflow values are `low`, `medium`, and `high`.
- The iOS evaluator defaults to `claude-opus-4-8` and uses adaptive thinking at the selected effort.
- Active runtime paths are `author-agent-workspace/`, `author-agent-metadata/`, `ios-eval-report/`, and `skill-eval-report/`.
- EAS artifact names are `authored-app`, `skill-eval-report`, `ios-eval-report`, and `eval-report`.
- Every artifact has one root `manifest.json`; every producer result has one authoritative location; no scratch directory or nested transport archive is uploaded.
- Only `authored-app` contains authored source. The iOS artifact contains no author trace or source.
- Old `agent-workspace`, `eval-out`, and `bundle/app` artifacts remain readable.
- `telemetry/` contains provider/OTLP data; `logs/` contains stage stdout/stderr.
- Screenshots are human postmortem context, never evaluator-visible pixel evidence or a scoring input.
- Capture one final-state PNG after each formal step reaches a terminal completed or aborted state; do not add screenshot-size metrics or retention caps yet.
- Preserve the negative-control skill scenario and all credential-exclusion rules.
- Do not add lint as a build-health gate.

---

## File Map

### New files

- `dataset/prompts/realistic.md` — approved middle-ground product prompt.
- `eval_harness/utils/artifacts/collect_author_artifact.sh` — constructs the canonical author artifact directory and manifest.
- `eval_harness/utils/artifacts/collect_ios_artifact.sh` — constructs the canonical iOS artifact directory and manifest.
- `eval_harness/utils/artifacts/package_artifact.sh` — creates one tarball and optionally mirrors that same tarball to GCS.
- `eval_harness/evaluator/reporting/types.ts` — stable consolidated summary and build-health types.
- `eval_harness/evaluator/reporting/normalize.ts` — safe artifact discovery, normalization, and referenced-screenshot copying.
- `eval_harness/evaluator/reporting/render.ts` — escaped static HTML renderer.
- `eval_harness/evaluator/reporting/main.ts` — report CLI.
- `eval_harness/evaluator/reporting/tests/reporting.test.ts` — normalizer, security, and renderer tests.
- `eval_harness/evaluator/reporting/tests/fixtures/` — minimal v2 author, skill, and iOS fixture trees.

### Files substantially modified

- `eval_harness/utils/shell/agents.sh` — reasoning validation and harness-specific effort mapping.
- `eval_harness/app_builder/scripts/author-app.sh` — renamed runtime roots, stage statuses, author collector.
- `eval_harness/evaluator/ios_agentic/scripts/eval-ios-app.sh` — v2 input/output roots, evaluator model/effort, stage statuses, iOS collector.
- `eval_harness/evaluator/ios_agentic/agent_device/{bridge.py,evaluator.py,tools.py}` — durable discretionary screenshots and deterministic terminal-step captures.
- `eval_harness/evaluator/ios_agentic/{main.py,report.py}` and `core/scoring.py` — model/effort plumbing and public assertion/screenshot detail.
- `eval_harness/evaluator/ios_agentic/prompts/prompt_agent.py` — screenshot human-evidence limitation.
- `eval_harness/evaluator/skill_invocation/{main.ts,analysis.ts,utils.ts}` — scratch cleanup, v2 discovery, manifest.
- `.eas/workflows/{eval-e2e.yml,author-app.yml,eval-ios-app.yml,eval-skill-use.yml}` — inputs, names, packagers, report job.
- `README.md`, `dataset/prompts/README.md`, and `AGENTS.md` — durable usage and artifact contracts.

### Files removed after replacement

- `eval_harness/utils/artifacts/collect_artifacts.sh` — phase-mixing collector that creates stitched duplicate bundles.
- `eval_harness/utils/tests/test_collect_artifacts.py` — replaced by phase-specific collector tests in the same test package.

---

### Task 1: Add the realistic prompt and model/effort controls

**Files:**
- Create: `dataset/prompts/realistic.md`
- Modify: `dataset/prompts.json`
- Modify: `dataset/prompts/README.md`
- Modify: `eval_harness/utils/shell/agents.sh`
- Modify: `eval_harness/app_builder/scripts/author-app.sh`
- Modify: `eval_harness/evaluator/ios_agentic/agent_device/evaluator.py`
- Modify: `eval_harness/evaluator/ios_agentic/main.py`
- Modify: `eval_harness/evaluator/ios_agentic/scripts/eval-ios-app.sh`
- Test: `eval_harness/utils/tests/test_resolve_prompt.py`
- Test: `eval_harness/utils/tests/muse_authoring.test.ts`
- Test: `eval_harness/evaluator/ios_agentic/tests/test_agent_device_evaluator.py`
- Test: `eval_harness/evaluator/ios_agentic/tests/test_main_results.py`

**Interfaces:**
- Produces: `eval::resolve_reasoning_effort <requested>` → `low|medium|high` or exit 2.
- Produces: `eval::run_coding_agent ... <model> <reasoning_effort> [muse_key]`.
- Produces: evaluator CLI options `--model` and `--reasoning-effort`.
- Produces: manifest-ready variables `AGENT_REASONING_EFFORT`, `EVALUATOR_MODEL`, and `EVALUATOR_REASONING_EFFORT`.

- [ ] **Step 1: Write failing prompt and shell tests**

Add an exact prompt assertion and effort matrix:

```python
def test_realistic_prompt_is_registered_verbatim(self) -> None:
    result = run_resolve(PROMPT_VARIANT="realistic")
    self.assertEqual(result.returncode, 0, result.stderr)
    self.assertEqual(result.stdout.strip(), "dataset/prompts/realistic.md")
    self.assertEqual(
        (ROOT / result.stdout.strip()).read_text().strip(),
        "Can you build this as an Expo app based on the product brief below?\n"
        "I want the core experience to feel complete, with the main actions easy to find and the important details handled thoughtfully.\n"
        "It should feel polished enough to give to a real user, not like a demo or rough prototype.",
    )
```

```ts
test("reasoning effort defaults high and rejects unsupported values", () => {
  const ok = runBash(`source "$0"; printf '%s|%s|%s|%s' \
    "$(eval::resolve_reasoning_effort '')" \
    "$(eval::resolve_reasoning_effort low)" \
    "$(eval::resolve_reasoning_effort medium)" \
    "$(eval::resolve_reasoning_effort high)"`);
  expect(output(ok)).toBe("high|low|medium|high");
  expect(runBash(`source "$0"; eval::resolve_reasoning_effort ultra`).exitCode).toBe(2);
});
```

- [ ] **Step 2: Run focused tests and confirm failure**

Run:

```bash
PYTHONPATH=. uv run --group test python -m unittest eval_harness.utils.tests.test_resolve_prompt
bun test eval_harness/utils/tests/muse_authoring.test.ts
```

Expected: prompt lookup fails for `realistic`; effort function is missing.

- [ ] **Step 3: Add the prompt and registry entry**

Create `dataset/prompts/realistic.md` with the approved three lines and register:

```json
"realistic": {
  "file": "prompts/realistic.md",
  "description": "A concise, conversational product request that asks for a complete, discoverable, polished Expo experience without baseline's technical build instructions."
}
```

- [ ] **Step 4: Implement provider-specific author effort mapping**

Add:

```bash
eval::resolve_reasoning_effort() {
  case "${1:-high}" in
    low|medium|high) printf '%s\n' "${1:-high}" ;;
    *) echo "unsupported reasoning effort: $1 (expected low, medium, or high)" >&2; return 2 ;;
  esac
}
```

Pass the resolved value through authoring and emit:

```bash
claude -p "$prompt" --model "$model" --effort "$reasoning_effort" ...
codex config: model_reasoning_effort = "$reasoning_effort"
muse exec ... --model "$model" --reasoning-effort "$reasoning_effort" ...
```

Append shell-escaped `AGENT_REASONING_EFFORT` to `author.env`.

- [ ] **Step 5: Write failing evaluator model/effort tests**

Patch `ClaudeAgentOptions` in the evaluator test and assert:

```python
self.assertEqual(options.model, "claude-opus-4-8")
self.assertEqual(options.effort, "high")
self.assertEqual(options.thinking, {"type": "adaptive"})
```

Add CLI parsing assertions for `--model claude-opus-4-8 --reasoning-effort high`.

- [ ] **Step 6: Implement evaluator model/effort plumbing**

Add constructor fields and CLI args, then replace the fixed thinking cap:

```python
options = ClaudeAgentOptions(
    ...,
    model=self.model,
    effort=self.reasoning_effort,
    thinking={"type": "adaptive"},
)
```

Default to `claude-opus-4-8` and `high` at the CLI boundary and pass the values from `eval-ios-app.sh`.

- [ ] **Step 7: Run focused tests and commit**

Run:

```bash
PYTHONPATH=. uv run --group test python -m unittest \
  eval_harness.utils.tests.test_resolve_prompt \
  eval_harness.evaluator.ios_agentic.tests.test_agent_device_evaluator \
  eval_harness.evaluator.ios_agentic.tests.test_main_results
bun test eval_harness/utils/tests/muse_authoring.test.ts
```

Expected: PASS.

```bash
git add dataset/prompts eval_harness/utils/shell/agents.sh \
  eval_harness/app_builder/scripts/author-app.sh \
  eval_harness/evaluator/ios_agentic
git commit -m "feat: configure eval models and reasoning"
```

### Task 2: Replace the stitched bundle with canonical author and iOS artifacts

**Files:**
- Create: `eval_harness/utils/artifacts/collect_author_artifact.sh`
- Create: `eval_harness/utils/artifacts/collect_ios_artifact.sh`
- Create: `eval_harness/utils/artifacts/package_artifact.sh`
- Delete: `eval_harness/utils/artifacts/collect_artifacts.sh`
- Modify: `eval_harness/app_builder/scripts/author-app.sh`
- Modify: `eval_harness/evaluator/ios_agentic/scripts/eval-ios-app.sh`
- Create: `eval_harness/utils/tests/test_author_artifact.py`
- Create: `eval_harness/utils/tests/test_ios_artifact.py`
- Delete: `eval_harness/utils/tests/test_collect_artifacts.py`
- Test: `eval_harness/utils/tests/muse_authoring.test.ts`

**Interfaces:**
- Produces: extracted `authored-app/` v2 tree with root manifest, workspace, metadata, author trace, telemetry, and logs.
- Produces: extracted `ios-eval-report/` v2 tree with root result/report, overall and plan traces, telemetry, and logs.
- Produces: `package_artifact.sh <source_dir> <archive_path> <gcs_object_name>`; one archive is used for EAS and optional GCS.

- [ ] **Step 1: Write failing canonical-layout tests**

Assert exact positive and negative paths:

```python
self.assertTrue((artifact / "manifest.json").is_file())
self.assertTrue((artifact / "author-agent-workspace" / run_id / "package.json").is_file())
self.assertTrue((artifact / "author-agent-metadata" / run_id / "telemetry" / "traces" / "muse-code-authoring.json").is_file())
self.assertFalse((artifact / "bundle").exists())
self.assertFalse(any(artifact.rglob("*.tgz")))
```

```python
self.assertTrue((artifact / "result.json").is_file())
self.assertTrue((artifact / "report.html").is_file())
self.assertTrue((artifact / "traces" / "agentic-evaluator.json").is_file())
self.assertTrue((artifact / "traces" / "test-plans" / "test_insert_20260810" / "summary.json").is_file())
self.assertFalse((artifact / "author-agent-workspace").exists())
self.assertFalse(any(artifact.rglob("claude-code-authoring.json")))
```

- [ ] **Step 2: Run the artifact tests and confirm failure**

Run:

```bash
PYTHONPATH=. uv run --group test python -m unittest \
  eval_harness.utils.tests.test_author_artifact \
  eval_harness.utils.tests.test_ios_artifact
```

Expected: FAIL because the phase-specific collectors do not exist.

- [ ] **Step 3: Implement the author collector and renamed runtime roots**

In `author-app.sh`, set:

```bash
WORKSPACE_ROOT="$ROOT/author-agent-workspace"
METADATA_ROOT="$ROOT/author-agent-metadata"
WORKSPACE="$WORKSPACE_ROOT/$RUN_ID"
OUT="$METADATA_ROOT/$RUN_ID"
ARTIFACT_ROOT="$ROOT/authored-app"
```

The EXIT collector reconstructs only the selected author trace, removes harness-owned secret/settings directories, writes one root manifest, and moves the two runtime roots under `authored-app/`. Exclude `node_modules`, `.expo`, native build outputs, `.mcp.json`, Codex state databases, Muse XDG data, and installed Muse binaries.

- [ ] **Step 4: Implement the iOS collector**

Make `eval-ios-app.sh` read v2 author paths first and old paths second. Write directly to:

```bash
OUT="$ROOT/ios-eval-report"
WORKSPACE="$ROOT/author-agent-workspace/$RUN_ID"
```

The iOS collector copies each producer-owned item once:

```text
manifest.json
result.json
report.html
traces/agentic-evaluator.json
traces/test-plans/<plan-run>/...
telemetry/anthropic.jsonl
telemetry/otel/
logs/
```

Do not reconstruct or retain the author trace on the macOS worker.

- [ ] **Step 5: Implement one-archive packaging and GCS mirroring**

Use a validated explicit source directory:

```bash
package::artifact() { # source_dir archive_path gcs_object_name
  tar -czf "$archive_path" -C "$source_dir" .
  if [ -n "${GCS_BUCKET:-}" ]; then
    gcloud storage cp "$archive_path" "gs://$GCS_BUCKET/$gcs_object_name"
  fi
}
```

Preserve current best-effort GCS behavior and service-account cleanup. Never create a nested `<run-id>.tgz`.

- [ ] **Step 6: Run artifact and Muse credential-exclusion tests**

Run:

```bash
PYTHONPATH=. uv run --group test python -m unittest \
  eval_harness.utils.tests.test_author_artifact \
  eval_harness.utils.tests.test_ios_artifact
bun test eval_harness/utils/tests/muse_authoring.test.ts
find eval_harness -name '*.sh' -print0 | xargs -0 bash -n
```

Expected: PASS; fixture artifacts contain no duplicate source, result, logs, author trace in iOS, settings, keys, or nested tar.

- [ ] **Step 7: Commit**

```bash
git add eval_harness/utils/artifacts eval_harness/utils/tests \
  eval_harness/app_builder/scripts/author-app.sh \
  eval_harness/evaluator/ios_agentic/scripts/eval-ios-app.sh
git commit -m "refactor: normalize eval artifact layouts"
```

### Task 3: Persist build-health stages in producer manifests

**Files:**
- Modify: `eval_harness/app_builder/scripts/author-app.sh`
- Modify: `eval_harness/evaluator/ios_agentic/scripts/eval-ios-app.sh`
- Modify: `eval_harness/utils/artifacts/collect_author_artifact.sh`
- Modify: `eval_harness/utils/artifacts/collect_ios_artifact.sh`
- Test: `eval_harness/utils/tests/test_author_artifact.py`
- Test: `eval_harness/utils/tests/test_ios_artifact.py`

**Interfaces:**
- Produces author manifest `build_health.app_authored` and `build_health.expo_export`.
- Produces iOS manifest `build_health.dependency_install`, `native_build`, `app_launch`, and `evaluation`.
- Each stage is `{ "status": "passed|warning|failed|not_run", "detail": string|null, "log": string|null }`.

- [ ] **Step 1: Write failing stage-status tests**

Test success, known failure, and unset status:

```python
self.assertEqual(manifest["build_health"]["native_build"]["status"], "passed")
self.assertEqual(manifest["build_health"]["app_launch"]["status"], "failed")
self.assertEqual(manifest["build_health"]["evaluation"]["status"], "not_run")
self.assertEqual(manifest["build_health"]["app_launch"]["log"], "logs/s6b-open.log")
```

- [ ] **Step 2: Run focused tests and confirm failure**

Run the two artifact test modules. Expected: missing `build_health` fields.

- [ ] **Step 3: Set explicit shell status variables at existing gates**

Initialize every status to `not_run`, then update immediately around the current checks:

```bash
IOS_DEPENDENCY_INSTALL_STATUS=failed
if eval::npm_install "$WORKSPACE" "$OUT"; then
  IOS_DEPENDENCY_INSTALL_STATUS=passed
else
  exit 1
fi
```

Apply the same pattern to authored output, Expo export, native build, launch probe, and evaluator result. Export the variables for the EXIT collector. Keep detailed diagnostics in the named log, not the manifest.

- [ ] **Step 4: Serialize and merge manifest health fields**

The collectors write typed objects and preserve author fields when the iOS job reads an authored artifact. Do not parse text logs and do not infer passes from file existence.

- [ ] **Step 5: Run tests and commit**

```bash
PYTHONPATH=. uv run --group test python -m unittest \
  eval_harness.utils.tests.test_author_artifact \
  eval_harness.utils.tests.test_ios_artifact
git add eval_harness/app_builder/scripts/author-app.sh \
  eval_harness/evaluator/ios_agentic/scripts/eval-ios-app.sh \
  eval_harness/utils/artifacts eval_harness/utils/tests
git commit -m "feat: persist eval build health"
```

### Task 4: Make screenshots durable and expose full assertion evidence

**Files:**
- Modify: `eval_harness/evaluator/ios_agentic/agent_device/bridge.py`
- Modify: `eval_harness/evaluator/ios_agentic/agent_device/tools.py`
- Modify: `eval_harness/evaluator/ios_agentic/agent_device/evaluator.py`
- Modify: `eval_harness/evaluator/ios_agentic/core/scoring.py`
- Modify: `eval_harness/evaluator/ios_agentic/main.py`
- Modify: `eval_harness/evaluator/ios_agentic/prompts/prompt_agent.py`
- Test: `eval_harness/evaluator/ios_agentic/tests/test_agent_device_bridge.py`
- Test: `eval_harness/evaluator/ios_agentic/tests/test_agent_device_evaluator.py`
- Test: `eval_harness/evaluator/ios_agentic/tests/test_main_results.py`

**Interfaces:**
- Produces: `StepResult.screenshot_path: str | None` and `screenshot_error: str | None`.
- Produces: serialized `steps[].hard_assertions[]`, `soft_assertions[]`, `screenshot`, and `screenshot_error`.
- Consumes: `EVAL_SCREENSHOT_DIR` for discretionary agent captures.

- [ ] **Step 1: Write failing bridge and evaluator screenshot tests**

Assert that a no-argument capture remains inside the trace root and that terminal steps pass an explicit deterministic path:

```python
with patch.dict(os.environ, {"EVAL_SCREENSHOT_DIR": str(trace / "screenshots")}):
    result = bridge.capture_screenshot()
    self.assertTrue(Path(result.output).is_relative_to(trace / "screenshots"))
```

```python
self.assertEqual(step.screenshot_path, "screenshots/step-01-final.png")
self.assertIsNone(step.screenshot_error)
```

Add a failure case proving screenshot errors do not alter `earned_points` or `passed`.

- [ ] **Step 2: Run screenshot tests and confirm failure**

Run the three Python test modules. Expected: temporary path escapes the trace and `StepResult` has no screenshot fields.

- [ ] **Step 3: Make discretionary screenshot paths durable**

When `path` is absent, require `EVAL_SCREENSHOT_DIR`, create it, and allocate a unique evidence filename inside it. Resolve the chosen path and reject any explicit path outside the configured screenshot root.

- [ ] **Step 4: Capture deterministic terminal-step screenshots**

Add a helper called after scoring and on formal-step abort:

```python
def _capture_terminal_screenshot(self, tracer: Tracer, step_number: int) -> tuple[str | None, str | None]:
    relative = Path("screenshots") / f"step-{step_number:02d}-final.png"
    result = self.bridge.capture_screenshot(str(tracer.root / relative))
    return (relative.as_posix(), None) if result.success else (None, result.error or result.output)
```

Attach the result to `StepResult` and trace `step_complete` / `plan_aborted` records without changing scoring.

- [ ] **Step 5: Serialize assertion detail**

Emit hard assertions as:

```json
{"command":"assert_visible: note-title","fatal":true,"passed":false}
```

Emit soft assertions as:

```json
{"check":"destructive action is clearly communicated","fatal":false,"passed":false,"evidence":"..."}
```

Keep existing counts derivable but preserve them during the schema migration for compatibility.

- [ ] **Step 6: Clarify screenshot behavior in the evaluator prompt**

Add exact guidance:

```text
capture_screenshot saves human-review evidence. It returns a path, not image pixels; you cannot inspect the screenshot. Never use it to decide or score an assertion. Base decisions on capture_screen and the structured assertion tools. You may capture additional feature-relevant states for later human review; the harness also captures each terminal formal-step state automatically.
```

- [ ] **Step 7: Run tests and commit**

```bash
PYTHONPATH=. uv run --group test python -m unittest \
  eval_harness.evaluator.ios_agentic.tests.test_agent_device_bridge \
  eval_harness.evaluator.ios_agentic.tests.test_agent_device_evaluator \
  eval_harness.evaluator.ios_agentic.tests.test_main_results
git add eval_harness/evaluator/ios_agentic
git commit -m "feat: capture iOS eval screenshot evidence"
```

### Task 5: Clean the skill artifact and add v2-compatible discovery

**Files:**
- Modify: `eval_harness/evaluator/skill_invocation/main.ts`
- Modify: `eval_harness/evaluator/skill_invocation/analysis.ts`
- Modify: `eval_harness/evaluator/skill_invocation/utils.ts`
- Modify: `eval_harness/evaluator/skill_invocation/scripts/eval-skill-use.sh`
- Test: `eval_harness/evaluator/skill_invocation/tests/skill_eval_analysis.test.ts`
- Test: `eval_harness/evaluator/skill_invocation/tests/skill_eval_core.test.ts`

**Interfaces:**
- Produces: root `skill-eval-report/manifest.json`, `metrics.json`, and `report.html` only.
- Consumes: v2 author paths first, then legacy author paths; v2 iOS paths first, then legacy iOS paths.

- [ ] **Step 1: Write failing v2 discovery and scratch-cleanup tests**

Create a v2 fixture and assert:

```ts
expect(layout.appDir).toEndWith(join("author-agent-workspace", "run-1"));
expect(layout.tracePath).toEndWith(join("author-agent-metadata", "run-1", "telemetry", "traces", "muse-code-authoring.json"));
expect(layout.resultPath).toEndWith(join("ios-eval-report", "result.json"));
```

Run the CLI on an archive and assert the output directory contains exactly `manifest.json`, `metrics.json`, and `report.html`.

- [ ] **Step 2: Run focused tests and confirm failure**

```bash
bun test eval_harness/evaluator/skill_invocation/tests
```

Expected: v2 paths are undiscovered and `unpacked/` remains.

- [ ] **Step 3: Implement safe temporary extraction**

Use `mkdtempSync(join(tmpdir(), "expo-skill-eval-"))` and `try/finally`:

```ts
const scratch = mkdtempSync(join(tmpdir(), "expo-skill-eval-"));
try {
  // unpack and analyze
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
```

Do not create `outDir/unpacked`.

- [ ] **Step 4: Add v2-first, legacy-second discovery**

Search exact canonical candidates before existing candidates. Preserve safe extraction and symlink/hard-link rejection. Write a small skill manifest containing schema version, artifact type, run identity, and primary file paths.

- [ ] **Step 5: Run tests and commit**

```bash
bun test eval_harness/evaluator/skill_invocation/tests
git add eval_harness/evaluator/skill_invocation
git commit -m "refactor: clean skill eval artifacts"
```

### Task 6: Normalize one-cell results and copy referenced evidence

**Files:**
- Create: `eval_harness/evaluator/reporting/types.ts`
- Create: `eval_harness/evaluator/reporting/normalize.ts`
- Create: `eval_harness/evaluator/reporting/main.ts`
- Create: `eval_harness/evaluator/reporting/tests/reporting.test.ts`
- Create: `eval_harness/evaluator/reporting/tests/fixtures/author/manifest.json`
- Create: `eval_harness/evaluator/reporting/tests/fixtures/skill/{manifest.json,metrics.json}`
- Create: `eval_harness/evaluator/reporting/tests/fixtures/ios/{manifest.json,result.json}`

**Interfaces:**
- Produces: `normalizeRun(inputs: ReportInputs): Promise<ConsolidatedSummary>`.
- Produces: `copyScreenshotEvidence(summary, iosRoot, outDir): Promise<void>` with containment checks.
- Produces CLI: `bun .../main.ts --authored-artifact PATH [--skill-artifact PATH] [--ios-artifact PATH] --out-dir PATH`.

- [ ] **Step 1: Define types and write failing normalization tests**

Define:

```ts
export type StageStatus = "passed" | "warning" | "failed" | "not_run";
export type BuildHealthStage = { id: string; label: string; status: StageStatus; detail: string | null; log: string | null };
export type ReportInputs = { authoredArtifact: string; skillArtifact: string | null; iosArtifact: string | null; outDir: string };
export type ConsolidatedSummary = {
  schema_version: 1;
  status: "complete" | "partial" | "failed";
  run: Record<string, unknown>;
  scores: { ios_macro_pct: number | null; skill_trigger_recall: number | null; skill_uptake_rate: number | null };
  build_health: BuildHealthStage[];
  skills: unknown[];
  ios: { test_plans: unknown[] };
  usage: { author: Record<string, number | null>; evaluator: Record<string, number | null> };
  warnings: string[];
  artifacts: Record<string, string | null>;
};
```

Test full, author-only, skill-disabled, iOS-disabled, evaluator-error, missing-result, and null-score inputs. Null must never become zero.

- [ ] **Step 2: Run the reporting test and confirm failure**

```bash
bun test eval_harness/evaluator/reporting/tests/reporting.test.ts
```

Expected: module-not-found failure.

- [ ] **Step 3: Implement v2 normalization and build health**

Normalize exact source files into `summary.json` and `data/build-health.json`. Copy exact source JSON to:

```text
data/author-manifest.json
data/skill-metrics.json
data/ios-result.json
```

Order health stages as authored, dependency install, syntax, Expo export, native build, app launch, evaluation. Missing sources yield `not_run`, never pass.

- [ ] **Step 4: Implement secure screenshot copying**

Resolve every `steps[].screenshot` against its plan trace directory and require:

```ts
const rel = relative(iosRoot, resolved);
rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
```

Reject symbolic links and non-regular files. Copy only referenced PNGs to stable names under `evidence/screenshots/`; rewrite summary paths relative to `report.html`. Sort failed steps before passed steps.

- [ ] **Step 5: Write the final artifact manifest**

Write root `manifest.json` with `schema_version: 1`, `artifact_type: "eval-report"`, run identity, and relative paths to `report.html`, `summary.json`, `data/`, and `evidence/screenshots/`. Do not add screenshot byte/count metrics.

- [ ] **Step 6: Run tests and commit**

```bash
bun test eval_harness/evaluator/reporting/tests/reporting.test.ts
git add eval_harness/evaluator/reporting
git commit -m "feat: normalize consolidated eval results"
```

### Task 7: Render the approved offline report

**Files:**
- Create: `eval_harness/evaluator/reporting/render.ts`
- Modify: `eval_harness/evaluator/reporting/main.ts`
- Modify: `eval_harness/evaluator/reporting/tests/reporting.test.ts`

**Interfaces:**
- Produces: `renderReport(summary: ConsolidatedSummary): string`.
- Produces: static `report.html` with no remote assets and only relative screenshot URLs.

- [ ] **Step 1: Write failing renderer tests**

Assert the approved sections and security properties:

```ts
expect(html).toContain("Build and evaluation ladder");
expect(html).toContain("Skill use");
expect(html).toContain("iOS behavior");
expect(html).toContain("Visual evidence");
expect(html.indexOf("Failed assertion")).toBeLessThan(html.indexOf("Passed"));
expect(html).not.toContain("<script");
expect(html).not.toContain("https://");
expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
```

- [ ] **Step 2: Run renderer tests and confirm failure**

Run the reporting test. Expected: renderer missing.

- [ ] **Step 3: Implement semantic escaped HTML**

Render, in order:

1. Navy run header with PRD, author harness/model/effort, prompt, scenario, SHA.
2. iOS quality, skill recall, skill uptake, and run-status cards.
3. Color-plus-text build-health ladder.
4. Skill and iOS summary panels.
5. Failed final-state screenshots first, then passing final-state screenshots.
6. Expandable assertion/check details.
7. Usage, tool calls, skill reads, versions, warnings, and machine-data paths.

Use Charter/Georgia headings, Avenir/system body fallbacks, the approved restrained palette, responsive CSS, no external font or JS, and an explicit note that screenshots are human final-state context rather than scoring proof.

- [ ] **Step 4: Render and inspect the fixture locally**

Run:

```bash
bun eval_harness/evaluator/reporting/main.ts \
  --authored-artifact eval_harness/evaluator/reporting/tests/fixtures/author \
  --skill-artifact eval_harness/evaluator/reporting/tests/fixtures/skill \
  --ios-artifact eval_harness/evaluator/reporting/tests/fixtures/ios \
  --out-dir /tmp/eval-report-fixture
open /tmp/eval-report-fixture/report.html
```

Verify desktop and narrow layouts, image links, status text, and absence of overflow.

- [ ] **Step 5: Run tests and commit**

```bash
bun test eval_harness/evaluator/reporting/tests/reporting.test.ts
git add eval_harness/evaluator/reporting
git commit -m "feat: render consolidated eval report"
```

### Task 8: Wire canonical artifacts and the final report into EAS

**Files:**
- Modify: `.eas/workflows/eval-e2e.yml`
- Modify: `.eas/workflows/author-app.yml`
- Modify: `.eas/workflows/eval-ios-app.yml`
- Modify: `.eas/workflows/eval-skill-use.yml`

**Interfaces:**
- Consumes the scripts and CLI from Tasks 1–7.
- Produces the four stable EAS artifact names.

- [ ] **Step 1: Add workflow-contract assertions to existing shell/config tests**

Assert all active workflows lack `agent-workspace`, `eval-out`, and `eval-e2e-output`, and that E2E contains:

```yaml
agent_reasoning_effort:
evaluator_model:
report:
  after: [eval_ios, eval_skill]
```

- [ ] **Step 2: Add model/effort inputs to author and E2E workflows**

Add the author effort choice input with `low`, `medium`, `high`, default
`high`; add evaluator model default `claude-opus-4-8`. Pass resolved author
values into authoring. In full E2E, pass evaluator effort `high` and iOS app
mode `release` as fixed job environment values to stay within EAS's ten-input
dispatch limit; retain both controls in `eval-ios-app.yml` replay.

- [ ] **Step 3: Switch all producer packaging to canonical roots**

Package:

```bash
bash eval_harness/utils/artifacts/package_artifact.sh authored-app authored-app.tar.gz '${{ workflow.id }}/authored-app.tar.gz'
bash eval_harness/utils/artifacts/package_artifact.sh ios-eval-report ios-eval-report.tar.gz '${{ workflow.id }}/ios-eval-report.tar.gz'
bash eval_harness/utils/artifacts/package_artifact.sh skill-eval-report skill-eval-report.tar.gz '${{ workflow.id }}/skill-eval-report.tar.gz'
bash eval_harness/utils/artifacts/package_artifact.sh eval-report eval-report.tar.gz '${{ workflow.id }}/eval-report.tar.gz'
```

Upload using `authored-app`, `ios-eval-report`, `skill-eval-report`, and
`eval-report`. Update replay download/unpack paths accordingly.

- [ ] **Step 4: Make downstream jobs failure-tolerant**

Use `after: [author_app]` for intended evaluator jobs while preserving their input `if` expressions and `always()` packaging/upload steps. Ensure a failed author artifact yields diagnostic evaluator manifests rather than silently omitting the final report.

- [ ] **Step 5: Add the final report job**

Use:

```yaml
report:
  after: [eval_ios, eval_skill]
  runs_on: linux-medium
```

Conditionally download skill/iOS artifacts according to `run_eval_skill` and `run_eval_ios`, always download `authored-app`, invoke the report CLI, package `eval-report.tar.gz`, and upload it as `eval-report`. Missing optional results must be passed as absent CLI arguments rather than fake paths.

- [ ] **Step 6: Validate workflows and run tests**

```bash
node /Users/adityashukla/.codex/plugins/cache/openai-curated-remote/expo/1.0.2/skills/expo-cicd-workflows/scripts/validate.js .eas/workflows/*.yml
find eval_harness -name '*.sh' -print0 | xargs -0 bash -n
bun run test:all
```

Expected: every workflow validates; all tests pass.

- [ ] **Step 7: Commit**

```bash
git add .eas/workflows eval_harness
git commit -m "feat: consolidate EAS eval outputs"
```

### Task 9: Update durable documentation and verify the complete branch

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `dataset/prompts/README.md`
- Modify: `docs/superpowers/specs/2026-08-10-refine-eval-outputs-design.md` only if implementation reveals a contract correction.

**Interfaces:**
- Documents the exact workflow inputs, artifact names/layouts, replay compatibility, report semantics, screenshot limitation, and live validation command.

- [ ] **Step 1: Update README usage and artifact walkthrough**

Document:

- one dispatch equals one evaluation cell;
- explicit experiment author models and fixed evaluator model;
- high effort defaults;
- `realistic` prompt text and intent;
- canonical author, skill, iOS, and final artifact trees;
- overall evaluator trace versus per-test-plan native traces;
- telemetry versus logs;
- screenshots as human-only context;
- future cross-run comparison as out of scope.

- [ ] **Step 2: Update operating notes**

Replace the obsolete generic collector note with the two phase-specific collectors, record all four artifact names, and preserve the existing session-log archival warning.

- [ ] **Step 3: Run the full local verification suite**

```bash
bun run test:all
find eval_harness -name '*.sh' -print0 | xargs -0 bash -n
bun test eval_harness/evaluator/skill_invocation/tests
PYTHONPATH=. uv run --group test python -m unittest \
  eval_harness.evaluator.ios_agentic.tests.test_test_plan_resolution
node /Users/adityashukla/.codex/plugins/cache/openai-curated-remote/expo/1.0.2/skills/expo-cicd-workflows/scripts/validate.js .eas/workflows/*.yml
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 4: Inspect the final diff and artifact fixture**

Confirm:

```bash
git status --short
git diff --stat origin/main...HEAD
find /tmp/eval-report-fixture -maxdepth 4 -type f -print | sort
```

The fixture must have only `manifest.json`, `report.html`, `summary.json`, `data/*.json`, and referenced `evidence/screenshots/*.png`.

- [ ] **Step 5: Commit documentation**

```bash
git add README.md AGENTS.md dataset/prompts/README.md docs/superpowers/specs
git commit -m "docs: explain consolidated eval reports"
```

### Task 10: Push and run the approved Notes/Muse validation

**Files:**
- No source changes unless the live run exposes a defect.

**Interfaces:**
- Consumes the completed branch and EAS `production` credentials.
- Produces one `eval-report` artifact for Notes/Muse.

- [ ] **Step 1: Rebase check and push the branch**

```bash
git fetch origin --prune
git log --oneline --left-right origin/main...HEAD
git push -u origin codex/refine-eval-outputs
```

Do not merge the branch.

- [ ] **Step 2: Dispatch the approved validation cell**

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

- [ ] **Step 3: Monitor all four jobs to terminal status**

Confirm authoring finishes, skill and iOS execute in parallel, and `report` runs after both. If an upstream job fails, verify that `eval-report` still renders a partial postmortem rather than rerunning immediately.

- [ ] **Step 4: Audit downloaded artifacts**

Extract each artifact to a separate temporary directory and verify:

- no `bundle/`, `unpacked/`, nested `.tgz`, duplicate source, or duplicate result;
- iOS has no author source or author trace;
- all manifests record exact model and effort values;
- screenshots live beneath plan traces and final copied evidence;
- screenshot paths are relative and load offline;
- no Meta/OpenAI/Anthropic key, Expo bearer token, `.mcp.json`, Muse settings, or raw Muse XDG data appears;
- final `summary.json`, `skill-metrics.json`, and `ios-result.json` reconcile;
- final report ladder, scores, screenshots, and details match source artifacts.

- [ ] **Step 5: Record the validation outcome**

If the run passes, add a concise README example only if the actual CLI syntax differed from the documented command. If the run finds a defect, write a failing regression test first, fix it in the smallest owning task area, rerun local verification, push, and repeat the same Notes/Muse cell once.
