import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openCase } from '../lifecycle.ts';
import type { AgentExecution, AgentRunner } from '../types.ts';

const execution: AgentExecution = {
  finalAnswer: 'done',
  toolCalls: [],
  endReason: 'completed',
  artifacts: [],
};
const runner: AgentRunner = async () => execution;

let artifactsDir: string;

beforeEach(() => {
  artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-lifecycle-test-'));
});

afterEach(() => {
  fs.rmSync(artifactsDir, { recursive: true, force: true });
});

describe('case resources and execution', () => {
  test('one execution shares fixture evidence until close; close is idempotent', async () => {
    let calls = 0;
    const cleanups: number[] = [];
    const run = await openCase(
      'refresh',
      {
        prompt: 'refresh',
        projectSetup: {
          prepareAsync({ root, onCleanup }) {
            fs.writeFileSync(path.join(root, 'App.tsx'), 'original');
            onCleanup(() => {
              cleanups.push(1);
            });
            onCleanup(() => {
              cleanups.push(2);
            });
            return { reloads: 1 };
          },
        },
      },
      {
        artifactsDir,
        runner: async () => {
          calls++;
          return execution;
        },
      }
    );
    expect(run.fixture.reloads).toBe(1);
    expect(run.workspace.read('App.tsx')).toBe('original');
    expect(run.execution).toEqual(execution);
    expect(calls).toBe(1);
    expect(cleanups).toEqual([]);
    await run.close();
    await run.close();
    expect(cleanups).toEqual([2, 1]);
    expect(fs.existsSync(run.workspace.root)).toBe(false);
    expect(fs.existsSync(run.artifactsDir)).toBe(true);
  });

  test('partial setup failure removes workspace and disposes acquired resources', async () => {
    let root = '';
    let disposed = false;
    await expect(
      openCase(
        'setup-error',
        {
          prompt: 'x',
          projectSetup: {
            prepareAsync(context) {
              root = context.root;
              context.onCleanup(() => {
                disposed = true;
              });
              throw new Error('setup failed');
            },
          },
        },
        { artifactsDir, runner }
      )
    ).rejects.toThrow('setup failed');
    expect(disposed).toBe(true);
    expect(fs.existsSync(root)).toBe(false);
  });

  test('runner infrastructure failure retains diagnostics and cleans fixtures', async () => {
    let disposed = false;
    await expect(
      openCase(
        'startup-error',
        {
          prompt: 'x',
          projectSetup: {
            prepareAsync({ onCleanup }) {
              onCleanup(() => {
                disposed = true;
              });
            },
          },
        },
        {
          artifactsDir,
          runner: async (ctx) => {
            fs.writeFileSync(path.join(ctx.artifactsDir, 'stderr.log'), 'missing provider');
            throw new Error('runner unavailable');
          },
        }
      )
    ).rejects.toThrow('runner unavailable');
    expect(disposed).toBe(true);
    const output = fs.readdirSync(artifactsDir)[0]!;
    expect(fs.readFileSync(path.join(artifactsDir, output, 'stderr.log'), 'utf8')).toBe(
      'missing provider'
    );
    expect(
      JSON.parse(fs.readFileSync(path.join(artifactsDir, output, 'result.json'), 'utf8')).status
    ).toBe('error');
  });

  test('unsuccessful attempts are gradeable and missing evidence stays explicit', async () => {
    const run = await openCase(
      'failed-attempt',
      { prompt: 'x', projectSetup: { prepareAsync() {} } },
      {
        artifactsDir,
        runner: async () => ({
          ...execution,
          endReason: 'failed',
          toolCalls: null,
        }),
      }
    );
    expect(run.execution.endReason).toBe('failed');
    expect(run.execution.toolCalls).toBeNull();
    await run.close();
  });

  test('deadline aborts the runner and always disposes resources', async () => {
    let aborted = false;
    let disposed = false;
    await expect(
      openCase(
        'timeout',
        {
          prompt: 'x',
          projectSetup: {
            prepareAsync({ onCleanup }) {
              onCleanup(() => {
                disposed = true;
              });
            },
          },
        },
        {
          artifactsDir,
          timeoutMs: 20,
          runner: async ({ signal }) => {
            await new Promise<void>((resolve) =>
              signal.addEventListener(
                'abort',
                () => {
                  aborted = true;
                  resolve();
                },
                { once: true }
              )
            );
            return { ...execution, endReason: 'cancelled' };
          },
        }
      )
    ).rejects.toThrow('timed out');
    expect(aborted).toBe(true);
    expect(disposed).toBe(true);
  });

  test('cleanup failures do not hide the original error or stop later cleanup', async () => {
    let disposed = false;
    await expect(
      openCase(
        'errors',
        {
          prompt: 'x',
          projectSetup: {
            prepareAsync({ onCleanup }) {
              onCleanup(() => {
                disposed = true;
              });
              onCleanup(() => {
                throw new Error('cleanup failed');
              });
              throw new Error('original setup error');
            },
          },
        },
        { artifactsDir, runner }
      )
    ).rejects.toThrow('original setup error');
    expect(disposed).toBe(true);
  });

  test('retaining workspace never retains live fixture resources; dry runs bypass agent', async () => {
    let disposed = false;
    const run = await openCase(
      'dry',
      {
        prompt: 'x',
        projectSetup: {
          prepareAsync({ onCleanup }) {
            onCleanup(() => {
              disposed = true;
            });
          },
        },
      },
      {
        artifactsDir,
        keepWorkspace: true,
        dryRun: true,
        runner: async () => {
          throw new Error('must not run');
        },
      }
    );
    try {
      await run.close();
      expect(disposed).toBe(true);
      expect(fs.existsSync(run.workspace.root)).toBe(true);
      const result = JSON.parse(
        fs.readFileSync(path.join(run.artifactsDir, 'result.json'), 'utf8')
      );
      expect(result.status).toBe('dry-run');
    } finally {
      fs.rmSync(run.workspace.root, { recursive: true, force: true });
    }
  });
});

