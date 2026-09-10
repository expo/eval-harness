import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCommandAsync } from './subprocess.ts';
import { createWorkspace } from './workspace.ts';
import type {
  AgentEvalConfig,
  AgentEvalOptions,
  AgentExecution,
  AgentRunner,
  Cleanup,
} from './types.ts';

export interface CheckResult {
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  error?: string;
}
export type ResolvedConfig = Required<Omit<AgentEvalConfig, 'runner'>> & {
  runner: AgentRunner;
};

export function resolveConfig(config: AgentEvalConfig & { runner: AgentRunner }): ResolvedConfig {
  const timeoutMs = config.timeoutMs ?? Number(process.env.EXPO_SKILL_EVAL_TIMEOUT ?? 900) * 1000;
  const cleanupTimeoutMs = config.cleanupTimeoutMs ?? 5_000;
  for (const [name, value] of Object.entries({ timeoutMs, cleanupTimeoutMs })) {
    if (!Number.isFinite(value) || value <= 0 || value > 2_147_000_000)
      throw new Error(`${name} must be a positive finite number`);
  }
  const condition =
    config.condition ??
    (process.env.EXPO_SKILL_EVAL_CONDITION === 'without-skill' ? 'without-skill' : 'with-skill');
  return {
    ...config,
    timeoutMs,
    cleanupTimeoutMs,
    condition,
    artifactsDir: path.resolve(config.artifactsDir ?? '.eval-results'),
    dryRun: config.dryRun ?? process.env.EXPO_SKILL_EVAL_DRY === '1',
    keepWorkspace: config.keepWorkspace ?? process.env.EXPO_SKILL_EVAL_KEEP === '1',
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

async function bounded<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Opens one agent attempt; the caller MUST close it after all independent checks. */
export async function openCase<T>(
  id: string,
  options: AgentEvalOptions<T>,
  input: AgentEvalConfig & { runner: AgentRunner }
) {
  const config = resolveConfig(input);
  fs.mkdirSync(config.artifactsDir, { recursive: true });
  const artifactsDir = fs.mkdtempSync(
    path.join(config.artifactsDir, `${id.replace(/[^a-zA-Z0-9_-]/g, '_')}-`)
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'expo-agent-eval-'));
  const startedAt = new Date().toISOString();
  const controller = new AbortController();
  const cleanupController = new AbortController();
  const cleanups: Cleanup[] = [];
  let closing: Promise<void> | undefined;
  let closed = false;
  let execution: AgentExecution | undefined;
  const writeResult = (status: string, checks: CheckResult[] = [], errors: string[] = []) => {
    fs.writeFileSync(
      path.join(artifactsDir, 'result.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          id,
          attemptId: path.basename(artifactsDir),
          prompt: options.prompt,
          startedAt,
          finishedAt: new Date().toISOString(),
          condition: config.condition,
          dryRun: config.dryRun,
          timeoutMs: config.timeoutMs,
          status,
          ...(config.keepWorkspace ? { workspace: root } : {}),
          execution,
          checks,
          errors,
          counts: {
            passed: checks.filter((check) => check.status === 'passed').length,
            failed: checks.filter((check) => check.status === 'failed').length,
            skipped: checks.filter((check) => check.status === 'skipped').length,
          },
        },
        null,
        2
      ) + '\n'
    );
  };
  const dispose = (): Promise<void> => {
    if (closing) return closing;
    closed = true;
    controller.abort(new Error('Case closed'));
    closing = (async () => {
      const errors: unknown[] = [];
      const deadline = performance.now() + config.cleanupTimeoutMs;
      const timer = setTimeout(
        () => cleanupController.abort(new Error('Fixture cleanup timed out')),
        config.cleanupTimeoutMs
      );
      try {
        while (cleanups.length) {
          const cleanup = cleanups.pop()!;
          try {
            await bounded(
              Promise.resolve().then(cleanup),
              Math.max(1, deadline - performance.now()),
              'Fixture cleanup timed out'
            );
          } catch (error) {
            errors.push(error);
          }
        }
      } finally {
        clearTimeout(timer);
        cleanupController.abort(new Error('Fixture cleanup finished'));
      }
      if (!config.keepWorkspace) {
        try {
          fs.rmSync(root, { recursive: true, force: true });
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) throw new AggregateError(errors, errors.map(errorText).join('; '));
    })();
    return closing;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutError = new Error(
    `Agent eval timed out after ${config.timeoutMs}ms. Artifacts: ${artifactsDir}`
  );
  const task = (async () => {
    const fixture = await options.projectSetup.prepareAsync({
      root,
      artifactsDir,
      signal: controller.signal,
      condition: config.condition,
      onCleanup(cleanup) {
        if (closed) throw new Error('Cannot register fixture resources after case cleanup');
        cleanups.push(cleanup);
      },
      runAsync: (command, args, runOptions) =>
        runCommandAsync(root, command, args, {
          signal: closed ? cleanupController.signal : controller.signal,
          timeoutMs: (runOptions?.timeoutSeconds ?? 600) * 1000,
        }),
    });
    controller.signal.throwIfAborted();
    execution = config.dryRun
      ? {
          finalAnswer: null,
          toolCalls: null,
          endReason: 'completed',
          artifacts: [],
          metadata: { dryRun: true },
        }
      : await config.runner({
          prompt: options.prompt,
          root,
          artifactsDir,
          signal: controller.signal,
        });
    controller.signal.throwIfAborted();
    return fixture;
  })();
  try {
    const fixture = await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort(timeoutError);
          reject(timeoutError);
        }, config.timeoutMs);
      }),
    ]);
    clearTimeout(timer);
    const completedExecution = execution!;
    let closeResult: Promise<void> | undefined;
    return {
      workspace: createWorkspace(root, config.condition),
      fixture,
      execution: completedExecution,
      artifactsDir,
      close(checks: CheckResult[] = []): Promise<void> {
        closeResult ??= (async () => {
          try {
            await dispose();
            const status = config.dryRun
              ? 'dry-run'
              : completedExecution.endReason !== 'completed' ||
                  checks.some((check) => check.status === 'failed')
                ? 'failed'
                : checks.some((check) => check.status === 'passed')
                  ? 'passed'
                  : 'ungraded';
            writeResult(status, checks);
          } catch (error) {
            writeResult('error', checks, [errorText(error)]);
            throw error;
          }
        })();
        return closeResult;
      },
    };
  } catch (original) {
    clearTimeout(timer);
    controller.abort(original);
    const errors: unknown[] = [original];
    // Give cooperative runners time to terminate children and flush transcripts before cleanup.
    try {
      await bounded(
        task.catch(() => undefined),
        config.cleanupTimeoutMs,
        'Runner/setup did not settle after cancellation'
      );
    } catch (error) {
      errors.push(error);
    }
    try {
      await dispose();
    } catch (error) {
      errors.push(error);
    }
    writeResult('error', [], errors.map(errorText));
    throw new AggregateError(
      errors,
      `${errors.map(errorText).join('; ')}. Artifacts: ${artifactsDir}`
    );
  }
}
