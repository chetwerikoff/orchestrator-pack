import { describe, expect, it } from 'vitest';
import { AC_MUTATION_CONTROLS } from './contracts.ts';
import {
  evaluateSemanticMutationGate,
  failingTestIdForMutation,
} from './mutation-semantic-gates.ts';

describe('[AC8] independent semantic mutation gates', () => {
  it('passes every contract-specific checker on the clean repository head', () => {
    const keys = Object.entries(AC_MUTATION_CONTROLS).flatMap(([ac, ids]) =>
      ids.map((mutationId) => `${ac}:${mutationId}`),
    );
    for (const key of keys) {
      expect(evaluateSemanticMutationGate(key), key).toEqual({
        ok: true,
        failingTestId: failingTestIdForMutation(key),
      });
    }
  });
});
