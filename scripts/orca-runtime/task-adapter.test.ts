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

function ownedTerminal(handle: string, generation: string, workspacePath = '/tmp/worktree-1248') {
  return {
    handle,
    incarnationId: generation,
    title: 'owned',
    worktreePath: workspacePath,
    status: 'running' as const,
  };
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
    const terminal = ownedTerminal(handle, generation);
    const runJson = vi.fn((args: readonly string[]): OrcaJsonResponse => {
      const operation = `${args[0] ?? ''} ${args[1] ?? ''}`;
      switch (operation) {
        case 'terminal create':
          return { ok: true, result: { terminal: { handle, incarnationId: generation, title: 'owned' } } };
        case 'worktree current':
          return { ok: true, result: { worktree: { path: '/tmp/worktree-1248', head: 'a'.repeat(40) } } };
        case 'terminal show':
          return { ok: true, result: { terminal } };
        case 'terminal close':
          return {
            ok: false,
            outcomeCategory: 'empty_stdout',
            error: { code: 'empty_stdout', message: 'ambiguous close result' },
          };
        default:
          return { ok: false, error: { code: 'unexpected_operation', message: operation } };
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

  it('does not retry an explicit runtime_error rejection', () => {
    const handle = 'rejected-terminal';
    const generation = 'rejected-generation';
    const terminal = ownedTerminal(handle, generation);
    const runJson = vi.fn((args: readonly string[]): OrcaJsonResponse => {
      const operation = `${args[0] ?? ''} ${args[1] ?? ''}`;
      switch (operation) {
        case 'terminal create':
          return { ok: true, result: { terminal: { handle, incarnationId: generation, title: 'owned' } } };
        case 'worktree current':
          return { ok: true, result: { worktree: { path: '/tmp/worktree-1248', head: 'a'.repeat(40) } } };
        case 'terminal show':
          return { ok: true, result: { terminal } };
        case 'terminal close':
          return { ok: false, error: { code: 'runtime_error', message: 'explicit rejection' } };
        default:
          return { ok: false, error: { code: 'unexpected_operation', message: operation } };
      }
    });
    const adapter = new OrcaTaskRuntimeAdapter({ runJson: runJson as never });
    const spawned = adapter.spawnWorker({ title: 'owned', command: 'cursor-agent' });
    expect(spawned.status).toBe('ok');
    if (spawned.status !== 'ok') return;

    expect(adapter.stopWorker(spawned.value.identity)).toEqual({
      status: 'failed',
      operation: 'stop_worker',
      reason: 'runtime_operation_failed',
    });
    expect(runJson.mock.calls.filter((call) => call[0]?.[1] === 'close')).toHaveLength(1);
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
      acquireClaim: () => ({ ok: true }),
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
    const terminal = ownedTerminal(handle, generation);
    const runJson = vi.fn((args: readonly string[]): OrcaJsonResponse => {
      const operation = `${args[0] ?? ''} ${args[1] ?? ''}`;
      switch (operation) {
        case 'terminal create':
          return { ok: true, result: { terminal: { handle, incarnationId: generation, title: 'owned' } } };
        case 'worktree current':
          return { ok: true, result: { worktree: { path: '/tmp/worktree-1248', head: 'a'.repeat(40) } } };
        case 'terminal show':
          return { ok: true, result: { terminal } };
        case 'terminal send':
          return {
            ok: false,
            outcomeCategory: 'empty_stdout',
            error: { code: 'empty_stdout', message: 'ambiguous send result' },
          };
        default:
          return { ok: false, error: { code: 'unexpected_operation', message: operation } };
      }
    });
    const adapter = new OrcaTaskRuntimeAdapter({ runJson: runJson as never });

    const result = executeRuntimeTaskLifecycle({
      adapter,
      title: 'owned',
      command: 'cursor-agent',
      prompt: 'verify',
      acquireClaim: () => ({ ok: true }),
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

describe('Orca task adapter exact generation authority', () => {
  it.each([
    ['create has provisional generation', 'create-generation'],
    ['create omits generation', null],
  ])('establishes from exact show when %s', (_name, createGeneration) => {
    const handle = 'exact-terminal';
    const stableGeneration = 'stable-generation';
    const calls: string[][] = [];
    const runJson = vi.fn((args: readonly string[]): OrcaJsonResponse => {
      calls.push([...args]);
      const operation = `${args[0] ?? ''} ${args[1] ?? ''}`;
      if (operation === 'terminal create') {
        return {
          ok: true,
          result: {
            terminal: {
              handle,
              title: 'owned',
              ...(createGeneration ? { incarnationId: createGeneration } : {}),
            },
          },
        };
      }
      if (operation === 'worktree current') {
        return { ok: true, result: { worktree: { path: '/tmp/worktree-1248', head: 'a'.repeat(40) } } };
      }
      if (operation === 'terminal show') {
        return { ok: true, result: { terminal: ownedTerminal(handle, stableGeneration) } };
      }
      return { ok: false, error: { code: 'unexpected_operation', message: operation } };
    });
    const adapter = new OrcaTaskRuntimeAdapter({ runJson: runJson as never });
    const spawned = adapter.spawnWorker({ title: 'owned', command: 'cursor-agent' });

    expect(spawned).toMatchObject({
      status: 'ok',
      value: { identity: { runtime: 'orca', id: handle, generation: stableGeneration } },
    });
    expect(calls.filter((args) => args[0] === 'terminal' && args[1] === 'show')).toHaveLength(1);
    expect(calls.filter((args) => args[0] === 'terminal' && args[1] === 'list')).toHaveLength(0);
  });

  it('dispatches once from exact show even when workspace list would miss the worker', () => {
    const handle = 'list-miss-terminal';
    const generation = 'list-miss-generation';
    const calls: string[][] = [];
    const runJson = vi.fn((args: readonly string[]): OrcaJsonResponse => {
      calls.push([...args]);
      const operation = `${args[0] ?? ''} ${args[1] ?? ''}`;
      if (operation === 'terminal create') {
        return { ok: true, result: { terminal: { handle, incarnationId: generation, title: 'owned' } } };
      }
      if (operation === 'worktree current') {
        return { ok: true, result: { worktree: { path: '/tmp/worktree-1248', head: 'a'.repeat(40) } } };
      }
      if (operation === 'terminal show') {
        return { ok: true, result: { terminal: ownedTerminal(handle, generation) } };
      }
      if (operation === 'terminal list') return { ok: true, result: { terminals: [] } };
      if (operation === 'terminal send') return { ok: true, result: { sent: true } };
      return { ok: false, error: { code: 'unexpected_operation', message: operation } };
    });
    const adapter = new OrcaTaskRuntimeAdapter({ runJson: runJson as never });
    const spawned = adapter.spawnWorker({ title: 'owned', command: 'cursor-agent' });
    expect(spawned.status).toBe('ok');
    if (spawned.status !== 'ok') return;

    expect(adapter.dispatchInput({ worker: spawned.value.identity, text: 'prompt' }))
      .toEqual({ status: 'dispatched' });
    expect(calls.filter((args) => args[0] === 'terminal' && args[1] === 'list')).toHaveLength(0);
    expect(calls.filter((args) => args[0] === 'terminal' && args[1] === 'send')).toHaveLength(1);
    const operations = calls.map((args) => `${args[0] ?? ''} ${args[1] ?? ''}`);
    expect(operations.slice(-2)).toEqual(['terminal show', 'terminal send']);
  });

  it.each([
    [
      'replacement generation',
      ownedTerminal('frozen-terminal', 'replacement-generation'),
      'worker_generation_mismatch',
    ],
    [
      'wrong worktree',
      ownedTerminal('frozen-terminal', 'frozen-generation', '/tmp/foreign-worktree'),
      'worker_workspace_mismatch',
    ],
  ])('fails before send for %s', (_name, secondObservation, expectedReason) => {
    const handle = 'frozen-terminal';
    const generation = 'frozen-generation';
    let showCalls = 0;
    let sendCalls = 0;
    const runJson = vi.fn((args: readonly string[]): OrcaJsonResponse => {
      const operation = `${args[0] ?? ''} ${args[1] ?? ''}`;
      if (operation === 'terminal create') {
        return { ok: true, result: { terminal: { handle, incarnationId: generation, title: 'owned' } } };
      }
      if (operation === 'worktree current') {
        return { ok: true, result: { worktree: { path: '/tmp/worktree-1248', head: 'a'.repeat(40) } } };
      }
      if (operation === 'terminal show') {
        showCalls += 1;
        return {
          ok: true,
          result: { terminal: showCalls === 1 ? ownedTerminal(handle, generation) : secondObservation },
        };
      }
      if (operation === 'terminal send') {
        sendCalls += 1;
        return { ok: true, result: { sent: true } };
      }
      return { ok: false, error: { code: 'unexpected_operation', message: operation } };
    });
    const adapter = new OrcaTaskRuntimeAdapter({ runJson: runJson as never });
    const spawned = adapter.spawnWorker({ title: 'owned', command: 'cursor-agent' });
    expect(spawned.status).toBe('ok');
    if (spawned.status !== 'ok') return;

    expect(adapter.dispatchInput({ worker: spawned.value.identity, text: 'must not send' }))
      .toEqual({ status: 'send_failed', reason: expectedReason });
    expect(sendCalls).toBe(0);
  });

  it('keeps missing-handle-like show failures unresolved without a positive absence witness', () => {
    const handle = 'unresolved-terminal';
    const generation = 'frozen-generation';
    let showCalls = 0;
    let sendCalls = 0;
    const runJson = vi.fn((args: readonly string[]): OrcaJsonResponse => {
      const operation = `${args[0] ?? ''} ${args[1] ?? ''}`;
      if (operation === 'terminal create') {
        return { ok: true, result: { terminal: { handle, incarnationId: generation, title: 'owned' } } };
      }
      if (operation === 'worktree current') {
        return { ok: true, result: { worktree: { path: '/tmp/worktree-1248', head: 'a'.repeat(40) } } };
      }
      if (operation === 'terminal show') {
        showCalls += 1;
        if (showCalls === 1) {
          return { ok: true, result: { terminal: ownedTerminal(handle, generation) } };
        }
        return {
          ok: false,
          outcomeCategory: 'supported_operation_failure',
          error: { code: 'terminal_not_found', message: 'terminal is no longer alive' },
        };
      }
      if (operation === 'terminal send') {
        sendCalls += 1;
        return { ok: true, result: { sent: true } };
      }
      return { ok: false, error: { code: 'unexpected_operation', message: operation } };
    });
    const adapter = new OrcaTaskRuntimeAdapter({ runJson: runJson as never });
    const spawned = adapter.spawnWorker({ title: 'owned', command: 'cursor-agent' });
    expect(spawned.status).toBe('ok');
    if (spawned.status !== 'ok') return;

    expect(adapter.dispatchInput({ worker: spawned.value.identity, text: 'must not send' }))
      .toEqual({ status: 'send_failed', reason: 'worker_generation_unresolved' });
    expect(sendCalls).toBe(0);
  });
});
