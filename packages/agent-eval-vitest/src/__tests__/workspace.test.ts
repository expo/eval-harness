import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createWorkspace } from '../workspace.ts';

describe('createWorkspace', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-eval-kit-test-'));
    fs.mkdirSync(path.join(root, 'src', 'db', 'migrations'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(root, 'node_modules', 'dep'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), '{"dependencies":{"expo-sqlite":"*"}}');
    fs.writeFileSync(path.join(root, 'App.tsx'), 'export default 1; // comment');
    fs.writeFileSync(path.join(root, 'src', 'db', 'migrations', '001_init.ts'), 'export {};');
    fs.writeFileSync(path.join(root, 'node_modules', 'dep', 'index.js'), 'ignored');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reads files and reports existence', () => {
    const ws = createWorkspace(root, 'with-skill');
    expect(ws.read('App.tsx')).toContain('export default 1');
    expect(ws.read('missing.ts')).toBe('');
    expect(ws.exists('src/db/migrations/001_init.ts')).toBe(true);
  });

  it('excludes node_modules from sources and strips comments from source()', () => {
    const ws = createWorkspace(root, 'with-skill');
    const paths = ws.sourceFiles().map((f) => f.path);
    expect(paths).toContain('App.tsx');
    expect(paths).toContain(path.join('src', 'db', 'migrations', '001_init.ts'));
    expect(ws.source()).not.toContain('ignored');
    expect(ws.source()).not.toContain('// comment');
  });

  it('globs workspace-relative paths', () => {
    const ws = createWorkspace(root, 'with-skill');
    expect(ws.glob('src/db/migrations/*.{ts,tsx,js,sql}')).toEqual([
      path.join('src', 'db', 'migrations', '001_init.ts'),
    ]);
    expect(ws.glob('nope/*.ts')).toEqual([]);
  });

  it('parses package.json', () => {
    const ws = createWorkspace(root, 'with-skill');
    expect(ws.packageJson()).toEqual({ dependencies: { 'expo-sqlite': '*' } });
  });
});
