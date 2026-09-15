import { stripComments } from '@expo/source-scan/strip-comments';
import fs from 'fs';
import path from 'path';

import type { Condition, EvalWorkspace } from './types.ts';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);

export function createWorkspace(root: string, condition: Condition): EvalWorkspace {
  let cachedSources: { path: string; contents: string }[] | null = null;
  const sourceFiles = () => {
    if (!cachedSources) {
      const sources: { path: string; contents: string }[] = [];
      const visit = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
            continue;
          }
          const absolutePath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            visit(absolutePath);
          } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
            sources.push({
              path: path.relative(root, absolutePath),
              contents: fs.readFileSync(absolutePath, 'utf8'),
            });
          }
        }
      };
      visit(root);
      cachedSources = sources;
    }
    return cachedSources;
  };

  return {
    root,
    condition,
    read: (relativePath) => {
      try {
        return fs.readFileSync(path.join(root, relativePath), 'utf8');
      } catch {
        return '';
      }
    },
    exists: (relativePath) => fs.existsSync(path.join(root, relativePath)),
    sourceFiles,
    source: () =>
      sourceFiles()
        .map((f) => stripComments(f.contents))
        .join('\n'),
    packageJson: () => {
      try {
        return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
      } catch {
        return undefined;
      }
    },
    glob: (pattern) =>
      fs
        .globSync(pattern, { cwd: root })
        .filter(
          (match) =>
            !match.split(path.sep).some((part) => part === 'node_modules' || part.startsWith('.'))
        )
        .sort(),
  };
}
