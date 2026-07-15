import { describe, expect, it } from 'vitest';
import { aggregateLane, type GateResult } from './types.ts';

function gate(overrides: Partial<GateResult> = {}): GateResult {
  return {
    gateId: overrides.gateId ?? 'gate',
    status: overrides.status ?? 'PASS',
    summary: overrides.summary ?? 'summary',
    evidence: overrides.evidence ?? ['static-source'],
    allowSkip: overrides.allowSkip,
    details: overrides.details,
  };
}

describe('gate-runner lane aggregation', () => {
  it('is green only when every gate passes', () => {
    const aggregate = aggregateLane([gate({ gateId: 'a' }), gate({ gateId: 'b' })]);
    expect(aggregate).toMatchObject({ status: 'PASS', green: true, exitCode: 0 });
  });

  it('fails the lane on any failure', () => {
    const aggregate = aggregateLane([gate({ gateId: 'a' }), gate({ gateId: 'b', status: 'FAIL' })]);
    expect(aggregate).toMatchObject({ status: 'FAIL', green: false, exitCode: 1 });
    expect(aggregate.failures.map((result) => result.gateId)).toEqual(['b']);
  });

  it('does not green-light an all-skip lane', () => {
    const aggregate = aggregateLane([gate({ gateId: 'a', status: 'SKIP' })]);
    expect(aggregate).toMatchObject({ status: 'SKIP', green: false, exitCode: 1 });
  });

  it('does not absorb an unallowed skip beside a passing gate', () => {
    const aggregate = aggregateLane([gate({ gateId: 'a' }), gate({ gateId: 'b', status: 'SKIP' })]);
    expect(aggregate).toMatchObject({ status: 'SKIP', green: false, exitCode: 1 });
    expect(aggregate.skipped.map((result) => result.gateId)).toEqual(['b']);
  });

  it('surfaces an explicitly allowed skip without converting it to pass', () => {
    const aggregate = aggregateLane([
      gate({ gateId: 'a', status: 'PASS' }),
      gate({ gateId: 'b', status: 'SKIP', allowSkip: true }),
    ]);
    expect(aggregate).toMatchObject({ status: 'SKIP', green: false, exitCode: 0 });
  });
});
