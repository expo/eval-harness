import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { join } from 'node:path';
import type { AgentExecution, AgentRunner, EndReason, RunnerContext, ToolCall } from './types.js';

export interface OllamaCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface OllamaRunnerOptions {
  /** Explicit model tag. The caller installs the model before running evaluations. */
  model: string;
  /** Execute argv for the CLI under evaluation; honor context.signal and settle on abort. */
  runCommand: (args: string[], context: RunnerContext) => Promise<OllamaCommandResult>;
  /** Server origin; defaults to OLLAMA_HOST or http://127.0.0.1:11434. */
  host?: string;
  /** Describe the CLI's available commands and task-specific rules. */
  systemPrompt?: string;
  /** Optional JSON Schema for run/done actions, passed to Ollama structured outputs. */
  actionSchema?: Record<string, unknown>;
  /** Maximum chat requests per evaluation. Default: 8. */
  maxTurns?: number;
  /** Wall-clock deadline for each HTTP request, including the response body. Default: 900000. */
  requestTimeoutMs?: number;
  /** Feedback limit per stdout/stderr field. Full output remains in evidence. Default: 800. */
  maxOutputChars?: number;
  /** Override thinking on models that support it; otherwise use the server default. */
  think?: boolean;
  temperature?: number;
  seed?: number;
}

type Message = { role: 'system' | 'user' | 'assistant'; content: string };
type Action = { run: string[] } | { done: true; summary: string };

