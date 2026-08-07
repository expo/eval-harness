# Task 2 — Muse trace normalization, artifacts, and trigger scoring

## Implementation

- Added `eval_harness/utils/telemetry/tracing/muse_session.ts`, a Muse durable-session JSONL parser and reconstruction CLI. It normalizes run prompts, assistant tool calls/results, assistant messages, model/token usage, metadata, terminal state, malformed records, and incomplete turns into the established `turns -> steps -> tool_calls` envelope.
- Durable `skill_read_observed` events (including the compatible direct `agent.skill_read.observed` payload) become stable-deduplicated `Skill` tool calls with the exact `skill_id` and observation evidence fields. Non-durable observations are ignored.
- Added run-time/mtime-filtered Muse session discovery under `$MUSE_DATA_ROOT/muse/sessions`, a parse-only mode, Braintrust fail-open export, and the source/agent values `muse-code-authoring` / `muse-code`.
- Artifact collection now reconstructs `telemetry/traces/muse-code-authoring.json`, preserves `telemetry/meta.jsonl` and raw Muse sessions, emits the trace in diagnostics, and retains the existing manifest `muse_cli_version` field.
- Skill analysis now discovers Muse traces; structured Muse `Skill` calls score exact IDs while excluding `bundled:` skills from Expo trigger evidence.

## Files

- `eval_harness/utils/telemetry/tracing/muse_session.ts`
- `eval_harness/utils/artifacts/collect_artifacts.sh`
- `eval_harness/evaluator/skill_invocation/analysis.ts`
- `eval_harness/evaluator/skill_invocation/uptake_checks/trigger.ts`
- `eval_harness/utils/tests/trace_parsers.test.ts`
- `eval_harness/utils/tests/muse_authoring.test.ts`
- `eval_harness/evaluator/skill_invocation/tests/skill_eval_core.test.ts`
- `eval_harness/evaluator/skill_invocation/tests/skill_eval_analysis.test.ts`

## RED/GREEN evidence

1. RED: `bun test eval_harness/utils/tests/trace_parsers.test.ts` failed because `../telemetry/tracing/muse_session.ts` did not exist.
2. GREEN: after implementing the parser, the focused four-file run passed: `77 pass, 0 fail, 3058 expect() calls`.
3. RED: `bun test eval_harness/evaluator/skill_invocation/tests/skill_eval_core.test.ts` failed because bundled Muse skill reads were reported as `read-session`.
4. GREEN: Muse trigger detection now excludes `bundled:` calls and the focused test passed.
5. RED: `bun test eval_harness/evaluator/skill_invocation/tests/skill_eval_analysis.test.ts` failed because `muse-code-authoring.json` was not a trace candidate.
6. GREEN: artifact discovery and analysis found the Muse trace and trigger scored `expo-test` at recall/precision `1`.
7. RED: the durable-session parser test failed when an ephemeral skill-read record was normalized.
8. GREEN: it now passes after filtering non-durable observations.

## Verification

- Focused parser, authoring/artifact, and skill-evaluator tests: `77 pass, 0 fail`.
- TypeScript type-check: `bun run typecheck` passed.
- Shell syntax: `find eval_harness -name '*.sh' -print0 | xargs -0 bash -n` passed.
- Full suite: `env UV_CACHE_DIR=/private/tmp/codex-uv-cache-muse bun run test:all` passed: TypeScript check, `95` Bun tests, and `18` Python tests.

## Self-review

- Parser output uses the same envelope and Braintrust bridge as Claude/Codex.
- Skill IDs are preserved verbatim in normalized calls; only the Muse trigger scorer filters `bundled:` internal skills.
- Repeated skill observations retain first-observed order, while result matching remains call-ID based.
- Artifact reconstruction remains fail-open and uses the isolated `MUSE_DATA_ROOT` selected during authoring.
- The only pre-existing unstaged files remain `.eas/workflows/author-app.yml`, `.eas/workflows/eval-e2e.yml`, and `.env.default`; they were not changed or staged by Task 2.

## Concerns

None. The fixture is compact and schema-derived; it does not copy the credential-free smoke-session log wholesale.
