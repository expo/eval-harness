// Parses a single JS/JSX/TS/TSX file and reports facts a tier-3 (AST) check
// can reason about, without needing Python to understand JS syntax itself.
// Deliberately narrow: this is not a general JS analysis tool, just the
// specific facts uptake_checks/checks_ast.py currently needs.
//
// Usage: node parse-file-facts.js <path-to-file>
// stdout (success): {"jsxTags": [...], "hasDefaultExport": bool,
//                     "namedValueExports": [...], "namedTypeExports": [...]}
// stderr + exit 1 (failure): {"error": "parse_error", "message": "..."}
//
// namedValueExports vs namedTypeExports matters: `export type Foo = ...` /
// `export interface Foo {}` are metadata, not "another export" in any
// meaningful sense -- verified against real authored apps where treating
// them the same produced false positives (e.g. a component file exporting
// both `ThemedText` and its `ThemedTextProps` type looks like "2 exports"
// but is one idiomatic component).
const fs = require('fs');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;

const filePath = process.argv[2];
const code = fs.readFileSync(filePath, 'utf8');

let ast;
try {
  ast = parser.parse(code, {
    sourceType: 'module',
    plugins: ['jsx', 'typescript'],
  });
} catch (err) {
  console.error(JSON.stringify({ error: 'parse_error', message: err.message }));
  process.exit(1);
}

const TYPE_ONLY_DECLARATIONS = new Set(['TSInterfaceDeclaration', 'TSTypeAliasDeclaration']);

const jsxTags = new Set();
let hasDefaultExport = false;
const namedValueExports = new Set();
const namedTypeExports = new Set();

traverse(ast, {
  JSXOpeningElement(path) {
    const name = path.node.name;
    if (name.type === 'JSXIdentifier') jsxTags.add(name.name);
  },
  ExportDefaultDeclaration() {
    hasDefaultExport = true;
  },
  ExportNamedDeclaration(path) {
    const decl = path.node.declaration;
    const isTypeOnly = path.node.exportKind === 'type';
    if (decl) {
      const bucket = isTypeOnly || TYPE_ONLY_DECLARATIONS.has(decl.type) ? namedTypeExports : namedValueExports;
      if (decl.id && decl.id.name) bucket.add(decl.id.name);
      if (decl.declarations) {
        for (const d of decl.declarations) {
          if (d.id && d.id.name) bucket.add(d.id.name);
        }
      }
    }
    for (const spec of path.node.specifiers || []) {
      if (spec.exported && spec.exported.name) {
        const bucket = isTypeOnly ? namedTypeExports : namedValueExports;
        bucket.add(spec.exported.name);
      }
    }
  },
});

console.log(JSON.stringify({
  jsxTags: Array.from(jsxTags),
  hasDefaultExport,
  namedValueExports: Array.from(namedValueExports),
  namedTypeExports: Array.from(namedTypeExports),
}));
