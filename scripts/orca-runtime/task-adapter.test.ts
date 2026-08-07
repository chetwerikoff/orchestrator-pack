import { describe, expect, it, vi } from 'vitest';
import { DeterministicRuntimeAdapter } from '../runtime/test-adapter.ts';
import { executeRuntimeTaskLifecycle } from '../runtime/task-lifecycle.ts';
import type { OrcaJsonResponse, OrcaTerminalSummary } from './native.ts';
import { OrcaTaskRuntimeAdapter } from './task-adapter.ts';

const WORKSPACE = '/tmp/worktree-1248';
const HEAD = 'a'.repeat(40);

function workspaceRunner() {
  return vi.fn((_command: string, args: readonly string[]) => {
    const operation = `${args[0] ?? ''} ${args[1] ?? ''}`;
    const payload = operation === 'worktree show'
      ? {
          ok: true,
          result: {
            worktree: {
              id: 'worktree-1248',
              path: WORKSPACE,
              head: HEAD,
            },
          },
        }
      : operation === 'worktree rm'
        ? { ok: true, result: { removed: true } }
        : { ok: false, error: { code: 'unexpected_operation', message: operation } };
    return { stdout: JSON.stringify(payload), stderr: '', status: 0 };
  });
}

function terminal(
  handle: string,
  generation: string,
  workspacePath = WORKSPACE,
  title = 'owned',
): OrcaTerminalSummary {
  return {
    handle,
    incarnationId: generation,
    title,
    worktreePath: workspacePath,
    status: 'running',
  };
}

