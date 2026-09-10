import { describe, expect, it } from 'bun:test';

import { parseSource } from '../parse.ts';
import { stripComments } from '../strip-comments.ts';
import { walk, type AstNode } from '../walk.ts';

describe('stripComments', () => {
  it('strips line and block comments', () => {
    expect(stripComments('const a = 1; // gone\nconst b = 2;')).toBe('const a = 1; \nconst b = 2;');
    expect(stripComments('/* gone */ const a = 1;')).toBe(' const a = 1;');
  });

  it('leaves // inside strings alone', () => {
    const line = `const url = 'https://expo.dev'; use(process.env.EXPO_PUBLIC_KEY);`;
    expect(stripComments(line)).toBe(line);
  });

  it('leaves comment markers inside templates alone', () => {
    const line = 'const sql = `SELECT * /* not a comment */ FROM t`;';
    expect(stripComments(line)).toBe(line);
  });

  it('handles escaped quotes', () => {
    expect(stripComments(`const s = 'don\\'t'; // gone`)).toBe(`const s = 'don\\'t'; `);
  });
});

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

describe('stripComments edge cases', () => {
  it.each([
    { name: 'empty input', source: '', expected: '' },
    { name: 'comment-free code and division', source: 'const ratio = total / count;', expected: 'const ratio = total / count;' },
    { name: 'line comment at EOF', source: 'run(); // no final newline', expected: 'run(); ' },
    { name: 'multiline block comment', source: 'before(); /* first\nsecond\nthird */ after();', expected: 'before(); \n\n after();' },
    { name: 'adjacent comments', source: '/* one *//* two */run();// three\nnext();', expected: 'run();\nnext();' },
    { name: 'line markers inside a block comment', source: '/* // hidden\nstill hidden */run();', expected: '\nrun();' },
    { name: 'block markers inside a line comment', source: '// /* hidden */\nrun();', expected: '\nrun();' },
    { name: 'unterminated block comment', source: 'run(); /* hidden\nstill hidden', expected: 'run(); \n' },
    { name: 'double-quoted comment markers', source: 'const text = "https://expo.dev/*path*/"; // gone', expected: 'const text = "https://expo.dev/*path*/"; ' },
    { name: 'escaped double quote', source: String.raw`const text = "say \"/* keep */"; /* gone */`, expected: String.raw`const text = "say \"/* keep */"; ` },
    { name: 'escaped backslash before closing quote', source: String.raw`const text = 'path\\'; // gone`, expected: String.raw`const text = 'path\\'; ` },
    { name: 'escaped template terminator', source: 'const text = `escaped \\` // keep`; // gone', expected: 'const text = `escaped \\` // keep`; ' },
    { name: 'multiline template', source: 'const text = `first\n// keep\n/* keep */`; /* gone */', expected: 'const text = `first\n// keep\n/* keep */`; ' },
  ])('$name', ({ source, expected }) => {
    expect(stripComments(source)).toBe(expected);
  });

  it('removes commented-out skill usage while preserving a live URL', () => {
    const source = `// SQLite.openDatabaseAsync('fake.db');
const endpoint = "https://expo.dev";
/* <SQLiteProvider databaseName="fake.db" /> */
fetch(endpoint);`;
    expect(stripComments(source)).toBe(`
const endpoint = "https://expo.dev";

fetch(endpoint);`);
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
