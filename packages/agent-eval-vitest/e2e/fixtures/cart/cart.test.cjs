const assert = require('node:assert/strict');
const { test } = require('node:test');
const { subtotal } = require('./cart.cjs');

test('an empty cart costs zero', () => {
  assert.equal(subtotal([]), 0);
});

test('a single item uses its unit price in cents', () => {
  assert.equal(subtotal([{ unitPrice: 499, quantity: 1 }]), 499);
});

test('multiple units contribute to the subtotal', () => {
  assert.equal(subtotal([{ unitPrice: 499, quantity: 3 }]), 1497);
});
