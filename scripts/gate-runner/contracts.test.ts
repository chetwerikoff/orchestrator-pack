import { describe, expect, it } from 'vitest';
import {
  aggregateLane,
  passGate,
  skipGate,
  type EvidenceObservation,
  type GateResult,
} from './contracts.ts';

const staticEvidence: EvidenceObservation = {
  class: 'static-source',
  state: 'present',
  source: 'fixture',
};

function pass(id = 'pass'): GateResult {
  return passGate(id, 'ok', ['static-source'], [staticEvidence]);
}

describe('gate result algebra', () => {
  it('keeps PASS, FAIL, and SKIP terminal and distinct', () => {
    expect(pass().status).toBe('PASS');
    const skipped = skipGate('skip', 'no evidence', [staticEvidence]);
    expect(skipped.status).toBe('SKIP');
    expect(skipped.reason).toBe('no evidence');
  });

  it('turns a nominal pass into SKIP when any required evidence class is absent', () => {
    const result = passGate('multi', 'all predicates pass', ['static-source', 'live-adoption'], [staticEvidence]);
    expect(result.status).toBe('SKIP');
    expect(result.details?.join('\n')).toContain('live-adoption');
  });

  it('turns unreachable evidence into SKIP rather than PASS', () => {
    const result = passGate('multi', 'all predicates pass', ['static-source', 'capture-schema'], [
      staticEvidence,
      { class: 'capture-schema', state: 'unreachable', source: 'capture.json' },
    ]);
    expect(result.status).toBe('SKIP');
  });

  it('greens a lane only when every gate passes', () => {
    expect(aggregateLane([pass('a'), pass('b')])).toMatchObject({
      status: 'PASS', green: true, exitCode: 0, checkConclusion: 'success',
    });
  });

  it('fails a required check on any FAIL or unallowed SKIP', () => {
    const failed = { ...pass('bad'), status: 'FAIL' as const };
    expect(aggregateLane([pass(), failed])).toMatchObject({ exitCode: 1, checkConclusion: 'failure' });
    expect(aggregateLane([pass(), skipGate('skip', 'missing', [])])).toMatchObject({
      status: 'SKIP', green: false, exitCode: 1, checkConclusion: 'failure',
    });
  });

  it('records an explicit allow-skip exception without relabeling it PASS', () => {
    expect(aggregateLane([pass(), skipGate('optional', 'not installed', [], [], true)])).toMatchObject({
      status: 'SKIP', green: false, exitCode: 0, checkConclusion: 'success',
    });
  });

  it('does not green-light an empty lane', () => {
    expect(aggregateLane([])).toMatchObject({ status: 'SKIP', green: false, exitCode: 1 });
  });
});
