import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeRunner } from '../claude.ts';
import type { RunnerContext } from '../types.ts';

interface FakeResponse {
  events?: readonly unknown[];
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  keepAlive?: boolean;
}

const replayScript = readFileSync(new URL('./fixtures/claude/replay.cjs', import.meta.url), 'utf8');
const success = { type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0.2 };
let workspaceRoot: string;
let previousPath: string | undefined;
let previousModel: string | undefined;
let context: RunnerContext;

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'eval-claude-'));
  previousPath = process.env.PATH;
  previousModel = process.env.EXPO_SKILL_EVAL_MODEL;
  process.env.PATH = workspaceRoot;
  delete process.env.EXPO_SKILL_EVAL_MODEL;
  context = {
    root: workspaceRoot,
    prompt: 'make app',
    artifactsDir: join(workspaceRoot, 'artifacts'),
    signal: new AbortController().signal,
  };
});

afterEach(() => {
  if (previousPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = previousPath;
  }
  if (previousModel === undefined) {
    delete process.env.EXPO_SKILL_EVAL_MODEL;
  } else {
    process.env.EXPO_SKILL_EVAL_MODEL = previousModel;
  }
  rmSync(workspaceRoot, { recursive: true, force: true });
});

function installFakeClaude(response: FakeResponse) {
  writeFileSync(join(workspaceRoot, 'response.json'), JSON.stringify(response));
  writeFileSync(join(workspaceRoot, 'claude'), `#!${process.execPath}\n${replayScript}`, {
    mode: 0o755,
  });
}

function readArtifact(filename: string) {
  return readFileSync(join(context.artifactsDir, filename), 'utf8');
}

function recordedArguments(): string[] {
  return JSON.parse(readFileSync(join(workspaceRoot, 'arguments.json'), 'utf8'));
}

async function cancelRunningClaude() {
  const controller = new AbortController();
  const pending = claudeRunner()({ ...context, signal: controller.signal });
  pending.catch(() => {});
  try {
    const deadline = performance.now() + 3000;
    while (!existsSync(join(workspaceRoot, 'ready'))) {
      if (performance.now() >= deadline) throw new Error('Fake Claude did not become ready');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    controller.abort();
    return await pending;
  } finally {
    controller.abort();
    await pending.catch(() => {});
  }
}

describe('execution evidence', () => {
  test('normalizes the final answer and tool results', async () => {
    installFakeClaude({
      events: [
        {
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { path: 'a' } }],
          },
        },
        {
          type: 'user',
          message: {
            content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file contents' }],
          },
        },
        success,
      ],
    });
    const result = await claudeRunner()(context);
    expect(result.endReason).toBe('completed');
    expect(result.finalAnswer).toBe('done');
    expect(result.toolCalls).toEqual([
      { id: 't1', name: 'Read', input: { path: 'a' }, result: 'file contents' },
    ]);
  });

  test('preserves separate stdout and stderr artifacts', async () => {
    installFakeClaude({ events: [success], stderr: 'stderr only\n' });
    const result = await claudeRunner()(context);
    expect(result.artifacts).toEqual(['claude.stdout.jsonl', 'claude.stderr.log']);
    expect(JSON.parse(readArtifact('claude.stdout.jsonl'))).toEqual(success);
    expect(readArtifact('claude.stderr.log')).toBe('stderr only\n');
  });

  test.each([
    ['error_during_execution', 'failed'],
    ['error_max_turns', 'budget-exhausted'],
    ['error_max_budget_usd', 'budget-exhausted'],
  ] as const)('maps %s to %s even when the CLI exits nonzero', async (subtype, expected) => {
    installFakeClaude({
      events: [{ type: 'result', subtype, is_error: true, errors: ['stopped'] }],
      exitCode: 1,
    });
    expect((await claudeRunner()(context)).endReason).toBe(expected);
  });

  test('waits for large artifact streams to finish', async () => {
    const largeText = 'x'.repeat(1024 * 1024);
    const stderr = 'e'.repeat(1024 * 1024) + '\n';
    installFakeClaude({
      stderr,
      events: [
        { type: 'assistant', message: { content: [{ type: 'text', text: largeText }] } },
        success,
      ],
    });
    await claudeRunner()(context);
    expect(readArtifact('claude.stdout.jsonl')).toContain(largeText);
    expect(readArtifact('claude.stderr.log')).toBe(stderr);
  });
});

