import { describe, it } from 'vitest';

describe('AO-absent Orca proof producer', () => {
  it('runs two unrelated Orca lifecycles with AO and pwsh unavailable', async () => {
    await import('./runtime-independence-two-lifecycle-proof.ts');
  });
});
