const { writeFileSync } = require('node:fs');

const filename = process.argv[2] ?? 'done';
writeFileSync(filename, 'yes');
