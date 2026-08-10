# iOS Evaluator Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every iOS evaluator outcome complete and truthful, stop finished or blocked Claude phases mechanically, stabilize repeated app lifecycle behavior, and validate the result with repeated EAS replays.

**Architecture:** Preserve the current Python evaluator and sequential plan loop. Add explicit terminal statuses at the plan and suite boundaries, write atomic checkpoints after each plan, and connect tool lifecycle state to Claude SDK interruption. Use release builds for product-like reliability trials while preserving development-client mode for debugging.

**Tech Stack:** Python 3.12, `unittest`, Claude Agent SDK, agent-device, Maestro fallback, Bash, Expo EAS Workflows.

## Global Constraints

- Keep the existing 200 seed-turn and 50 step-turn workflow budgets until repeated-run evidence supports changing them.
- Treat app assertion failures as scored evaluation results; treat driver, SDK, restart, and timeout failures as evaluator errors.
- Any evaluator error must make the final CLI and EAS job fail after partial evidence is saved.
- Preserve release and development-client build options; use release for the acceptance runs.
- Do not redesign seeding instructions or primitive test-plan semantics in this PR.
- Write tests before production changes and observe every regression test fail for the intended reason.

---

### Task 1: Explicit plan outcomes

**Files:**
- Modify: `eval_harness/evaluator/ios_agentic/core/scoring.py`
- Modify: `eval_harness/evaluator/ios_agentic/agent_device/evaluator.py`
- Create: `eval_harness/evaluator/ios_agentic/tests/test_agent_device_evaluator.py`

**Interfaces:**
- Produces: `TestPlanResult.status`, `TestPlanResult.error_stage`, and `TestPlanResult.error_reason`.
- Consumes: the existing `AgentDeviceResult` restart result and existing scoring fields.

- [ ] **Step 1: Write a failing restart-classification test**

Create a controlled evaluator whose real plan-result path receives a failed
bridge restart. Assert the result has `status == "evaluator_error"`,
`error_stage == "restart"`, the bridge reason, and no scored steps.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
PYTHONPATH=. uv run python -m unittest \
  eval_harness.evaluator.ios_agentic.tests.test_agent_device_evaluator.AgentDeviceEvaluatorOutcomeTests.test_regression_restart_failure_is_an_evaluator_error
```

Expected: failure because `TestPlanResult` does not expose the status/error
contract and the current restart branch returns a default zero score.

- [ ] **Step 3: Implement the minimal result fields and restart assignment**

Add terminal fields to `TestPlanResult`. Initialize a plan as in-progress, mark
the restart branch as an evaluator error, mark the N/A branch as not applicable,
and mark normal completion as completed.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the command from Step 2. Expected: one passing test.

### Task 2: Mechanical completion and explicit abort

**Files:**
- Modify: `eval_harness/evaluator/ios_agentic/core/tool_state.py`
- Modify: `eval_harness/evaluator/ios_agentic/agent_device/tools.py`
- Modify: `eval_harness/evaluator/ios_agentic/agent_device/evaluator.py`
- Modify: `eval_harness/evaluator/ios_agentic/prompts/prompt_agent.py`
- Test: `eval_harness/evaluator/ios_agentic/tests/test_agent_device_evaluator.py`

**Interfaces:**
- Produces: `StepState.aborted`, `abort_category`, and `abort_reason`.
- Produces: agent-visible `abort_step({category, reason})`.
- Produces: evaluator helper that consumes SDK messages until completion/abort,
  calls `client.interrupt()` once, and drains through `ResultMessage`.

- [ ] **Step 1: Write failing tests for completion and abort interruption**

Use a small fake streaming client at the SDK boundary. The stream must set the
real `StepState.completed` or `StepState.aborted`, then yield another message
before its terminal result. Assert `interrupt()` is called exactly once and the
post-completion agent turn is not processed as work.

- [ ] **Step 2: Verify both tests fail for the intended reason**

Run:

```bash
PYTHONPATH=. uv run python -m unittest \
  eval_harness.evaluator.ios_agentic.tests.test_agent_device_evaluator.AgentDeviceEvaluatorLifecycleTests
