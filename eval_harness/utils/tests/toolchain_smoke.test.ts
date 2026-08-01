import { expect, test } from "bun:test";

test("[SMOKE] Bun executes TypeScript tests", () => {
  const values: readonly number[] = [1, 2, 3];
  const total = values.reduce((sum, value) => sum + value, 0);

  expect(total).toBe(6);
});
