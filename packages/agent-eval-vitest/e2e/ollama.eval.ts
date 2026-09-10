import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll } from 'vitest';
import { createAgentEval, expect } from '@expo/agent-eval-vitest';
import { ollamaRunner, type OllamaCommandResult } from '@expo/agent-eval-vitest/ollama';

const fixtureCli = fileURLToPath(new URL('./fixtures/report-cli.cjs', import.meta.url));
const token = randomUUID();
const input = JSON.stringify({ token }) + '\n';
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
      'You operate a fixture CLI in a temporary project.',
      'Its only command is create-report, with no arguments.',
      'Invoke it with exactly {"run":["create-report"]}. The run array contains only strings.',
      'Do not add an empty array, object, or null argument.',
      'This command reads input.json and writes report.json.',
      'After the command succeeds, report that the task is done.',
    ].join('\n'),
    maxTurns: 3,
    requestTimeoutMs: 15 * 60_000,
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
      'Use the fixture CLI to create report.json from input.json. Leave input.json unchanged.',
    projectSetup: {
      prepareAsync({ root, artifactsDir, onCleanup }) {
        workspaceRoot = root;
        caseArtifacts = artifactsDir;
        writeFileSync(join(root, 'input.json'), input);
        onCleanup(() => writeFileSync(join(artifactsDir, 'cleanup.txt'), 'completed'));
      },
    },
  },
  (check) => {
    check('the real CLI creates the expected report', (workspace) => {
      expect(JSON.parse(workspace.read('report.json'))).toEqual({ status: 'ready', token });
    });

    check('the input remains unchanged', (workspace) => {
      expect(workspace.read('input.json')).toBe(input);
    });

    check(
      'execution contains a successful command and final answer',
      (_workspace, { execution }) => {
        expect(execution.endReason).toBe('completed');
        expect(execution.finalAnswer?.trim().length).toBeGreaterThan(0);
        expect(execution.toolCalls).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: 'run',
              input: ['create-report'],
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
