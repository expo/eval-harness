import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ollamaRunner } from '../ollama.ts';
import type { RunnerContext } from '../types.ts';

let server: Server;
let host: string;
let context: RunnerContext;
interface ChatRequest {
  model: string;
  messages: { role: string; content: string }[];
}

let requests: ChatRequest[];
let responses: { status?: number; body?: unknown; hang?: boolean }[];
let onRequest: (() => void) | undefined;

function answer(content: unknown, extra: Record<string, unknown> = {}) {
  return { model: 'test-model', done: true, message: { role: 'assistant', content }, ...extra };
}

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'ollama-test-'));
  context = {
    root,
    prompt: 'inspect the project',
    artifactsDir: join(root, 'artifacts'),
    signal: new AbortController().signal,
  };
  requests = [];
  responses = [];
  onRequest = undefined;
  server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    expect(request.url).toBe('/api/chat');
    onRequest?.();
    const next = responses.shift();
    if (next?.hang) return;
    response.writeHead(next?.status ?? 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(next?.body ?? answer('{"done":true,"summary":"finished"}')));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test server port');
  host = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
  await rm(context.root, { recursive: true, force: true });
});

const commandResult = { exitCode: 0, stdout: 'ready', stderr: '' };

function runner(options: Partial<Parameters<typeof ollamaRunner>[0]> = {}) {
  return ollamaRunner({
    model: 'test-model',
    host,
    runCommand: async () => commandResult,
    ...options,
  });
}

test('sends the prompt, explicit model, and reproducible JSON settings', async () => {
  const result = await runner({ systemPrompt: 'Use the CLI.', seed: 7 })(context);

  expect(result.endReason).toBe('completed');
  expect(result.finalAnswer).toBe('finished');
  expect(result.toolCalls).toEqual([]);
  expect(requests[0]).toMatchObject({
    model: 'test-model',
    stream: false,
    format: 'json',
    options: { temperature: 0, seed: 7 },
  });
  expect(requests[0]!.messages[0]!.content).toContain('Use the CLI.');
  expect(requests[0]!.messages[1]).toEqual({ role: 'user', content: context.prompt });
  const transcript = await readFile(join(context.artifactsDir, 'ollama.jsonl'), 'utf8');
  expect(transcript).toContain('finished');
  expect(result.artifacts).toEqual(['ollama.jsonl']);
});

test('passes argv and workspace context to the handler and feeds back its result', async () => {
  responses.push({ body: answer('{"run":["status","--json"]}') });
  let observed: unknown;
  const result = await runner({
    runCommand: async (args, received) => {
      observed = { args, root: received.root, signal: received.signal };
      return commandResult;
    },
  })(context);

  expect(observed).toEqual({
    args: ['status', '--json'],
    root: context.root,
    signal: context.signal,
  });
  expect(result.toolCalls).toEqual([
    { id: 'ollama-1', name: 'run', input: ['status', '--json'], result: commandResult },
  ]);
  expect(JSON.parse(requests[1]!.messages.at(-1)!.content)).toEqual(commandResult);
  expect(result.endReason).toBe('completed');
});

test('a nonzero command exit is evidence and lets the agent recover', async () => {
  responses.push({ body: answer('{"run":["bad-command"]}') });
  const result = await runner({
    runCommand: async () => ({ exitCode: 2, stdout: '', stderr: 'unknown command' }),
  })(context);

  expect(result.endReason).toBe('completed');
  expect(result.toolCalls?.[0]?.result).toMatchObject({ exitCode: 2 });
  expect(requests[1]!.messages.at(-1)!.content).toContain('unknown command');
});

test('truncates model feedback but retains full command evidence', async () => {
  responses.push({ body: answer('{"run":["status"]}') });
  const result = await runner({
    maxOutputChars: 4,
    runCommand: async () => ({ exitCode: 0, stdout: 'long output', stderr: '' }),
  })(context);

  expect(result.toolCalls?.[0]?.result).toMatchObject({ stdout: 'long output' });
  expect(JSON.parse(requests[1]!.messages.at(-1)!.content).stdout).toBe('long');
});

