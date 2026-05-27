import { describe, expect, it } from 'vitest';
import { computeFindingSignature } from '../lib/finding_signature.js';

describe('computeFindingSignature', () => {
  it('matches architecture #3.F sha256(type, code, normalized path)', () => {
    const signature = computeFindingSignature({
      type: 'quality',
      code: 'unused-var',
      path: './plugins/demo/lib.ts',
    });
    expect(signature).toHaveLength(64);
    expect(signature).toMatch(/^[a-f0-9]+$/);
    expect(
      computeFindingSignature({
        type: 'quality',
        code: 'unused-var',
        path: 'plugins/demo/lib.ts',
      }),
    ).toBe(signature);
  });

  it('uses empty path segment when path is null', () => {
    const withNull = computeFindingSignature({
      type: 'ci',
      code: 'failed-lint',
      path: null,
    });
    const withEmpty = computeFindingSignature({
      type: 'ci',
      code: 'failed-lint',
      path: '',
    });
    expect(withNull).toBe(withEmpty);
  });
});
