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

  function workerLookup(): OrcaJsonResponse {
    return {
      ok: true,
      result: { terminal: { handle: worker.id, incarnationId: worker.generation, worktreePath: '/tmp/w' } },
    };
  }

  it('treats successful terminal send without a submit witness as unknown and sends once', () => {
    const runJson = vi.fn((args: readonly string[]): OrcaJsonResponse => {
      const operation = `${args[0] ?? ''} ${args[1] ?? ''}`;
      if (operation === 'terminal show') return workerLookup();
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

  it('does not credential a synthetic submit-witness shape without production capture', () => {
    const runJson = vi.fn((args: readonly string[]): OrcaJsonResponse => {
      const operation = `${args[0] ?? ''} ${args[1] ?? ''}`;
      if (operation === 'terminal show') return workerLookup();
      if (operation === 'terminal send') {
        return {
          ok: true,
          result: {
            send: {
              accepted: true,
              submitWitness: {
                runtime: worker.runtime,
                workerId: worker.id,
                workerGeneration: worker.generation,
                payloadSha256: '0cfefcacfe03534dd908444efd6e4d0d1075fd8cf59ac79bf956312385679cfe',
                submitted: true,
              },
            },
          },
        };
      }
      return { ok: false, error: { code: 'unexpected_operation', message: operation } };
    });
    const adapter = new OrcaRuntimeAdapter({ runJson: runJson as never });
    expect(adapter.dispatchInput({ worker, text: 'exact payload' })).toEqual({
      status: 'dispatch_unknown',
      reason: 'submit_witness_unavailable',
    });
    expect(runJson.mock.calls.filter((call) => call[0]?.[0] === 'terminal' && call[0]?.[1] === 'send'))
      .toHaveLength(1);
  });

  it('reports a process-launch failure before send as definitive and never retries', () => {
    const runJson = vi.fn((args: readonly string[]): OrcaJsonResponse => {
      const operation = `${args[0] ?? ''} ${args[1] ?? ''}`;
      if (operation === 'terminal show') return workerLookup();
      if (operation === 'terminal send') {
        return {
          ok: false,
          outcomeCategory: 'process_launch_failed',
          error: { code: 'spawn_failed', message: 'not started' },
        };
      }
      return { ok: false, error: { code: 'unexpected_operation', message: operation } };
    });
    const adapter = new OrcaRuntimeAdapter({ runJson: runJson as never });
    expect(adapter.dispatchInput({ worker, text: 'exact payload' })).toEqual({
      status: 'send_failed',
      reason: 'runtime_unavailable',
    });
    expect(runJson.mock.calls.filter((call) => call[0]?.[0] === 'terminal' && call[0]?.[1] === 'send'))
      .toHaveLength(1);
  });

  it('keeps an ambiguous send response unknown and never retries', () => {
    const runJson = vi.fn((args: readonly string[]): OrcaJsonResponse => {
      const operation = `${args[0] ?? ''} ${args[1] ?? ''}`;
      if (operation === 'terminal show') return workerLookup();
      if (operation === 'terminal send') {
        return {
          ok: false,
          outcomeCategory: 'invalid_json',
          error: { code: 'invalid_json', message: 'ambiguous' },
        };
      }
      return { ok: false, error: { code: 'unexpected_operation', message: operation } };
    });
    const adapter = new OrcaRuntimeAdapter({ runJson: runJson as never });
    expect(adapter.dispatchInput({ worker, text: 'exact payload' })).toEqual({
      status: 'dispatch_unknown',
      reason: 'runtime_response_invalid',
    });
    expect(runJson.mock.calls.filter((call) => call[0]?.[0] === 'terminal' && call[0]?.[1] === 'send'))
      .toHaveLength(1);
  });

  it('returns an authoritative empty bound-run check only with exact run identity and without --wait', () => {
    const runJson = vi.fn((args: readonly string[]): OrcaJsonResponse => ({
      ok: true,
      result: { count: 0, run_id: 'run-current' },
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

  it('fails closed when an empty result has no run identity', () => {
    const adapter = new OrcaRuntimeAdapter({
      runJson: vi.fn((): OrcaJsonResponse => ({ ok: true, result: { count: 0 } })) as never,
    });
    expect(adapter.checkInbox({ runId: 'run-current' })).toEqual({
      status: 'unknown',
      reason: 'runtime_inbox_run_identity_unproven',
    });
  });

  it('surfaces one whole Delivery with many messages and carries one exact ack on the next check', () => {
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

  it('replays an unacked Delivery and advances serially only after its exact ack', () => {
    const runJson = vi.fn((args: readonly string[]): OrcaJsonResponse => {
      const ackIndex = args.indexOf('--ack');
      const ack = ackIndex >= 0 ? args[ackIndex + 1] : undefined;
      if (ack === 'delivery-2') return { ok: true, result: { count: 0, run_id: 'run-current' } };
      if (ack === 'delivery-1') {
        return {
          ok: true,
          result: {
            count: 1,
            run_id: 'run-current',
            delivery_id: 'delivery-2',
            messages: [{ type: 'status', body: 'second' }],
          },
        };
      }
      return {
        ok: true,
        result: {
          count: 1,
          run_id: 'run-current',
          delivery_id: 'delivery-1',
          messages: [{ type: 'status', body: 'first' }],
        },
      };
    });
    const adapter = new OrcaRuntimeAdapter({ runJson: runJson as never });
    const first = adapter.checkInbox({ runId: 'run-current' });
    expect(adapter.checkInbox({ runId: 'run-current' })).toEqual(first);
    expect(first).toMatchObject({ status: 'delivery', delivery: { deliveryId: 'delivery-1' } });
    expect(adapter.checkInbox({ runId: 'run-current', ackDeliveryId: 'delivery-1' }))
      .toMatchObject({ status: 'delivery', delivery: { deliveryId: 'delivery-2' } });
    expect(adapter.checkInbox({ runId: 'run-current', ackDeliveryId: 'delivery-2' }))
      .toEqual({ status: 'empty', runId: 'run-current' });
  });

  it('fails closed on sibling-run and missing-run Deliveries', () => {
    const responses: OrcaJsonResponse[] = [
      {
        ok: true,
        result: {
          count: 1,
          run_id: 'run-sibling',
          delivery_id: 'foreign',
          messages: [{ type: 'status', body: 'foreign' }],
        },
      },
      {
        ok: true,
        result: {
          count: 1,
          delivery_id: 'missing-run',
          messages: [{ type: 'status', body: 'unscoped' }],
        },
      },
    ];
    const runJson = vi.fn((): OrcaJsonResponse => responses.shift()!);
    const adapter = new OrcaRuntimeAdapter({ runJson: runJson as never });
    expect(adapter.checkInbox({ runId: 'run-current' })).toEqual({
      status: 'unknown',
      reason: 'runtime_inbox_run_mismatch',
    });
    expect(adapter.checkInbox({ runId: 'run-current' })).toEqual({
      status: 'unknown',
      reason: 'runtime_inbox_run_identity_unproven',
    });
  });

  it('fails closed on malformed message or duplicate/concurrent ack ambiguity', () => {
    const malformed = new OrcaRuntimeAdapter({
      runJson: vi.fn((): OrcaJsonResponse => ({
        ok: true,
        result: {
          count: 1,
          run_id: 'run-current',
          delivery_id: 'delivery-1',
          messages: [{ body: 'missing-type' }],
        },
      })) as never,
    });
    expect(malformed.checkInbox({ runId: 'run-current' })).toEqual({
      status: 'unsupported',
      reason: 'runtime_inbox_message_shape_unsupported',
    });

    const ambiguousAck = new OrcaRuntimeAdapter({
      runJson: vi.fn((): OrcaJsonResponse => ({
        ok: false,
        outcomeCategory: 'supported_operation_failure',
        error: { code: 'duplicate_ack', message: 'ack state ambiguous' },
      })) as never,
    });
    expect(ambiguousAck.checkInbox({ runId: 'run-current', ackDeliveryId: 'delivery-1' })).toEqual({
      status: 'unknown',
      reason: 'runtime_operation_failed',
    });
  });

  it('reports inbox deadline exhaustion as unknown instead of empty', () => {
    const adapter = new OrcaRuntimeAdapter({
      runJson: vi.fn((): OrcaJsonResponse => ({
        ok: false,
        outcomeCategory: 'supported_operation_failure',
        error: { code: 'orca_operation_timeout', message: 'deadline' },
      })) as never,
    });
    expect(adapter.checkInbox({ runId: 'run-current' }, { timeoutMs: 1 })).toEqual({
      status: 'unknown',
      reason: 'runtime_timeout',
    });
  });
});
