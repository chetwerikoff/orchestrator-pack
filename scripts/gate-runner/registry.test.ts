import { describe, expect, it } from 'vitest';
import { passGate } from './contracts.ts';
import { selectGateRegistrations, validateGateRegistrations, type GateRegistration } from './registry.ts';

function registration(gateId: string): GateRegistration {
  return {
    gateId,
    evaluate: () => passGate(gateId, 'ok', [], []),
  };
}

describe('gate extension registry', () => {
  it('keeps the unfiltered registration order stable', () => {
    const registrations = [registration('a'), registration('b')];
    expect(selectGateRegistrations(registrations, undefined)).toBe(registrations);
  });

  it('selects named gates without changing their registration order', () => {
    const registrations = [registration('a'), registration('b'), registration('c')];
    expect(selectGateRegistrations(registrations, ['c', 'a']).map((item) => item.gateId)).toEqual(['a', 'c']);
  });

  it('rejects unknown, duplicate, empty, and reserved registrations', () => {
    expect(() => selectGateRegistrations([registration('a')], ['missing'])).toThrow(/unknown gate/u);
    expect(() => validateGateRegistrations([registration('a'), registration('a')])).toThrow(/duplicate/u);
    expect(() => validateGateRegistrations([registration('')])).toThrow(/must not be empty/u);
    expect(() => validateGateRegistrations([registration('gate-census')])).toThrow(/reserved/u);
  });
});