```

Expected: failure because the evaluator currently only waits for
`ResultMessage` and no abort state/tool exists.

- [ ] **Step 3: Implement interrupt-aware response draining**

After processing each SDK message, interrupt once when the current real state
is completed or aborted. Continue reading only to drain the SDK's terminal
result; do not let the extra model content mutate the next phase.

- [ ] **Step 4: Implement `abort_step` and prompt guidance**

Use explicit categories such as `driver_error`, `setup_blocked`,
`app_unreachable`, and `other`. Tell the agent to abort after a terminal tool
error or repeated recovery actions without observable progress. Do not use
abort for an observed app assertion failure; record that assertion and complete
the step normally.

- [ ] **Step 5: Convert aborted seed/step state into plan evaluator error**

Preserve completed earlier steps, record phase and reason, close the trace, and
return an `evaluator_error` plan result.

- [ ] **Step 6: Run focused and full iOS unit tests**

```bash
PYTHONPATH=. uv run python -m unittest \
  eval_harness.evaluator.ios_agentic.tests.test_agent_device_evaluator
PYTHONPATH=. uv run python -m unittest discover \
  -s eval_harness/evaluator/ios_agentic/tests -p 'test_*.py'
```

Expected: all pass without warnings or leaked tasks.

### Task 3: Atomic suite checkpoints and failed-job semantics

**Files:**
- Modify: `eval_harness/evaluator/ios_agentic/main.py`
- Modify: `eval_harness/utils/shell/evaluator.sh`
- Create: `eval_harness/evaluator/ios_agentic/tests/test_main_results.py`
- Modify: `eval_harness/evaluator/ios_agentic/tests/test_eval_ios_script.py`

**Interfaces:**
- Produces: suite `status`, `expected_plan_count`, `terminal_plan_count`, and
  `evaluator_errors` in `result.json`.
- Produces: atomic checkpoint writer used after every terminal plan result.
- Consumes: `TestPlanResult` terminal fields from Task 1.

- [ ] **Step 1: Write failing pure-output tests**

Hand-construct completed, N/A, and evaluator-error plan results. Assert that:

- completed plus N/A produces a completed suite;
- any evaluator error produces an incomplete suite;
- an evaluator-error plan is excluded from score/macro aggregation;
- expected and terminal counts are literal and correct.

- [ ] **Step 2: Write a failing checkpoint-survival test**

Run the result loop with a controlled evaluator that completes one plan and
raises on the second. Assert the on-disk JSON retains the first plan, records
the second evaluator error, is valid JSON, and the CLI returns non-zero.

- [ ] **Step 3: Verify RED**

```bash
PYTHONPATH=. uv run python -m unittest \
  eval_harness.evaluator.ios_agentic.tests.test_main_results
