import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'scripts/estate-cut/issue-906-vertical-slice.test.ts',
      'scripts/gate-runner/census.test.ts',
      'scripts/orchestrator-wake-supervisor-side-process-registry.test.ts',
    ],
    environment: 'node',
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 120_000,
  },
});