test('invalid or ambiguous actions never execute commands and exhaust the turn budget', async () => {
  responses.push(
    { body: answer('{"run":["status"],"done":true}') },
    { body: answer('{"run":[4]}') }
  );
  let called = false;
  const result = await runner({
    maxTurns: 2,
    runCommand: async () => {
      called = true;
      return commandResult;
    },
  })(context);

  expect(called).toBe(false);
  expect(result.endReason).toBe('budget-exhausted');
  expect(requests).toHaveLength(2);
  expect(requests[1]!.messages.at(-1)!.content).toContain('valid JSON action');
});

test('records the last command before exhausting the turn budget', async () => {
  responses.push({ body: answer('{"run":["status"]}') });
  const result = await runner({ maxTurns: 1 })(context);

  expect(result.endReason).toBe('budget-exhausted');
  expect(result.toolCalls).toHaveLength(1);
});

test('rejects HTTP failures as infrastructure errors and saves the response', async () => {
  responses.push({ status: 404, body: { error: 'model not installed' } });
  await expect(runner()(context)).rejects.toThrow('404');
  expect(await readFile(join(context.artifactsDir, 'ollama.jsonl'), 'utf8')).toContain(
    'model not installed'
  );
});

test('rejects malformed server responses', async () => {
  responses.push({ body: answer(42) });
  await expect(runner()(context)).rejects.toThrow('Ollama protocol');
});

test('does not execute a truncated generation', async () => {
  responses.push({ body: answer('{"run":["status"]}', { done_reason: 'length' }) });
  const result = await runner()(context);

  expect(result.endReason).toBe('budget-exhausted');
  expect(result.toolCalls).toEqual([]);
});

test('returns cancelled without contacting the server when already aborted', async () => {
  const result = await runner()({ ...context, signal: AbortSignal.abort() });

  expect(result.endReason).toBe('cancelled');
  expect(requests).toEqual([]);
});

test('cancels an in-flight HTTP request', async () => {
  const controller = new AbortController();
  responses.push({ hang: true });
  onRequest = () => controller.abort();
  const result = await runner()({ ...context, signal: controller.signal });

  expect(result.endReason).toBe('cancelled');
});

test('bounds a stalled HTTP request with its own deadline', async () => {
  responses.push({ hang: true });
  const result = await runner({ requestTimeoutMs: 30 })(context);

  expect(result.endReason).toBe('timeout');
  expect(requests).toHaveLength(1);
});

test('preserves a command invocation when its handler is cancelled', async () => {
  const controller = new AbortController();
  responses.push({ body: answer('{"run":["status"]}') });
  const result = await runner({
    runCommand: async (_args, received) => {
      controller.abort();
      received.signal.throwIfAborted();
      return commandResult;
    },
  })({ ...context, signal: controller.signal });

  expect(result.endReason).toBe('cancelled');
  expect(result.toolCalls).toHaveLength(1);
});

test('rejects command-handler infrastructure failures', async () => {
  responses.push({ body: answer('{"run":["status"]}') });
  await expect(
    runner({
      runCommand: async () => {
        throw new Error('CLI binary missing');
      },
    })(context)
  ).rejects.toThrow('CLI binary missing');
});

test('validates model, URL, and numeric limits before any requests', () => {
  expect(() => runner({ model: '' })).toThrow('model');
  expect(() => runner({ host: 'file:///tmp/socket' })).toThrow('http');
  expect(() => runner({ maxTurns: 0 })).toThrow('maxTurns');
  expect(() => runner({ requestTimeoutMs: Infinity })).toThrow('requestTimeoutMs');
  expect(() => runner({ maxOutputChars: -1 })).toThrow('maxOutputChars');
});
