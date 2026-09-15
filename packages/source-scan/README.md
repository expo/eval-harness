# source-scan (internal)

**Private workspace; do not publish to npm.**

Shared source-scanning helpers for Expo evaluation tools and the repository's
skill analyzer. Compiled ESM and TypeScript declarations run under Node and Bun.

```ts
import { parseSource, stripComments, walk } from '@expo/source-scan';

const ast = parseSource('const value: number = 1;', 'app.ts');
walk(ast, (node) => { console.log(node.type); });
stripComments("const url = 'https://expo.dev'; // comment");
```

- `stripComments(code)` removes line and block comments, preserving quoted
  strings and template contents. It is a lightweight lexical helper, not a
  complete JavaScript lexer: regex literals and comments inside template
  interpolations are not fully handled. It does not guarantee token positions
  or whitespace preservation.
- `parseSource(code, sourceFilename?)` returns a Babel AST as `unknown`, using
  module syntax and the JSX and TypeScript plugins. Syntax errors throw.
- `walk(value, visit)` recursively visits objects with a string `type`, skipping
  `loc`, `start`, `end`, and `range`. Inputs must be acyclic.
- `BABEL_PARSE_OPTIONS` and `AstNode` expose the parser defaults and visitor type.

The `@expo/source-scan/strip-comments` and `@expo/source-scan/walk` subpaths
load without importing Babel. The root entry imports the parser.

Both the Vitest kit and analyzer use this workspace as a dev dependency.
Bun bundles its JavaScript into each consumer; rollup-plugin-dts bundles its
public declarations. Babel stays a direct runtime dependency in both consumers.
There are no source-copy steps or separately published scanner packages.

Each consumer build refreshes source-scan first. Edit the canonical files here
and run the root build. `bun run --cwd packages/source-scan test` runs shared
helper tests. The consumers' isolated tarball checks install with npm and Bun
while the private package's registry is blocked, and verify runtime and strict
type resolution without source-scan installed.
