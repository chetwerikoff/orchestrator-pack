import { defineConfig } from 'vitest/config';

const ci = process.env.CI === 'true';
const lightLane = process.env.VITEST_CI_LIGHT_LANE === '1';
const lightMaxWorkers = Number(process.env.VITEST_LIGHT_MAX_WORKERS ?? '2');

export default defineConfig({
  test: {
    globalSetup: ['scripts/vitest-global-setup.ts'],
    include: [
      'plugins/**/tests/**/*.test.ts',
      'scripts/**/*.test.ts',
      'tests/agents-md-size-budget.test.ts',
    ],
    environment: 'node',
    // Issue #488 slow-test budget: per-test ceiling must not be below 120s in CI.
    testTimeout: ci ? 120_000 : 15_000,
    // Heavy lanes stay serial in-runner (#487/#536). Only classified light files
    // may use bounded in-process parallelism (#556).
    ...(ci
      ? lightLane
        ? {
            pool: 'forks',
            fileParallelism: true,
            maxWorkers: Number.isFinite(lightMaxWorkers) && lightMaxWorkers >= 1
              ? Math.min(lightMaxWorkers, 4)
              : 2,
          }
        : {
            pool: 'forks',
            fileParallelism: false,
            maxWorkers: 1,
          }
      : {}),
  },
});
