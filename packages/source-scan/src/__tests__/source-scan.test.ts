import { describe, expect, it } from 'bun:test';

import { parseSource } from '../parse.ts';
import { walk, type AstNode } from '../walk.ts';

describe('walk', () => {
  it('visits call expressions and JSX elements', () => {
    const ast = parseSource(
      `import * as SQLite from 'expo-sqlite';
const db = await SQLite.openDatabaseAsync('app.db');
export default () => <SQLiteProvider databaseName="app.db" />;`
    );
    const seen: string[] = [];
    walk(ast, (node: AstNode) => {
      if (node.type === 'CallExpression' || node.type === 'JSXOpeningElement') {
        seen.push(node.type);
      }
    });
    expect(seen).toContain('CallExpression');
    expect(seen).toContain('JSXOpeningElement');
  });
});

describe('parseSource', () => {
  it('parses TypeScript annotations together with JSX and module exports', () => {
    const ast = parseSource('export const Screen = (props: { title: string }) => <Text>{props.title}</Text>;', 'screen.tsx');
    const types: string[] = [];
    walk(ast, (node) => { types.push(node.type); });
    expect(types).toContain('ExportNamedDeclaration');
    expect(types).toContain('TSTypeAnnotation');
    expect(types).toContain('JSXElement');
    expect(types).toContain('JSXExpressionContainer');
  });

  it('records the source filename on node locations', () => {
    const identifiers: AstNode[] = [];
    walk(parseSource('const answer = 42;', 'src/answer.ts'), (node) => {
      if (node.type === 'Identifier') identifiers.push(node);
    });
    expect(identifiers).toHaveLength(1);
    expect(identifiers[0]?.loc).toMatchObject({ filename: 'src/answer.ts', start: { line: 1, column: 6 } });
  });

  it('accepts an empty module without a filename', () => {
    expect(parseSource('')).toMatchObject({ type: 'File', program: { type: 'Program', sourceType: 'module', body: [] } });
  });

  it('throws on malformed source instead of returning a partial AST', () => {
    expect(() => parseSource('const value: = ;', 'broken.ts')).toThrow(SyntaxError);
  });
});

describe('walk traversal', () => {
  it('visits parents before children through arrays and untyped containers', () => {
    const root = {
      type: 'Root',
      children: [{ type: 'First', child: { type: 'Nested' } }, null, { wrapper: { type: 'Last' } }],
    };
    const seen: string[] = [];
    walk(root, (node) => { seen.push(node.type); });
    expect(seen).toEqual(['Root', 'First', 'Nested', 'Last']);
  });

  it('skips position metadata even if it contains node-shaped objects', () => {
    const node = {
      type: 'Root',
      loc: { type: 'Location' },
      start: { type: 'Start' },
      end: { type: 'End' },
      range: [{ type: 'Range' }],
      expression: { type: 'Identifier' },
    };
    const seen: string[] = [];
    walk(node, (child) => { seen.push(child.type); });
    expect(seen).toEqual(['Root', 'Identifier']);
  });

  it('ignores primitives and non-string types while traversing their children', () => {
    const seen: string[] = [];
    walk([undefined, null, false, 0, 'text', { type: 123, child: { type: 'Identifier' } }], (node) => {
      seen.push(node.type);
    });
    expect(seen).toEqual(['Identifier']);
  });

  it('passes the original node objects to the visitor without mutating the tree', () => {
    const leaf = Object.freeze({ type: 'Identifier', name: 'value' });
    const root = Object.freeze({ type: 'Root', child: leaf });
    const seen: AstNode[] = [];
    walk(root, (node) => { seen.push(node); });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(root);
    expect(seen[1]).toBe(leaf);
  });
});
