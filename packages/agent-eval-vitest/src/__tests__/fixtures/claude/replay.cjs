const { readFileSync, writeFileSync } = require('node:fs');

const response = JSON.parse(readFileSync('response.json', 'utf8'));
writeFileSync('arguments.json', JSON.stringify(process.argv.slice(2)));

if (response.stderr) {
  process.stderr.write(response.stderr);
}
for (const event of response.events ?? []) {
  console.log(JSON.stringify(event));
}
if (response.stdout) {
  process.stdout.write(response.stdout);
}

process.exitCode = response.exitCode ?? 0;
if (response.keepAlive) {
  setInterval(() => {}, 1000);
}
