import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['scripts/gate-runner/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 15_000,
  },
});
