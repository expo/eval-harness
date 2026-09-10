import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, normalize } from './fixture.mjs';

const installer = process.argv[2] ?? 'npm';
assert(['npm', 'bun'].includes(installer));
const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const repo = path.resolve(packageRoot, '../..');
const scratch = mkdtempSync(path.join(tmpdir(), 'skill-analyzer-consumer-'));
const env = { ...process.env };
delete env.NODE_PATH;
delete env.NODE_OPTIONS;
const run = (command, args, cwd = scratch) => {
  try { return execFileSync(command, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error) { process.stderr.write(error.stdout ?? ''); process.stderr.write(error.stderr ?? ''); throw error; }
};
try {
  const tarball = path.join(scratch, 'skill-analyzer.tgz');
  run('bun', ['pm', 'pack', '--filename', tarball], packageRoot);
  const files = new Set(run('tar', ['-tzf', tarball]).trim().split('\n').map(file => file.replace(/^package\//, '')));
  for (const file of ['build/bin.js', 'build/main.js', 'build/index.js', 'build/index.d.ts', 'build/artifacts.js', 'build/build_health/node_parser.js', 'build/uptake_checks/checks_data.json', 'build/uptake_checks/skill_map.json']) assert(files.has(file), `Missing ${file}`);
  for (const file of [...files].filter(file => /\.(js|d\.ts)$/.test(file))) {
    assert(!/['"]@expo\/source-scan(?:['"]|\/)/.test(readFileSync(path.join(packageRoot, file), 'utf8')), `${file} references private package`);
  }
  assert([...files].every(file => file.startsWith('build/') || ['README.md', 'package.json', 'LICENSE'].includes(file)));
  const manifest = JSON.parse(run('tar', ['-xOf', tarball, 'package/package.json']));
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    assert(!Object.values(manifest[field] ?? {}).some(value => /^(catalog|workspace):/.test(value)), `${field} contains a local protocol`);
  }
  writeFileSync(path.join(scratch, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  writeFileSync(path.join(scratch, '.npmrc'), '@expo:registry=http://127.0.0.1:9\nfetch-retries=0\n');
  const dependencies = [tarball, `typescript@${manifest.devDependencies.typescript}`, '@types/node@22'];
  if (installer === 'bun') run('bun', ['add', '--ignore-scripts', ...dependencies]);
  else run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...dependencies]);
  assert(!existsSync(path.join(scratch, 'node_modules/@expo/source-scan')));
  const installed = JSON.parse(readFileSync(path.join(scratch, 'node_modules/@expo/skill-analyzer/package.json'), 'utf8'));
  assert(!('@expo/source-scan' in installed.dependencies));
  assert(!Object.values(installed.dependencies).some(value => value.startsWith('workspace:')));
  const f = fixture(scratch);
  const cliArgs = out => ['analyze-artifacts', '--authored-artifact', f.authored, '--scenario', 'skills_available_unmentioned', '--out-dir', out, '--prd-skills', f.prdSkills];
  const packedOut = path.join(scratch, 'packed-report');
  const legacyOut = path.join(scratch, 'legacy-report');
  const cli = path.join(scratch, 'node_modules/.bin/skill-analyzer');
  run(cli, cliArgs(packedOut)); // Test npm's installed bin and Bun shebang.
  run('bun', [path.join(repo, 'eval_harness/evaluator/skill_invocation/main.ts'), ...cliArgs(legacyOut)]);
  for (const name of ['metrics.json', 'manifest.json']) {
    const actual = normalize(JSON.parse(readFileSync(path.join(packedOut, name), 'utf8')), scratch);
    const legacy = normalize(JSON.parse(readFileSync(path.join(legacyOut, name), 'utf8')), scratch);
    const golden = JSON.parse(readFileSync(path.join(packageRoot, 'tests', name), 'utf8'));
    assert.deepEqual(actual, golden, `${name}: parity against pre-extraction behavior`);
    assert.deepEqual(actual, legacy, `${name}: legacy CLI parity`);
  }
  assert(readFileSync(path.join(packedOut, 'report.html'), 'utf8').includes('expo-router'));
  writeFileSync(path.join(scratch, 'consumer.ts'), `
import assert from 'node:assert/strict';
import { analyzeArtifacts, defaultChecksDirectory, checkSyntax, CheckResult, computeBundleResult, allChecks } from '@expo/skill-analyzer';
import { materializeArtifact } from '@expo/skill-analyzer/artifacts';
import { runCli } from '@expo/skill-analyzer/cli';
import { CheckResult as RegistryResult, register } from '@expo/skill-analyzer/uptake_checks/registry';
import { c } from 'tar';
${Object.keys(manifest.exports).map((key,i) => `import * as entry${i} from '${key === '.' ? manifest.name : manifest.name + key.slice(1)}'; void entry${i};`).join('\n')}
assert.equal(typeof CheckResult, 'function');
assert.equal(CheckResult, RegistryResult, 'entrypoints share class identity');
const root = ${JSON.stringify(scratch)};
materializeArtifact(root + '/authored', root + '/materialized');
const result = await analyzeArtifacts({ authoredArtifact: root + '/authored', evalArtifact: null, scenario: 'skills_available_unmentioned', outDir: root + '/api-report', prdSkillsPath: root + '/prd-skills.json', checksDir: defaultChecksDirectory });
assert.equal(result.app, 'test-app');
assert.equal((await checkSyntax(root + '/authored/author-agent-workspace/run-1')).ok, true);
assert.equal(computeBundleResult(root + '/authored/author-agent-workspace/run-1').ok, null);
assert.equal(await runCli(['analyze-artifacts', '--authored-artifact', 'absent', '--scenario', 's', '--out-dir', 'absent']), 2);
const customRunner = () => new CheckResult({ id: 'packed-custom-check', category: 'test', kind: 'code', target: null, passed: true, evidence: 'shared registry', status: 'passed' });
register('packed-custom-check', 'test')(customRunner);
assert.equal(allChecks(defaultChecksDirectory).get('packed-custom-check')?.run, customRunner, 'entrypoints share registry state');
await c({ gzip: true, file: root + '/authored.tar.gz', cwd: root }, ['authored']);
`);
  run('bun', ['consumer.ts']);
  for (const name of ['metrics.json', 'manifest.json']) {
    assert.deepEqual(JSON.parse(readFileSync(path.join(scratch, 'api-report', name), 'utf8')), JSON.parse(readFileSync(path.join(packedOut, name), 'utf8')), `API parity: ${name}`);
  }
  const archiveArgs = cliArgs(path.join(scratch, 'archive-report'));
  archiveArgs[2] = path.join(scratch, 'authored.tar.gz');
  run(cli, archiveArgs);
  const archivedMetrics = JSON.parse(readFileSync(path.join(scratch, 'archive-report/metrics.json'), 'utf8'));
  const directoryMetrics = JSON.parse(readFileSync(path.join(packedOut, 'metrics.json'), 'utf8'));
  assert.deepEqual(archivedMetrics.skills, directoryMetrics.skills);
  assert.deepEqual(archivedMetrics.build_health, directoryMetrics.build_health);
  for (const [module, resolution] of [['NodeNext', 'NodeNext'], ['ESNext', 'Bundler']]) {
    run(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '--strict', '--target', 'ESNext', '--module', module, '--moduleResolution', resolution, '--types', 'node', 'consumer.ts']);
  }
  console.log(`Bundled analyzer passed: ${installer} install with private registry blocked, Bun bin/API, all exports, packaged checks, strict NodeNext/Bundler types, directory/archive analysis, materialization, pre-extraction and legacy parity.`);
} finally { rmSync(scratch, { recursive: true, force: true }); }
