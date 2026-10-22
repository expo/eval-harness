function subtotal(items) {
  return items.reduce((total, item) => total + item.unitPrice, 0);
}

module.exports = { subtotal };
