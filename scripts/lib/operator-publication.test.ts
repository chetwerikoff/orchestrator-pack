import { describe, expect, it } from 'vitest';
import type {
  RuntimeAdapter,
  RuntimeDispatchResult,
  RuntimeWorkerIdentity,
} from '../runtime/contracts.ts';
import {
  OPERATOR_PUBLICATION_MAX_TEXT_BYTES,
  publishOperatorMessageOnce,
} from './operator-publication.ts';

const target: RuntimeWorkerIdentity = { runtime: 'fixture', id: 'worker-1', generation: 'g1' };

function adapterWith(result: RuntimeDispatchResult): { adapter: RuntimeAdapter; calls: unknown[] } {
  const calls: unknown[] = [];
  const adapter = {
    id: 'fixture',
    dispatchInput(input: unknown, options: unknown) { calls.push({ input, options }); return result; },
  } as unknown as RuntimeAdapter;
  return { adapter, calls };
}

describe('publishOperatorMessageOnce', () => {
  it.each([
    [{ status: 'dispatched' } as const, 'submitted'],
    [{ status: 'send_failed', reason: 'no-send' } as const, 'pre_dispatch_failure'],
    [{ status: 'dispatch_unknown', reason: 'unknown' } as const, 'ambiguous'],
  ])('maps one transport result exactly', (transport, expected) => {
    const { adapter, calls } = adapterWith(transport);
    expect(publishOperatorMessageOnce(adapter, {
      route: 'operator-primary', target, text: ' exact text ', timeoutMs: 100,
    })).toBe(expected);
    expect(calls).toEqual([{ input: { worker: target, text: ' exact text ' }, options: { timeoutMs: 100 } }]);
  });

  it('rejects invalid and out-of-bound input before dispatch', () => {
    const { adapter, calls } = adapterWith({ status: 'dispatched' });
    const invalid = [
      { route: 'operator-primary', target, text: ' ', timeoutMs: 1 },
      { route: 'operator-primary', target, text: 'x', timeoutMs: 0 },
      { route: 'operator-primary', target, text: 'x', timeoutMs: 30_001 },
      { route: 'operator-primary', target: { ...target, generation: '' }, text: 'x', timeoutMs: 1 },
      { route: 'operator-primary', target, text: 'x'.repeat(OPERATOR_PUBLICATION_MAX_TEXT_BYTES + 1), timeoutMs: 1 },
    ];
    for (const input of invalid) {
      expect(publishOperatorMessageOnce(adapter, input as never)).toBe('pre_dispatch_failure');
    }
    expect(calls).toEqual([]);
  });

  it('accepts exact UTF-8 byte and timeout boundaries', () => {
    const { adapter, calls } = adapterWith({ status: 'dispatched' });
    expect(publishOperatorMessageOnce(adapter, {
      route: 'operator-primary', target, text: 'x'.repeat(OPERATOR_PUBLICATION_MAX_TEXT_BYTES), timeoutMs: 30_000,
    })).toBe('submitted');
    expect(calls).toHaveLength(1);
  });
});
