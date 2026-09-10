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

Published consumers copy the four source modules into their own
`src/internal/source-scan/` directory before building or packing. Generated copies
are ignored by Git; edit the canonical files here. Consumers declare
`@babel/parser` directly and must not depend on this private workspace at runtime.
The Vitest kit compiles these copies to ESM and declarations; the Bun analyzer
ships them as TypeScript alongside its other source files.

`node ../source-scan/scripts/copy-source.mjs` runs from a consumer package root.
`bun run --cwd packages/source-scan test` runs the shared helper tests.
The published packages' isolated npm smoke checks verify inclusion and ensure
no `@expo/source-scan` installation is required.
