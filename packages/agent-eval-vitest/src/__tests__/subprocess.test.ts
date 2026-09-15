import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { runCommandAsync } from '../subprocess.ts';

const fixturesDirectory = fileURLToPath(new URL('./fixtures/subprocess/', import.meta.url));
let workspaceRoot: string;

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'eval-process-'));
});

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

function fixture(name: string) {
  return join(fixturesDirectory, name);
}

test('runs the command in its workspace and waits for it to finish', async () => {
  await runCommandAsync(workspaceRoot, 'node', [fixture('write-file.cjs')]);
  expect(readFileSync(join(workspaceRoot, 'done'), 'utf8')).toBe('yes');
});

test('rejects a command that cannot start', async () => {
  await expect(runCommandAsync(workspaceRoot, '/missing-eval-command', [])).rejects.toThrow();
});

test('includes stderr when a command exits unsuccessfully', async () => {
  await expect(runCommandAsync(workspaceRoot, 'node', [fixture('fail.cjs')])).rejects.toThrow(
    'diagnostic'
  );
});

test('does not start a command when its signal is already aborted', async () => {
  await expect(
    runCommandAsync(workspaceRoot, 'node', [fixture('write-file.cjs')], {
      signal: AbortSignal.abort(),
    })
  ).rejects.toThrow();
  expect(existsSync(join(workspaceRoot, 'done'))).toBe(false);
});

test('rejects an invalid timeout', async () => {
  await expect(runCommandAsync(workspaceRoot, 'node', [], { timeoutMs: -1 })).rejects.toThrow(
    'timeoutMs'
  );
});

describe.skipIf(process.platform === 'win32')('POSIX process-group cleanup', () => {
  async function expectDescendantStopped() {
    expect(existsSync(join(workspaceRoot, 'descendant.pid'))).toBe(true);
    await delay(900);
    expect(existsSync(join(workspaceRoot, 'escaped'))).toBe(false);
  }

  test('a timeout stops the command and its descendants', async () => {
    const command = runCommandAsync(workspaceRoot, 'node', [fixture('process-tree.cjs')], {
      timeoutMs: 300,
    });
    await expect(command).rejects.toThrow(/timed out/i);
    await expectDescendantStopped();
  });

  test('an abort stops the command and its descendants', async () => {
    const controller = new AbortController();
    const command = runCommandAsync(workspaceRoot, 'node', [fixture('process-tree.cjs')], {
      signal: controller.signal,
    });
    const timer = setTimeout(() => controller.abort(), 300);
    try {
      await expect(command).rejects.toThrow(/abort/i);
      await expectDescendantStopped();
    } finally {
      clearTimeout(timer);
    }
  });

  test('normal exit stops descendants that inherited output pipes', async () => {
    await runCommandAsync(workspaceRoot, 'node', [fixture('process-tree.cjs'), 'exit-leader'], {
      timeoutMs: 2000,
    });
    await expectDescendantStopped();
  });
});
