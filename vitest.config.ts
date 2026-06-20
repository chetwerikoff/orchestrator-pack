import { defineConfig } from 'vitest/config';

const ci = process.env.CI === 'true';

export default defineConfig({
  test: {
    include: ['plugins/**/tests/**/*.test.ts', 'scripts/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15_000,
    // GHA runners occasionally hit vitest-worker onTaskUpdate RPC timeouts when
    // many heavy script integration files run in parallel (all tests pass).
    ...(ci
      ? {
          pool: 'forks',
          fileParallelism: false,
          maxWorkers: 1,
        }
      : {}),
  },
});
