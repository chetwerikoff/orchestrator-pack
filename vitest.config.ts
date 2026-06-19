import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['plugins/**/tests/**/*.test.ts', 'scripts/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15_000,
  },
});
