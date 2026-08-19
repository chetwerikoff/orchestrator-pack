import { describe, expect, it, vi } from 'vitest';
import type { OrcaJsonResponse } from './native.ts';
import { OrcaRuntimeAdapter } from './adapter.ts';
import { OrcaTaskRuntimeAdapter } from './task-adapter.ts';

describe('Issue #1441 exact runtime identity fencing', () => {
  it('performs zero send/read effects when a handle is reused by a new incarnation', () => {
    const runJson = vi.fn((args: readonly string[]): OrcaJsonResponse => {
      const operation = `${args[0] ?? ''} ${args[1] ?? ''}`;
      if (operation === 'terminal show') {
        return {
          ok: true,
          result: {
            terminal: {
              handle: 'pane-handle',
              incarnationId: 'incarnation-B',
              worktreePath: '/tmp/worktree-1441',
              title: 'current worker',
              status: 'running',
            },
          },
        };
      }
      return {
        ok: false,
        error: { code: 'unexpected_effect', message: operation },
      };
    });
    const adapter = new OrcaRuntimeAdapter({ runJson: runJson as never });
    const stale = { runtime: 'orca', id: 'pane-handle', generation: 'incarnation-A' } as const;

    expect(adapter.dispatchInput({ worker: stale, text: 'must not send' })).toEqual({
      status: 'send_failed',
      reason: 'worker_generation_not_found',
    });
    expect(adapter.readBoundedOutput({ worker: stale })).toEqual({
      status: 'failed',
      operation: 'read_bounded_output',
      reason: 'worker_generation_not_found',
    });
    expect(runJson.mock.calls.filter((call) => call[0]?.[1] === 'send')).toHaveLength(0);
    expect(runJson.mock.calls.filter((call) => call[0]?.[1] === 'read')).toHaveLength(0);
  });

  it('fences a remapped Dispatch when Orca cannot prove the exact current target', () => {
    const runJson = vi.fn((args: readonly string[]): OrcaJsonResponse => {
      const operation = `${args[0] ?? ''} ${args[1] ?? ''}`;
      if (operation === 'orchestration worker-show') {
        return {
          ok: true,
          result: {
            worker: { agent_terminal_handle: 'handle-B' },
            terminal: { handle: 'handle-B' },
            observation: { exactWorker: false, status: 'live' },
          },
        };
      }
      return {
        ok: false,
        error: { code: 'unexpected_effect', message: operation },
      };
    });
    const adapter = new OrcaTaskRuntimeAdapter({ runJson: runJson as never });

    expect(adapter.resolveAssignmentWorker({ provider: 'orca', bindingKey: 'dispatch-1441' })).toEqual({
      status: 'failed',
      operation: 'resolve_assignment_worker',
      reason: 'assignment_target_unresolved',
    });
    expect(runJson).toHaveBeenCalledTimes(1);
    expect(runJson.mock.calls[0]?.[0]).toEqual([
      'orchestration', 'worker-show', '--dispatch', 'dispatch-1441',
    ]);
    expect(runJson.mock.calls.some((call) => call[0]?.[0] === 'terminal')).toBe(false);
  });

  it('does not choose a first match when the Dispatch observation is ambiguous', () => {
    const runJson = vi.fn((): OrcaJsonResponse => ({
      ok: true,
      result: {
        worker: { agent_terminal_handle: 'handle-B' },
        terminal: { handle: 'handle-B' },
        observation: { exactWorker: true, status: 'ambiguous' },
      },
    }));
    const adapter = new OrcaTaskRuntimeAdapter({ runJson: runJson as never });
    expect(adapter.resolveAssignmentWorker({ provider: 'orca', bindingKey: 'dispatch-ambiguous' })).toEqual({
      status: 'failed',
      operation: 'resolve_assignment_worker',
      reason: 'assignment_target_unresolved',
    });
    expect(runJson).toHaveBeenCalledTimes(1);
  });
});