```

Expected: failures because main writes only once, has no suite status, and does
not classify evaluator exceptions.

- [ ] **Step 4: Implement output construction and atomic writes**

Write a sibling temporary JSON file, flush it, and replace the public output.
Checkpoint before the first plan and after every terminal plan. Generate the
human-readable report from the same data.

- [ ] **Step 5: Guarantee cleanup and non-zero incomplete exit**

Wrap bridge ownership in `try/finally`. Continue after per-plan evaluator
errors when the process remains usable. Return non-zero after writing the final
incomplete result.

- [ ] **Step 6: Strengthen the shell result gate**

`eval::require_evaluator_result` must require `status == "completed"`, equal
expected/terminal counts, no evaluator errors, and numeric score fields.

- [ ] **Step 7: Verify GREEN**

Run the new result tests and `test_eval_ios_script`. Expected: all pass.

### Task 4: Stable build-mode behavior

**Files:**
- Modify: `.eas/workflows/eval-ios-app.yml`
- Modify: `eval_harness/evaluator/ios_agentic/scripts/eval-ios-app.sh`
- Modify: `eval_harness/evaluator/ios_agentic/tests/test_eval_ios_script.py`
- Test: `eval_harness/evaluator/ios_agentic/tests/test_agent_device_bridge.py`

**Interfaces:**
- Produces: release as the replay default while preserving the explicit
  `ios_app_mode` choice.
- Produces: development-client mode that does not delete its whole shared
  launcher container by default.

- [ ] **Step 1: Add a behavioral shell test for build-mode defaults**

Factor only the mode selection needed to run the real shell behavior with
controlled external commands. Assert the default selects release and an
explicit `dev-client` input remains accepted.

- [ ] **Step 2: Add/retain bridge coverage for development-client preservation**

Exercise the real restart branch with only simctl/agent-device external
boundaries replaced. Assert an unset opt-in does not remove development-client
data directories.

- [ ] **Step 3: Verify RED where behavior changes**

Run the two focused test modules. The release-default test must fail against
the current replay default.

- [ ] **Step 4: Change the replay and script defaults to release**

Retain the workflow choice and explicit environment override. Remove the
script's unconditional opt-in to whole-container development-client clearing.

- [ ] **Step 5: Validate workflow syntax and run shell tests**

Fetch the current EAS workflow schema/syntax reference, then run:

```bash
find eval_harness -name '*.sh' -print0 | xargs -0 bash -n
node /Users/adityashukla/.codex/plugins/cache/openai-curated-remote/expo/1.0.2/skills/expo-cicd-workflows/scripts/validate.js .eas/workflows/*.yml
PYTHONPATH=. uv run python -m unittest \
  eval_harness.evaluator.ios_agentic.tests.test_eval_ios_script \
  eval_harness.evaluator.ios_agentic.tests.test_agent_device_bridge
```

Expected: all pass.

### Task 5: Evaluator artifact scope

**Files:**
- Modify: `eval_harness/utils/artifacts/collect_artifacts.sh`
- Modify: `.eas/workflows/eval-ios-app.yml`
- Create: `eval_harness/utils/tests/test_collect_artifacts.py`

**Interfaces:**
- Produces: evaluator artifact containing diagnostic/source evidence without
  reproducible dependency/native build trees.

- [ ] **Step 1: Write a failing packaging integration test**

Create a small temporary authored workspace containing source, result, trace,
`node_modules`, Pods, DerivedData, and native build output. Run the real
packaging helper and inspect the archive. Assert source/results/traces remain
and derived trees do not.

- [ ] **Step 2: Verify RED**

Run the focused packaging test. Expected: failure showing the current archive
contains at least one derived tree.

- [ ] **Step 3: Add narrow archive exclusions**

Exclude only reproducible dependency/build directories. Do not exclude source,
manifests, result/report, traces, screenshots, or stage logs.

- [ ] **Step 4: Verify GREEN and shell syntax**

Run the packaging test and all shell syntax checks.

### Task 6: Full local verification and review

**Files:**
- Modify only files required by review findings.

- [ ] **Step 1: Run the canonical full verification**

```bash
bun install --frozen-lockfile
bun run test:all
find eval_harness -name '*.sh' -print0 | xargs -0 bash -n
node /Users/adityashukla/.codex/plugins/cache/openai-curated-remote/expo/1.0.2/skills/expo-cicd-workflows/scripts/validate.js .eas/workflows/*.yml
```

- [ ] **Step 2: Inspect the complete diff against `origin/main`**

Confirm no Muse behavior was lost during rebase, no migration-only documents
were restored, and every new result field has a consumer or test.

- [ ] **Step 3: Run an independent Codex code review**

Review the final diff for false-green paths, exception/cleanup leaks, circular
test oracles, and EAS compatibility. Fix critical and important findings with
new failing tests first.

### Task 7: Repeated EAS reliability trials

**Files:**
- Modify code/tests only when a run exposes a reproduced defect.
- Update the PR description or comment with summarized evidence; do not add raw
  EAS logs to the repository.

- [ ] **Step 1: Run one Notes release replay**

Use the known healthy Notes authored-app artifact and `eval-ios-app.yml` with
`ios_app_mode=release`. Download and inspect result, traces, and logs.

- [ ] **Step 2: Classify any failure before changing code**

Separate authored-app defects, agent judgment variance, driver/restart faults,
SDK/quota faults, and harness classification faults. Add a reproducing test
before each code fix.

- [ ] **Step 3: Repeat Notes until three consecutive complete runs**

Every expected Notes plan must be completed or N/A. Record duration and turns
per seed/step without requiring equal scores.

- [ ] **Step 4: Repeat Pool until three consecutive complete runs**

Use one healthy Pool artifact. Apply the same structural gate and collect the
same phase timing evidence.

- [ ] **Step 5: Analyze turn and duration distributions**

Compare useful work before `complete_step`, post-completion turns, restart
time, seed time, formal-step time, and tool-error recovery. Do not reduce
budgets in this PR unless every observed valid phase has ample measured margin
and the user approves the new limits.

- [ ] **Step 6: Report remaining semantic work separately**

Summarize what belongs to the later ground-up seeding/test-plan strategy rather
than this reliability PR.
