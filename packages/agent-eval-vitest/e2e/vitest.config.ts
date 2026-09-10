import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['e2e/*.eval.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    retry: 0,
    hookTimeout: 35 * 60_000,
    reporters: ['default', 'json'],
    outputFile: { json: '.eval-results/ollama-e2e/vitest.json' },
  },
});
