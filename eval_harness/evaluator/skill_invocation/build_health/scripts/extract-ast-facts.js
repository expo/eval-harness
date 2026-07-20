// Extracts the small set of structural facts a syntax-tree uptake check
// needs and a regex genuinely can't verify: whether a file carries the
// 'use dom' directive, how many default exports it has, and which JSX
// elements it renders that are bound to an import from 'react-native'
// (not just any element with a matching name -- e.g. a locally-defined
// <Text> shouldn't count). Handles both named imports (<Text> from
// `import { Text } from 'react-native'`) and namespace imports (<RN.Text>
// from `import * as RN from 'react-native'`, a JSXMemberExpression rather
// than a bare JSXIdentifier) -- a naive walk that only handles named
// imports would let the namespace form evade a "no react-native JSX"
// check entirely. No @babel/traverse dependency: a plain recursive walk
// over the already-parsed AST is enough for these facts, so this reuses
// the same @babel/parser dependency as check-syntax.js rather than adding
// a new one.
//
// Usage: node extract-ast-facts.js <path-to-file>
// stdout (success): {"ok": true, "hasUseDomDirective": bool,
//   "defaultExportCount": int, "reactNativeJsxElementsUsed": [str, ...]}
// stderr + exit 1 (failure): {"error": "parse_error", "message": "..."}
const fs = require('fs');
const parser = require('@babel/parser');

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

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  if (typeof node.type === 'string') visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'range') continue;
    const value = node[key];
    if (value && typeof value === 'object') walk(value, visit);
  }
}

const hasUseDomDirective = (ast.program.directives || []).some(
  (d) => d.value && d.value.value === 'use dom'
);

// Named bindings (`import { View } from 'react-native'`) and namespace
// bindings (`import * as RN from 'react-native'`) are tracked separately --
// a namespace-imported component is used as <RN.Text>, a JSXMemberExpression,
// not a bare JSXIdentifier, so the two cases need different JSX-side matching.
const reactNativeBindings = new Set();
const reactNativeNamespaceBindings = new Set();
let defaultExportCount = 0;
const jsxElementNames = new Set();
const jsxMemberUsages = [];

walk(ast, (node) => {
  if (node.type === 'ImportDeclaration' && node.source && node.source.value === 'react-native') {
    for (const spec of node.specifiers || []) {
      if (spec.type === 'ImportSpecifier' && spec.local) reactNativeBindings.add(spec.local.name);
      if (spec.type === 'ImportNamespaceSpecifier' && spec.local) reactNativeNamespaceBindings.add(spec.local.name);
    }
  }
  if (node.type === 'ExportDefaultDeclaration') defaultExportCount += 1;
  if (node.type === 'JSXOpeningElement' && node.name) {
    if (node.name.type === 'JSXIdentifier') {
      jsxElementNames.add(node.name.name);
    } else if (
      node.name.type === 'JSXMemberExpression' &&
      node.name.object && node.name.object.type === 'JSXIdentifier' &&
      node.name.property && node.name.property.type === 'JSXIdentifier'
    ) {
      jsxMemberUsages.push(`${node.name.object.name}.${node.name.property.name}`);
    }
  }
});

const reactNativeJsxElementsUsed = [...jsxElementNames].filter((n) => reactNativeBindings.has(n));
for (const usage of jsxMemberUsages) {
  const [objectName] = usage.split('.');
  if (reactNativeNamespaceBindings.has(objectName)) reactNativeJsxElementsUsed.push(usage);
}

console.log(JSON.stringify({
  ok: true,
  hasUseDomDirective,
  defaultExportCount,
  reactNativeJsxElementsUsed,
}));
