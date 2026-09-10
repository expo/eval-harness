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
