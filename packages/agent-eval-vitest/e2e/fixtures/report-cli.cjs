const { readFileSync, writeFileSync } = require('node:fs');

const [command, ...args] = process.argv.slice(2);

if (command !== 'create-report' || args.length !== 0) {
  console.error('usage: create-report');
  process.exitCode = 2;
} else {
  const input = JSON.parse(readFileSync('input.json', 'utf8'));
  writeFileSync('report.json', JSON.stringify({ status: 'ready', token: input.token }) + '\n');
  console.log('Created report.json successfully. The task is complete.');
}
