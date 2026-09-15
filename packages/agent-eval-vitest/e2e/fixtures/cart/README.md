# Cart pricing

`cart.cjs` exports `subtotal(items)`. Each item has an integer `unitPrice` in
cents and a nonnegative integer `quantity`. The result is the subtotal in cents.
There are no dependencies. Run the tests with `node --test cart.test.cjs`.
