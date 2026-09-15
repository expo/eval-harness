const assert = require('node:assert/strict');
const { subtotal } = require(process.argv[2]);

// Independent cases are kept outside the agent workspace.
assert.equal(subtotal([]), 0);
assert.equal(subtotal([{ unitPrice: 125, quantity: 4 }]), 500);
assert.equal(subtotal([{ unitPrice: 999, quantity: 0 }]), 0);
assert.equal(
  subtotal([
    { unitPrice: 275, quantity: 2 },
    { unitPrice: 125, quantity: 3 },
  ]),
  925
);

const items = [{ unitPrice: 90, quantity: 2 }];
const before = JSON.stringify(items);
assert.equal(subtotal(items), 180);
assert.equal(JSON.stringify(items), before, 'subtotal must not mutate its input');
console.log('Independent cart checks passed');
