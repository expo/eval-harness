# Real Ollama end-to-end test

This suite runs a real local model through `ollamaRunner`, the public package
exports, Vitest registration, a child-process CLI, fixture cleanup, and persisted
execution/check artifacts. It complements the offline fake-server and packed
consumer tests. It does not run from `bun test` or the root `test:ts` script.

The agent receives a bug report: cart subtotals are incorrect for multiple units.
The harness first records the failing baseline tests. The agent must inspect a
small JavaScript project, change the implementation, run the tests successfully,
and finish with a summary. The command
adapter exposes generic `list`, `read`, `write`, and `test` operations. The prompt
describes these tools but provides neither a patch nor a prescribed action sequence.

Independent checks execute the repaired module against additional cases outside the
agent's project (mixed items, zero quantity, empty cart, and input preservation).
They also require the original tests and documentation to remain unchanged, and
verify evidence of source inspection and a passing test after editing.
A final hook verifies workspace removal, registered cleanup, and saved check counts.
The final source, tests, and README are preserved alongside the model transcript.

This is a small coding task through the kit's public API, using a self-contained
project and command adapter.

## Run locally

Install Bun 1.3.14, Node >=22.17, and Ollama. Start Ollama in another terminal
with `ollama serve`, then run from the repository root:

```sh
ollama pull qwen3:4b
bun install --frozen-lockfile
bun run --cwd packages/agent-eval-vitest test:e2e
```

`OLLAMA_HOST` selects a different server. `OLLAMA_E2E_MODEL` overrides the model
for local experiments. The defaults are `qwen3:4b`, temperature 0, seed 42. Thinking is enabled for diagnosis and code editing. The test allows twelve model turns,
15 minutes per HTTP request, and 30 minutes for the full evaluation. Slow CPU
inference can take several minutes; no live server means this explicit command
fails rather than skipping silently.

Evidence is under `packages/agent-eval-vitest/.eval-results/ollama-e2e/`: Vitest
JSON plus per-case `ollama.jsonl`, `result.json`, and a cleanup marker. The package
is built before the test; the ephemeral application workspace is always removed.

## GitHub Actions

`.github/workflows/ollama-e2e.yml` runs on relevant PR changes, main pushes, and
manual dispatch. The job is advisory while model
reliability is measured. Inspect the explicit step outcome and uploaded evidence;
a successful workflow conclusion alone does not prove that model inference passed.
The ordinary offline tests remain blocking.

The job installs checksum-verified Ollama 0.32.15 on Ubuntu 24.04, starts a
loopback-only server, pulls `qwen3:4b`, and runs Vitest under Node 22.17. It uses
no model API secrets or GPU and does not cache model weights. The model tag can
change upstream; the uploaded `/api/tags` response records its actual digest.
Artifacts and server/version logs are uploaded even after test failures and kept
for seven days. No hosted-model fallback or automatic inference retries are used.
