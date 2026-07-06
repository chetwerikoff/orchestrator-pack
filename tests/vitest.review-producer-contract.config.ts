import { defineConfig } from 'vitest/config';

/** Scoped runner for Issue #626 mapping tests under tests/** (keeps root vitest.config.ts unchanged). */
export default defineConfig({
  test: {
    include: ['tests/review-producer-contract.test.ts'],
    environment: 'node',
  },
});
