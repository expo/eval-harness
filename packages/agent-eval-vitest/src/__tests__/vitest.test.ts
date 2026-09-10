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
  fs.writeFileSync(
    path.join(fixtureDir, 'vitest.config.ts'),
    `export default { test: {
    include: ['case.eval.ts'], testTimeout: 100, reporters: ['json'], outputFile: 'vitest.json',
  } };`
  );
});

afterEach(() => {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
  fs.rmSync(artifactsDir, { recursive: true, force: true });
});

function runVitest(source: string, ...args: string[]) {
  fs.writeFileSync(path.join(fixtureDir, 'case.eval.ts'), source);
  const result = spawnSync('node', [cli, 'run', '--config', 'vitest.config.ts', ...args], {
    cwd: fixtureDir,
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  return result;
}

function readCaseResult() {
  const cases = fs.readdirSync(artifactsDir);
  expect(cases).toHaveLength(1);
  return JSON.parse(fs.readFileSync(path.join(artifactsDir, cases[0]!, 'result.json'), 'utf8'));
}

function independentChecksCase() {
  return `
import { expect } from 'vitest';
import fs from 'node:fs';
import { createAgentEval } from '../src/index.ts';
const agentEval = createAgentEval({ artifactsDir: ${JSON.stringify(artifactsDir)}, runner: async ({ root }) => {
  fs.appendFileSync(${JSON.stringify(path.join(fixtureDir, 'runs'))}, 'run\\n');
  return { finalAnswer: 'refreshed', toolCalls: [], endReason: 'completed', artifacts: [] };
} });
const options = { prompt: 'refresh', projectSetup: { prepareAsync({ root, onCleanup }) {
  fs.writeFileSync(${JSON.stringify(path.join(fixtureDir, 'workspace'))}, root);
  onCleanup(() => fs.writeFileSync(${JSON.stringify(path.join(fixtureDir, 'cleanup'))}, 'done'));
  return { reloads: 1 };
} } };
agentEval(import.meta.url, options, check => {
  check('first fails', () => expect(1).toBe(2));
  check('second still executes', (_ws, { fixture, execution }) => {
    expect(fixture.reloads).toBe(1); expect(execution.finalAnswer).toBe('refreshed');
  });
  check('not applicable', (_ws, { skip }) => skip('no native runtime'));
});
agentEval.skip(import.meta.url, { ...options, title: 'skipped case' }, check => {
  check('never executes', () => { throw Error('must skip'); });
});
`;
}

test('runs the agent once and reports independent checks with cleanup', () => {
  const result = runVitest(independentChecksCase());
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
  const result = runVitest(independentChecksCase(), '-t', 'nothing-matches-this');
  expect(result.status).toBe(0);
  expect(fs.existsSync(path.join(fixtureDir, 'runs'))).toBe(false);
  expect(fs.readdirSync(artifactsDir)).toEqual([]);
}, 30_000);

test('records Vitest timeouts as failed checks', () => {
  const result = runVitest(`
import { createAgentEval } from '../src/index.ts';
const agentEval = createAgentEval({ artifactsDir: ${JSON.stringify(artifactsDir)}, runner: async () => ({
  finalAnswer: 'done', toolCalls: [], endReason: 'completed', artifacts: [],
}) });
agentEval(import.meta.url, { prompt: 'timeout', projectSetup: { prepareAsync() {} } }, check => {
  check('times out', async () => { await new Promise(() => {}); });
});
`);
  expect(result.status).toBe(1);
  const summary = readCaseResult();
  expect(summary.status).toBe('failed');
  expect(summary.counts.failed).toBe(1);
}, 30_000);

test('fails the suite on budget exhaustion even when preservation checks pass', () => {
  const result = runVitest(`
import { createAgentEval } from '../src/index.ts';
const agentEval = createAgentEval({ artifactsDir: ${JSON.stringify(artifactsDir)}, runner: async () => ({
  finalAnswer: 'out of budget', toolCalls: [], endReason: 'budget-exhausted', artifacts: [],
}) });
agentEval(import.meta.url, { prompt: 'budget', projectSetup: { prepareAsync() {} } }, check => {
  check('preservation passes', () => {});
});
`);
  expect(result.status).toBe(1);
}, 30_000);

test('includes inherited hook failures in the case result', () => {
  const result = runVitest(`
import { createAgentEval } from '../src/index.ts';
import { beforeEach } from 'vitest';
beforeEach(({ task }) => { if (task.name === 'hook fails') throw new Error('inherited hook failure'); });
const agentEval = createAgentEval({ artifactsDir: ${JSON.stringify(artifactsDir)}, runner: async () => ({
  finalAnswer: 'done', toolCalls: [], endReason: 'completed', artifacts: [],
}) });
agentEval(import.meta.url, { prompt: 'hook-failure', projectSetup: { prepareAsync() {} } }, check => {
  check('passes', () => {});
  check('hook fails', () => {});
});
`);
  expect(result.status).toBe(1);
  const summary = readCaseResult();
  expect(summary.status).toBe('failed');
  expect(summary.counts).toEqual({ passed: 1, failed: 1, skipped: 0 });
}, 30_000);
