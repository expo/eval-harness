import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeRunner } from '../claude.ts';
let root: string;
let oldPath: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'eval-claude-'));
  oldPath = process.env.PATH;
  process.env.PATH = root;
});
afterEach(() => {
  if (oldPath === undefined) delete process.env.PATH;
  else process.env.PATH = oldPath;
  rmSync(root, { recursive: true, force: true });
});
function fake(script: string) {
  writeFileSync(join(root, 'claude'), `#!${process.execPath}\n${script}`, {
    mode: 0o755,
  });
}
const context = () => ({
  root,
  prompt: 'make app',
  artifactsDir: join(root, 'artifacts'),
  signal: new AbortController().signal,
});
const emit = (value: unknown) => `console.log(${JSON.stringify(JSON.stringify(value))});`;
test('normalizes final answer and tool evidence, preserving separate flushed artifacts and model args', async () => {
  fake(
    `require('fs').writeFileSync('args',JSON.stringify(process.argv)); console.error('stderr only');` +
      emit({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { path: 'a' } }],
        },
      }) +
      emit({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't1',
              content: 'file contents',
            },
          ],
        },
      }) +
      emit({
        type: 'result',
        subtype: 'success',
        result: 'done',
        total_cost_usd: 0.2,
      })
  );
  const result = await claudeRunner({ model: 'test-model' })(context());
  expect(result.endReason).toBe('completed');
  expect(result.finalAnswer).toBe('done');
  expect(result.toolCalls).toEqual([
    { id: 't1', name: 'Read', input: { path: 'a' }, result: 'file contents' },
  ]);
  const artifacts = result.artifacts.map((p) => readFileSync(join(root, 'artifacts', p), 'utf8'));
  expect(
    artifacts[0]!
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
  ).toHaveLength(3);
  expect(artifacts[1]).toBe('stderr only\n');
  expect(readFileSync(join(root, 'args'), 'utf8')).toContain('test-model');
});
test('distinguishes execution failures and budget exhaustion including nonzero exits', async () => {
  for (const [subtype, expected] of [
    ['error_during_execution', 'failed'],
    ['error_max_turns', 'budget-exhausted'],
    ['error_max_budget_usd', 'budget-exhausted'],
  ] as const) {
    fake(
      emit({ type: 'result', subtype, is_error: true, errors: ['stopped'] }) + 'process.exitCode=1;'
    );
    expect((await claudeRunner()(context())).endReason).toBe(expected);
  }
});
test('rejects malformed, missing, unknown and contradictory terminal protocol', async () => {
  for (const script of [
    "console.log('not json')",
    emit({ type: 'system' }),
    emit({ type: 'result', subtype: 'surprise' }),
    emit({ type: 'result', subtype: 'success', result: 'ok' }) + 'process.exitCode=2;',
  ]) {
    fake(script);
    await expect(claudeRunner()(context())).rejects.toThrow();
  }
});
test('startup failure rejects; abort returns cancellation with flushed logs', async () => {
  await expect(claudeRunner()(context())).rejects.toThrow();
  fake("console.error('started');setInterval(()=>{},1000)");
  const controller = new AbortController();
  const promise = claudeRunner()({ ...context(), signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  expect((await promise).endReason).toBe('cancelled');
});
test('waits for large stdout and stderr artifact streams to finish', async () => {
  const large = 'x'.repeat(1024 * 1024);
  fake(
    `console.error('e'.repeat(1024*1024));console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'x'.repeat(1024*1024)}]}}));` +
      emit({ type: 'result', subtype: 'success', result: 'complete' })
  );
  const result = await claudeRunner()(context());
  expect(readFileSync(join(root, 'artifacts', result.artifacts[0]!), 'utf8')).toContain(large);
  expect(readFileSync(join(root, 'artifacts', result.artifacts[1]!), 'utf8').length).toBe(
    1024 * 1024 + 1
  );
});
test('artifact sink failure rejects and terminates the producer', async () => {
  mkdirSync(join(root, 'artifacts', 'claude.stdout.jsonl'), {
    recursive: true,
  });
  fake("setInterval(()=>console.log('output'),10)");
  await expect(claudeRunner()(context())).rejects.toThrow();
});
test('cancelled partial JSON is retained, and duplicate results are rejected', async () => {
  fake('process.stdout.write(\'{"type":\');setInterval(()=>{},1000)');
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 300);
  expect((await claudeRunner()({ ...context(), signal: controller.signal })).endReason).toBe(
    'cancelled'
  );
  fake(
    emit({ type: 'result', subtype: 'success', result: 'one' }) +
      emit({ type: 'result', subtype: 'success', result: 'two' })
  );
  await expect(claudeRunner()(context())).rejects.toThrow(/duplicate/);
});
test('legacy model fallback, explicit precedence, CLI default and init metadata', async () => {
  const previous = process.env.EXPO_SKILL_EVAL_MODEL;
  try {
    process.env.EXPO_SKILL_EVAL_MODEL = 'legacy-model';
    fake(
      `require('fs').writeFileSync('args',JSON.stringify(process.argv.slice(2)));` +
        emit({
          type: 'system',
          subtype: 'init',
          model: 'actual-model-snapshot',
          claude_code_version: '2.1.99',
          session_id: 'session-1',
        }) +
        emit({ type: 'result', subtype: 'success', result: 'ok' })
    );
    const result = await claudeRunner()(context());
    expect(JSON.parse(readFileSync(join(root, 'args'), 'utf8'))).toContain('legacy-model');
    expect(result.metadata).toMatchObject({
      requestedModel: 'legacy-model',
      model: 'actual-model-snapshot',
      version: '2.1.99',
      sessionId: 'session-1',
    });
    await claudeRunner({ model: 'explicit-model' })(context());
    const args = JSON.parse(readFileSync(join(root, 'args'), 'utf8'));
    expect(args).toContain('explicit-model');
    expect(args).not.toContain('legacy-model');
    delete process.env.EXPO_SKILL_EVAL_MODEL;
    await claudeRunner()(context());
    expect(JSON.parse(readFileSync(join(root, 'args'), 'utf8'))).not.toContain('--model');
  } finally {
    if (previous === undefined) delete process.env.EXPO_SKILL_EVAL_MODEL;
    else process.env.EXPO_SKILL_EVAL_MODEL = previous;
  }
});
