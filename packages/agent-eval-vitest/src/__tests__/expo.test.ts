import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createExpoProject, type ExpoProjectSetup } from '../expo.ts';
import type { PrepareContext } from '../types.ts';

let directory: string;
let options: ExpoProjectSetup;
let context: PrepareContext;
const skillPath = '.claude/skills/npm-test-pkg-skill';

function writeFile(relative: string, contents: string) {
  const target = join(directory, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function readWorkspaceFile(relative: string) {
  return readFileSync(join(context.root, relative), 'utf8');
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'eval-expo-'));
  // Every test gets a minimal local package, an empty skill, and an empty workspace.
  writeFile('package/package.json', JSON.stringify({ name: '@test/pkg', main: 'index.cjs' }));
  writeFile('package/index.cjs', 'module.exports = "local-checkout";');
  for (const name of ['workspace', 'fixtures', 'skill']) {
    mkdirSync(join(directory, name));
  }
  options = {
    packageName: '@test/pkg',
    packageRoot: pathToFileURL(join(directory, 'package')),
    skillDir: join(directory, 'skill'),
    fixturesDir: join(directory, 'fixtures'),
  };
  context = {
    root: join(directory, 'workspace'),
    artifactsDir: join(directory, 'artifacts'),
    condition: 'with-skill',
    signal: new AbortController().signal,
    onCleanup() {},
    async runAsync() {
      throw new Error('Unexpected network command');
    },
  };
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe('fixture preparation', () => {
  test('applies named fixtures in order', async () => {
    writeFile('fixtures/base/app.ts', 'base');
    writeFile('fixtures/overlay/app.ts', 'overlay');
    await createExpoProject({
      ...options,
      fixture: ['base', 'overlay'],
    }).prepareAsync(context);
    expect(readWorkspaceFile('app.ts')).toBe('overlay');
  });

  test('explicit files override fixture contents', async () => {
    writeFile('fixtures/base/app.ts', 'base');
    await createExpoProject({
      ...options,
      fixture: 'base',
      files: { 'app.ts': 'override' },
    }).prepareAsync(context);
    expect(readWorkspaceFile('app.ts')).toBe('override');
  });

  test('merges fixture dependencies with overrides and the local package', async () => {
    writeFile('fixtures/base/package.json', JSON.stringify({ dependencies: { expo: '1' } }));
    await createExpoProject({
      ...options,
      fixture: 'base',
      dependencies: { other: '2' },
    }).prepareAsync(context);
    expect(JSON.parse(readWorkspaceFile('package.json')).dependencies).toEqual({
      expo: '1',
      other: '2',
      '@test/pkg': `file:${join(directory, 'package')}`,
    });
  });

  test('passes the prepared workspace to the user hook', async () => {
    let preparedContext: PrepareContext | undefined;
    await createExpoProject({
      ...options,
      files: { 'app.ts': 'override' },
      prepareAsync(current) {
        preparedContext = current;
        expect(readFileSync(join(current.root, 'app.ts'), 'utf8')).toBe('override');
      },
    }).prepareAsync(context);
    expect(preparedContext).toBe(context);
  });
});

describe('local package and skill installation', () => {
  test('replaces the installed registry package with the local checkout after preparation', async () => {
    await createExpoProject({
      ...options,
      prepareAsync() {
        writeFile('workspace/node_modules/@test/pkg/registry.js', 'registry');
      },
    }).prepareAsync(context);
    expect(realpathSync(join(context.root, 'node_modules/@test/pkg'))).toBe(
      realpathSync(join(directory, 'package'))
    );
    const resolved = execFileSync('node', ['-e', "console.log(require('@test/pkg'))"], {
      cwd: context.root,
      encoding: 'utf8',
    });
    expect(resolved.trim()).toBe('local-checkout');
  });

  test('copies the skill but excludes its evaluation files', async () => {
    writeFile('skill/SKILL.md', 'skill');
    writeFile('skill/.evals/private.ts', 'excluded');
    await createExpoProject(options).prepareAsync(context);
    expect(readWorkspaceFile(`${skillPath}/SKILL.md`)).toBe('skill');
    expect(existsSync(join(context.root, skillPath, '.evals'))).toBe(false);
  });

  test('without-skill removes a seeded skill and still links the local package', async () => {
    context.condition = 'without-skill';
    writeFile(`workspace/${skillPath}/SKILL.md`, 'seeded');
    await createExpoProject(options).prepareAsync(context);
    expect(existsSync(join(context.root, skillPath))).toBe(false);
    expect(realpathSync(join(context.root, 'node_modules/@test/pkg'))).toBe(
      realpathSync(join(directory, 'package'))
    );
  });
});

describe('optional scaffolding', () => {
  test('uses the explicit version and template without installing dependencies', async () => {
    const calls: Array<[string, string[]]> = [];
    context.runAsync = async (command, args) => {
      calls.push([command, args]);
      writeFile('workspace/package.json', '{}');
    };
    await createExpoProject({
      ...options,
      createExpoAppVersion: '3.4.5',
      baseTemplate: 'blank-typescript@sdk-55',
    }).prepareAsync(context);
    expect(calls).toEqual([
      [
        'npx',
        [
          '--yes',
          'create-expo-app@3.4.5',
          context.root,
          '--template',
          'blank-typescript@sdk-55',
          '--no-install',
          '--yes',
        ],
      ],
    ]);
  });

  test.each(['3.7.0', '4.0.0'])(
    'disables generated agent files with scaffold %s',
    async (version) => {
      for (const condition of ['with-skill', 'without-skill'] as const) {
        context.condition = condition;
        context.runAsync = async (_command, args, runOptions) => {
          expect(args).toContain('--no-agents-md');
          expect(runOptions).toEqual({ timeoutMs: 600_000 });
          writeFile('workspace/package.json', '{}');
          if (!args.includes('--no-agents-md')) {
            writeFile('workspace/AGENTS.md', 'Expo guidance');
            writeFile('workspace/CLAUDE.md', '@AGENTS.md');
            writeFile(
              'workspace/.claude/settings.json',
              JSON.stringify({
                enabledPlugins: { 'expo@claude-plugins-official': true },
              })
            );
          }
        };
        await createExpoProject({
          ...options,
          createExpoAppVersion: version,
          baseTemplate: 'blank-typescript@sdk-55',
        }).prepareAsync(context);
        expect(existsSync(join(context.root, 'AGENTS.md'))).toBe(false);
        expect(existsSync(join(context.root, 'CLAUDE.md'))).toBe(false);
        expect(existsSync(join(context.root, '.claude/settings.json'))).toBe(false);
        expect(existsSync(join(context.root, skillPath))).toBe(condition === 'with-skill');
      }
    }
  );

  test('requires an exact scaffold version', () => {
    expect(() => createExpoProject({ ...options, baseTemplate: 'blank' })).toThrow(/version/i);
  });
});

describe('preparation failures', () => {
  test.each(['../escape', '/tmp/escape'])('rejects an unsafe output path: %s', async (relative) => {
    await expect(
      createExpoProject({
        ...options,
        files: { [relative]: 'bad' },
      }).prepareAsync(context)
    ).rejects.toThrow(/relative path/);
  });

  test('rejects fixture paths outside the fixture directory', async () => {
    await expect(
      createExpoProject({ ...options, fixture: '../package' }).prepareAsync(context)
    ).rejects.toThrow(/relative path/);
  });

  test('rejects a missing fixture', async () => {
    await expect(
      createExpoProject({ ...options, fixture: 'missing' }).prepareAsync(context)
    ).rejects.toThrow(/ENOENT/);
  });

  test('does not write through a workspace symlink', async () => {
    symlinkSync(join(directory, 'package'), join(context.root, 'outside'));
    await expect(
      createExpoProject({
        ...options,
        files: { 'outside/escape': 'bad' },
      }).prepareAsync(context)
    ).rejects.toThrow(/Symlink/);
    expect(existsSync(join(directory, 'package/escape'))).toBe(false);
  });

  test('propagates preparation hook errors', async () => {
    await expect(
      createExpoProject({
        ...options,
        prepareAsync() {
          throw new Error('hook failed');
        },
      }).prepareAsync(context)
    ).rejects.toThrow('hook failed');
  });

  test('stops before package linking if preparation aborts', async () => {
    const controller = new AbortController();
    context.signal = controller.signal;
    await expect(
      createExpoProject({
        ...options,
        prepareAsync() {
          controller.abort();
        },
      }).prepareAsync(context)
    ).rejects.toThrow();
    expect(existsSync(join(context.root, 'node_modules/@test/pkg'))).toBe(false);
  });
});
