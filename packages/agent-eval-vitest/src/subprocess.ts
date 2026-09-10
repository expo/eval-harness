import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

export interface CommandOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}
interface ProcessOptions extends CommandOptions {
  env?: NodeJS.ProcessEnv;
  stdoutPath?: string;
  stderrPath?: string;
}
interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  aborted: boolean;
  timedOut: boolean;
  stderr: string;
}

/** Internal transport: settle only after child close and both artifact streams flush. */
export async function runProcessAsync(
  root: string,
  command: string,
  args: string[],
  options: ProcessOptions = {}
): Promise<ProcessResult> {
  if (
    options.timeoutMs !== undefined &&
    (!Number.isFinite(options.timeoutMs) ||
      options.timeoutMs <= 0 ||
      options.timeoutMs > 2_147_483_647)
  ) {
    throw new Error('timeoutMs must be a finite positive timer duration');
  }
  options.signal?.throwIfAborted();
  const child = spawn(command, args, {
    cwd: root,
    env: options.env ?? process.env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let aborted = false;
  let timedOut = false;
  let stderr = '';
  let failure: Error | undefined;
  const kill = () => {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failure ??= error as Error;
    }
  };
  const abort = () => {
    aborted = true;
    kill();
  };
  // Register before awaiting anything, then close the pre-spawn abort race.
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer =
    options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          kill();
        }, options.timeoutMs);
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-64 * 1024);
  });
  const streams = (
    [
      ['stdout', options.stdoutPath],
      ['stderr', options.stderrPath],
    ] as const
  ).map(([name, file]) => {
    if (!file) {
      child[name].resume();
      return Promise.resolve();
    }
    return pipeline(child[name], createWriteStream(file)).catch((error) => {
      failure ??= error;
      kill();
    });
  });
  child.on('error', (error) => {
    failure ??= error;
  });
  // A command may leave descendants holding its pipes open. Kill its process
  // group when the leader exits as well as on cancellation.
  child.once('exit', kill);
  const exit = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  options.signal?.removeEventListener('abort', abort);
  await Promise.all(streams);
  if (failure) throw failure;
  return { ...exit, aborted, timedOut, stderr };
}

export async function runCommandAsync(
  root: string,
  command: string,
  args: string[],
  options: CommandOptions = {}
): Promise<void> {
  const result = await runProcessAsync(root, command, args, options);
  if (result.aborted) throw new DOMException('Command aborted', 'AbortError');
  if (result.timedOut)
    throw new Error(`${command} timed out after ${options.timeoutMs}ms\n${result.stderr}`);
  if (result.code !== 0)
    throw new Error(`${command} exited with ${result.code ?? result.signal}\n${result.stderr}`);
}
