import { afterEach, beforeEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
const cli = path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
let fixtureDir: string;
let artifactsDir: string;

beforeEach(() => {
  // Keep the fixture beneath the package so it resolves the same Vitest peer.
  fixtureDir = fs.mkdtempSync(path.join(packageRoot, '.vitest-integration-'));
  artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-vitest-results-'));
});

afterEach(() => {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
  fs.rmSync(artifactsDir, { recursive: true, force: true });
});

function runVitest(fixture: string, ...args: string[]) {
  const configPath = path.join(fixtureDir, 'vitest.config.ts');
  fs.writeFileSync(
    configPath,
    `export default ${JSON.stringify({
      test: {
        include: [`src/__tests__/fixtures/vitest/${fixture}.eval.ts`],
        testTimeout: 100,
        reporters: ['json'],
        outputFile: path.join(fixtureDir, 'vitest.json'),
      },
    })}`
  );
  const result = spawnSync(
    'node',
    [cli, 'run', '--root', packageRoot, '--config', configPath, ...args],
    {
      cwd: packageRoot,
      env: { ...process.env, EVAL_TEST_ARTIFACTS: artifactsDir, EVAL_TEST_DIRECTORY: fixtureDir },
      encoding: 'utf8',
      timeout: 30_000,
    }
  );
  if (result.error) {
    throw result.error;
  }
  return result;
}

function readCaseResult() {
  const cases = fs.readdirSync(artifactsDir);
  expect(cases).toHaveLength(1);
  return JSON.parse(fs.readFileSync(path.join(artifactsDir, cases[0]!, 'result.json'), 'utf8'));
}

test('runs the agent once and reports independent checks with cleanup', () => {
  const result = runVitest('independent-checks');
  expect({
    status: result.status,
    error: result.error?.message,
    stderr: result.stderr,
  }).toMatchObject({ status: 1 });
  expect(fs.readFileSync(path.join(fixtureDir, 'runs'), 'utf8')).toBe('run\n');
  expect(fs.readFileSync(path.join(fixtureDir, 'cleanup'), 'utf8')).toBe('done');
  expect(fs.existsSync(fs.readFileSync(path.join(fixtureDir, 'workspace'), 'utf8'))).toBe(false);
  const report = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'vitest.json'), 'utf8'));
  expect(report.numPassedTests).toBe(1);
  expect(report.numFailedTests).toBe(1);
  expect(report.numPendingTests).toBe(2);
  const summary = readCaseResult();
  expect(summary.status).toBe('failed');
  expect(summary.counts).toEqual({ passed: 1, failed: 1, skipped: 1 });
}, 30_000);

test('a fully filtered case never starts an agent', () => {
  const result = runVitest('independent-checks', '-t', 'nothing-matches-this');
  expect(result.status).toBe(0);
  expect(fs.existsSync(path.join(fixtureDir, 'runs'))).toBe(false);
  expect(fs.readdirSync(artifactsDir)).toEqual([]);
}, 30_000);

test('records Vitest timeouts as failed checks', () => {
  const result = runVitest('timeout');
  expect(result.status).toBe(1);
  const summary = readCaseResult();
  expect(summary.status).toBe('failed');
  expect(summary.counts.failed).toBe(1);
}, 30_000);

test('fails the suite on budget exhaustion even when preservation checks pass', () => {
  const result = runVitest('budget');
  expect(result.status).toBe(1);
}, 30_000);

test('includes inherited hook failures in the case result', () => {
  const result = runVitest('hook-failure');
  expect(result.status).toBe(1);
  const summary = readCaseResult();
  expect(summary.status).toBe('failed');
  expect(summary.counts).toEqual({ passed: 1, failed: 1, skipped: 0 });
}, 30_000);
