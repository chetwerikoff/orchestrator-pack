import { describe, expect, it, vi } from 'vitest';
import { DeterministicRuntimeAdapter } from '../runtime/test-adapter.ts';
import { executeRuntimeTaskLifecycle } from '../runtime/task-lifecycle.ts';
import type { OrcaJsonResponse } from './native.ts';
import { OrcaTaskRuntimeAdapter } from './task-adapter.ts';

function workspaceRunner() {
  return vi.fn((_command: string, args: readonly string[]) => {
    const operation = `${args[0] ?? ''} ${args[1] ?? ''}`;
    const payload = operation === 'worktree show'
      ? {
          ok: true,
          result: {
            worktree: {
              id: 'worktree-1248',
              path: '/tmp/worktree-1248',
              head: 'a'.repeat(40),
            },
          },
        }
      : operation === 'worktree rm'
        ? { ok: true, result: { removed: true } }
        : { ok: false, error: { code: 'unexpected_operation', message: operation } };
    return { stdout: JSON.stringify(payload), stderr: '', status: 0 };
  });
}

describe('Orca task adapter destructive operations', () => {
  it('prevalidates exact path and head before one remove', () => {
    const runner = workspaceRunner();
    const adapter = new OrcaTaskRuntimeAdapter({ runner: runner as never });
    const result = adapter.removeWorkspace({
      workspacePath: '/tmp/worktree-1248',
      expectedHeadSha: 'a'.repeat(40),
    });
    expect(result).toEqual({ status: 'ok', value: { removed: true } });
    expect(runner.mock.calls.map((call) => call[1]?.slice(0, 2))).toEqual([
      ['worktree', 'show'],
      ['worktree', 'rm'],
    ]);
    expect(runner.mock.calls[1]?.[1]).toContain('id:worktree-1248');
  });

  it('does not remove when the observed head changed', () => {
    const runner = workspaceRunner();
    const adapter = new OrcaTaskRuntimeAdapter({ runner: runner as never });
    const result = adapter.removeWorkspace({
      workspacePath: '/tmp/worktree-1248',
      expectedHeadSha: 'b'.repeat(40),
    });
    expect(result).toEqual({
      status: 'failed',
      operation: 'remove_workspace',
      reason: 'runtime_workspace_head_mismatch',
    });
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('does not remove when the native path differs', () => {
    const runner = workspaceRunner();
    runner.mockImplementationOnce((_command: string, _args: readonly string[]) => ({
      stdout: JSON.stringify({
        ok: true,
        result: {
          worktree: {
            id: 'foreign',
            path: '/tmp/foreign-worktree',
            head: 'a'.repeat(40),
          },
        },
      }),
      stderr: '', status: 0,
    }));
    const adapter = new OrcaTaskRuntimeAdapter({ runner: runner as never });
    const result = adapter.removeWorkspace({
      workspacePath: '/tmp/worktree-1248',
      expectedHeadSha: 'a'.repeat(40),
    });
    expect(result).toEqual({
      status: 'failed',
      operation: 'remove_workspace',
      reason: 'runtime_workspace_path_mismatch',
    });
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('consumes close authority before an ambiguous transport result', () => {
    const handle = 'owned-terminal';
    const generation = 'owned-generation';
    const runJson = vi.fn((args: readonly string[]): OrcaJsonResponse => {
      const operation = `${args[0] ?? ''} ${args[1] ?? ''}`;
      switch (operation) {
        case 'terminal create':
          return {
            ok: true,
            result: { terminal: { handle, incarnationId: generation, title: 'owned' } },
          };
        case 'worktree current':
          return {
            ok: true,
            result: { worktree: { path: '/tmp/worktree-1248', head: 'a'.repeat(40) } },
          };
        case 'terminal list':
          return {
            ok: true,
            result: {
              terminals: [{
                handle,
                incarnationId: generation,
                title: 'owned',
                worktreePath: '/tmp/worktree-1248',
                status: 'running',
              }],
            },
          };
        case 'terminal close':
          return {
            ok: false,
            outcomeCategory: 'empty_stdout',
            error: { code: 'empty_stdout', message: 'ambiguous close result' },
          };
        default:
          return {
            ok: false,
            error: { code: 'unexpected_operation', message: operation },
          };
      }
    });
    const adapter = new OrcaTaskRuntimeAdapter({ runJson: runJson as never });
    const spawned = adapter.spawnWorker({ title: 'owned', command: 'cursor-agent' });
    expect(spawned.status).toBe('ok');
    if (spawned.status !== 'ok') return;

    expect(adapter.stopWorker(spawned.value.identity)).toEqual({
      status: 'failed',
      operation: 'stop_worker',
      reason: 'runtime_response_invalid',
    });
    expect(adapter.stopWorker(spawned.value.identity)).toEqual({
      status: 'failed',
      operation: 'stop_worker',
      reason: 'worker_not_owned_by_runtime_instance',
    });
    expect(runJson.mock.calls.filter((call) => call[0]?.[1] === 'close')).toHaveLength(1);
  });

  it('retains deterministic worker identity after one ambiguous dispatch', () => {
    const adapter = new DeterministicRuntimeAdapter();
    const dispatch = vi.spyOn(adapter, 'dispatchInput').mockReturnValue({
      status: 'dispatch_unknown',
      reason: 'transport_interrupted',
    });
    const stop = vi.spyOn(adapter, 'stopWorker');

    const result = executeRuntimeTaskLifecycle({
      adapter,
      title: 'owned',
      command: 'cursor-agent',
      prompt: 'verify',
    });

    expect(result).toMatchObject({
      stage: 'dispatch',
      result: { status: 'dispatch_unknown', reason: 'transport_interrupted' },
      worker: {
        identity: {
          runtime: 'test',
          id: 'worker-1',
          generation: 'generation-1',
        },
      },
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
  });

  it('retains Orca worker identity after one ambiguous dispatch', () => {
    const handle = 'ambiguous-terminal';
    const generation = 'ambiguous-generation';
    const runJson = vi.fn((args: readonly string[]): OrcaJsonResponse => {
      const operation = `${args[0] ?? ''} ${args[1] ?? ''}`;
      switch (operation) {
        case 'terminal create':
          return {
            ok: true,
            result: { terminal: { handle, incarnationId: generation, title: 'owned' } },
          };
        case 'worktree current':
          return {
            ok: true,
            result: { worktree: { path: '/tmp/worktree-1248', head: 'a'.repeat(40) } },
          };
        case 'terminal list':
          return {
            ok: true,
            result: {
              terminals: [{
                handle,
                incarnationId: generation,
                title: 'owned',
                worktreePath: '/tmp/worktree-1248',
                status: 'running',
              }],
            },
          };
        case 'terminal send':
          return {
            ok: false,
            outcomeCategory: 'empty_stdout',
            error: { code: 'empty_stdout', message: 'ambiguous send result' },
          };
        default:
          return {
            ok: false,
            error: { code: 'unexpected_operation', message: operation },
          };
      }
    });
    const adapter = new OrcaTaskRuntimeAdapter({ runJson: runJson as never });

    const result = executeRuntimeTaskLifecycle({
      adapter,
      title: 'owned',
      command: 'cursor-agent',
      prompt: 'verify',
    });

    expect(result).toMatchObject({
      stage: 'dispatch',
      result: { status: 'dispatch_unknown' },
      worker: { identity: { runtime: 'orca', id: handle, generation } },
    });
    expect(runJson.mock.calls.filter((call) => call[0]?.[1] === 'send')).toHaveLength(1);
    expect(runJson.mock.calls.filter((call) => call[0]?.[1] === 'close')).toHaveLength(0);
  });
});
