import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const installer = process.argv[2] ?? 'npm';
assert(['npm', 'bun'].includes(installer));

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const scratch = mkdtempSync(path.join(os.tmpdir(), 'agent-eval-consumer-'));

const env = { ...process.env };
delete env.NODE_PATH;
delete env.NODE_OPTIONS;

const run = (command, args, cwd = scratch) => {
  try {
    return execFileSync(command, args, {
      cwd,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    });
  } catch (error) {
    process.stderr.write(error.stdout ?? '');
    process.stderr.write(error.stderr ?? '');
    throw error;
  }
};

try {
  // Build and inspect the release artifact before installing it.
  const tarball = path.join(scratch, 'agent-eval-vitest.tgz');
  run('bun', ['pm', 'pack', '--filename', tarball], packageRoot);
  const files = run('tar', ['-tzf', tarball])
    .trim()
    .split('\n')
    .map((file) => file.replace(/^package\//, ''));
  assert(files.includes('build/index.d.ts'));
  assert(
    files.every(
      (file) => file.startsWith('build/') || ['package.json', 'README.md', 'LICENSE'].includes(file)
    )
  );
  assert(
    !files.some((file) => file.includes('internal/source-scan') || file.includes('__tests__'))
  );
  for (const file of files.filter((file) => /\.(js|d\.ts)$/.test(file))) {
    const output = readFileSync(path.join(packageRoot, file), 'utf8');
    assert(!/['"]@expo\/source-scan(?:['"]|\/)/.test(output), `${file} references private package`);
  }

  const manifest = JSON.parse(run('tar', ['-xOf', tarball, 'package/package.json']));
  for (const field of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ]) {
    assert(
      !Object.values(manifest[field] ?? {}).some((value) => /^(catalog|workspace):/.test(value)),
      `${field} contains a local protocol`
    );
  }

  // The consumer has no workspace links and cannot fetch private Expo packages.
  writeFileSync(
    path.join(scratch, 'package.json'),
    JSON.stringify({ private: true, type: 'module' })
  );
  writeFileSync(
    path.join(scratch, '.npmrc'),
    '@expo:registry=http://127.0.0.1:9\nfetch-retries=0\n'
  );
  const dependencies = [
    tarball,
    `vitest@${manifest.devDependencies.vitest}`,
    `typescript@${manifest.devDependencies.typescript}`,
    '@types/node@22',
  ];
  if (installer === 'bun') {
    run('bun', ['add', '--ignore-scripts', ...dependencies]);
  } else {
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...dependencies]);
  }

  const installed = JSON.parse(
    readFileSync(path.join(scratch, 'node_modules/@expo/agent-eval-vitest/package.json'), 'utf8')
  );
  assert(!existsSync(path.join(scratch, 'node_modules/@expo/source-scan')));
  assert(!('@expo/source-scan' in installed.dependencies));
  assert(!Object.values(installed.dependencies).some((value) => value.startsWith('workspace:')));

  // Run the same readable example as both a Vitest case and a declaration check.
  copyFileSync(
    new URL('./fixtures/consumer.eval.ts', import.meta.url),
    path.join(scratch, 'case.eval.ts')
  );

  writeFileSync(
    path.join(scratch, 'vitest.config.ts'),
    `export default { test: {
    include: ['*.eval.ts'], server: { deps: { inline: ['@expo/agent-eval-vitest'] } },
  } };`
  );
  run(process.execPath, ['node_modules/vitest/vitest.mjs', 'run']);
  for (const [module, resolution] of [
    ['NodeNext', 'NodeNext'],
    ['ESNext', 'Bundler'],
  ]) {
    run(process.execPath, [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '--strict',
      '--target',
      'ES2022',
      '--lib',
      'ES2022,DOM,ESNext.Disposable',
      '--module',
      module,
      '--moduleResolution',
      resolution,
      'case.eval.ts',
    ]);
  }

  console.log(
    `Bundled agent-eval consumer passed: ${installer} install with private registry blocked, real Node/Vitest run, bundled scanner, public subpaths and strict declaration checks.`
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
