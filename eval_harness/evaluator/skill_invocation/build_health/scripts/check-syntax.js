// Reports whether a single JS/JSX/TS/TSX file parses cleanly. The only
// consumer is build_health/syntax_check.py -- there is no regex substitute
// for "is this syntactically valid code," which is the whole reason this
// script (and its one real dependency, @babel/parser) exists at all.
//
// Usage: node check-syntax.js <path-to-file>
// stdout (success): {"ok": true}
// stderr + exit 1 (failure): {"error": "parse_error", "message": "..."}
const fs = require('fs');
const parser = require('@babel/parser');

const filePath = process.argv[2];
const code = fs.readFileSync(filePath, 'utf8');

try {
  parser.parse(code, {
    sourceType: 'module',
    plugins: ['jsx', 'typescript'],
  });
} catch (err) {
  console.error(JSON.stringify({ error: 'parse_error', message: err.message }));
  process.exit(1);
}

console.log(JSON.stringify({ ok: true }));
