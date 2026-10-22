import { describe, expect, it } from 'bun:test';

import { parseSource } from '../parse.ts';
import { walk, type AstNode } from '../walk.ts';

describe('parseSource', () => {
  it('parses TypeScript annotations together with JSX and module exports', () => {
    const ast = parseSource(
      'export const Screen = (props: { title: string }) => <Text>{props.title}</Text>;',
      'screen.tsx'
    );
    const types: string[] = [];
    walk(ast, (node) => {
      types.push(node.type);
    });
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
    expect(identifiers[0]?.loc).toMatchObject({
      filename: 'src/answer.ts',
      start: { line: 1, column: 6 },
    });
  });

  it('accepts an empty module without a filename', () => {
    expect(parseSource('')).toMatchObject({
      type: 'File',
      program: { type: 'Program', sourceType: 'module', body: [] },
    });
  });

  it('throws on malformed source instead of returning a partial AST', () => {
    expect(() => parseSource('const value: = ;', 'broken.ts')).toThrow(SyntaxError);
  });
});
