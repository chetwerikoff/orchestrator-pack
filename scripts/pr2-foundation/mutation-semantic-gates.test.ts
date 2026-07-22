import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AC_MUTATION_CONTROLS } from './contracts.ts';
import { FOUNDATION_MUTATION_CATALOG } from './mutation-catalog.ts';
import {
  buildBoundedSemanticMutation,
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
  it('builds a bounded non-empty mutation plan for every declared control', () => {
    for (const [ac, ids] of Object.entries(AC_MUTATION_CONTROLS)) {
      for (const mutationId of ids) {
        const key = `${ac}:${mutationId}`;
        const bindingPath = FOUNDATION_MUTATION_CATALOG
          .find((entry) => `${entry.ac}:${entry.mutationId}` === key)?.artifactPath;
        expect(bindingPath, key).toBeTruthy();
        const absolute = path.resolve(bindingPath!);
        const source = existsSync(absolute) ? readFileSync(absolute, 'utf8') : null;
        const plan = buildBoundedSemanticMutation(key, source);
        expect(plan.artifactPath, key).toBe(bindingPath);
        expect(plan.affectedOccurrences, key).toBeGreaterThan(0);
        expect(plan.content, key).not.toBe(source);
      }
    }
  });

});
