import { describe, expect, it } from 'vitest';
import { runRealFoundationScopeProof } from './real-scope-proof.ts';

describe('[AC9] real committed declaration and base-to-head scope proof', () => {
  it('keeps the immutable declaration baseline while validating only the current PR delta', () => {
    expect(runRealFoundationScopeProof()).toEqual({
      ok: true,
      result: 'foundation-bounded-regular-single-revert',
    });
  });
});
