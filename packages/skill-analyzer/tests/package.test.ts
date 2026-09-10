import { expect, test } from 'bun:test';
import { resolve } from 'node:path';

const cli = resolve(import.meta.dir, '../src/main.ts');
test('package CLI requires explicit ground truth before materializing inputs', () => {
  const result = Bun.spawnSync([process.execPath, cli, 'analyze-artifacts',
    '--authored-artifact', '/nonexistent', '--scenario', 'skills_available_unmentioned',
    '--out-dir', '/nonexistent-output'], { stdout: 'pipe', stderr: 'pipe' });
  expect(result.exitCode).toBe(2);
  expect(result.stderr.toString()).toContain('required: --prd-skills');
});
test('package imports expose scoring, checks, bundled data, and shared materialization', async () => {
  const api = await import('../src/index.ts');
  const artifacts = await import('../src/artifacts.ts');
  expect(typeof api.analyzeArtifacts).toBe('function');
  expect(typeof api.CheckResult).toBe('function');
  expect(typeof artifacts.materializeArtifact).toBe('function');
  expect(await Bun.file(resolve(api.defaultChecksDirectory, 'checks_data.json')).exists()).toBe(true);
  expect(await Bun.file(resolve(api.defaultChecksDirectory, 'skill_map.json')).exists()).toBe(true);
});

test('legacy CLI still documents its optional repository ground-truth default', () => {
  const legacyCli = resolve(import.meta.dir, '../../../eval_harness/evaluator/skill_invocation/main.ts');
  const result = Bun.spawnSync([process.execPath, legacyCli, 'analyze-artifacts', '--help'], { stdout: 'pipe', stderr: 'pipe' });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain('[--prd-skills PRD_SKILLS]');
  expect(result.stdout.toString()).toContain('(default: dataset/prd_skills.json)');
});
