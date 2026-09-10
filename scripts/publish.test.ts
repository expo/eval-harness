import { describe, expect, test } from 'bun:test';
import {
  packageDirectory,
  parseArgs,
  publish,
  validateTag,
  validateVersion,
  updateLockVersion,
  type PublishIo,
} from './publish.ts';
import { validateManifest } from './pack-release.ts';

function fixture(
  overrides: Record<string, { status: number; stdout: string; stderr: string }> = {},
  version = '0.1.0',
  name = '@expo/agent-eval-vitest'
) {
  const runs: string[][] = [];
  const writes: [string, string][] = [];
  const logs: string[] = [];
  const io: PublishIo = {
    read: (path) =>
      path === 'bun.lock'
        ? `{\n  \"workspaces\": {\n    \"packages/agent-eval-vitest\": {\n      \"name\": \"@expo/agent-eval-vitest\",\n      \"version\": \"${version}\",\n    },\n  },\n}\n`
        : JSON.stringify({ name, version }),
    write: (path, content) => {
      writes.push([path, content]);
    },
    log: (message) => {
      logs.push(message);
    },
    run: (command, args) => {
      runs.push([command, ...args]);
      const key = [command, ...args].join(' ');
      if (overrides[key]) return overrides[key];
      if (command === 'npm')
        return { status: 1, stdout: JSON.stringify({ error: { code: 'E404' } }), stderr: '' };
      return {
        status: 0,
        stdout:
          key === 'git branch --show-current'
            ? 'main\n'
            : key === 'git remote get-url origin'
              ? 'git@github.com:expo/eval-experiments.git\n'
              : '',
        stderr: '',
      };
    },
  };
  return { io, runs, writes, logs };
}
const ok = (stdout: string) => ({ status: 0, stdout, stderr: '' });
const failure = { status: 1, stdout: '', stderr: 'failed' };

describe('release inputs', () => {
  test('defaults, positional version and both flag forms', () => {
    expect(parseArgs([])).toEqual({
      package: '@expo/agent-eval-vitest',
      version: '',
      tag: 'latest',
      dryRun: false,
      help: false,
    });
    expect(
      parseArgs(['0.2.0', '--package=@expo/skill-analyzer', '--tag', 'next', '--dry-run'])
    ).toMatchObject({
      version: '0.2.0',
      package: '@expo/skill-analyzer',
      tag: 'next',
      dryRun: true,
    });
  });
  test.each([
    { args: ['--tag'] },
    { args: ['--package='] },
    { args: ['--unknown'] },
    { args: ['0.1.0', '0.2.0'] },
  ])('rejects bad arguments %j', ({ args }) => {
    expect(() => parseArgs(args)).toThrow();
  });
  test.each(['@expo/source-scan', '__proto__', '../../package.json'])(
    'rejects package %s',
    (name) => {
      expect(() => packageDirectory(name)).toThrow();
    }
  );
  test.each(['', '-next', '1.2', 'x', 'x.1', 'v2', 'latest;echo bad'])('rejects tag %s', (tag) => {
    expect(() => validateTag(tag)).toThrow();
  });
  test.each([
    '1',
    'v1.0.0',
    '1.2.3;echo',
    '1.0.0-',
    '01.0.0',
    '1.0.0-01',
    '1.0.0-a..b',
    '99999999999999999999.0.0',
  ])('rejects version %s', (version) => {
    expect(() => validateVersion(version)).toThrow();
  });
});

