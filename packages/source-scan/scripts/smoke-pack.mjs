import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const scratch = mkdtempSync(path.join(tmpdir(), 'source-scan-consumer-'));
const env = { ...process.env };
// Do not let a caller's module lookup settings hide missing packed files/deps.
delete env.NODE_PATH;
delete env.NODE_OPTIONS;
const run = (command, args, cwd = scratch) => {
  try {
    return execFileSync(command, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    process.stderr.write(error.stdout ?? '');
    process.stderr.write(error.stderr ?? '');
    throw error;
  }
};

try {
  // Exercise the actual npm prepack hook, with output outside the repository.
  const [packed] = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', scratch], packageRoot));
  const files = new Set(packed.files.map(({ path }) => path));
  for (const entry of ['index', 'parse', 'strip-comments', 'walk']) {
    assert(files.has(`build/${entry}.js`), `Missing compiled ${entry}`);
    assert(files.has(`build/${entry}.d.ts`), `Missing declaration ${entry}`);
  }
  assert([...files].every((file) => file.startsWith('build/') || ['package.json', 'README.md', 'LICENSE'].includes(file)), 'Unexpected packed files');
  assert(![...files].some((file) => file.includes('__tests__') || file.endsWith('.ts') && !file.endsWith('.d.ts')));
  writeFileSync(path.join(scratch, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', path.join(scratch, packed.filename), `typescript@${manifest.devDependencies.typescript}`]);
  writeFileSync(path.join(scratch, 'consumer.mjs'), `
import assert from 'node:assert/strict';
import { parseSource, stripComments, walk, BABEL_PARSE_OPTIONS } from '@expo/source-scan';
import { stripComments as stripSubpath } from '@expo/source-scan/strip-comments';
import { walk as walkSubpath, BABEL_PARSE_OPTIONS as options } from '@expo/source-scan/walk';
assert.equal(stripComments, stripSubpath);
assert.equal(walk, walkSubpath);
assert.equal(options, BABEL_PARSE_OPTIONS);
assert.equal(stripComments("const url = 'https://expo.dev'; // removed"), "const url = 'https://expo.dev'; ");
const seen = [];
walk(parseSource('const value: number = 1; export default () => <View />;', 'app.tsx'), node => seen.push(node.type));
assert(seen.includes('JSXOpeningElement'));
assert(seen.includes('TSTypeAnnotation'));
assert.throws(() => parseSource('const = ;'));
`);
  run(process.execPath, ['consumer.mjs']);
  writeFileSync(path.join(scratch, 'consumer.ts'), `
import { parseSource, stripComments, walk, BABEL_PARSE_OPTIONS, type AstNode } from '@expo/source-scan';
import { stripComments as stripSubpath } from '@expo/source-scan/strip-comments';
import { walk as walkSubpath, BABEL_PARSE_OPTIONS as options, type AstNode as SubpathNode } from '@expo/source-scan/walk';
const visit = (node: AstNode): void => { const other: SubpathNode = node; const type: string = other.type; void type; };
walk(parseSource(stripComments('const n: number = 1'), 'app.ts'), visit);
walkSubpath(parseSource(stripSubpath('const n = 1')), visit);
const mode: 'module' = options.sourceType;
const plugins: readonly ['jsx', 'typescript'] = BABEL_PARSE_OPTIONS.plugins;
void mode; void plugins;
`);
  for (const [module, resolution] of [['NodeNext', 'NodeNext'], ['ESNext', 'Bundler']]) {
    run(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '--strict', '--target', 'ES2022', '--module', module, '--moduleResolution', resolution, 'consumer.ts']);
  }
  // In a fresh process the lightweight exports must work without Babel installed.
  renameSync(path.join(scratch, 'node_modules/@babel/parser'), path.join(scratch, 'parser-unavailable'));
  run(process.execPath, ['--input-type=module', '-e', `
import { stripComments } from '@expo/source-scan/strip-comments';
import { walk } from '@expo/source-scan/walk';
if (stripComments('x // removed') !== 'x ') throw new Error('strip failed');
let count = 0; walk({ type: 'Identifier' }, () => count++);
if (count !== 1) throw new Error('walk failed');
`]);
  console.log('Packed npm consumer passed: Node ESM, all exports, NodeNext/Bundler types, Babel-free subpaths.');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
