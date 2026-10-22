const { writeFileSync } = require('node:fs');

// If process-group cleanup fails, the descendant leaves evidence after the leader stops.
setTimeout(() => writeFileSync('escaped', 'bad'), Number(process.argv[2]));
setInterval(() => {}, 1000);
