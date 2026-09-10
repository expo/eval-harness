# @expo/agent-eval-vitest

Agent evaluations expressed as colocated `.eval.ts` cases. Each case prepares a
project, runs an agent once, then reports independent named checks through Vitest.
This package is being prepared for its first npm release; the examples below use
the intended registry name. It requires Node >=22.17 and Vitest >=4.1.0 <5.

## A case with a custom runner

```ts
// refresh.eval.ts
import { createAgentEval, expect } from '@expo/agent-eval-vitest';
import { myToolLoop } from './runner';
import { startReloadFixture } from './fixtures';

const agentEval = createAgentEval({
  runner: myToolLoop,
  timeoutMs: 900_000,
  artifactsDir: '.eval-results',
});

agentEval(
  import.meta.url,
  {
    prompt: 'The app still shows the old screen after my edit. Refresh it.',
    projectSetup: {
      async prepareAsync({ root, signal, onCleanup }) {
        const fixture = await startReloadFixture(root, signal);
        onCleanup(() => fixture.stop());
        return fixture;
      },
    },
  },
  (check) => {
    check('runtime receives the reload', (_workspace, { fixture }) => {
      expect(fixture.reloadRequests()).toHaveLength(1);
    });
    check('agent explains the result', (_workspace, { execution }) => {
      expect(execution.finalAnswer).toContain('refreshed');
    });
  }
);
```

Fixture and runner implementations belong to the consumer. The return type from
`prepareAsync` flows into check callbacks. Register cleanup immediately after
acquiring each resource, including resources created before setup completes.

Use a dedicated Vitest config so costly agent runs are separate from unit tests:

```ts
// vitest.evals.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['**/*.eval.ts'],
    // The package imports Vitest's test/hook API; keep the same module context.
    server: { deps: { inline: ['@expo/agent-eval-vitest'] } },
    maxWorkers: 1,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
```

```sh
npx vitest run --config vitest.evals.config.ts
```

`agentEval.skip(...)`, `agentEval.only(...)`, normal name filtering, ordinary
Vitest assertions, and `skip(note)` inside a check are supported. A skipped or
fully filtered case does not start an agent. No custom reporter is required.

`timeoutMs` controls setup plus the agent run. Each check (including work before
`skip()`) uses Vitest's separate `testTimeout`; consumer hooks use `hookTimeout`.
The kit supplies its own timeout for its setup and cleanup hooks.

## Runner and lifecycle contract

An `AgentRunner` receives `{ prompt, root, artifactsDir, signal }` and returns:

```ts
{
  finalAnswer: string | null,
  toolCalls: Array<{ id: string; name: string; input: unknown;
                    result?: unknown; error?: string }> | null,
  endReason: 'completed' | 'failed' | 'cancelled' | 'timeout' | 'budget-exhausted',
  artifacts: string[], // paths relative to artifactsDir
  metadata?: Record<string, unknown>,
}
```

Use `null` for unavailable evidence, rather than claiming no tools were called.
Keep evidence/metadata JSON-serializable. Write raw transcripts into `artifactsDir`,
not the disposable workspace. Provider/tool-specific data can remain in `input`,
`result`, and metadata; a check must understand its runner's tool vocabulary.

Reject for infrastructure failures (missing executable, invalid protocol, etc.).
Return execution evidence when an agent made an unsuccessful attempt. A tool's
nonzero exit alone does not imply infrastructure failure. Checks still run on
unsuccessful attempts, but a non-completed execution makes the Vitest suite fail
even if preservation checks pass.

Setup and runners must honor `signal`, stop their resources, and settle on abort.
The kit imposes its own deadline, waits a bounded interval for cancellation, then
runs registered cleanup in reverse order. The original setup/runner `signal` is
already aborted inside `onCleanup`; do not reuse it for shutdown requests. Cleanup also runs after partial setup
failure and runner failure. Disposers share a total `cleanupTimeoutMs` budget (default 5s);
subsequent disposers are still invoked if one fails. Cleanup commands registered
through `runAsync` receive a fresh signal bounded by that cleanup deadline.
`runAsync(command, args, { timeoutMs })` uses milliseconds (default `600_000`). JavaScript cannot forcibly terminate
an arbitrary injected function that ignores cancellation. Checks should observe
completed evidence and avoid starting unregistered asynchronous work.

