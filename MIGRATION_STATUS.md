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
| Timeout and process helper | `codex/ts-timeout`; PR pending | None; process timing is unsuitable for useful PBT | 5 characterization tests pass; cleanup specification is expected-failing | 5 strict TypeScript tests committed at the verified red stage; implementation pending | Pending | Focused module coverage pending | Authoring replay pending | Pending | Pending | In progress |
| Telemetry parsers and emission | Branch/PR pending | To be selected per parser | Fixture and property tests pending | Pending | Pending | Script-style modules currently absent from coverage report | `author-app.yml` pending | Pending | Pending | Not started |
| Deterministic skill evaluator | Branch/PR pending | To be selected | Existing core suite passes | Pending | Pending | Core mostly covered; CLI is 0% | Skill replay pending | Pending | Pending | Not started |
| iOS core, parsing, scoring, and reports | Branch/PR pending | To be selected | Existing report and resolution tests pass | Pending | Pending | Important modules range from 17% to 89% | iOS replay pending | Pending | Pending | Not started |
| iOS bridges and tools | Branch/PR pending | To be selected | Recorded-adapter tests pending | Pending | Pending | Tools are 6%; bridges are 13% and 20% | iOS replay pending | Pending | Pending | Not started |
| iOS orchestration and CLI | Branch/PR pending | To be selected | Orchestration characterization pending | Pending | Pending | Main is 36%; evaluators are 19% and 22% | iOS replay pending | Pending | Pending | Not started |
| Final cutover and cleanup | Umbrella PR pending | All accepted IDs | Final Python comparison pending | Full Bun suite pending | Final parity pending | Final report pending | Notes E2E pending | Pending | Pending | Not started |

## Active rolling stack

The stack is capped at three dependent child PRs. Only the lowest stable PR is
initially marked ready for Expo review.

