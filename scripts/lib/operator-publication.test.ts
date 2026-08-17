import { describe, expect, it, vi } from 'vitest';
import type {
  RuntimeAdapter,
  RuntimeDispatchResult,
  RuntimeWorkerIdentity,
} from '../runtime/contracts.ts';
import { OrcaRuntimeAdapter } from '../orca-runtime/adapter.ts';
import type { OrcaJsonResponse } from '../orca-runtime/native.ts';
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

describe('Orca message truth', () => {
  const worker: RuntimeWorkerIdentity = { runtime: 'orca', id: 'worker-1', generation: 'g1' };

  it('treats successful terminal send without a submit witness as unknown and sends once', () => {
    const runJson = vi.fn((args: readonly string[]): OrcaJsonResponse => {
      const operation = `${args[0] ?? ''} ${args[1] ?? ''}`;
      if (operation === 'terminal show') {
        return {
          ok: true,
          result: { terminal: { handle: worker.id, incarnationId: worker.generation, worktreePath: '/tmp/w' } },
        };
      }
      if (operation === 'terminal send') return { ok: true, result: {} };
      return { ok: false, error: { code: 'unexpected_operation', message: operation } };
    });
    const adapter = new OrcaRuntimeAdapter({ runJson: runJson as never });
    expect(adapter.dispatchInput({ worker, text: 'exact payload' })).toEqual({
      status: 'dispatch_unknown',
      reason: 'submit_witness_unavailable',
    });
    const sends = runJson.mock.calls.filter((call) => call[0]?.[0] === 'terminal' && call[0]?.[1] === 'send');
    expect(sends).toHaveLength(1);
    expect(sends[0]?.[0]).toEqual([
      'terminal', 'send', '--terminal', worker.id, '--text', 'exact payload', '--enter',
    ]);
  });

  it('returns an authoritative empty bound-run check without --wait', () => {
    const runJson = vi.fn((args: readonly string[]): OrcaJsonResponse => ({
      ok: true,
      result: { count: 0 },
    }));
    const adapter = new OrcaRuntimeAdapter({ runJson: runJson as never });
    expect(adapter.checkInbox({ runId: 'run-current' }, { timeoutMs: 100 })).toEqual({
      status: 'empty',
      runId: 'run-current',
    });
    expect(runJson.mock.calls[0]?.[0]).toEqual([
      'orchestration', 'check', '--run', 'run-current',
    ]);
    expect(runJson.mock.calls[0]?.[0]).not.toContain('--wait');
  });

  it('surfaces one exact Delivery and carries its ack on the next check', () => {
    const runJson = vi.fn((args: readonly string[]): OrcaJsonResponse => ({
      ok: true,
      result: args.includes('--ack')
        ? { count: 0, run_id: 'run-current' }
        : {
            count: 2,
            run_id: 'run-current',
            delivery_id: 'delivery-1',
            messages: [
              { type: 'question', subject: 'one', body: 'a' },
              { type: 'worker_done', subject: 'two', body: 'b' },
            ],
          },
    }));
    const adapter = new OrcaRuntimeAdapter({ runJson: runJson as never });
    expect(adapter.checkInbox({ runId: 'run-current' })).toEqual({
      status: 'delivery',
      delivery: {
        runId: 'run-current',
        deliveryId: 'delivery-1',
        messages: [
          { type: 'question', subject: 'one', body: 'a' },
          { type: 'worker_done', subject: 'two', body: 'b' },
        ],
      },
    });
    expect(adapter.checkInbox({ runId: 'run-current', ackDeliveryId: 'delivery-1' })).toEqual({
      status: 'empty',
      runId: 'run-current',
    });
    expect(runJson.mock.calls[1]?.[0]).toEqual([
      'orchestration', 'check', '--run', 'run-current', '--ack', 'delivery-1',
    ]);
  });

  it('fails closed on a sibling-run Delivery', () => {
    const runJson = vi.fn((): OrcaJsonResponse => ({
      ok: true,
      result: {
        count: 1,
        run_id: 'run-sibling',
        delivery_id: 'foreign',
        messages: [{ type: 'status', body: 'foreign' }],
      },
    }));
    const adapter = new OrcaRuntimeAdapter({ runJson: runJson as never });
    expect(adapter.checkInbox({ runId: 'run-current' })).toEqual({
      status: 'unknown',
      reason: 'runtime_inbox_run_mismatch',
    });
  });
});
