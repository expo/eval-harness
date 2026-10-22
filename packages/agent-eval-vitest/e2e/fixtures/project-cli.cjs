const { existsSync, readFileSync, readdirSync, writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');

const [command, ...args] = process.argv.slice(2);
const validFile = (name) => typeof name === 'string' && /^[a-zA-Z0-9_.-]+$/.test(name);

if (command === 'list' && args.length === 0) {
  console.log(readdirSync('.').join('\n'));
} else if (command === 'read' && args.length === 1 && validFile(args[0])) {
  if (!existsSync(args[0])) {
    console.error(`No such file: ${args[0]}. Use list to discover the exact filenames.`);
    process.exitCode = 1;
  } else {
    process.stdout.write(readFileSync(args[0], 'utf8'));
  }
} else if (command === 'write' && args.length === 2 && validFile(args[0])) {
  writeFileSync(args[0], args[1]);
  console.log(`Wrote ${args[0]}`);
} else if (command === 'test' && args.length === 0) {
  const result = spawnSync(process.execPath, ['--test', 'cart.test.cjs'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status ?? 1;
} else {
  console.error(
    'Invalid arguments. Use ["list"], ["read", "filename"], ["write", "filename", "contents"], or ["test"].'
  );
  process.exitCode = 2;
}