describe('Orca task adapter destructive operations', () => {
  it('prevalidates exact path and head before one remove', () => {
    const runner = workspaceRunner();
    const adapter = new OrcaTaskRuntimeAdapter({ runner: runner as never });
    const result = adapter.removeWorkspace({
      workspacePath: WORKSPACE,
      expectedHeadSha: HEAD,
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
      workspacePath: WORKSPACE,
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
            head: HEAD,
          },
        },
      }),
      stderr: '', status: 0,
    }));
    const adapter = new OrcaTaskRuntimeAdapter({ runner: runner as never });
    const result = adapter.removeWorkspace({
      workspacePath: WORKSPACE,
      expectedHeadSha: HEAD,
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
    const observed = terminal(handle, generation);
    const runJson = vi.fn((args: readonly string[]): OrcaJsonResponse => {
      const operation = `${args[0] ?? ''} ${args[1] ?? ''}`;
      switch (operation) {
        case 'terminal create':
          return { ok: true, result: { terminal: { handle, incarnationId: generation, title: 'owned' } } };
        case 'worktree current':
          return { ok: true, result: { worktree: { path: WORKSPACE, head: HEAD } } };
        case 'terminal show':
          return { ok: true, result: { terminal: observed } };
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
    const observed = terminal(handle, generation);
    const runJson = vi.fn((args: readonly string[]): OrcaJsonResponse => {
      const operation = `${args[0] ?? ''} ${args[1] ?? ''}`;
      switch (operation) {
        case 'terminal create':
          return { ok: true, result: { terminal: { handle, incarnationId: generation, title: 'owned' } } };
        case 'worktree current':
          return { ok: true, result: { worktree: { path: WORKSPACE, head: HEAD } } };
        case 'terminal show':
          return { ok: true, result: { terminal: observed } };
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
    const observed = terminal(handle, generation);
    const calls: string[][] = [];
    const runJson = vi.fn((args: readonly string[]): OrcaJsonResponse => {
      calls.push([...args]);
      const operation = `${args[0] ?? ''} ${args[1] ?? ''}`;
      switch (operation) {
        case 'terminal create':
          return { ok: true, result: { terminal: { handle, incarnationId: generation, title: 'owned' } } };
        case 'worktree current':
          return { ok: true, result: { worktree: { path: WORKSPACE, head: HEAD } } };
        case 'terminal show':
          return { ok: true, result: { terminal: observed } };
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
    expect(calls.filter((args) => args[0] === 'terminal' && args[1] === 'send')).toHaveLength(1);
    const operations = calls.map((args) => `${args[0] ?? ''} ${args[1] ?? ''}`);
    const sendIndex = operations.indexOf('terminal send');
    expect(operations[sendIndex - 1]).toBe('terminal show');
    expect(calls.filter((args) => args[0] === 'terminal' && args[1] === 'close')).toHaveLength(0);
  });
});

describe('Orca exact generation authority', () => {
  it.each([
    {
      name: 'create generation already matches',
      createGeneration: 'stable-generation',
      exactGeneration: 'stable-generation',
      exactTitle: 'owned',
    },
    {
      name: 'create generation is provisional and differs',
      createGeneration: 'create-generation',
      exactGeneration: 'stable-generation',
      exactTitle: 'renamed-after-create',
    },
    {
      name: 'create omits generation while a list hit would disagree',
      createGeneration: null,
      exactGeneration: 'stable-generation',
      exactTitle: 'owned',
    },
    {
      name: 'create omits generation while a list would miss',
      createGeneration: null,
      exactGeneration: 'stable-generation',
      exactTitle: 'renamed-after-create',
    },
  ])('freezes exact terminal-show identity: $name', ({
    createGeneration,
    exactGeneration,
    exactTitle,
  }) => {
    const handle = 'matrix-terminal';
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
        return { ok: true, result: { worktree: { path: WORKSPACE, head: HEAD } } };
      }
      if (operation === 'terminal show') {
        return {
          ok: true,
          result: { terminal: terminal(handle, exactGeneration, WORKSPACE, exactTitle) },
        };
      }
      if (operation === 'terminal list') {
        return createGeneration === null && exactTitle === 'owned'
          ? {
              ok: true,
              result: { terminals: [terminal(handle, 'conflicting-list-generation')] },
            }
          : { ok: true, result: { terminals: [] } };
      }
      return { ok: false, error: { code: 'unexpected_operation', message: operation } };
    });
    const adapter = new OrcaTaskRuntimeAdapter({ runJson: runJson as never });

    const spawned = adapter.spawnWorker({ title: 'owned', command: 'cursor-agent' });

    expect(spawned).toMatchObject({
      status: 'ok',
      value: {
        identity: { runtime: 'orca', id: handle, generation: exactGeneration },
        workspacePath: WORKSPACE,
      },
    });
    expect(calls.filter((args) => args[0] === 'terminal' && args[1] === 'show')).toHaveLength(1);
    expect(calls.filter((args) => args[0] === 'terminal' && args[1] === 'list')).toHaveLength(0);
    expect(calls.map((args) => `${args[0] ?? ''} ${args[1] ?? ''}`)).toEqual([
      'terminal create',
      'worktree current',
      'terminal show',
    ]);
  });

  it.each([
    {
      name: 'replacement generation',
      second: terminal('frozen-terminal', 'replacement-generation'),
      reason: 'worker_generation_mismatch',
    },
    {
      name: 'wrong worktree',
      second: terminal('frozen-terminal', 'frozen-generation', '/tmp/foreign-worktree'),
      reason: 'worker_workspace_mismatch',
    },
  ])('fails before payload send for $name', ({ second, reason }) => {
    const handle = 'frozen-terminal';
    const generation = 'frozen-generation';
    let showCalls = 0;
    let sendCalls = 0;
    const calls: string[][] = [];
    const runJson = vi.fn((args: readonly string[]): OrcaJsonResponse => {
      calls.push([...args]);
      const operation = `${args[0] ?? ''} ${args[1] ?? ''}`;
      if (operation === 'terminal create') {
        return { ok: true, result: { terminal: { handle, incarnationId: generation, title: 'owned' } } };
      }
      if (operation === 'worktree current') {
        return { ok: true, result: { worktree: { path: WORKSPACE, head: HEAD } } };
      }
      if (operation === 'terminal show') {
        showCalls += 1;
        return {
          ok: true,
          result: { terminal: showCalls === 1 ? terminal(handle, generation) : second },
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

    const result = adapter.dispatchInput({ worker: spawned.value.identity, text: 'must not send' });
    expect(result.status).toBe('send_failed');
    if (result.status === 'send_failed') {
      expect(result.reason).toContain(reason);
      expect(result.reason).toContain(`expected_handle=${handle}`);
      expect(result.reason).toContain(`expected_generation=${generation}`);
      expect(result.reason).toContain('identity_source=orca_terminal_show');
      expect(result.reason).toContain('resolution=');
    }
    expect(sendCalls).toBe(0);
  });

  it('keeps exact-show failure unresolved and sends zero payload bytes', () => {
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
        return { ok: true, result: { worktree: { path: WORKSPACE, head: HEAD } } };
      }
      if (operation === 'terminal show') {
        showCalls += 1;
        if (showCalls === 1) return { ok: true, result: { terminal: terminal(handle, generation) } };
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

    const result = adapter.dispatchInput({ worker: spawned.value.identity, text: 'must not send' });
    expect(result.status).toBe('send_failed');
    if (result.status === 'send_failed') {
      expect(result.reason).toContain('worker_generation_unresolved');
      expect(result.reason).toContain(`expected_handle=${handle}`);
      expect(result.reason).toContain(`expected_generation=${generation}`);
      expect(result.reason).toContain('observed_generation=unresolved');
      expect(result.reason).toContain('lookup_failure=terminal_show%3Aruntime_operation_failed');
    }
    expect(sendCalls).toBe(0);
  });

  it('re-observes exact frozen identity immediately before one full-payload send', () => {
    const handle = 'ordered-terminal';
    const generation = 'ordered-generation';
    const calls: string[][] = [];
    const runJson = vi.fn((args: readonly string[]): OrcaJsonResponse => {
      calls.push([...args]);
      const operation = `${args[0] ?? ''} ${args[1] ?? ''}`;
      if (operation === 'terminal create') {
        return { ok: true, result: { terminal: { handle, incarnationId: 'provisional-generation', title: 'owned' } } };
      }
      if (operation === 'worktree current') {
        return { ok: true, result: { worktree: { path: WORKSPACE, head: HEAD } } };
      }
      if (operation === 'terminal show') {
        return { ok: true, result: { terminal: terminal(handle, generation, WORKSPACE, 'renamed') } };
      }
      if (operation === 'terminal list') {
        return { ok: true, result: { terminals: [] } };
      }
      if (operation === 'terminal send') return { ok: true, result: { sent: true } };
      return { ok: false, error: { code: 'unexpected_operation', message: operation } };
    });
    const adapter = new OrcaTaskRuntimeAdapter({ runJson: runJson as never });
    const spawned = adapter.spawnWorker({ title: 'owned', command: 'cursor-agent' });
    expect(spawned.status).toBe('ok');
    if (spawned.status !== 'ok') return;

    expect(adapter.dispatchInput({ worker: spawned.value.identity, text: 'payload' }))
      .toEqual({ status: 'dispatched' });

    const operations = calls.map((args) => `${args[0] ?? ''} ${args[1] ?? ''}`);
    const sendIndex = operations.indexOf('terminal send');
    expect(operations[sendIndex - 1]).toBe('terminal show');
    expect(calls[sendIndex]).toContain('--text');
    expect(calls[sendIndex]).toContain('payload');
    expect(operations.filter((value) => value === 'terminal list')).toHaveLength(0);
    expect(operations.filter((value) => value === 'terminal send')).toHaveLength(1);
  });
});
