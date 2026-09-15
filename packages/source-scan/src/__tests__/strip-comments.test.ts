import { describe, expect, it } from 'bun:test';

import { stripComments } from '../strip-comments.ts';

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

describe('stripComments edge cases', () => {
  it.each([
    { name: 'empty input', source: '', expected: '' },
    {
      name: 'comment-free code and division',
      source: 'const ratio = total / count;',
      expected: 'const ratio = total / count;',
    },
    { name: 'line comment at EOF', source: 'run(); // no final newline', expected: 'run(); ' },
    {
      name: 'multiline block comment',
      source: 'before(); /* first\nsecond\nthird */ after();',
      expected: 'before(); \n\n after();',
    },
    {
      name: 'adjacent comments',
      source: '/* one *//* two */run();// three\nnext();',
      expected: 'run();\nnext();',
    },
    {
      name: 'line markers inside a block comment',
      source: '/* // hidden\nstill hidden */run();',
      expected: '\nrun();',
    },
    {
      name: 'block markers inside a line comment',
      source: '// /* hidden */\nrun();',
      expected: '\nrun();',
    },
    {
      name: 'unterminated block comment',
      source: 'run(); /* hidden\nstill hidden',
      expected: 'run(); \n',
    },
    {
      name: 'double-quoted comment markers',
      source: 'const text = "https://expo.dev/*path*/"; // gone',
      expected: 'const text = "https://expo.dev/*path*/"; ',
    },
    {
      name: 'escaped double quote',
      source: String.raw`const text = "say \"/* keep */"; /* gone */`,
      expected: String.raw`const text = "say \"/* keep */"; `,
    },
    {
      name: 'escaped backslash before closing quote',
      source: String.raw`const text = 'path\\'; // gone`,
      expected: String.raw`const text = 'path\\'; `,
    },
    {
      name: 'escaped template terminator',
      source: 'const text = `escaped \\` // keep`; // gone',
      expected: 'const text = `escaped \\` // keep`; ',
    },
    {
      name: 'multiline template',
      source: 'const text = `first\n// keep\n/* keep */`; /* gone */',
      expected: 'const text = `first\n// keep\n/* keep */`; ',
    },
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
