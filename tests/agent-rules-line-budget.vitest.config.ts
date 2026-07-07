import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/agent-rules-line-budget.test.ts'],
    environment: 'node',
  },
});