| Position | Branch | Base | Local checkout | PR state |
| --- | --- | --- | --- | --- |
| Integration | `codex/migrate-to-ts` | `main` | Repository root | Umbrella draft not opened |
| A | `codex/ts-migration-docs` | `codex/migrate-to-ts` | `.worktrees/ts-migration-docs` | [PR #24](https://github.com/expo/eval-experiments/pull/24); ready for Expo review |
| B | `codex/ts-toolchain` | `codex/ts-migration-docs` | `.worktrees/ts-toolchain` | [PR #25](https://github.com/expo/eval-experiments/pull/25); ready for Expo review |
| C | `codex/ts-timeout` | `codex/ts-toolchain` | `.worktrees/ts-timeout` | Active development; not opened |

No fourth dependent PR may be opened until the bottom PR merges. After a
bottom PR merges, its successor is rebased and retargeted, affected checks are
rerun, and materially changed diffs are reviewed again.

## File-level change ledger

Every tracked path is approved and reviewed independently of its containing
slice. “Proposed before edit” means the file's purpose, exact change, expected
effect, and verification were presented in the task before it was modified.

| Path | Slice | Purpose | Approval evidence | Review | Evidence commit | State |
| --- | --- | --- | --- | --- | --- | --- |
| `MIGRATION_TESTING.md` | Documentation | Define migration and testing gates. | Explicitly approved before review-fix edit. | Codex re-review passed. | `aa4d0af`, `fd74f31` | Implemented in PR #24 |
| `MIGRATION_STATUS.md` | Documentation | Record branches, evidence, risks, and reviews. | Explicitly approved before review-fix edit. | Codex re-review passed. | `c719dd3`, `fd74f31` | Implemented in PR #24 |
| `README.md` | Documentation | Link migration material without changing runtime guidance. | Plan approved; proposed before edit. | Codex review: no issue. | `aa4d0af` | Implemented in PR #24 |
| `test_properties.json` | Documentation | Hold reviewed language-independent properties. | Plan approved; proposed before edit. | Codex review: no issue. | `aa4d0af` | Empty draft in PR #24 |
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
| `eval_harness/utils/tests/test_timeout_exec.py` | Timeout helper | Characterize the Python CLI and expose incomplete descendant cleanup. | Explicitly approved before edit. | Pending. | `987de1b` | 5 pass; 1 expected failure |
| `eval_harness/utils/tests/timeout_exec.test.ts` | Timeout helper | Define TypeScript parity behavior before implementation and retain a todo for `DEFECT-001`. | Explicitly approved before edit. | Pending. | `7ca8312` | Strict typecheck passes; 5 tests fail because implementation is absent; 1 todo |

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

## Migration defect backlog

Every confirmed implementation defect receives a stable ID, an executable
regression or expected-failing test, and an explicit disposition. Final cutover
cannot silently ignore an open row: it must be fixed, linked to an owned
follow-up issue with a deferral decision, or marked out of scope with rationale.

| ID | Slice | Defect | Executable evidence | Follow-up gate | State |
| --- | --- | --- | --- | --- | --- |
| DEFECT-001 | Timeout helper | After a timeout, the direct child can exit on `SIGTERM` while a descendant that ignores `SIGTERM` remains alive in the managed process group. | `test_spec_timed_out_descendants_do_not_survive` is an expected failure; temporary probe and test cleanup forcibly kill the leaked descendant. | Decide explicitly whether to fix before TypeScript cutover or preserve temporarily and open an owned post-migration issue. Remove `expectedFailure` only when the cleanup contract passes. | Open |

## Discrepancies, defects, and risks

| ID | Classification | Observation | Decision | State |
| --- | --- | --- | --- | --- |
| RISK-001 | Coverage risk | Timeout and telemetry script modules do not appear in the Coverage.py report. | Treat them as having no baseline coverage and add focused tests before translation. | Open |
| RISK-002 | Compatibility risk | `archive.extractall` emits a Python 3.14 behavior-change warning during the suite. | Review archive path-safety as a critical specification candidate during skill-evaluator migration; do not classify a defect before contract analysis. | Open |
| RISK-003 | Runtime-budget risk | The full Notes iOS baseline completed two plans and timed out during the third of 11 after 1,800 seconds. | Preserve the failure as baseline evidence. Bound replay scope or change the budget only in a separate reviewed behavior/infrastructure decision. | Open |
| RISK-004 | Observability risk | `EVAL_STREAM_LOGS=1` pipes Python through `tee`, but normal Python output remained buffered until process exit. | Add a focused shell/CLI characterization and make live progress observable before relying on long migration replays. | Open |
| RISK-005 | Artifact-integrity risk | The 630 MB iOS failure artifact has a valid gzip stream and recoverable high-value files, but a complete tar listing reports a malformed/truncated entry. | Inspect failure-package creation before using bundle byte integrity as a migration gate; retain stable EAS artifact IDs rather than expiring URLs. | Open |
| RISK-006 | Dependency-isolation risk | The first toolchain commit placed Coverage and Hypothesis in uv's default `dev` group, so bare EAS `uv sync` would install them. | Move them to a non-default `test` group and select it centrally from `bun run test:python`; prove behavior in isolated environments. | Fixed in `a9db7ef` |
| RISK-007 | Replay-input risk | `eas/download_artifact` returned 404 for the historical authored-app artifact's displayed ID even though the original run still listed it and a fresh signed URL worked. | Preserve both run IDs; use a fresh signed URL for current replay evidence and investigate artifact-ID replay semantics separately from language migration. | Open |
| RISK-008 | Artifact-size risk | The standalone skill replay packaged its unpacked authored app, producing a roughly 28 MB report versus the original E2E report's roughly 9 KB. | Preserve current behavior during toolchain work; review report staging and cleanup during the skill-evaluator slice. | Open |

No Python-to-TypeScript behavioral discrepancy exists yet because no runtime
slice has been translated. Existing defects discovered later must be recorded
without being silently fixed as part of syntax translation.

## Review record

| Review | Reviewer or tool | State | Link or evidence |
| --- | --- | --- | --- |
| Author self-review | Pending | Pending | — |
| Codex review | Independent Codex reviewer | Pass | Initial findings fixed; final re-review found no remaining issues and assessed the slice ready to merge. |
| AI-assisted PR review | Independent Codex reviewer | Pass | User selected Codex review as sufficient; no Copilot or additional third-party review required. |
| Toolchain Codex review | Independent Codex reviewer | Pass | One P2 dependency-isolation issue fixed in `a9db7ef`; re-review found no remaining issues. |
| Expo collaborator review | Pending | Pending | — |
| Umbrella approval | Pending | Pending | — |

AI review supplements human ownership. It does not replace Expo review for
workflow contracts, evaluator semantics, or infrastructure behavior.
