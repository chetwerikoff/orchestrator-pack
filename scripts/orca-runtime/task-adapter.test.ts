import { describe, expect, it, vi } from 'vitest';
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

describe('Orca task adapter destructive workspace operation', () => {
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
      stderr: '',
      status: 0,
    }));
    const adapter = new OrcaTaskRuntimeAdapter({ runner: runner as never });
    const result = adapter.removeWorkspace({ workspacePath: '/tmp/worktree-1248' });
    expect(result).toEqual({
      status: 'failed',
      operation: 'remove_workspace',
      reason: 'runtime_workspace_path_mismatch',
    });
    expect(runner).toHaveBeenCalledTimes(1);
  });
});
