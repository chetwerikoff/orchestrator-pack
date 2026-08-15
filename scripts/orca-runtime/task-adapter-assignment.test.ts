import { describe, expect, it, vi } from 'vitest';
import type { OrcaJsonResponse } from './native.ts';
import { OrcaTaskRuntimeAdapter } from './task-adapter.ts';

describe('Orca WorkerAssignment resolution', () => {
  it('resolves a Dispatch only after Orca exact-worker evidence and current terminal identity', () => {
    const runJson = vi.fn((args: readonly string[]): OrcaJsonResponse => {
      const operation = `${args[0] ?? ''} ${args[1] ?? ''}`;
      if (operation === 'orchestration worker-show') {
        expect(args).toContain('dispatch-1420');
        return {
          ok: true,
          result: {
            worker: { agent_terminal_handle: 'terminal-1420' },
            terminal: { handle: 'terminal-1420' },
            observation: { exactWorker: true, status: 'running' },
          },
        };
      }
      if (operation === 'terminal show') {
        return {
          ok: true,
          result: {
            terminal: {
              handle: 'terminal-1420',
              incarnationId: 'generation-1420',
              worktreePath: '/tmp/worktree-1420',
              title: 'worker',
              status: 'running',
            },
          },
        };
      }
      return { ok: false, error: { code: 'unexpected_operation', message: operation } };
    });
    const adapter = new OrcaTaskRuntimeAdapter({ runJson: runJson as never });
    const result = adapter.resolveAssignmentWorker({ provider: 'orca', bindingKey: 'dispatch-1420' });
    expect(result).toEqual({
      status: 'ok',
      value: {
        identity: { runtime: 'orca', id: 'terminal-1420', generation: 'generation-1420' },
        workspacePath: '/tmp/worktree-1420',
        title: 'worker',
        provenance: 'external',
      },
    });
    expect(runJson.mock.calls.map((call) => call[0]?.slice(0, 2))).toEqual([
      ['orchestration', 'worker-show'],
      ['terminal', 'show'],
    ]);
  });

  it('does not turn a non-exact Dispatch observation into runtime authority', () => {
    const runJson = vi.fn((_args: readonly string[]): OrcaJsonResponse => ({
      ok: true,
      result: {
        worker: { agent_terminal_handle: 'stale-terminal' },
        terminal: { handle: 'stale-terminal' },
        observation: { exactWorker: false, status: 'running' },
      },
    }));
    const adapter = new OrcaTaskRuntimeAdapter({ runJson: runJson as never });
    expect(adapter.resolveAssignmentWorker({ provider: 'orca', bindingKey: 'dispatch-stale' })).toEqual({
      status: 'ok',
      value: null,
    });
    expect(runJson).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-Orca provider without runtime lookup', () => {
    const runJson = vi.fn();
    const adapter = new OrcaTaskRuntimeAdapter({ runJson: runJson as never });
    expect(adapter.resolveAssignmentWorker({ provider: 'remote-browser', bindingKey: 'dispatch-1' })).toEqual({
      status: 'unsupported',
      operation: 'resolve_assignment_worker',
      reason: 'assignment_provider_unsupported',
    });
    expect(runJson).not.toHaveBeenCalled();
  });
});
