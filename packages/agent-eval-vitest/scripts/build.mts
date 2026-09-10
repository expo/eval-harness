import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { rollup } from 'rollup';
import { dts } from 'rollup-plugin-dts';

rmSync('build', { recursive: true, force: true });
execFileSync('tsc', ['-p', 'tsconfig.build.json'], { stdio: 'inherit' });

const entrypoints = ['index', 'claude', 'ollama', 'expo'];
const result = await Bun.build({
  entrypoints: entrypoints.map((name) => `./src/${name}.ts`),
  outdir: './build',
  target: 'node',
  format: 'esm',
  splitting: true,
  sourcemap: 'linked',
  external: ['vitest', '@babel/parser'],
});

if (!result.success) {
  throw new AggregateError(result.logs, 'JavaScript bundling failed');
}

// Bundle the private workspace's declarations too; public dependencies stay external.
const declarations = await rollup({
  input: Object.fromEntries(entrypoints.map((name) => [name, `build/.types/${name}.d.ts`])),
  external: (id) =>
    !id.startsWith('.') &&
    !path.isAbsolute(id) &&
    id !== '@expo/source-scan' &&
    !id.startsWith('@expo/source-scan/'),
  plugins: [dts({ respectExternal: true, tsconfig: './tsconfig.build.json' })],
  onwarn(warning, warn) {
    if (warning.code === 'UNRESOLVED_IMPORT') {
      throw new Error(warning.message);
    }
    warn(warning);
  },
});

try {
  await declarations.write({
    dir: 'build',
    format: 'es',
    entryFileNames: '[name].d.ts',
    chunkFileNames: 'types-[hash].d.ts',
  });
} finally {
  await declarations.close();
  rmSync('build/.types', { recursive: true, force: true });
}