The default `agentEval` uses `claudeRunner()`, exported separately from
`@expo/agent-eval-vitest/claude`. It runs the installed Claude Code CLI with
`--dangerously-skip-permissions` in the temporary workspace. CLI authentication
must already be configured. Configure the model with `claudeRunner({ model })`;
otherwise the legacy model environment override or the CLI configuration applies.
The adapter records separate stdout JSONL and stderr artifacts, normalizes tool
calls/results, and waits for process termination and artifact flushing. This
release targets POSIX hosts for subprocess-tree cancellation; Windows child
process trees are not covered by that guarantee.

## Ollama command runner

`ollamaRunner` runs a bounded JSON command loop against Ollama's
[`/api/chat` API](https://docs.ollama.com/api/chat). The model emits `{"run": ["command", "arg"]}` or
`{"done": true, "summary": "..."}`. This uses JSON output, not native Ollama tool
calling. The caller supplies the command executor and describes its CLI in the
system prompt; the runner never implicitly exposes a shell or reads workspace files.

```ts
import { ollamaRunner } from '@expo/agent-eval-vitest/ollama';

const runner = ollamaRunner({
  model: 'qwen3:4b', // provision this model before the evaluation
  systemPrompt: 'Use the agent CLI to inspect the project. Start with status --json.',
  maxTurns: 8,
  async runCommand(args, { root, signal }) {
    // Your executor validates argv, runs the fixed CLI in root, forwards signal,
    // and returns { exitCode, stdout, stderr }. It must settle after cancellation.
    return executeAgentCli(args, { cwd: root, signal });
  },
});
const agentEval = createAgentEval({ runner, timeoutMs: 20 * 60_000 });
```

`executeAgentCli` above is consumer-owned: validate arguments, select the executable,
forward cancellation, and capture stdout/stderr. Describe available commands in the
system prompt; the runner adds JSON action instructions. Put grading in Vitest checks.

Supply `actionSchema` to constrain generation with an Ollama JSON Schema matching
your command interface. It must retain the runner's `run`/`done` action shapes.
Runtime action parsing and command-handler validation still apply.

The host defaults to `OLLAMA_HOST` or `http://127.0.0.1:11434`; `host` overrides it.
The model is always explicit. The runner does not start Ollama or pull models.
Use `think: false` to disable thinking for supported models; when omitted, the
server/model default applies. Defaults are 8 chat requests, temperature 0, seed 42, and a 15-minute deadline per
HTTP request. Configure the evaluation's total `timeoutMs` separately; the default
kit deadline may be shorter than local inference. Node HTTP avoids fetch's shorter
headers timeout, and the runner cancels pending HTTP requests on abort.

Each command receives the workspace context and abort signal. Nonzero command
exits are fed back to the model; thrown executor errors reject as infrastructure
failures. Stdout/stderr feedback is limited to `maxOutputChars` (800 per field by
default), while full results remain in `execution.toolCalls` and `ollama.jsonl`.
The transcript also records requests, responses, and errors in `artifactsDir`.
It contains prompts and command output, so treat it as evaluation evidence.

Malformed model actions receive corrective feedback and count toward `maxTurns`.
Exhausting turns or generation length returns `budget-exhausted`; HTTP deadlines
return `timeout`; cancellation returns `cancelled`. HTTP/protocol failures reject.
There are no live-model calls in the package tests: they use a local fake HTTP
server, including the packed consumer test under Node.

## Workspace helpers

Workspace helpers (`read`, `exists`, `sourceFiles`, `source`, `packageJson`, `glob`)
and workspace-first named check callbacks keep their familiar shape.
`loadAstSupport()` uses the shipped scanner dependency; a broken parser install
throws instead of silently skipping AST checks.

## Expo fixtures and migration from the old kit

Wrap the old declarative setup with `createExpoProject`:

```ts
import { createExpoProject } from '@expo/agent-eval-vitest/expo';

const projectSetup = createExpoProject({
  packageName: 'expo-sqlite',
  packageRoot: new URL('../../', import.meta.url),
  skillDir: new URL('../', import.meta.url),
  fixturesDir: new URL('./fixtures/', import.meta.url),
  baseDirectory: new URL('./base-app/', import.meta.url),
  fixture: 'notes-db',
  files: { 'README.md': 'Eval workspace\n' },
  async prepareAsync({ runAsync }) {
    await runAsync('npm', ['install']);
  },
});
```

Paths above are illustrative; resolve them for your case location. The prepared
base and fixtures must contain ordinary files/directories, not symlinks. Builds
and dependencies required by the local package must already be available in its
checkout. After preparation, the adapter sets the manifest dependency and links
`node_modules/<package>` to the actual local checkout. Tests verify real module
resolution, rather than just reading the dependency declaration.

Scaffolding is an explicit alternative to `baseDirectory`: supply an exact
`createExpoAppVersion` and an explicit `baseTemplate` (pin the template too for
reproducibility). There is no shared scaffold cache in this initial implementation.
The old implicit `create-expo-app@latest` behavior is deliberately removed.

For `with-skill`, the adapter copies the package skill into the Claude skill
layout and excludes `.evals`. For `without-skill`, it removes that package's skill
at the same target; consumers remain responsible for any other skills/config
present in their base fixture. Generic project setups do not require Expo or a
skill directory.

Migration from the unpublished `@expo/skill-eval-kit`:

1. Change imports to `@expo/agent-eval-vitest` and wrap declarative setup with
   `createExpoProject`, choosing a prepared base or explicit pinned scaffold.
2. Replace the in-repo source alias with the installed package and use the
   dependency-inline setting above.
3. Keep the existing `agentEval(import.meta.url, options, checks)` call shape.

Legacy `EXPO_SKILL_EVAL_TIMEOUT` (seconds), `EXPO_SKILL_EVAL_CONDITION`,
`EXPO_SKILL_EVAL_DRY`, `EXPO_SKILL_EVAL_KEEP`, and `EXPO_SKILL_EVAL_MODEL` remain
supported. Explicit configuration wins over environment values. Other timing
options use milliseconds.

## Results and verification

Every executed case writes `.eval-results/<case>-<attempt>/result.json` with
`schemaVersion: 1`, task status, check counts/results, execution evidence, prompt,
condition, timing, and errors. Status distinguishes `passed`, `failed`, `error`,
`ungraded` (no passing checks), and `dry-run`. Dry-run seeds are never labeled as
agent success. Agent/provider metadata is available when supplied by the runner.
A dedicated aggregate reporter and fixture-content fingerprinting remain follow-up
work; this result format is separate from the existing EAS producer manifests.

Failed checks do not prevent later checks. Check retries/repeats are disabled;
a Vitest watch rerun starts a new case attempt. `keepWorkspace` retains files for
inspection but still stops registered resources. Transcripts and result files
remain available after workspace deletion; manage their retention in consumer CI.

```sh
bun run build
bun run --cwd packages/agent-eval-vitest test
bun run --cwd packages/agent-eval-vitest test:pack
```

Tests use fake runners, fake CLI executables, fixture resources, and actual Vitest
subprocesses. The packed smoke test installs the tarball with npm and Bun in clean
projects outside the repo, runs Vitest under Node, and checks public exports
and TypeScript inference. It needs registry access but makes no model calls.

The kit uses Bun's JavaScript bundler. `@expo/source-scan` is a private workspace
dev dependency: its code is included in the generated ESM, while Babel and Vitest
stay external. Babel is a runtime dependency and Vitest is a peer dependency.
No source-scanning files are copied into the kit's source tree.

The build generates declarations with TypeScript and bundles them using
`rollup-plugin-dts`, including the private scanner's types. Its TypeScript 6
compatibility dependency supplies the compiler API absent from TypeScript 7.
These are build tools only; consumers need neither Bun nor the private workspace.

`bun pm pack` runs this build through `prepack` (Bun must be installed on the build
machine) and replaces catalog/workspace references with normal versions.
Use Bun for packing or publishing releases; direct `npm pack` does not resolve
Bun catalogs. The tarball includes JavaScript chunks, source maps, and declarations.
The smoke checks install it using npm and Bun with the `@expo` registry blocked,
then run real Node/Vitest checks and strict NodeNext/Bundler type checks without
`skipLibCheck`. The type checks include `ESNext.Disposable`, required by Vitest's
spy declarations.

## Live end-to-end coverage

The opt-in `bun run test:e2e` command exercises a real Ollama model through Vitest,
a fixture CLI, independent checks, cleanup, and saved evidence. See
[end-to-end test guide](https://github.com/expo/eval-experiments/tree/main/packages/agent-eval-vitest/e2e) for local setup and the separate advisory GitHub
Actions job. The default tests continue to run without live models.
