import { readFileSync } from 'node:fs';
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
      expect(binding.strategy).not.toBe('corrupt');
      expect(binding.strategy).not.toBe('delete');
      expect(binding.failingTestId).toBe(`mutation-contract:${binding.ac}:${binding.mutationId}`);
    }
  });
});

describe('[Issue 1440] orchestration escalation guarantees', () => {
  it('gives every formerly unproved at-least-once-until-ack class one explicit disposition', () => {
    const catalog = JSON.parse(readFileSync(
      new URL('../orchestrator-message-catalog.json', import.meta.url),
      'utf8',
    )) as {
      escalationClasses: Array<{
        code: string;
        delivery_guarantee: string;
        guarantee_reconciliation?: { decision?: string; reason?: string };
      }>;
    };
    const codes = ['E1', 'E3', 'E5', 'E10', 'E11-promoted', 'E12', 'E14', 'E15', 'E16'];
    const selected = catalog.escalationClasses.filter((entry) => codes.includes(entry.code));
    expect(selected.map((entry) => entry.code).sort()).toEqual([...codes].sort());
    for (const entry of selected) {
      expect(entry.guarantee_reconciliation?.decision).toMatch(/^(retain|downgrade)$/);
      expect(entry.guarantee_reconciliation?.reason?.trim()).toBeTruthy();
      if (entry.guarantee_reconciliation?.decision === 'downgrade') {
        expect(entry.delivery_guarantee).not.toBe('at-least-once-until-ack');
      }
    }
  });
});
