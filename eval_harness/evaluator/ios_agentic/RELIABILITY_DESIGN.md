# iOS Evaluator Reliability Design

## Goal

Given a healthy authored Expo project, the iOS evaluator must either evaluate
every expected plan or report a structured evaluator failure. Driver, SDK,
restart, timeout, and quota failures must never appear as app-score failures or
as a successful EAS job.

This work hardens the evaluator machinery. It does not redesign the semantic
content of seeding or the primitive plans. We will use the resulting timing
evidence for that later design work.

## App source and build modes

The coding agent authors an Expo source project. It does not commit the harness
to Expo Go, a development build, or a release build. The evaluation workflow
chooses how to build the same source:

- **Expo Go** supports only projects compatible with the native modules already
  inside Expo Go. It is not the general evaluator path.
- **Development client** builds the authored native project with Expo's
  development launcher and loads JavaScript from Metro. It is useful for
  debugging, but its launcher and the authored app share one data container.
- **Release** builds the authored native project without Metro or the
  development launcher. It supports custom native modules and is closest to
  the shipped app.

Both development-client and release modes remain supported. The primary EAS
and reliability-validation path uses release mode because it removes the
launcher/Metro state from repeated app restarts. This does not constrain what
the coding agent can author.

## Outcome model

Every expected plan has exactly one terminal status:

- `completed`: every formal step produced a scored result. Failed app
  assertions are valid completed results and may score zero.
- `not_applicable`: the plan does not apply to the app, with a recorded reason.
- `evaluator_error`: the harness could not complete the plan, with a stage and
  reason. Restart failures, agent/driver aborts, SDK errors, and future phase
  timeouts use this status.

The suite status is `completed` only when every expected plan is `completed` or
`not_applicable`. Any `evaluator_error` makes the suite `incomplete`, makes the
CLI and EAS job exit non-zero, and remains visible in the uploaded result.

```text
failed assertion  -> completed plan, score reflects failure
driver/SDK failure -> evaluator_error plan, incomplete suite, failed EAS job
```

## Agent phase termination

`complete_step` currently records completion but does not stop Claude's active
response. After the MCP tool changes step state, the evaluator will call the
Claude SDK's `interrupt()` operation and drain the SDK response to its terminal
message before sending the next prompt.

The agent also receives an explicit `abort_step` tool. It records a structured
category and reason when a phase cannot make progress. It is distinct from a
failed app assertion: an abort means the evaluator could not finish judging the
app. Calling either completion tool mechanically interrupts the active response.

Prompts will tell the agent to abort after a terminal driver error or repeated
recovery attempts without observable progress. Existing 200/50 turn ceilings
remain unchanged during the first hardening pass so that old high-complexity
cases are not excluded without evidence.

## Checkpointing and cleanup

The CLI writes `result.json` atomically after each plan. It first writes a
temporary sibling and then replaces the public result path, so an interrupted
write cannot expose malformed JSON. The checkpoint includes expected and
completed plan counts, suite status, every terminal plan result, and errors.

Bridge cleanup runs in `finally`, including after exceptions. If an unexpected
exception occurs in one plan, the CLI records it as `evaluator_error`, writes a
checkpoint, and continues when possible so later plans can provide diagnostic
evidence. The final exit remains non-zero.

## Restart policy

The replay workflow defaults to release mode, matching the full E2E workflow.
Release restarts terminate, clear authored-app data, launch the installed app,
and wait for authored-app content.

Development-client mode remains an explicit debug option. It must not delete
the entire shared development-client container by default because doing so
deletes launcher connection state. A failure to restore authored-app content is
reported as `evaluator_error`; it is never converted to an empty zero score.

The existing Maestro-hybrid restart remains available as a diagnostic option.
It does not solve deleted development-client state, and prior matrix runs found
its Maestro/JVM lifecycle could itself flake, so it is not restored as the
unconditional default.

## Timing policy

We will not choose smaller turn budgets or final wall-clock limits until the
mechanical completion and restart defects are removed. Traces will record phase
duration and turns used. Repeated Notes and Pool runs will show the normal and
tail distributions.

After that evidence, a separate decision will set per-seed, per-step, per-plan,
and last-resort suite limits. A later seeding/plan-strategy review may change
semantic setup behavior; this reliability work only prevents unbounded or
misclassified execution.

## Artifact policy

Evaluator artifacts retain results, reports, traces, screenshots, manifests,
app source needed to understand the run, and relevant stage/build logs. They
exclude reproducible dependency and native build caches such as
`node_modules`, Pods, DerivedData, and compiled build products.

## Verification

Automated tests must prove:

1. Restart and agent aborts become `evaluator_error` rather than empty scores.
2. Any evaluator error makes the suite incomplete and the CLI/shell exit
   non-zero.
3. Successful and not-applicable plans remain valid.
4. A checkpoint survives a later plan failure.
5. `complete_step` and `abort_step` interrupt the active SDK response.
6. Cleanup runs after success and failure.
7. Release is the replay default and development-client mode preserves launcher
   state by default.
8. Artifact packaging excludes derived build data while retaining diagnostics.

EAS acceptance uses the same healthy Notes artifact for three consecutive
release replays and the same healthy Pool artifact for three consecutive
release replays. Scores and agent trajectories may vary. Every run must:

- Finish the workflow successfully.
- Produce one legitimate terminal result for every expected plan.
- Contain no evaluator error, restart failure, quota failure, or timeout.
- Produce valid result/report/trace artifacts.
- Record phase durations and turn counts for the later timeout and seeding
  analysis.
