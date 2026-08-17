import { describe, expect, it } from 'vitest';
import type { RuntimeAdapter, RuntimeWorker, RuntimeWorkerIdentity } from '../runtime/contracts.ts';
import { publishWorkerDegradedCiHandoffOnce } from './worker-degraded-ci-handoff.ts';

const target: RuntimeWorkerIdentity = { runtime: 'fixture', id: 'worker-1', generation: 'g1' };
const worker: RuntimeWorker = {
  identity: target, workspacePath: '/tmp/work', title: null, provenance: 'internal',
};

function fixture(resolved: unknown): { adapter: RuntimeAdapter; findCalls: unknown[]; dispatchCalls: unknown[] } {
  const findCalls: unknown[] = [];
  const dispatchCalls: unknown[] = [];
  return {
    findCalls,
    dispatchCalls,
    adapter: {
      id: 'fixture',
      findWorker(identity: unknown, options: unknown) { findCalls.push({ identity, options }); return resolved as never; },
      dispatchInput(input: unknown, options: unknown) { dispatchCalls.push({ input, options }); return { status: 'dispatched' }; },
    } as unknown as RuntimeAdapter,
  };
}

describe('publishWorkerDegradedCiHandoffOnce', () => {
  it('uses one exact freshness lookup and one dispatch', () => {
    const f = fixture({ status: 'ok', value: worker });
    expect(publishWorkerDegradedCiHandoffOnce(f.adapter, { target, text: 'degraded', timeoutMs: 1_000 }))
      .toBe('submitted');
    expect(f.findCalls).toHaveLength(1);
    expect(f.dispatchCalls).toHaveLength(1);
    expect(f.dispatchCalls[0]).toMatchObject({ input: { worker: target, text: 'degraded' } });
  });

  it.each([
    { status: 'failed', operation: 'find_worker', reason: 'failed' },
    { status: 'ok', value: null },
    { status: 'ok', value: { ...worker, identity: { ...target, generation: 'g2' } } },
    { status: 'ok', value: { ...worker, identity: { ...target, id: '' } } },
  ])('fails closed with zero dispatch for unresolved or mismatched identity', (resolved) => {
    const f = fixture(resolved);
    expect(publishWorkerDegradedCiHandoffOnce(f.adapter, { target, text: 'degraded', timeoutMs: 1_000 }))
      .toBe('pre_dispatch_failure');
    expect(f.findCalls).toHaveLength(1);
    expect(f.dispatchCalls).toEqual([]);
  });

  it('rejects structurally invalid identity before lookup', () => {
    const f = fixture({ status: 'ok', value: worker });
    expect(publishWorkerDegradedCiHandoffOnce(f.adapter, {
      target: { ...target, runtime: '' }, text: 'degraded', timeoutMs: 1_000,
    })).toBe('pre_dispatch_failure');
    expect(f.findCalls).toEqual([]);
    expect(f.dispatchCalls).toEqual([]);
  });
});
