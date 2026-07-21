import { describe, expect, it } from 'vitest';
import { AC_MUTATION_CONTROLS } from './contracts.ts';
import { FOUNDATION_MUTATION_CATALOG } from './mutation-catalog.ts';

describe('[AC8] external mutation catalog', () => {
  it('binds every declared control exactly once to a real artifact and specific checker ID', () => {
    const expected = Object.entries(AC_MUTATION_CONTROLS).flatMap(([ac, ids]) =>
      ids.map((mutationId) => `${ac}:${mutationId}`),
    );
    const actual = FOUNDATION_MUTATION_CATALOG.map((entry) => `${entry.ac}:${entry.mutationId}`);
    expect(new Set(actual).size).toBe(actual.length);
    expect([...actual].sort()).toEqual([...expected].sort());
    for (const binding of FOUNDATION_MUTATION_CATALOG) {
      expect(binding.artifactPath).not.toMatch(/^\/|^[A-Za-z]:[\\/]/);
      expect(binding.failingTestId).toBe(`mutation-contract:${binding.ac}:${binding.mutationId}`);
    }
  });
});