test('cleanup subprocesses use a fresh bounded signal even after runner failure', async () => {
  const marker = path.join(artifactsDir, 'cleanup-ran');
  await expect(
    openCase(
      'cleanup-command',
      {
        prompt: 'x',
        projectSetup: {
          prepareAsync({ onCleanup, runAsync }) {
            onCleanup(() =>
              runAsync('node', [
                '-e',
                "require('fs').writeFileSync(process.argv[1], 'done')",
                marker,
              ])
            );
          },
        },
      },
      {
        artifactsDir,
        runner: async () => {
          throw new Error('startup failed');
        },
      }
    )
  ).rejects.toThrow('startup failed');
  expect(fs.readFileSync(marker, 'utf8')).toBe('done');
});

test('stalled cleanups share one total deadline and do not block later disposers', async () => {
  let finalCleanup = false;
  const run = await openCase(
    'bounded-cleanup',
    {
      prompt: 'x',
      projectSetup: {
        prepareAsync({ onCleanup }) {
          onCleanup(() => {
            finalCleanup = true;
          });
          for (let i = 0; i < 3; i++) {
            onCleanup(() => new Promise(() => {}));
          }
        },
      },
    },
    { artifactsDir, runner, cleanupTimeoutMs: 100 }
  );
  const start = performance.now();
  await expect(run.close()).rejects.toThrow('cleanup');
  expect(performance.now() - start).toBeLessThan(250);
  expect(finalCleanup).toBe(true);
  expect(fs.existsSync(run.workspace.root)).toBe(false);
});

test('a completed attempt keeps its signal live until close, past the setup deadline', async () => {
  let signal: AbortSignal | undefined;
  const run = await openCase(
    'settled-deadline',
    {
      prompt: 'x',
      projectSetup: {
        prepareAsync(context) {
          signal = context.signal;
        },
      },
    },
    { artifactsDir, runner, timeoutMs: 10 }
  );
  try {
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(signal?.aborted).toBe(false);
  } finally {
    await run.close();
  }
  expect(signal?.aborted).toBe(true);
});

test('a cleanup rejection after its deadline remains handled', async () => {
  let rejectCleanup!: (reason: Error) => void;
  const run = await openCase(
    'late-cleanup',
    {
      prompt: 'x',
      projectSetup: {
        prepareAsync({ onCleanup }) {
          onCleanup(
            () =>
              new Promise<void>((_, reject) => {
                rejectCleanup = reject;
              })
          );
        },
      },
    },
    { artifactsDir, runner, cleanupTimeoutMs: 10 }
  );
  await expect(run.close()).rejects.toThrow('cleanup timed out');
  rejectCleanup(new Error('late cleanup rejection'));
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(fs.existsSync(run.workspace.root)).toBe(false);
});

test('prepare commands use millisecond timeout options', async () => {
  await expect(
    openCase(
      'command-timeout',
      {
        prompt: 'x',
        projectSetup: {
          async prepareAsync({ runAsync }) {
            await runAsync(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
              timeoutMs: 20,
            });
          },
        },
      },
      { artifactsDir, runner, timeoutMs: 1000 }
    )
  ).rejects.toThrow('timed out after 20ms');
});
