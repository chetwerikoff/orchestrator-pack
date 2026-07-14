import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'scripts/kernel/**/*.test.ts',
      'scripts/toolchain/**/*.test.ts',
    ],
    environment: 'node',
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 15_000,
  },
});
