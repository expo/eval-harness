import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll } from 'vitest';
import { createAgentEval, expect } from '@expo/agent-eval-vitest';
import { ollamaRunner, type OllamaCommandResult } from '@expo/agent-eval-vitest/ollama';

const fixtureCli = fileURLToPath(new URL('./fixtures/project-cli.cjs', import.meta.url));
const fixtureProject = fileURLToPath(new URL('./fixtures/cart/', import.meta.url));
const verifier = fileURLToPath(new URL('./fixtures/verify-cart.cjs', import.meta.url));
const originalSource = readFileSync(join(fixtureProject, 'cart.cjs'), 'utf8');
const originalTests = readFileSync(join(fixtureProject, 'cart.test.cjs'), 'utf8');
const originalReadme = readFileSync(join(fixtureProject, 'README.md'), 'utf8');
let workspaceRoot: string | undefined;
let caseArtifacts: string | undefined;

const agentEval = createAgentEval({
  artifactsDir: resolve('.eval-results/ollama-e2e'),
  timeoutMs: 30 * 60_000,
  keepWorkspace: false,
  dryRun: false,
  runner: ollamaRunner({
    model: process.env.OLLAMA_E2E_MODEL ?? 'qwen3:4b',
    systemPrompt: [
      'You are a coding agent working in a small JavaScript project.',
      'Available commands (every run array element is a string):',
      'list: list project files.',
      'read <file>: read a file.',
      'write <file> <contents>: replace a file with the supplied complete contents.',
      'test: run the project test suite with Node.',
      'Inspect the project, edit the implementation, and run tests before finishing.',
      'Command results are observations; respond with your next action, not a copy of the result.',
    ].join('\n'),
    maxTurns: 12,
    maxOutputChars: 4000,
    requestTimeoutMs: 15 * 60_000,
    think: true,
    temperature: 0,
    seed: 42,
    runCommand(args, { root, signal }) {
      return new Promise<OllamaCommandResult>((resolve, reject) => {
        execFile(
          process.execPath,
          [fixtureCli, ...args],
          {
            cwd: root,
            signal,
            encoding: 'utf8',
            timeout: 30_000,
            maxBuffer: 1024 * 1024,
          },
          (error, stdout, stderr) => {
            if (signal.aborted) {
              reject(signal.reason);
            } else if (error && typeof error.code !== 'number') {
              reject(error);
            } else {
              resolve({
                exitCode: error && typeof error.code === 'number' ? error.code : 0,
                stdout,
                stderr,
              });
            }
          }
        );
      });
    },
  }),
});

agentEval(
  import.meta.url,
  {
    prompt:
      'Cart subtotals are incorrect when customers buy multiple units. Fix the bug while preserving the public API. Do not change the tests or documentation.',
    projectSetup: {
      prepareAsync({ root, artifactsDir, onCleanup }) {
        workspaceRoot = root;
        caseArtifacts = artifactsDir;
        cpSync(fixtureProject, root, { recursive: true });
        onCleanup(() => {
          for (const name of ['cart.cjs', 'cart.test.cjs', 'README.md']) {
            const path = join(root, name);
            if (existsSync(path)) cpSync(path, join(artifactsDir, name));
          }
          writeFileSync(join(artifactsDir, 'cleanup.txt'), 'completed');
        });
        const baseline = spawnSync(process.execPath, ['--test', 'cart.test.cjs'], {
          cwd: root,
          encoding: 'utf8',
          timeout: 10_000,
        });
        writeFileSync(
          join(artifactsDir, 'baseline-tests.log'),
          (baseline.stdout ?? '') + (baseline.stderr ?? '')
        );
        expect(baseline.error).toBeUndefined();
        expect(baseline.status).toBe(1);
      },
    },
  },
  (check) => {
    check('the repaired implementation passes independent cart cases', (workspace) => {
      expect(workspace.read('cart.cjs')).not.toBe(originalSource);
      expect(
        execFileSync(process.execPath, [verifier, join(workspace.root, 'cart.cjs')], {
          encoding: 'utf8',
          timeout: 10_000,
        })
      ).toContain('Independent cart checks passed');
    });

    check('the original tests and documentation remain unchanged', (workspace) => {
      expect(workspace.read('cart.test.cjs')).toBe(originalTests);
      expect(workspace.read('README.md')).toBe(originalReadme);
    });

    check(
      'execution contains a successful command and final answer',
      (_workspace, { execution }) => {
        expect(execution.endReason).toBe('completed');
        expect(execution.finalAnswer?.trim().length).toBeGreaterThan(0);
        const calls = execution.toolCalls ?? [];
        const writeIndex = calls.findIndex(
          (call) => Array.isArray(call.input) && call.input[0] === 'write'
        );
        expect(writeIndex).toBeGreaterThan(0);
        expect(calls.slice(0, writeIndex)).toEqual(
          expect.arrayContaining([expect.objectContaining({ input: ['read', 'cart.cjs'] })])
        );
        expect(calls.slice(writeIndex + 1)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              input: ['test'],
              result: expect.objectContaining({ exitCode: 0 }),
            }),
          ])
        );
      }
    );
  }
);

// The nested eval suite closes before this file-level hook reads the final artifacts.
afterAll(() => {
  expect(workspaceRoot).toBeDefined();
  expect(caseArtifacts).toBeDefined();
  expect(existsSync(workspaceRoot!)).toBe(false);
  expect(readFileSync(join(caseArtifacts!, 'cleanup.txt'), 'utf8')).toBe('completed');

  const result = JSON.parse(readFileSync(join(caseArtifacts!, 'result.json'), 'utf8'));
  expect(result.counts).toEqual({ passed: 3, failed: 0, skipped: 0 });
  expect(result.execution.endReason).toBe('completed');
  expect(readFileSync(join(caseArtifacts!, 'ollama.jsonl'), 'utf8')).toContain('command-result');
});
