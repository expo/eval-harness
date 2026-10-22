import { expect, test } from 'vitest';
import { createServer } from 'node:http';
import { ollamaRunner } from '@expo/agent-eval-vitest/ollama';

test('published Ollama runner executes a command under Node', async () => {
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const { messages } = JSON.parse(body);
    const content =
      messages.length === 2
        ? JSON.stringify({ run: ['status'] })
        : JSON.stringify({ done: true, summary: 'ready' });
    response.end(JSON.stringify({ done: true, message: { role: 'assistant', content } }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server port');
    const runner = ollamaRunner({
      model: 'fixture-model',
      host: `http://127.0.0.1:${address.port}`,
      runCommand: async (args) => {
        expect(args).toEqual(['status']);
        return { exitCode: 0, stdout: 'ready', stderr: '' };
      },
    });
    const result = await runner({
      root: process.cwd(),
      artifactsDir: `${process.cwd()}/ollama-artifacts`,
      prompt: 'check status',
      signal: new AbortController().signal,
    });
    expect(result.endReason).toBe('completed');
    expect(result.finalAnswer).toBe('ready');
    expect(result.toolCalls).toHaveLength(1);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  }
});
