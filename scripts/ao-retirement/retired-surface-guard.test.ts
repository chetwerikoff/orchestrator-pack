import { describe, it } from 'vitest';

describe('retired AO surface proof producer', () => {
  it('runs the exact retired-surface self-test producer', async () => {
    await import('./retired-surface-selftest.ts');
  });
});