describe('release orchestration', () => {
  test('dry run performs read-only checks without writes, push or dispatch', () => {
    const f = fixture();
    publish(['--dry-run'], f.io);
    expect(f.writes).toEqual([]);
    expect(
      f.runs.every(
        ([command, arg]) =>
          command === 'npm' || (command === 'git' && ['branch', 'status', 'remote'].includes(arg!))
      )
    ).toBe(true);
    expect(f.logs[0]).toContain('0.1.1');
  });
  test('bumps package and lockfile before commit, push and scoped raw-field dispatch', () => {
    const f = fixture();
    publish([], f.io);
    expect(JSON.parse(f.writes[0]![1]).version).toBe('0.1.1');
    expect(f.runs.slice(-5)).toEqual([
      ['bun', 'install', '--lockfile-only', '--ignore-scripts'],
      ['git', 'add', '--', 'packages/agent-eval-vitest/package.json', 'bun.lock'],
      ['git', 'commit', '-m', 'Publish @expo/agent-eval-vitest@0.1.1'],
      ['git', 'push', 'origin', 'HEAD:refs/heads/main'],
      [
        'gh',
        'workflow',
        'run',
        'publish.yml',
        '--repo',
        'expo/eval-experiments',
        '--ref',
        'main',
        '--raw-field',
        'package=@expo/agent-eval-vitest',
        '--raw-field',
        'version=0.1.1',
        '--raw-field',
        'tag=latest',
      ],
    ]);
  });
  test('dispatches the analyzer package independently', () => {
    const f = fixture({}, '0.1.0', '@expo/skill-analyzer');
    publish(['0.1.0', '--package', '@expo/skill-analyzer'], f.io);
    expect(f.runs.at(-1)).toContain('package=@expo/skill-analyzer');
  });
  test('explicit current version supports first publish without bumping', () => {
    const f = fixture();
    publish(['0.1.0'], f.io);
    expect(f.writes).toEqual([]);
    expect(f.runs.at(-2)).toEqual(['git', 'push', 'origin', 'HEAD:refs/heads/main']);
  });
  test('prereleases require an explicit non-latest tag', () => {
    const f = fixture();
    expect(() => publish(['0.2.0-beta.1'], f.io)).toThrow('prerelease');
    publish(['0.2.0-beta.1', '--tag', 'next', '--dry-run'], f.io);
  });
  test.each([
    ['git branch --show-current', ok(''), 'detached'],
    ['git status --porcelain', ok(' M README.md'), 'clean'],
    ['git remote get-url origin', ok('git@github.com:someone/fork.git'), 'origin'],
    [
      'npm view @expo/agent-eval-vitest@0.1.1 version --json --registry=https://registry.npmjs.org',
      ok('"0.1.1"'),
      'already published',
    ],
    [
      'npm view @expo/agent-eval-vitest@0.1.1 version --json --registry=https://registry.npmjs.org',
      failure,
      'Cannot check npm',
    ],
  ] as const)('stops before mutations on %s', (command, result, message) => {
    const f = fixture({ [command]: result });
    expect(() => publish([], f.io)).toThrow(message);
    expect(f.writes).toEqual([]);
    expect(f.runs.some(([command]) => command === 'gh')).toBe(false);
  });
  test.each([
    'bun install --lockfile-only --ignore-scripts',
    'git commit -m Publish @expo/agent-eval-vitest@0.1.1',
    'git push origin HEAD:refs/heads/main',
  ])('does not dispatch after %s fails', (command) => {
    const f = fixture({ [command]: failure });
    expect(() => publish([], f.io)).toThrow('failed');
    expect(f.runs.some(([command]) => command === 'gh')).toBe(false);
  });
  test('reports dispatch failures after push', () => {
    const f = fixture();
    const run = f.io.run;
    f.io.run = (command, args) => (command === 'gh' ? failure : run(command, args));
    expect(() => publish(['0.1.0'], f.io)).toThrow('failed');
    expect(f.logs.some((line) => line.startsWith('Dispatched'))).toBe(false);
  });
  test('help needs no repository or registry', () => {
    const f = fixture();
    publish(['--help'], f.io);
    expect(f.runs).toEqual([]);
  });
});

describe('packed release manifest', () => {
  const manifest = {
    name: '@expo/skill-analyzer',
    version: '0.1.0',
    dependencies: { tar: '^7.5.22' },
  };
  test('accepts resolved dependencies', () => {
    expect(() => validateManifest(manifest, manifest.name, manifest.version)).not.toThrow();
  });
  test.each([
    { private: true },
    { version: '0.2.0' },
    { name: '@expo/source-scan' },
    { dependencies: { tar: 'catalog:' } },
    { devDependencies: { '@expo/source-scan': 'workspace:*' } },
    { dependencies: { '@expo/source-scan': '0.1.0' } },
  ])('rejects invalid packed manifest %j', (override) => {
    expect(() =>
      validateManifest({ ...manifest, ...override }, manifest.name, manifest.version)
    ).toThrow();
  });
});

test('lock version update preserves other workspaces and resolutions', () => {
  const lock = fixture().io.read('bun.lock');
  const updated = updateLockVersion(lock, 'packages/agent-eval-vitest', '0.1.0', '0.1.1');
  expect(updated).toBe(lock.replace('"version": "0.1.0"', '"version": "0.1.1"'));
  expect(() => updateLockVersion(lock, 'packages/skill-analyzer', '0.1.0', '0.1.1')).toThrow();
  expect(() => updateLockVersion(lock, 'packages/agent-eval-vitest', '0.2.0', '0.1.1')).toThrow();
});
