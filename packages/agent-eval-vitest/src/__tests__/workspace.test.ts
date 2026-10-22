import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createWorkspace } from '../workspace.ts';
import type { EvalWorkspace } from '../types.ts';

let root: string;
let workspace: EvalWorkspace;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-eval-workspace-'));
  workspace = createWorkspace(root, 'with-skill');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeFile(relativePath: string, contents: string) {
  const filename = join(root, relativePath);
  mkdirSync(dirname(filename), { recursive: true });
  writeFileSync(filename, contents);
}

describe('file access', () => {
  test('reads a workspace file', () => {
    writeFile('App.tsx', 'export default 1;');
    expect(workspace.read('App.tsx')).toBe('export default 1;');
  });

  test('returns an empty string for a missing file', () => {
    expect(workspace.read('missing.ts')).toBe('');
  });

  test('reports whether a nested file exists', () => {
    writeFile('src/db/migrations/001_init.ts', 'export {};');
    expect(workspace.exists('src/db/migrations/001_init.ts')).toBe(true);
    expect(workspace.exists('missing.ts')).toBe(false);
  });

  test('parses the package manifest', () => {
    writeFile('package.json', JSON.stringify({ dependencies: { 'expo-sqlite': '*' } }));
    expect(workspace.packageJson()).toEqual({ dependencies: { 'expo-sqlite': '*' } });
  });
});

describe('source discovery', () => {
  test('includes nested sources but excludes node_modules', () => {
    writeFile('App.tsx', 'export default 1;');
    writeFile('src/db/migrations/001_init.ts', 'export {};');
    writeFile('node_modules/dep/index.js', 'ignored');
    const paths = workspace.sourceFiles().map((file) => file.path);
    expect(paths.sort()).toEqual(['App.tsx', join('src', 'db', 'migrations', '001_init.ts')]);
    expect(workspace.source()).not.toContain('ignored');
  });

  test('strips comments from the combined source', () => {
    writeFile('App.tsx', 'export default 1; // comment');
    expect(workspace.source()).toBe('export default 1; ');
  });

  test('globs paths relative to the workspace', () => {
    writeFile('src/db/migrations/001_init.ts', 'export {};');
    expect(workspace.glob('src/db/migrations/*.{ts,tsx,js,sql}')).toEqual([
      join('src', 'db', 'migrations', '001_init.ts'),
    ]);
    expect(workspace.glob('nope/*.ts')).toEqual([]);
  });
});
