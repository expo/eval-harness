# Python-to-TypeScript Migration Status

This file is the living evidence record for replacing active Python runtime
code with TypeScript executed by Bun. It records what was run, what passed,
what remains unknown, and which reviews are still required.

The testing policy and terminology are defined in `MIGRATION_TESTING.md`.
Language-independent behavioral properties are defined in
`test_properties.json`. A property ID, such as `SCORE-001`, connects a semantic
property to its implementation and migration evidence here.

## Status vocabulary

| Status | Meaning |
| --- | --- |
| Not started | No implementation or evidence exists for the slice. |
| In progress | Work has started, but one or more required gates remain. |
| Blocked | A named dependency prevents useful progress. |
| Ready for review | Local evidence is complete and the PR is awaiting human review. |
| Complete | The slice has passed its required local, differential, EAS, and review gates. |
| Out of scope | The slice is intentionally excluded with a recorded reason. |

`Pending` in an evidence cell means the check has not been performed. It must
not be read as a failure or a pass.

## Current migration matrix

| Slice | Branch/PR | Property IDs | Python evidence | TS evidence | Differential | Coverage | EAS | AI | Expo | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Baseline and migration documentation | `codex/ts-migration-docs`; [PR #24](https://github.com/expo/eval-experiments/pull/24) | None yet | Corrected baseline: 118 tests; PR branch: 120 tests | Not applicable | Not applicable | Baseline recorded below | Authoring and skill jobs pass; iOS times out | Codex pass | Pending | Ready for review |
| Bun and TypeScript toolchain | `codex/ts-toolchain`; [PR #25](https://github.com/expo/eval-experiments/pull/25) | None expected | Pass: 120 tests | Strict typecheck and 1 Bun smoke test pass from frozen lockfile | Not applicable | No runtime TS exists yet; smoke coverage is not meaningful | All four workflows validate; Linux replay installs Bun 1.3.14 and passes with baseline-equivalent metrics | Codex pass | Pending | Ready for review |
| Timeout and process helper | `codex/ts-timeout`; [PR #26](https://github.com/expo/eval-experiments/pull/26) | None; process timing is unsuitable for useful PBT | Retired after initial characterization/parity; review-discovered behavior was recovered from Git history | Strict typecheck; 16 permanent timeout tests plus the toolchain smoke test; executable expected failure for `DEFECT-001`; all 5 shell caller files switched | Caller-relevant finite decimal timeouts, signal status, output, exit, and best-effort cleanup behavior pass | Bun child-process execution is not attributed by the parent coverage profile; focused behavior evidence passes | macOS helper smoke and bounded caller replay pass; the earlier numeric-parity smoke covered a broader Python grammar that is intentionally no longer supported | Codex pass | Kudo approved; minor findings addressed and all local/configuration checks pass | Merged |
| Agent trace parsers | `codex/ts-trace-parsers`; [PR #28](https://github.com/expo/eval-experiments/pull/28) | `TRACE-001` | 12 characterization/differential tests passed before retirement | Strict typecheck; 16 permanent parser tests; collector switched to Bun | Fixtures, CLI edges, and 30 real traces per agent match after approved normalization | Claude 80.49%; Codex 76.47% line coverage | Claude authoring replay passes with valid trace; parallel Codex worker was lost before collection | Codex re-review pass | Kudo's requested changes implemented; rereview pending | Ready for rereview |
| Remaining telemetry conversion and emission | Branch/PR pending | To be selected per transformation | Existing Python behavior remains active | Pending | Pending | Not measured | Replay pending | Pending | Pending | Not started |
| Deterministic skill evaluator — core | `codex/ts-skill-core`; [PR #29](https://github.com/expo/eval-experiments/pull/29) | `SKILL-001`–`SKILL-004` | 116 focused and 131 repository tests pass; safe artifact reruns preserve archive-extraction guarantees | Strict typecheck; 41 focused and 74 repository Bun tests pass; source loading, globbing, and check dispatch are asynchronous; bundle checks accept iOS or Android | Registry definitions/results, empty-directory globs, malformed UTF-8 handling, and Python float rounding match | Focused TS: 94.15% functions, 92.63% lines; registry 100% | Deferred: no production caller changes in this additive core PR | Codex re-review pass | Kudo's requested changes implemented; rereview pending | Ready for rereview |
| Deterministic skill evaluator — analysis, report, and CLI cutover | Branch/PR pending | Reuse accepted skill properties; add only if a new critical surface qualifies | Existing Python remains active | Pending | Pending | CLI is 0% in the baseline | Skill replay pending | Pending | Pending | Not started |
| iOS core, parsing, scoring, and reports | Branch/PR pending | To be selected | Existing report and resolution tests pass | Pending | Pending | Important modules range from 17% to 89% | iOS replay pending | Pending | Pending | Not started |
| iOS bridges and tools | Branch/PR pending | To be selected | Recorded-adapter tests pending | Pending | Pending | Tools are 6%; bridges are 13% and 20% | iOS replay pending | Pending | Pending | Not started |
| iOS orchestration and CLI | Branch/PR pending | To be selected | Orchestration characterization pending | Pending | Pending | Main is 36%; evaluators are 19% and 22% | iOS replay pending | Pending | Pending | Not started |
| Final cutover and cleanup | Umbrella PR pending | All accepted IDs | Final Python comparison pending | Full Bun suite pending | Final parity pending | Final report pending | Notes E2E pending | Pending | Pending | Not started |

## Active rolling stack

The stack may extend beyond three dependent child PRs when external review
latency would otherwise halt migration work. Every new branch must start from
an internally complete parent, keep a bounded scope, and preserve immediate
parentage so each PR shows only its own slice. PRs may be reviewed concurrently,
but they merge strictly from the bottom of the stack upward.

| Position | Branch | Base | Local checkout | PR state |
| --- | --- | --- | --- | --- |
| Integration | `codex/migrate-to-ts` | `main` | Repository root | Umbrella draft not opened |
| A | `codex/ts-migration-docs` | `codex/migrate-to-ts` | `.worktrees/ts-migration-docs` | [PR #24](https://github.com/expo/eval-experiments/pull/24); ready for Expo review |
| B | `codex/ts-toolchain` | `codex/ts-migration-docs` | `.worktrees/ts-toolchain` | [PR #25](https://github.com/expo/eval-experiments/pull/25); ready for Expo review |
| C | `codex/ts-timeout` | `codex/ts-toolchain` | `.worktrees/ts-timeout` | [Draft PR #26](https://github.com/expo/eval-experiments/pull/26); internally complete |
| D | `codex/ts-trace-parsers` | `codex/ts-timeout` | `.worktrees/ts-trace-parsers` | [Draft PR #28](https://github.com/expo/eval-experiments/pull/28); internally complete |
| E | `codex/ts-skill-core` | `codex/ts-trace-parsers` | `.worktrees/ts-skill-core` | [Draft PR #29](https://github.com/expo/eval-experiments/pull/29); internally complete |

After a bottom PR merges, every descendant is restacked in parent-to-child
order using the recorded old parent tips and `git rebase --onto`. Affected
checks are rerun, and materially changed diffs are reviewed again. A deeper
stack increases this maintenance cost, so new slices remain small and no branch
starts from a parent that still has unresolved internal review findings.

## File-level change ledger

Every tracked path is approved and reviewed independently of its containing
slice. “Proposed before edit” means the file's purpose, exact change, expected
effect, and verification were presented in the task before it was modified.

| Path | Slice | Purpose | Approval evidence | Review | Tested evidence revision | State |
| --- | --- | --- | --- | --- | --- | --- |
| `MIGRATION_TESTING.md` | Documentation | Define migration, testing, review, commit, and merge gates. | Explicitly approved before the original guide and the methodology expansion. | Codex re-review passed. | `aa4d0af`, `fd74f31`, `c627356` | Expanded on the timeout branch with lessons from the first runtime migration |
| `MIGRATION_STATUS.md` | Documentation | Record branches, evidence, risks, reviews, and the evidence-attribution policy. | Standing approval for status updates. | Codex re-review passed. | Records reviewed implementation heads through trace-parser retirement `73df13c`; the roll-up does not self-reference | Updated with trace-parser evidence, EAS results, and remaining telemetry boundary |
| `README.md` | Documentation | Link migration material without changing runtime guidance. | Plan approved; proposed before edit. | Codex review: no issue. | `aa4d0af` | Implemented in PR #24 |
| `test_properties.json` | Documentation and trace parsers | Hold reviewed language-independent properties. | Plan approved; user later authorized autonomous completion of the parser PR. | Codex pass. | `aa4d0af`, `1b72240`, `89cb705` | Contains schema-valid `TRACE-001`, retained for the permanent Bun PBT |
| `test_properties.schema.json` | Documentation | Validate property-record structure and safe source paths. | Explicitly approved before retaining review fix. | Codex re-review passed. | `aa4d0af`, `fd74f31` | Implemented in PR #24 |
| `eval_harness/utils/tests/test_property_catalog.py` | Documentation | Enforce uniqueness of the stable property ID. | Explicitly approved before retaining review fix. | Codex re-review passed. | `fd74f31` | Implemented in PR #24 |
| `package.json` | Toolchain | Define reproducible Bun, typecheck, and combined test commands. | Explicitly approved before edit. | Codex P2 fixed; re-review passed. | `e242545`, `a9db7ef` | Local tests explicitly request the non-default test group |
| `tsconfig.json` | Toolchain | Apply strict TypeScript checks without emitting duplicate JavaScript. | Explicitly approved before edit. | Codex re-review passed. | `e242545` | Implemented locally |
| `bun.lock` | Toolchain | Lock the complete Bun dependency graph. | Explicitly approved before retaining generated file. | Codex re-review passed. | `e242545` | Frozen install passes |
| `eval_harness/utils/tests/toolchain_smoke.test.ts` | Toolchain | Prove Bun executes a typed test through the configured runner. | Explicitly approved before retaining file. | Codex re-review passed. | `e242545` | 1 test passes |
| `pyproject.toml` | Toolchain | Declare Coverage.py and Hypothesis as development-only dependencies. | Explicitly approved before edit. | Codex P2 fixed; re-review passed. | `e242545`, `a9db7ef` | Non-default `test` group excludes tools from bare runtime sync |
| `uv.lock` | Toolchain | Lock the new Python development dependencies exactly. | Explicitly approved before update. | Codex P2 fixed; re-review passed. | `e242545`, `a9db7ef` | Lock check and isolated runtime/test sync checks pass |
| `.eas/workflows/author-app.yml` | Toolchain | Pin the tested Bun version on the authoring worker. | Explicitly approved before edit. | Codex re-review passed. | `e242545` | Expo validator passes |
| `.eas/workflows/eval-skill-use.yml` | Toolchain | Pin the tested Bun version on the skill-evaluator worker. | Explicitly approved before edit. | Codex re-review passed. | `e242545` | Expo validator passes |
| `.eas/workflows/eval-ios-app.yml` | Toolchain | Pin the tested Bun version on the iOS-evaluator worker. | Explicitly approved before edit. | Codex re-review passed. | `e242545` | Expo validator passes |
| `.eas/workflows/eval-e2e.yml` | Toolchain | Pin the tested Bun version for every job in the primary workflow. | Explicitly approved before edit. | Codex re-review passed. | `e242545` | Expo validator passes |
| `eval_harness/utils/tests/test_timeout_exec.py` | Timeout helper | Characterize the Python CLI and expose incomplete descendant cleanup. | Explicitly approved before edit and later deletion. | Codex pass. | `987de1b`, `668c117` | Removed after behavior and executable defect evidence moved to TypeScript |
| `eval_harness/utils/tests/timeout_exec.test.ts` | Timeout helper | Protect permanent Bun behavior and execute the known cleanup defect; previously hosted transitional parity cases. | Explicitly approved before each edit. | Codex pass; Kudo review findings addressed. | `7ca8312`, `0ae001a`, `668c117`, `e6ed4e0`; final review-feedback commit pending | 16 caller-relevant timeout grammar, signal, exit, output, diagnostics, and cleanup-race cases pass; executable `test.failing` retains `DEFECT-001` |
| `eval_harness/utils/shell/timeout_exec.py` | Timeout helper | Original Python timeout implementation retained only for migration parity. | Explicitly approved before deletion. | Codex pass. | `668c117` | Removed after local parity, caller cutover, and EAS gates passed |
| `eval_harness/utils/shell/timeout_exec.ts` | Timeout helper | Translate the Python timeout CLI for direct execution by Bun. | Explicitly approved before edit. | Codex pass; Kudo review findings addressed. | `e506682`, `e6ed4e0`; final review-feedback commit pending | Accepts the finite, non-negative decimal timeout forms used by callers; cleanup races cannot replace timeout exit 124; `DEFECT-001` remains intentionally preserved |
| `eval_harness/utils/shell/agents.sh` | Timeout helper | Use the Bun timeout helper when platform timeout commands are unavailable. | Explicitly approved before edit. | Codex pass. | `d260437` | Forced fallback selects Bun; all shell syntax and full local suites pass |
| `eval_harness/app_builder/scripts/author-app.sh` | Timeout helper | Use the Bun timeout helper for the build-health fallback. | Explicitly approved as part of the complete caller batch. | Codex pass. | `fae5d05` | Shell syntax and full local suites pass |
| `eval_harness/utils/shell/evaluator.sh` | Timeout helper | Use the Bun timeout helper for the evaluator fallback. | Explicitly approved as part of the complete caller batch. | Codex pass. | `fae5d05` | Shell syntax and full local suites pass |
| `eval_harness/utils/shell/app_runtime.sh` | Timeout helper | Use the Bun timeout helper for release-build timeout enforcement. | Explicitly approved as part of the complete caller batch. | Codex pass. | `fae5d05` | Shell syntax and full local suites pass |
| `eval_harness/utils/shell/ios.sh` | Timeout helper | Use the Bun timeout helper for simulator boot and runner preparation. | Explicitly approved as part of the complete caller batch. | Codex pass. | `fae5d05` | Shell syntax and full local suites pass |
| `eval_harness/utils/tests/trace_parsers.test.ts` | Trace parsers | Permanently protect normalized parser behavior, `TRACE-001`, CLI compatibility, discovery, parsed-field numeric spelling and large-integer precision, and the Braintrust bridge. | User authorized autonomous completion of this PR. | Codex re-review pass; Expo review changes implemented. | `1b72240`, `89cb705`; current PR head | 16 tests pass, including unknown-record compatibility and a real offline bridge invocation; Claude 80.49% and Codex 76.47% line coverage |
| `eval_harness/utils/tests/test_trace_parsers.py` | Trace parsers | Characterize Python and compare Python/Bun observables during migration. | User authorized autonomous completion of this PR. | Codex re-review pass. | `1b72240`, `89cb705`, `73df13c` | Removed after 12 tests, real-trace sampling, and independent review established parity |
| `eval_harness/utils/telemetry/tracing/cc_transcript.ts` | Trace parsers | Reconstruct Claude Code transcripts with Bun while preserving the normalized artifact contract. | User authorized autonomous completion of this PR. | Codex re-review pass; Expo review changes implemented. | `1b72240`, `89cb705`; current PR head | Streams JSONL records, ignores unsupported external record types before message validation, and passes strict typecheck, permanent tests, local collector smoke, and real EAS collection |
| `eval_harness/utils/telemetry/tracing/codex_rollout.ts` | Trace parsers | Reconstruct Codex rollouts with Bun while preserving the normalized artifact contract. | User authorized autonomous completion of this PR. | Codex re-review pass; Expo review changes implemented. | `1b72240`, `89cb705`; current PR head | Uses the shared streaming JSONL reader, ignores unsupported external record types before payload validation, and passes strict typecheck, permanent tests, local collector smoke, and real-session parity sampling |
| `eval_harness/utils/telemetry/tracing/cc_transcript.py` | Trace parsers | Original Claude parser retained temporarily as the differential oracle. | User authorized autonomous completion of this PR. | Codex re-review pass. | `73df13c` | Removed after caller cutover, differential comparison, EAS collection, and review |
| `eval_harness/utils/telemetry/tracing/codex_rollout.py` | Trace parsers | Original Codex parser retained temporarily as the differential oracle. | User authorized autonomous completion of this PR. | Codex re-review pass. | `73df13c` | Removed after caller cutover, differential comparison, real-session sampling, and review |
| `eval_harness/utils/telemetry/tracing/bt_emit.py` | Trace parsers | Document the tested transitional Bun-to-Python Braintrust emission boundary. | User authorized autonomous completion of this PR. | Codex re-review pass. | `73df13c` | Runtime behavior unchanged; conversion/emission remains for a later telemetry slice |
| `eval_harness/utils/artifacts/collect_artifacts.sh` | Trace parsers | Invoke Claude, Codex, and evaluator trace reconstruction through Bun. | User authorized autonomous completion of this PR. | Codex re-review pass. | `1b72240` | Shell syntax, local collector smoke, and real Claude EAS collection pass |
| `test_properties.json` (`SKILL-001`–`SKILL-004`) | Skill evaluator core | Define independent properties for check resolution, metric status handling, trigger partitions, and archive path safety. | User authorized autonomous completion of the skill PR. | Codex findings addressed. | Skill-core PR head | Schema-valid properties have permanent Python/TypeScript tests |
| `package.json`, `bun.lock` | Skill evaluator core | Add the Babel parser, tar reader, and their locked transitive dependencies for syntax analysis and safe artifact handling. | User authorized autonomous completion of the skill PR. | Codex findings addressed. | `290753d` | Frozen install, strict typecheck, and all Bun tests pass |
| `eval_harness/evaluator/skill_invocation/utils.py` | Skill evaluator core | Harden the Python differential oracle against archive traversal, links, unsupported entries, and partial extraction. | User authorized autonomous completion of the skill PR. | Codex findings addressed. | Skill-core PR head | Security regressions and all 115 focused Python tests pass |
| `eval_harness/evaluator/skill_invocation/utils.ts` | Skill evaluator core | Translate shared helpers, preserve semantic JSON and Python rounding behavior, and preflight archives before extraction. | User authorized autonomous completion of the skill PR. | Codex findings addressed. | Skill-core PR head | Focused Bun tests and exact rounding/UTF-8 differential cases pass |
| `eval_harness/evaluator/skill_invocation/uptake_checks/*.ts` | Skill evaluator core | Translate trigger detection, declarative registry behavior, and code-driven uptake checks without changing the check taxonomy. | User authorized autonomous completion of the skill PR. | Codex findings addressed. | `290753d` plus skill-core PR head | Registry metadata and results match Python; registry and code checks have 100% focused line coverage |
| `eval_harness/evaluator/skill_invocation/build_health/*.ts` | Skill evaluator core | Translate syntax parsing and build-bundle health helpers. | User authorized autonomous completion of the skill PR. | Codex findings addressed. | `290753d` plus skill-core PR head | Recorded valid, malformed, missing, and cleanup cases pass |
| `eval_harness/evaluator/skill_invocation/tests/test_skill_eval_core.py` | Skill evaluator core | Protect Python behavior, execute accepted properties, and serve as the temporary differential oracle. | User authorized autonomous completion of the skill PR. | Codex findings addressed. | `7973803` plus skill-core PR head | 115 focused tests pass; retained until the skill CLI cutover PR |
| `eval_harness/evaluator/skill_invocation/tests/skill_eval_core.test.ts` | Skill evaluator core | Permanently protect the translated core and compare modelable behavior with Python during migration. | User authorized autonomous completion of the skill PR. | Codex findings addressed. | `290753d` plus skill-core PR head | 34 tests pass; focused coverage is 98.21% functions and 95.27% lines |

Generated files, renames, deletions, and workflow changes use the same ledger.
A material rebase returns affected rows to a pending review state.

## Baseline identity

| Field | Value |
| --- | --- |
| Date | 2026-07-31 |
| Integration commit | `555a83d` (`Use Claude subscription OAuth in EAS evals`) |
| Integration branch | `codex/migrate-to-ts` |
| Documentation branch | `codex/ts-migration-docs` |
| Python | CPython 3.12.13, resolved by uv |
| Original recorded discovery count | 114 |
| Utility tests omitted by original discovery | 4 |
| Corrected pre-migration baseline | 118 passing tests |
| Documentation branch count | 120 passing tests, including 2 new catalog-integrity tests |
| Active runtime Python physical lines | 7,482 |
| Current active runtime Python physical lines | 6,822 after the timeout helper and 620 parser lines were retired; excludes tests, legacy code, and package-marker files |
| Notes PRD | `dataset/prds/notes/prd/mvp.txt` |
| Notes primitive plan | `dataset/test_plans/primitives/test_insert.txt` |

### Python test commands

```bash
PYTHONPATH=. uv run python -m unittest discover \
  -s eval_harness \
  -p 'test_*.py'

PYTHONPATH=. uv run python -m unittest discover \
  -s eval_harness/utils/tests \
  -p 'test_*.py'
```

Current documentation-branch result:

```text
Main discovery:    114 tests, OK
Utility discovery:  6 tests, OK
Combined:          120 tests, OK
```

Before the two catalog tests were added, utility discovery contained four
tests, making the corrected untouched baseline 118 rather than 114. The main
discovery intentionally prints two error messages while testing invalid
test-plan configurations; those messages do not represent suite failures.

## Coverage baseline

### Commands

The initially planned command was run first:

```bash
PYTHONPATH=. uv run --with coverage coverage run \
  -m unittest discover \
  -s eval_harness \
  -p 'test_*.py'

uv run --with coverage coverage report -m
```

It reported 60% across 3,935 statements, but it included only modules imported
by the tests. A completely unimported module could disappear instead of being
shown at 0%.

The baseline was therefore repeated with explicit source directories:

```bash
PYTHONPATH=. uv run --with coverage coverage run \
  --source=eval_harness/evaluator,eval_harness/utils \
  -m unittest discover \
  -s eval_harness \
  -p 'test_*.py'

uv run --with coverage coverage report -m
```

This reported 59% across 3,998 discoverable statements. Script-style Python
files in utility directories without package `__init__.py` files were still
not listed. The percentage is therefore a useful evaluator baseline, not a
complete measurement of every active Python file.

### Important blind spots

| Module or area | Baseline coverage | Interpretation |
| --- | ---: | --- |
| `eval_harness/utils/shell/timeout_exec.py` | Not discovered | No existing coverage evidence; characterize before translation. |
| Telemetry tracing Python files | Not discovered | No existing coverage evidence; build fixtures before translation. |
| Skill evaluator `main.py` | 0% | Core behavior is tested through imported functions, but the CLI boundary is not. |
| Agent-device tools | 6% | External-command and tool behavior needs recorded-response coverage. |
| Maestro tools | 6% | External-command and tool behavior needs recorded-response coverage. |
| Agent-device bridge | 13% | Process, device, timeout, and cleanup paths are mostly untested. |
| iOS turn aggregator | 17% | Stateful aggregation needs focused examples and model properties. |
| iOS test-plan parser | 18% | Parser grammar and ordering need characterization and properties. |
| Agent-device evaluator | 19% | Orchestration paths are weakly protected. |
| Maestro bridge | 20% | Adapter and failure behavior needs recorded-response coverage. |
| Maestro hierarchy parser | 20% | Structured parsing is a likely PBT candidate. |
| Maestro evaluator | 22% | Orchestration paths are weakly protected. |
| iOS main CLI | 36% | CLI defaults, plan resolution, and output behavior need protection. |

Coverage is a map of executed lines, not a correctness score. There is no
arbitrary percentage gate. Each slice uses this report to find critical blind
spots before translation.

### Python lines-remaining metric

The baseline of 7,482 physical lines was calculated with:

```bash
rg --files eval_harness \
  -g '*.py' \
  -g '!eval_harness/legacy/**' \
  -g '!**/tests/**' \
  -g '!**/__init__.py' \
  -0 | sort -z | xargs -0 wc -l
```

This metric includes comments, docstrings, and blank lines. It excludes tests,
archival code, and package marker files. It is a simple migration-progress
indicator, not a productivity or complexity measure. Future measurements must
use the same definition to remain comparable.

## Interface and artifact inventory

These are compatibility surfaces, not invitations to rename or redesign.

| Surface | Baseline contract |
| --- | --- |
| Primary workflow | `.eas/workflows/eval-e2e.yml` |
| Authoring replay | `.eas/workflows/author-app.yml` |
| iOS evaluator replay | `.eas/workflows/eval-ios-app.yml` |
| Skill evaluator replay | `.eas/workflows/eval-skill-use.yml` |
| Python iOS CLI | `python -m eval_harness.evaluator.ios_agentic.main` |
| Python skill CLI | `python -m eval_harness.evaluator.skill_invocation.main` |
| Authoring shell entrypoint | `eval_harness/app_builder/scripts/author-app.sh` |
| iOS shell entrypoint | `eval_harness/evaluator/ios_agentic/scripts/eval-ios-app.sh` |
| Skill shell entrypoint | `eval_harness/evaluator/skill_invocation/scripts/eval-skill-use.sh` |
| Run index filename | `manifest.json` |
| Skill report artifact | `skill-eval-report` |
| Skill report files | `metrics.json` and `report.html` |
| Expo routing variables | `EAS_PROJECT_ID`, `EXPO_SLUG`, `EXPO_OWNER`, and `EXPO_APP_NAME` |
| Authoring PRD input | Direct `prd` input passed to `author-app.sh` |
| Skill scenario default | `skills_available_unmentioned` |
| Test-plan selection | Resolved from the authored artifact's PRD unless a local CLI override is supplied |

The final migration must preserve workflow inputs, CLI flags and defaults,
environment-variable behavior, artifact names, schemas, and meaningful output
ordering unless a separately reviewed behavior change says otherwise.

## EAS baseline

| Evidence | State |
| --- | --- |
| Notes Python E2E attempt | **Failure:** authoring and skill evaluation passed; iOS evaluation exceeded its 1,800-second guard and exited 124. |
| Workflow run | [`019fb9e9-266b-7d99-9828-0e3ef9f11622`](https://expo.dev/accounts/georgian-team/projects/adi-test-project/workflows/019fb9e9-266b-7d99-9828-0e3ef9f11622) |
| Commit used by EAS | `555a83d` |
| Authoring job | Success: `019fb9e9-2ac9-7979-a048-d87e85370078` |
| Authored-app artifact | `authored-app`, ID `019fb9f3-16b2-7fdb-bf93-421d48d04178` |
| Skill job | Success: `019fb9f3-1ec0-772c-8fbb-b4cc914c5447` |
| Skill artifact | `skill-eval-report`, ID `019fb9f3-581f-7d87-9f30-3da260d7ab5e`; valid `metrics.json` and `report.html` inspected. |
| iOS job | Failure: `019fb9f3-1ec0-7b65-a094-389b63ffe02e` |
| iOS failure artifact | `eval-e2e-output`, ID `019fba19-e857-749d-9606-994ad05daf32` |
| iOS progress at timeout | `test_insert.txt` and `test_delete.txt` completed; `test_update.txt` reached turn 49; 8 of 11 plans did not start. |
| iOS result contract | No final `result.json` or `report.html`; bundle `manifest.json` has null score fields, as expected for an interrupted run. |
| Artifact inspection | Failure logs and three evaluator trace directories are present. Selected files are recoverable, but a full tar listing reports a malformed/truncated entry. |
| Replay input | The authored-app artifact above is the fixed Python baseline input for later skill and iOS replays. |

This is an observed failure of the existing Python baseline, not a migration
regression. The current full Notes iOS workload did not fit the workflow's
30-minute evaluator budget in this baseline run. The reusable authored-app
artifact and successful skill result remain valid baseline evidence. A later
iOS replay must either use a deliberately bounded test surface or first address
the separately reviewed runtime-budget issue; increasing a timeout silently is
not a migration-equivalence change.

## Toolchain EAS validation

| Evidence | State |
| --- | --- |
| Commit | `e950f42` |
| First replay | [Run `019fbbc0-efa2-7470-9927-3a6e16a3e293`](https://expo.dev/accounts/georgian-team/projects/adi-test-project/workflows/019fbbc0-efa2-7470-9927-3a6e16a3e293): failed before analysis because `eas/download_artifact` returned 404 for the historical displayed artifact ID. |
| Bun provisioning in first replay | Pass: EAS logged `Installing bun@1.3.14` and completed `INSTALL_CUSTOM_TOOLS`. |
| Controlled replay | [Run `019fbbc2-9ecd-78ec-b8e1-78876047633e`](https://expo.dev/accounts/georgian-team/projects/adi-test-project/workflows/019fbbc2-9ecd-78ec-b8e1-78876047633e): success using the same artifact through its fresh signed URL. |
| Skill report artifact | `skill-eval-report`, ID `019fbbc2-e2a5-70a3-911d-51ffa97f29b7`; contains `metrics.json` and `report.html`. |
| Deterministic comparison | Exact structural and value match to the original Python `metrics.json` after normalizing only the different temporary authored-root prefix. |
| Artifact-size observation | Replay artifact is about 28 MB because it includes `skill-eval-report/unpacked/authored`; the original E2E skill report was about 9 KB. Recorded as a packaging risk, not changed in this PR. |

## Timeout-helper EAS validation

| Evidence | State |
| --- | --- |
| Commit content | Clean `codex/ts-timeout` worktree at `4ce009e`, uploaded by EAS CLI for an untracked temporary workflow. |
| macOS smoke | [Run `019fbbef-4ae3-7ed3-b24b-31c3a488e14c`](https://expo.dev/accounts/georgian-team/projects/adi-test-project/workflows/019fbbef-4ae3-7ed3-b24b-31c3a488e14c): success. |
| Assertions | Bun 1.3.14 executes the helper; normal output passes through; timeout returns 124 with exact diagnostic; `agents.sh` fallback selects Bun. |
| Reviewed parity smoke | [Run `019fbc1d-2b96-7fc0-8f0b-f742282695c2`](https://expo.dev/accounts/georgian-team/projects/adi-test-project/workflows/019fbc1d-2b96-7fc0-8f0b-f742282695c2): success on macOS for signal status, numeric grammar, scientific formatting, non-finite values, and oversized timers. |
| Bounded caller replay | [Run `019fbbf2-5a5c-7d2a-b354-a91da38398c6`](https://expo.dev/accounts/georgian-team/projects/adi-test-project/workflows/019fbbf2-5a5c-7d2a-b354-a91da38398c6): success against commit `ce88766`. |
| Replay scope | Fixed Notes artifact, release mode, and `test_insert.txt` only. The temporary workflow was not added to the repository and did not change active workflow inputs. |
| Caller evidence | Bun-guarded simulator boot, `ios-runner` preparation, release build/install, launch probe, and evaluator all completed. Result: 6/6 points, 100% macro and micro scores. |
| Replay artifact | `timeout-callers-replay-output`, ID `019fbc03-cf34-79ee-9432-4df537139fc7`, 717,715,469 bytes. |
| Scope boundary | The bounded replay is the timeout-slice gate. The complete 11-plan Notes replay remains part of later iOS/final validation and retains the known 30-minute budget risk (`RISK-003`). |

## Evidence log

| Date | Commit | Slice | Command or workflow | Result | Notes |
| --- | --- | --- | --- | --- | --- |
| 2026-07-31 | `555a83d` | Baseline | `PYTHONPATH=. uv run python -m unittest discover -s eval_harness -p 'test_*.py'` | Pass: 114 tests | Untouched Python baseline. |
| 2026-07-31 | `555a83d` | Baseline correction | `PYTHONPATH=. uv run python -m unittest eval_harness.utils.tests.test_claude_auth` | Pass: 4 tests | Existing utility tests omitted by the original discovery command; corrected untouched baseline is 118. |
| 2026-07-31 | `555a83d` | Coverage | Planned Coverage.py command without `--source` | Pass: 60% of 3,935 discovered statements | Omits completely unimported modules. |
| 2026-07-31 | `555a83d` | Coverage | Coverage.py with explicit evaluator and utility sources | Pass: 59% of 3,998 discovered statements | Script-style utility modules still absent; recorded as blind spots. |
| 2026-07-31 | `aa4d0af` | Property catalog | Draft 2020-12 metaschema and instance validation | Pass | First commit containing the validated schema and catalog; `jsonschema` supplied ephemerally by uv. |
| 2026-07-31 | `fd74f31` | Documentation review fixes | Main and utility unittest discovery plus schema, catalog, and duplicate-ID validation | Pass: 120 tests | Independent Codex re-review found no remaining issues and assessed the slice ready to merge. |
| 2026-07-31 | `555a83d` | Notes E2E baseline | `eas workflow:run .eas/workflows/eval-e2e.yml -F agent=claude-code -F prd=dataset/prds/notes/prd/mvp.txt -F run_eval_ios=true -F run_eval_skill=true -F skill_scenario=skills_available_unmentioned` | Partial: authoring and skill pass; iOS timeout | Run `019fb9e9-266b-7d99-9828-0e3ef9f11622`; timeout occurred during the third of 11 plans. |
| 2026-07-31 | `555a83d` | EAS artifact inspection | Inspect authored app, skill report, and iOS failure bundle | Partial pass | Skill JSON/HTML valid; iOS logs and traces recoverable; no final iOS result; outer tar has a malformed trailing entry. |
| 2026-08-01 | `e242545` | Bun dependency lock | `bun install --frozen-lockfile` with Bun 1.3.14 | Pass: 481 packages checked, no changes | Confirms `package.json` and `bun.lock` agree. |
| 2026-08-01 | `e242545` | Toolchain | `bun run test:all` | Pass | Strict typecheck; 1 Bun test; 114 main-discovery Python tests; 6 utility-discovery Python tests. |
| 2026-08-01 | `e242545` | Python development tools | `uv lock --check`; start Coverage.py and import Hypothesis | Pass | Coverage.py 7.15.2; Hypothesis 6.164.0. |
| 2026-08-01 | `e242545` | EAS Bun provisioning configuration | Official Expo workflow validator on `.eas/workflows/*.yml` | Pass: 4 workflows | Each active workflow pins Bun 1.3.14 under `defaults.tools`. Live EAS provisioning remains pending. |
| 2026-08-01 | `e242545` | Shell compatibility | Parse every active `eval_harness/**/*.sh` with `bash -n` | Pass | Workflow-only tool pins did not alter shell behavior. |
| 2026-08-01 | `a9db7ef` | Python test dependency isolation | Sync isolated environments with bare `uv sync --frozen` and `uv sync --frozen --group test` | Pass | Bare runtime sync contains neither Coverage nor Hypothesis; explicit test sync contains Coverage 7.15.2 and Hypothesis 6.164.0. |
| 2026-08-01 | `a9db7ef` | Corrected toolchain | `bun run test:all` | Pass | The canonical command automatically selects the non-default Python `test` group; strict typecheck, 1 Bun test, and 120 Python tests pass. |
| 2026-08-01 | `e950f42` | Live EAS Bun provisioning | Skill replay run `019fbbc0-efa2-7470-9927-3a6e16a3e293` | Partial: Bun pass; replay input failure | EAS installed Bun 1.3.14 successfully, then the historical artifact-ID lookup returned 404 before analysis. |
| 2026-08-01 | `e950f42` | Controlled EAS skill replay | Skill replay run `019fbbc2-9ecd-78ec-b8e1-78876047633e` using the same artifact's fresh signed URL | Pass | Required report files present; normalized `metrics.json` exactly matches the Python baseline. |
| 2026-08-01 | `987de1b` | Timeout Python characterization | `python -m unittest discover -s eval_harness/utils/tests -p 'test_timeout_exec.py' -v` | Pass: 5 tests; 1 expected failure | Expected failure is specifically `descendant process ... survived wrapper exit`. |
| 2026-08-01 | `987de1b` | Timeout regression check | `bun run test:all` | Pass | Strict typecheck; 1 Bun test; 114 main Python tests; 12 utility tests including 1 expected failure. |
| 2026-08-01 | `7ca8312` | Timeout TypeScript red stage | `bun test eval_harness/utils/tests/timeout_exec.test.ts` plus `bun run typecheck` | Expected red: 5 failures; 1 todo; typecheck passes | All five failures receive exit 1 because `timeout_exec.ts` does not exist; direct Bun invocation confirms module-not-found. |
| 2026-08-01 | `e506682` | Timeout TypeScript green stage | `bun test eval_harness/utils/tests/timeout_exec.test.ts` plus `bun run typecheck` | Pass: 5 tests; 1 todo; strict typecheck passes | Bun implementation preserves the characterized CLI behavior; cleanup todo tracks `DEFECT-001`. |
| 2026-08-01 | `e506682` | Timeout full local regression | `bun run test:all` | Pass | 6 TypeScript tests pass with 1 todo; 114 main-discovery Python tests and 12 utility-discovery Python tests pass with 1 expected failure. |
| 2026-08-01 | `0ae001a` | Timeout differential comparison | Run both timeout CLIs with identical arguments and child commands | Pass: 5 exact comparisons | Missing arguments, invalid timeout, child exit, child output, and timeout observables match exactly. |
| 2026-08-01 | `0ae001a` | Timeout post-differential regression | `bun run test:all` | Pass | Strict typecheck; 11 TypeScript tests with 1 todo; 114 main-discovery Python tests; 12 utility-discovery Python tests with 1 expected failure. |
| 2026-08-01 | `d260437` | First timeout caller cutover | Force `eval::_agent_timeout` fallback; parse all active shell scripts; run `bun run test:all` | Pass | Fallback emits `bun .../timeout_exec.ts 2400`; strict typecheck and all TypeScript/Python suites pass. |
| 2026-08-01 | `fae5d05` | Complete timeout caller cutover | Search active callers; parse all active shell scripts; run focused parity/type checks and `bun run test:all` | Pass | All five caller files use Bun; 10 focused timeout tests and all repository TypeScript/Python suites pass. |
| 2026-08-01 | `4ce009e` | EAS macOS timeout smoke | Temporary validated workflow run `019fbbef-4ae3-7ed3-b24b-31c3a488e14c` | Pass | Bun 1.3.14 executed normal and timed-out commands with expected observables; temporary workflow was not added to the repository. |
| 2026-08-01 | `ce88766` | Bounded EAS timeout-caller replay | Temporary validated workflow run `019fbbf2-5a5c-7d2a-b354-a91da38398c6` | Pass | Real Notes release app and `test_insert.txt`; timeout callers completed; result 6/6; artifact `019fbc03-cf34-79ee-9432-4df537139fc7`. |
| 2026-08-01 | `2145dda` | Timeout TypeScript coverage probe | `bun test --coverage` | Tests pass; no file table emitted | The helper runs in child Bun processes, whose execution is not merged into the parent test process's coverage profile; no percentage claim is made. |
| 2026-08-01 | `668c117` | Timeout Python retirement | Focused TypeScript tests, strict typecheck, all shell parsing, reference audit, and `bun run test:all` | Pass | 7 TypeScript tests; 114 main Python tests; 6 remaining utility Python tests; active runtime Python falls from 7,482 to 7,440 lines. |
| 2026-08-01 | Working tree after `14351bb` | Review parity red stage | Add signal-status and Python-compatible numeric-text regression cases; run focused Bun test and strict typecheck | Expected red: 10 failures; typecheck passes | Failures exactly reproduce status 143 vs 241, JS-only hex acceptance, underscore rejection, exponent spelling, and non-finite/oversized timer drift. |
| 2026-08-01 | `e6ed4e0` | Review parity green stage | Focused tests, strict typecheck, all shell parsing, and `bun run test:all` | Pass | 16 focused timeout tests; 17 total TypeScript tests; 114 main Python tests; 6 utility Python tests. |
| 2026-08-01 | `e6ed4e0` | Timeout-helper Codex re-review | Independent review plus focused suite, strict typecheck, shell parsing, grammar/format edge checks, and a 56-value Python `:g` comparison | Pass | No remaining findings; signal mapping, float compatibility, timer cancellation, expected-failure honesty, and recorded evidence are consistent. |
| 2026-08-01 | `e6ed4e0` | EAS reviewed parity smoke | Temporary validated workflow run `019fbc1d-2b96-7fc0-8f0b-f742282695c2` | Pass | The runtime/test tree later committed as `e6ed4e0` passed all newly reviewed parity cases on Bun 1.3.14 for macOS; the temporary workflow was not added to the repository. |
| 2026-08-01 | `c627356` | Migration-method expansion | Independent review of reference retention, commit/evidence discipline, runtime parity checks, and the concrete rolling-stack restack procedure | Pass | Initial review found two important and two minor documentation gaps; all were fixed, and re-review found no remaining issues. |
| 2026-08-04 | `a184d94` | Trace-parser worktree baseline | Frozen Bun install; Babel parser dependency install; `bun run test:all` | Pass | 17 TypeScript tests, 114 main Python tests, and 6 utility Python tests pass. Fresh worktrees must expose the NVM Node/npm toolchain so inherited Babel-backed Python checks can run. |
| 2026-08-04 | `89cb705` | Trace-parser migration parity | Python characterization/differential suite; strict typecheck; permanent Bun suite; 30 real Claude and 30 real Codex samples | Pass | Twelve Python migration tests and 13 permanent Bun parser tests pass; semantic output matches for sampled real traces and reviewed CLI, parsed-field numeric, and error boundaries. Exact float spelling is not promised for newly derived fields. |
| 2026-08-04 | `89cb705` | Trace-parser Codex review | Independent implementation/reference review followed by focused re-review | Superseded by Expo review | The earlier review fixed argparse behavior, discovery/symlinks, parsed-field numeric compatibility, malformed-record boundaries, and bridge-wrapper coverage. Kudo's later review identified unknown-record, streaming, and real bridge-execution follow-ups. |
| 2026-08-04 | `1b72240` | Claude authoring EAS replay | `author-app.yml` run `019fcd6e-080e-7e5b-99d5-ab2b3330d809` | Pass | Bun 1.3.14 reconstructed `claude-code-authoring.json`; artifact `019fcd81-5c3b-74ad-a0b4-ca4092916715` contains one session, one turn, and 81 tool calls. Later review fixes affect compatibility edges, not the exercised caller path. |
| 2026-08-04 | `1b72240` | Parallel Codex authoring EAS replay | `author-app.yml` run `019fcd6e-28f1-7a66-815c-3591ecc54712` | Infrastructure failure | Expo reported a lost worker connection during agent authoring, before trace collection, and uploaded no artifact. This is not counted as parser pass or failure. |
| 2026-08-04 | `73df13c` | Trace-parser Python retirement | Frozen install; `bun run test:all`; shell syntax; reference audit; official Expo workflow validator | Pass | 30 Bun tests, 114 main Python tests, and 6 remaining utility tests pass; all four workflows validate; only legacy `.py` names retained in help text for CLI compatibility. |
| 2026-08-04 | `73df13c` | Trace-parser coverage | `bun test --coverage eval_harness/utils/tests/trace_parsers.test.ts` | Pass | Thirteen tests pass; Claude parser line coverage is 79.89% and Codex parser line coverage is 77.28%. Coverage is evidence of exercised surfaces, not a correctness score. |
| 2026-08-07 | Review-feedback working tree | Unknown-record red/green tests; real offline bridge invocation; shared streaming reader; strict typecheck; frozen install; `bun run test:all`; focused coverage; shell syntax; Expo workflow validator | Pass | 33 Bun tests and 120 Python tests pass. The 16-test parser suite gives Claude 80.49% and Codex 76.47% line coverage. Unsupported external record types no longer discard valid sessions. Exact float spelling remains guaranteed only for parsed-through values. |
| 2026-08-04 | Skill-core PR head | Skill-core migration gate | Frozen install; strict typecheck; all Bun tests; main and utility Python discovery; focused Python and Bun suites; property-schema validation | Pass | 64 Bun tests, 124 main Python tests, 6 utility Python tests, and all 115 focused Python skill tests pass; five total JSON properties validate. |
| 2026-08-04 | Skill-core PR head | Skill-core differential and coverage evidence | Exact registry/check metadata and results; malformed UTF-8; Python float rounding; `bun test --coverage` | Pass | Thirty-four focused Bun tests pass; 98.21% function and 95.27% line coverage; registry and code-check modules are 100% covered in the focused profile. |
| 2026-08-04 | Skill-core PR head | Skill-core Codex review | Independent review, fixes, and final uncommitted re-review | Pass | Registry initialization/metadata, rounding, UTF-8, cleanup, JSON semantics, and archive preflight findings were fixed; final reviewer reported no actionable regressions. |
| 2026-08-07 | Review-feedback working tree | Safe staged artifact reruns; empty-directory glob parity; deterministic file and JSON ordering; corrupt-versus-unsafe archive errors; strict typecheck; `bun run test:all`; focused coverage | Pass | 71 Bun tests and 131 Python tests pass. The focused skill-core suite has 38 Bun tests and 116 Python tests; its profile is 97.72% functions and 94.93% lines, with registry at 100%. The expanded Python↔TypeScript registry fixture matches exactly. Broad async, Android-platform, and unrelated dependency/SDK changes remain out of this parity PR. |
| 2026-08-07 | Expanded review-feedback working tree | Frozen install; concurrent source discovery/reads; async glob and check dispatch; `Promise.all` syntax checks; iOS/Android bundle selection; root dependency audit; strict typecheck; `bun run test:all`; focused coverage; EAS project resolution | Pass | 74 Bun tests and 131 Python tests pass; the 41-test focused profile is 94.15% functions and 92.63% lines, with registry and syntax checking at 100%. The unused root `expo` dependency and its lock entries were removed; `eas project:info` still resolves `@georgian-team/adi-test-project` with project ID `338f6455-57a3-49c9-a2e0-36e5a0577c77`. |

## Migration defect backlog

Every confirmed implementation defect receives a stable ID, an executable
regression or expected-failing test, and an explicit disposition. Final cutover
cannot silently ignore an open row: it must be fixed, linked to an owned
follow-up issue with a deferral decision, or marked out of scope with rationale.

| ID | Slice | Defect | Executable evidence | Follow-up gate | State |
| --- | --- | --- | --- | --- | --- |
| DEFECT-001 | Timeout helper | After a timeout, the direct child can exit on `SIGTERM` while a descendant that ignores `SIGTERM` remains alive in the managed process group. | Bun's `[SPEC DEFECT-001] timed-out descendants do not survive` uses `test.failing`, executes on every run, and forcibly kills the leaked descendant during cleanup. | Preserve during syntax migration and open an owned behavior-fix follow-up. Remove `test.failing` only when the cleanup contract passes normally. | Open |
| DEFECT-002 | Skill evaluator core | Python artifact extraction could follow archive or pre-existing links, accept unsupported tar entries until extraction time, and leave partial output before rejecting a later unsafe member. | Python and Bun `SKILL-004` regressions cover traversal, symbolic/hard links, special entries, non-empty destinations, and safe-before-unsafe archives. | Fixed immediately because this was a filesystem security/data-integrity defect; keep the permanent regressions after Python retirement. | Fixed in skill-core PR |

## Discrepancies, defects, and risks

| ID | Classification | Observation | Decision | State |
| --- | --- | --- | --- | --- |
| RISK-001 | Coverage risk | Timeout and telemetry script modules did not appear in the Python Coverage.py report. | Treat unmeasured slices as having no baseline coverage and add focused tests before translation. Bun now measures the migrated parsers at 79.89% and 77.28%; remaining telemetry is still unmeasured. | Partially addressed |
| RISK-002 | Compatibility risk | `archive.extractall` emitted a Python 3.14 behavior-change warning, and review confirmed concrete link and partial-extraction vulnerabilities. | Adopted `SKILL-004`, fixed `DEFECT-002` in both the temporary Python oracle and TypeScript implementation, and retained adversarial regressions. | Fixed in skill-core PR |
| RISK-003 | Runtime-budget risk | The full Notes iOS baseline completed two plans and timed out during the third of 11 after 1,800 seconds. | Preserve the failure as baseline evidence. Bound replay scope or change the budget only in a separate reviewed behavior/infrastructure decision. | Open |
| RISK-004 | Observability risk | `EVAL_STREAM_LOGS=1` pipes Python through `tee`, but normal Python output remained buffered until process exit. | Add a focused shell/CLI characterization and make live progress observable before relying on long migration replays. | Open |
| RISK-005 | Artifact-integrity risk | The 630 MB iOS failure artifact has a valid gzip stream and recoverable high-value files, but a complete tar listing reports a malformed/truncated entry. | Inspect failure-package creation before using bundle byte integrity as a migration gate; retain stable EAS artifact IDs rather than expiring URLs. | Open |
| RISK-006 | Dependency-isolation risk | The first toolchain commit placed Coverage and Hypothesis in uv's default `dev` group, so bare EAS `uv sync` would install them. | Move them to a non-default `test` group and select it centrally from `bun run test:python`; prove behavior in isolated environments. | Fixed in `a9db7ef` |
| RISK-007 | Replay-input risk | `eas/download_artifact` returned 404 for the historical authored-app artifact's displayed ID even though the original run still listed it and a fresh signed URL worked. | Preserve both run IDs; use a fresh signed URL for current replay evidence and investigate artifact-ID replay semantics separately from language migration. | Open |
| RISK-008 | Artifact-size risk | The standalone skill replay packaged its unpacked authored app, producing a roughly 28 MB report versus the original E2E report's roughly 9 KB. | Preserve current behavior during toolchain work; review report staging and cleanup during the skill-evaluator slice. | Open |
| RISK-009 | EAS worker reliability | The parallel Codex authoring replay lost its Expo worker during agent execution before trace collection. | Do not infer parser behavior from the run. Retain local/real-session parity evidence and require a successful Codex EAS artifact when the next relevant authoring or end-to-end replay is run. | Open |

The timeout helper and both agent trace parsers have completed TypeScript
cutover. The skill evaluator's utilities, trigger/check registry, code-driven
checks, and build-health helpers now have an additive TypeScript implementation;
its Python caller remains active until the next PR migrates analysis, reporting,
and the CLI and validates the complete EAS replay. Braintrust span conversion
and emission still use Python behind a tested transitional bridge. Existing
defects discovered later must be recorded without being silently fixed as part
of syntax translation, except serious security or data-loss defects such as
`DEFECT-002`, which require an explicit immediate disposition.

## Review record

| Review | Reviewer or tool | State | Link or evidence |
| --- | --- | --- | --- |
| Author self-review | Pending | Pending | — |
| Codex review | Independent Codex reviewer | Pass | Initial findings fixed; final re-review found no remaining issues and assessed the slice ready to merge. |
| AI-assisted PR review | Independent Codex reviewer | Pass | User selected Codex review as sufficient; no Copilot or additional third-party review required. |
| Toolchain Codex review | Independent Codex reviewer | Pass | One P2 dependency-isolation issue fixed in `a9db7ef`; re-review found no remaining issues. |
| Timeout-helper Codex review | Independent Codex reviewer | Pass | No critical issues; two important signal-status and timeout numeric-text parity gaps were fixed, and re-review found no remaining issues. |
| Trace-parser Codex review | Independent Codex reviewer | Pass | Five important compatibility gaps were fixed; focused re-review found no remaining critical or important issues and assessed the slice ready. |
| Skill-core Codex review | Independent Codex reviewer | Pass | Registry initialization/metadata, float rounding, UTF-8 parity, bundle cleanup, JSON semantics, and archive preflight findings were fixed; final re-review reported no actionable regressions. |
| Migration-method Codex review | Independent Codex reviewer | Pass | Reference retention, evidence attribution, safe stack restacking, and final post-retirement review are internally consistent; re-review found no remaining issues. |
| Expo collaborator review | Pending | Pending | — |
| Umbrella approval | Pending | Pending | — |

AI review supplements human ownership. It does not replace Expo review for
workflow contracts, evaluator semantics, or infrastructure behavior.
