import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runRealFoundationScopeProof } from './real-scope-proof.ts';

const pr2aSuccessorPresent = existsSync('scripts/pr2a/closed-world-scanner.ts');

describe('[AC9] real committed declaration and base-to-head scope proof', () => {
  it('keeps the immutable foundation proof or routes to the declared PR 2a successor authority', () => {
    if (pr2aSuccessorPresent) {
      expect(existsSync('scripts/pr2a/planning-validator.ts')).toBe(true);
      expect(existsSync('scripts/pr2a/reference-grammar.json')).toBe(true);
      return;
    }
    expect(runRealFoundationScopeProof()).toEqual({
      ok: true,
      result: 'foundation-bounded-regular-single-revert',
    });
  });
});
