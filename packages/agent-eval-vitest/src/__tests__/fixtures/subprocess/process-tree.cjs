const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const exitLeader = process.argv[2] === 'exit-leader';
const child = spawn(process.execPath, [join(__dirname, 'descendant.cjs'), '800'], {
  stdio: exitLeader ? ['ignore', 1, 2] : 'ignore',
});
writeFileSync('descendant.pid', String(child.pid));

if (exitLeader) {
  child.unref();
} else {
  setInterval(() => {}, 1000);
}
