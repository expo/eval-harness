# @expo/source-scan

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

From the repository root:

```bash
bun install
bun run --cwd packages/source-scan test
bun run --cwd packages/source-scan build
bun run --cwd packages/source-scan test:pack
```

`npm pack` runs the package build through `prepack`. Exports always reference
`build/*.js` and `build/*.d.ts`; publication does not remap source paths.
The smoke check packs and installs into a fresh temporary npm project, exercises
all public exports in Node, compiles consumers with NodeNext and Bundler module
resolution, and checks the lightweight subpaths with Babel removed. It requires
npm registry access and cleans up the temporary project on success or failure.