describe('protocol failures', () => {
  test.each([
    { name: 'malformed JSON', response: { stdout: 'not json\n' } },
    { name: 'missing terminal result', response: { events: [{ type: 'system' }] } },
    {
      name: 'unknown terminal subtype',
      response: { events: [{ type: 'result', subtype: 'surprise' }] },
    },
    { name: 'success with a nonzero exit', response: { events: [success], exitCode: 2 } },
  ])('rejects $name', async ({ response }) => {
    installFakeClaude(response);
    await expect(claudeRunner()(context)).rejects.toThrow();
  });

  test('rejects duplicate terminal results', async () => {
    installFakeClaude({ events: [success, success] });
    await expect(claudeRunner()(context)).rejects.toThrow(/duplicate/);
  });
});

describe('process failures and cancellation', () => {
  test('pre-start cancellation leaves tool evidence unavailable', async () => {
    const result = await claudeRunner()({ ...context, signal: AbortSignal.abort() });
    expect(result).toMatchObject({ finalAnswer: null, toolCalls: null, endReason: 'cancelled' });
  });

  test('ignores a cancelled trailing partial record followed by blank lines', async () => {
    const stdout = '{"type":\n\n';
    installFakeClaude({ stdout, keepAlive: true });
    expect((await cancelRunningClaude()).endReason).toBe('cancelled');
    expect(readArtifact('claude.stdout.jsonl')).toBe(stdout);
  });

  test('still rejects malformed records before later evidence on cancellation', async () => {
    installFakeClaude({ stdout: '{"type":\n{"type":"system"}\n', keepAlive: true });
    await expect(cancelRunningClaude()).rejects.toThrow('invalid JSON');
  });

  test('rejects when the CLI cannot start', async () => {
    await expect(claudeRunner()(context)).rejects.toThrow();
  });

  test('returns cancellation after flushing available diagnostics', async () => {
    installFakeClaude({ stderr: 'started\n', keepAlive: true });
    expect((await cancelRunningClaude()).endReason).toBe('cancelled');
    expect(readArtifact('claude.stderr.log')).toBe('started\n');
  });

  test('retains partial JSON when cancellation interrupts a record', async () => {
    installFakeClaude({ stdout: '{"type":', keepAlive: true });
    expect((await cancelRunningClaude()).endReason).toBe('cancelled');
    expect(readArtifact('claude.stdout.jsonl')).toBe('{"type":');
  });

  test('rejects an artifact write failure and terminates the producer', async () => {
    mkdirSync(join(context.artifactsDir, 'claude.stdout.jsonl'), { recursive: true });
    installFakeClaude({ events: [success], keepAlive: true });
    await expect(claudeRunner()(context)).rejects.toThrow();
  });
});

describe('model selection', () => {
  test('uses the legacy model environment setting', async () => {
    process.env.EXPO_SKILL_EVAL_MODEL = 'legacy-model';
    installFakeClaude({ events: [success] });
    await claudeRunner()(context);
    expect(recordedArguments()).toContain('legacy-model');
  });

  test('an explicit model overrides the environment setting', async () => {
    process.env.EXPO_SKILL_EVAL_MODEL = 'legacy-model';
    installFakeClaude({ events: [success] });
    await claudeRunner({ model: 'explicit-model' })(context);
    expect(recordedArguments()).toContain('explicit-model');
    expect(recordedArguments()).not.toContain('legacy-model');
  });

  test('leaves model selection to the CLI when no override is supplied', async () => {
    installFakeClaude({ events: [success] });
    await claudeRunner()(context);
    expect(recordedArguments()).not.toContain('--model');
  });

  test('reports model and session metadata from the init event', async () => {
    installFakeClaude({
      events: [
        {
          type: 'system',
          subtype: 'init',
          model: 'actual-model-snapshot',
          claude_code_version: '2.1.99',
          session_id: 'session-1',
        },
        success,
      ],
    });
    const result = await claudeRunner({ model: 'test-model' })(context);
    expect(result.metadata).toMatchObject({
      requestedModel: 'test-model',
      model: 'actual-model-snapshot',
      version: '2.1.99',
      sessionId: 'session-1',
    });
  });
});
