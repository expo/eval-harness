import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Only these canonical modules ship; tests and workspace metadata stay here.
const source = fileURLToPath(new URL('../src/', import.meta.url));
const destination = path.resolve('src/internal/source-scan');
rmSync(destination, { recursive: true, force: true });
mkdirSync(destination, { recursive: true });
for (const name of ['index.ts', 'parse.ts', 'walk.ts', 'strip-comments.ts']) {
  copyFileSync(path.join(source, name), path.join(destination, name));
}
