import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentRunner, EndReason, ToolCall } from './types.js';
import { runProcessAsync } from './subprocess.js';

type RecordValue = Record<string, unknown>;
function object(value: unknown): value is RecordValue {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Model precedence: options.model, EXPO_SKILL_EVAL_MODEL, then the CLI default. */
export function claudeRunner(options: { model?: string } = {}): AgentRunner {
  return async ({ root, prompt, artifactsDir, signal }) => {
    await mkdir(artifactsDir, { recursive: true });
    const artifacts = ['claude.stdout.jsonl', 'claude.stderr.log'];
    if (signal.aborted)
      return {
        finalAnswer: null,
        toolCalls: [],
        endReason: 'cancelled',
        artifacts: [],
      };
    const env = { ...process.env };
    delete env.CLAUDECODE;
    const args = [
      '-p',
      prompt,
      '--output-format',
      'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
    ];
    const requestedModel = options.model ?? process.env.EXPO_SKILL_EVAL_MODEL;
    if (requestedModel) args.push('--model', requestedModel);
    const exit = await runProcessAsync(root, 'claude', args, {
      signal,
      env,
      stdoutPath: join(artifactsDir, artifacts[0]!),
      stderrPath: join(artifactsDir, artifacts[1]!),
    });
    const toolCalls: ToolCall[] = [];
    let terminal: RecordValue | undefined;
    let init: RecordValue | undefined;
    const transcript = await readFile(join(artifactsDir, artifacts[0]!), 'utf8');
    const lines = transcript.split('\n');
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!.trim();
      if (!line) continue;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        // Killing a writer can truncate its last JSONL record.
        if (exit.aborted && index === lines.length - 1) break;
        throw new Error(`Claude protocol: invalid JSON on line ${index + 1}`);
      }
      if (!object(event) || typeof event.type !== 'string')
        throw new Error('Claude protocol: invalid event');
      if (event.type === 'system' && event.subtype === 'init') init = event;
      if (event.type === 'result') {
        if (terminal) throw new Error('Claude protocol: duplicate result');
        terminal = event;
      }
      if (
        (event.type === 'assistant' || event.type === 'user') &&
        object(event.message) &&
        Array.isArray(event.message.content)
      ) {
        for (const block of event.message.content) {
          if (!object(block)) continue;
          if (block.type === 'tool_use') {
            if (typeof block.id !== 'string' || typeof block.name !== 'string')
              throw new Error('Claude protocol: invalid tool_use');
            // CLI re-emissions may contain the same tool block more than once.
            if (!toolCalls.some((call) => call.id === block.id))
              toolCalls.push({
                id: block.id,
                name: block.name,
                input: block.input,
              });
          } else if (block.type === 'tool_result') {
            const call = toolCalls.find((call) => call.id === block.tool_use_id);
            if (!call) throw new Error('Claude protocol: unmatched tool_result');
            call.result = block.content;
            if (block.is_error)
              call.error =
                typeof block.content === 'string'
                  ? block.content
                  : (JSON.stringify(block.content) ?? 'Tool failed');
          }
        }
      }
    }
    let endReason: EndReason;
    if (exit.aborted) endReason = 'cancelled';
    else {
      if (!terminal)
        throw new Error(
          `Claude protocol: missing result (exit ${exit.code ?? exit.signal}). ${exit.stderr}`
        );
      switch (terminal.subtype) {
        case 'success':
          if (exit.code !== 0)
            throw new Error(`Claude protocol: success with exit ${exit.code ?? exit.signal}`);
          endReason = terminal.is_error ? 'failed' : 'completed';
          break;
        case 'error_max_turns':
        case 'error_max_budget_usd':
          endReason = 'budget-exhausted';
          break;
        case 'error_during_execution':
        case 'error_max_structured_output_retries':
          endReason = 'failed';
          break;
        default:
          throw new Error(`Claude protocol: unknown result subtype ${String(terminal.subtype)}`);
      }
    }
    return {
      finalAnswer: typeof terminal?.result === 'string' ? terminal.result : null,
      toolCalls,
      endReason,
      artifacts,
      metadata: {
        requestedModel: requestedModel || null,
        model: typeof init?.model === 'string' ? init.model : null,
        version: typeof init?.claude_code_version === 'string' ? init.claude_code_version : null,
        sessionId: typeof init?.session_id === 'string' ? init.session_id : null,
        result: terminal ?? null,
        exitCode: exit.code,
        signal: exit.signal,
      },
    };
  };
}