const ACTION_PROMPT = `Respond with exactly one JSON object:
{"run": ["command", "arg"]} to execute one command, or
{"done": true, "summary": "what you accomplished"} when the task is complete.
Wait for each command result before choosing the next action. Do not combine run and done.`;

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${name} must be a positive integer`);
  return value;
}

/** Ollama JSON command loop. The caller owns CLI execution; no shell is implicitly exposed. */
export function ollamaRunner(options: OllamaRunnerOptions): AgentRunner {
  if (!options.model.trim()) throw new Error('Ollama model must be explicit and non-empty');
  const endpoint = new URL(
    '/api/chat',
    options.host ?? process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434'
  );
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new Error('Ollama host must be an http(s) URL without embedded credentials');
  }
  const maxTurns = positiveInteger('maxTurns', options.maxTurns ?? 8);
  const requestTimeoutMs = positiveInteger('requestTimeoutMs', options.requestTimeoutMs ?? 900_000);
  if (requestTimeoutMs > 2_147_483_647) throw new Error('requestTimeoutMs exceeds the timer limit');
  const maxOutputChars = positiveInteger('maxOutputChars', options.maxOutputChars ?? 800);
  const temperature = options.temperature ?? 0;
  const seed = options.seed ?? 42;
  if (!Number.isFinite(temperature) || temperature < 0)
    throw new Error('temperature must be finite and nonnegative');
  if (!Number.isSafeInteger(seed)) throw new Error('seed must be an integer');

  return async (context) => {
    const toolCalls: ToolCall[] = [];
    let turns = 0;
    const execution = (
      endReason: EndReason,
      finalAnswer: string | null = null
    ): AgentExecution => ({
      finalAnswer,
      toolCalls,
      endReason,
      artifacts: ['ollama.jsonl'],
      metadata: { requestedModel: options.model, turns },
    });

    await mkdir(context.artifactsDir, { recursive: true });
    const transcriptPath = join(context.artifactsDir, 'ollama.jsonl');
    await writeFile(transcriptPath, '');
    const record = (event: unknown) => appendFile(transcriptPath, JSON.stringify(event) + '\n');
    const messages: Message[] = [
      {
        role: 'system',
        content: [options.systemPrompt, ACTION_PROMPT].filter(Boolean).join('\n\n'),
      },
      { role: 'user', content: context.prompt },
    ];

    try {
      for (; turns < maxTurns;) {
        context.signal.throwIfAborted();
        turns++;
        const body = {
          model: options.model,
          messages,
          stream: false,
          format: options.actionSchema ?? 'json',
          ...(options.think === undefined ? {} : { think: options.think }),
          options: { temperature, seed },
        };
        await record({ type: 'request', turn: turns, body });
        const response = await chat(endpoint, body, context.signal, requestTimeoutMs);
        await record({ type: 'response', turn: turns, ...response });
        if (response.status < 200 || response.status >= 300) {
          throw new Error(`Ollama HTTP ${response.status}: ${response.text.slice(0, 1000)}`);
        }

        context.signal.throwIfAborted();
        const reply = parseReply(response.text);
        if (reply.truncated) return execution('budget-exhausted');
        messages.push({ role: 'assistant', content: reply.content });
        const action = parseAction(reply.content);
        if (!action) {
          messages.push({
            role: 'user',
            content: `Your reply was not a single valid JSON action. ${ACTION_PROMPT}`,
          });
          continue;
        }
        context.signal.throwIfAborted();
        if ('done' in action) return execution('completed', action.summary);

        const call: ToolCall = {
          id: `ollama-${toolCalls.length + 1}`,
          name: 'run',
          input: action.run,
        };
        toolCalls.push(call);
        await record({ type: 'command', turn: turns, call });
        const result = await options.runCommand(action.run, context);
        if (
          (result.exitCode !== null && !Number.isInteger(result.exitCode)) ||
          typeof result.stdout !== 'string' ||
          typeof result.stderr !== 'string'
        ) {
          throw new Error('Ollama command handler returned an invalid result');
        }
        call.result = result;
        await record({ type: 'command-result', turn: turns, call });
        context.signal.throwIfAborted();
        messages.push({
          role: 'user',
          content: JSON.stringify({
            exitCode: result.exitCode,
            stdout: result.stdout.slice(0, maxOutputChars),
            stderr: result.stderr.slice(0, maxOutputChars),
          }),
        });
      }
      return execution('budget-exhausted');
    } catch (error) {
      await record({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
      if (context.signal.aborted) return execution('cancelled');
      if (error instanceof RequestTimeoutError) return execution('timeout');
      throw error;
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseReply(text: string): { content: string; truncated: boolean } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('Ollama protocol: invalid response JSON');
  }
  if (
    !isRecord(value) ||
    value.done !== true ||
    !isRecord(value.message) ||
    value.message.role !== 'assistant' ||
    typeof value.message.content !== 'string'
  ) {
    throw new Error('Ollama protocol: expected a completed assistant message');
  }
  if (Array.isArray(value.message.tool_calls) && value.message.tool_calls.length) {
    throw new Error('Ollama protocol: expected JSON actions, not native tool calls');
  }
  return { content: value.message.content, truncated: value.done_reason === 'length' };
}

function parseAction(content: string): Action | undefined {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return;
  }
  if (!isRecord(value)) return;
  if (
    value.done === true &&
    !('run' in value) &&
    (value.summary === undefined || typeof value.summary === 'string')
  ) {
    return { done: true, summary: value.summary ?? '' };
  }
  if (
    !('done' in value) &&
    Array.isArray(value.run) &&
    value.run.length > 0 &&
    value.run.every((arg) => typeof arg === 'string') &&
    typeof value.run[0] === 'string' &&
    value.run[0].length > 0
  ) {
    return { run: value.run };
  }
}

class RequestTimeoutError extends Error {}

/** Use Node HTTP so slow local inference is not subject to fetch's headers timeout. */
async function chat(
  endpoint: URL,
  body: unknown,
  signal: AbortSignal,
  timeoutMs: number
): Promise<{ status: number; text: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new RequestTimeoutError('Ollama request timed out')),
    timeoutMs
  );
  const requestSignal = AbortSignal.any([signal, controller.signal]);
  const payload = JSON.stringify(body);

  try {
    return await new Promise((resolve, reject) => {
      const request = (endpoint.protocol === 'https:' ? httpsRequest : httpRequest)(
        endpoint,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 8 * 1024 * 1024) {
              const error = new Error('Ollama response exceeds 8 MiB');
              request.destroy(error);
              reject(error);
            } else {
              chunks.push(chunk);
            }
          });
          response.on('error', reject);
          response.on('end', () =>
            resolve({
              status: response.statusCode ?? 0,
              text: Buffer.concat(chunks).toString('utf8'),
            })
          );
        }
      );
      const abort = () => {
        request.destroy();
        reject(requestSignal.reason);
      };
      request.on('error', reject);
      request.on('close', () => requestSignal.removeEventListener('abort', abort));
      requestSignal.addEventListener('abort', abort, { once: true });
      if (requestSignal.aborted) abort();
      else request.end(payload);
    });
  } catch (error) {
    if (controller.signal.aborted && !signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
