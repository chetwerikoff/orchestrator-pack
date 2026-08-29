// @vitest-ci-lane light
// @vitest-pre-topology-seconds 120
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DeterministicRuntimeAdapter } from '../runtime/test-adapter.ts';
import { executeRuntimeTaskLifecycle } from '../runtime/task-lifecycle.ts';
import type { OrcaJsonResponse } from './native.ts';
import { OrcaRuntimeAdapter } from './adapter.ts';
import { OrcaTaskRuntimeAdapter } from './task-adapter.ts';

// Producer-backed fixture contract, pinned to stablyai/orca@
// f5fd7303ab00bcfeff72c92f2bc33ba9364cd622:
// - orchestration-worker-control.ts emits `live` and normalizes legacy `running` to it;
// - lifecycle-reconciliation.ts authorizes the exact assignee before recordHeartbeat;
// - dispatch-completion.ts writes heartbeat only while status='dispatched';
// - coordinator-task-dispatch.ts declares 10 minutes as two heartbeat intervals;
// - worker-show does not emit observation.status='gone': an absent local Dispatch
//   is the supported `dispatch_not_found` error `Worker Dispatch <id> was not found.`;
// - the federated no-worker-record path deliberately reuses that error code with a
//   different message and is not local Dispatch-absence authority.
// The timestamp below uses Orca's SQLite datetime('now') storage shape rather
// than a hand-invented worker-show timestamp format.
function currentOrcaHeartbeat(ageMs = 60_000): string {
  return new Date(Date.now() - ageMs).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/u, '');
}

function producerBackedActiveWorkerShow(observationStatus: 'live' | 'running' = 'live') {
  return {
    dispatch: {
      status: 'dispatched',
      last_heartbeat_at: currentOrcaHeartbeat(),
    },
    worker: {
      agent_terminal_handle: 'term-active',
      worktree_id: 'repo::active',
      state: 'ready',
      stage: 'input_accepted',
    },
    terminal: { handle: 'term-active' },
    observation: { exactWorker: true, status: observationStatus },
  } as const;
}

describe('Orca async transport envelope classification', () => {
  it('classifies a non-zero child exit with an error envelope as a runtime response', async () => {
    const directory = mkdtempSync(join(process.cwd(), '.tmp-orca-async-envelope-'));
    const executable = join(directory, 'orca-fixture.mjs');
    const envelope = JSON.stringify({
      ok: false,
      error: { code: 'runtime_error', message: 'supported operation failed' },
    });
    writeFileSync(
      executable,
      `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(envelope)});\nprocess.exitCode = 1;\n`,
    );
    chmodSync(executable, 0o755);

    try {
      const result = await new OrcaRuntimeAdapter({ executable }).listWorkersAsync();
      expect(result).toEqual({
        status: 'failed',
        operation: 'list_workers',
        reason: 'runtime_operation_failed',
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

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

describe('Orca task adapter exact spawn identity', () => {
  it('reads back the exact incarnation before task-edge child output observation', () => {
    const handle = 'term-carriage-witness';
    const ptyGeneration = '/tmp/opk-1706-carriage@@pty-generation';
    const exactGeneration = 'incarnation-carriage-generation';
    const workspacePath = '/tmp/opk-1706-carriage';
    const terminal = {
      handle,
      incarnationId: exactGeneration,
      worktreePath: workspacePath,
      title: 'carriage-witness',
      status: 'running' as const,
    };
    const operations: string[] = [];
    const runJson = vi.fn((args: readonly string[]): OrcaJsonResponse => {
      const operation = String(args[0] ?? '') + ' ' + String(args[1] ?? '');
      operations.push(operation);
      switch (operation) {
        case 'terminal create':
          return { ok: true, result: { terminal: { handle, ptyId: ptyGeneration, title: terminal.title } } };
        case 'terminal show':
          return { ok: true, result: { terminal } };
        case 'terminal list':
          return { ok: true, result: { totalCount: 1, truncated: false, terminals: [terminal] } };
        case 'terminal read':
          return { ok: true, result: { terminal: { handle, status: 'running', tail: ['TASK_EDGE_SENTINEL'], nextCursor: '1' } } };
        case 'terminal close':
          return { ok: true, result: { closed: true } };
        default:
          return { ok: false, error: { code: 'unexpected_operation', message: operation } };
      }
    });
    const adapter = new OrcaTaskRuntimeAdapter({ runJson: runJson as never });

    const spawned = adapter.spawnWorker({ title: 'carriage-witness', command: 'node witness', workspace: 'active' });
    expect(spawned.status).toBe('ok');
    if (spawned.status !== 'ok') return;
    expect(spawned.value.identity.generation).toBe(exactGeneration);
    expect(spawned.value.provenance).toBe('internal');

    const read = adapter.readBoundedOutput({ worker: spawned.value.identity, limit: 200 });
    expect(read.status).toBe('ok');
    if (read.status !== 'ok') return;
    expect(read.value.lines.join('\n')).toContain('TASK_EDGE_SENTINEL');

    expect(adapter.stopWorker(spawned.value.identity).status).toBe('ok');
    const createIndex = operations.indexOf('terminal create');
    expect(createIndex).toBeGreaterThanOrEqual(0);
    const showIndex = operations.indexOf('terminal show');
    expect(showIndex).toBeGreaterThan(createIndex);
    expect(operations.slice(createIndex + 1, showIndex)).not.toContain('terminal read');
  });
});

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
              totalCount: 1,
              truncated: false,
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

  it('does not retry an explicit runtime_error rejection', () => {
    const handle = 'rejected-terminal';
    const generation = 'rejected-generation';
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
              totalCount: 1,
              truncated: false,
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
            error: { code: 'runtime_error', message: 'explicit rejection' },
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
              totalCount: 1,
              truncated: false,
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

describe('Orca assignment resolution', () => {
  it.each(['live', 'running'] as const)(
    'accepts exact %s Dispatch only with the pinned producer-backed active contract',
    (observationStatus) => {
      const runJson = vi.fn((args: readonly string[]): OrcaJsonResponse => {
        const operation = `${args[0] ?? ''} ${args[1] ?? ''}`;
        if (operation === 'orchestration worker-show') {
          return { ok: true, result: producerBackedActiveWorkerShow(observationStatus) };
        }
        if (operation === 'terminal show') {
          return {
            ok: true,
            result: {
              terminal: {
                handle: 'term-active',
                incarnationId: 'generation-active',
                worktreePath: '/tmp/worktree-active',
                title: 'active worker',
                status: 'running',
              },
            },
          };
        }
        return { ok: false, error: { code: 'unexpected_operation', message: operation } };
      });
      const adapter = new OrcaTaskRuntimeAdapter({ runJson: runJson as never });

      expect(adapter.resolveAssignmentWorker({ provider: 'orca', bindingKey: 'dispatch-active' })).toEqual({
        status: 'ok',
        value: {
          kind: 'resolved',
          worker: {
            identity: { runtime: 'orca', id: 'term-active', generation: 'generation-active' },
            workspacePath: '/tmp/worktree-active',
            title: 'active worker',
            provenance: 'internal',
          },
        },
      });
      expect(runJson.mock.calls.map((call) => call[0]?.slice(0, 2))).toEqual([
        ['orchestration', 'worker-show'],
        ['terminal', 'show'],
      ]);
    },
  );

  it.each([
    ['stale', currentOrcaHeartbeat(10 * 60 * 1_000 + 5_000)],
    ['malformed', 'not-an-orca-timestamp'],
  ] as const)('rejects %s heartbeat as activity authority', (_label, heartbeat) => {
    const runJson = vi.fn((): OrcaJsonResponse => ({
      ok: true,
      result: {
        ...producerBackedActiveWorkerShow(),
        dispatch: { status: 'dispatched', last_heartbeat_at: heartbeat },
      },
    }));
    const adapter = new OrcaTaskRuntimeAdapter({ runJson: runJson as never });

    expect(adapter.resolveAssignmentWorker({ provider: 'orca', bindingKey: 'dispatch-heartbeat-invalid' })).toEqual({
      status: 'failed',
      operation: 'resolve_assignment_worker',
      reason: 'assignment_target_unresolved',
    });
    expect(runJson).toHaveBeenCalledTimes(1);
  });

  it('rejects ready + input_accepted with no heartbeat because prompt acceptance is not activity proof', () => {
    const runJson = vi.fn((): OrcaJsonResponse => ({
      ok: true,
      result: {
        dispatch: { status: 'dispatched', last_heartbeat_at: null },
        worker: {
          agent_terminal_handle: 'term-never-started',
          state: 'ready',
          stage: 'input_accepted',
        },
        terminal: { handle: 'term-never-started' },
        observation: { exactWorker: true, status: 'live' },
      },
    }));
    const adapter = new OrcaTaskRuntimeAdapter({ runJson: runJson as never });

    expect(adapter.resolveAssignmentWorker({ provider: 'orca', bindingKey: 'dispatch-never-started' })).toEqual({
      status: 'failed',
      operation: 'resolve_assignment_worker',
      reason: 'assignment_target_unresolved',
    });
    expect(runJson).toHaveBeenCalledTimes(1);
  });

  it('freezes the captured running + succeeded + settled lifecycle as inactive, never gone', () => {
    const runJson = vi.fn((): OrcaJsonResponse => ({
      ok: true,
      result: {
        worker: {
          agent_terminal_handle: 'term-settled',
          worktree_id: 'repo::settled',
          state: 'succeeded',
          stage: 'settled',
        },
        terminal: { handle: 'term-settled' },
        observation: { exactWorker: true, status: 'running' },
      },
    }));
    const adapter = new OrcaTaskRuntimeAdapter({ runJson: runJson as never });

    expect(adapter.resolveAssignmentWorker({ provider: 'orca', bindingKey: 'dispatch-settled' })).toEqual({
      status: 'failed',
      operation: 'resolve_assignment_worker',
      reason: 'assignment_target_inactive',
    });
    expect(runJson).toHaveBeenCalledTimes(1);
  });

  it('rejects invented gone plus dispatched heartbeat instead of treating it as producer absence', () => {
    const runJson = vi.fn((): OrcaJsonResponse => ({
      ok: true,
      result: {
        dispatch: { status: 'dispatched', last_heartbeat_at: currentOrcaHeartbeat() },
        worker: {
          agent_terminal_handle: 'term-contradictory',
          state: 'succeeded',
          stage: 'settled',
        },
        observation: { exactWorker: true, status: 'gone' },
      },
    }));
    const adapter = new OrcaTaskRuntimeAdapter({ runJson: runJson as never });

    expect(adapter.resolveAssignmentWorker({ provider: 'orca', bindingKey: 'dispatch-contradictory' })).toEqual({
      status: 'failed',
      operation: 'resolve_assignment_worker',
      reason: 'assignment_target_unresolved',
    });
  });

  it('fails closed on malformed lifecycle fields instead of granting absence', () => {
    const runJson = vi.fn((): OrcaJsonResponse => ({
      ok: true,
      result: {
        worker: { agent_terminal_handle: 'term-malformed', state: 7 },
        observation: { exactWorker: true, status: 'gone' },
      },
    } as unknown as OrcaJsonResponse));
    const adapter = new OrcaTaskRuntimeAdapter({ runJson: runJson as never });

    expect(adapter.resolveAssignmentWorker({ provider: 'orca', bindingKey: 'dispatch-malformed' })).toEqual({
      status: 'failed',
      operation: 'resolve_assignment_worker',
      reason: 'assignment_target_unresolved',
    });
  });

  it('maps only the pinned local dispatch_not_found producer envelope to logical gone', () => {
    const runJson = vi.fn((args: readonly string[]): OrcaJsonResponse => {
      expect(args).toEqual(['orchestration', 'worker-show', '--dispatch', 'dispatch-1']);
      return {
        ok: false,
        outcomeCategory: 'supported_operation_failure',
        error: {
          code: 'dispatch_not_found',
          message: 'Worker Dispatch dispatch-1 was not found.',
        },
      };
    });
    const adapter = new OrcaTaskRuntimeAdapter({ runJson: runJson as never });
    expect(adapter.resolveAssignmentWorker({ provider: 'orca', bindingKey: 'dispatch-1' })).toEqual({
      status: 'ok',
      value: { kind: 'gone' },
    });
  });

  it('does not grant absence for federated no-worker-record dispatch_not_found', () => {
    const runJson = vi.fn((): OrcaJsonResponse => ({
      ok: false,
      outcomeCategory: 'supported_operation_failure',
      error: {
        code: 'dispatch_not_found',
        message: 'Federated Worker Dispatch dispatch-1 has no worker record.',
      },
    }));
    const adapter = new OrcaTaskRuntimeAdapter({ runJson: runJson as never });
    expect(adapter.resolveAssignmentWorker({ provider: 'orca', bindingKey: 'dispatch-1' })).toEqual({
      status: 'failed',
      operation: 'resolve_assignment_worker',
      reason: 'runtime_operation_failed',
    });
  });

  it('classifies an exact exited target as gone after its terminal is released', () => {
    const runJson = vi.fn((args: readonly string[]): OrcaJsonResponse => {
      if (args[0] === 'terminal' && args[1] === 'show') {
        return {
          ok: true,
          result: {
            terminal: {
              handle: 'term-owned',
              incarnationId: 'generation-1',
              worktreePath: '/tmp/worktree',
            },
          },
        };
      }
      expect(args).toEqual(['orchestration', 'worker-show', '--dispatch', 'dispatch-1']);
      return {
        ok: true,
        result: {
          worker: { agent_terminal_handle: 'term-owned' },
          terminal: null,
          observation: { exactWorker: true, status: 'exited' },
          terminalResource: {
            terminalHandle: 'term-owned',
            worktreeId: 'repo::worktree',
            originDispatchId: 'dispatch-1',
            ownerDispatchId: 'dispatch-1',
            releaseState: 'released',
          },
        },
      };
    });
    const adapter = new OrcaTaskRuntimeAdapter({ runJson: runJson as never });
    expect(adapter.resolveAssignmentWorker({ provider: 'orca', bindingKey: 'dispatch-1' })).toEqual({
      status: 'ok',
      value: { kind: 'gone', workerId: 'term-owned' },
    });
  });

  it('classifies an exact exited target as inactive while its terminal remains owned', () => {
    const runJson = vi.fn((args: readonly string[]): OrcaJsonResponse => {
      if (args[0] === 'terminal' && args[1] === 'show') {
        return {
          ok: true,
          result: {
            terminal: {
              handle: 'term-owned',
              incarnationId: 'generation-1',
              worktreePath: '/tmp/worktree',
            },
          },
        };
      }
      expect(args).toEqual(['orchestration', 'worker-show', '--dispatch', 'dispatch-1']);
      return {
        ok: true,
        result: {
          worker: { agent_terminal_handle: 'term-owned' },
          terminal: null,
          observation: { exactWorker: true, status: 'exited' },
          terminalResource: {
            terminalHandle: 'term-owned',
            worktreeId: 'repo::worktree',
            originDispatchId: 'dispatch-1',
            ownerDispatchId: 'dispatch-1',
            releaseState: ' RELEASED ',
          },
        },
      };
    });
    const adapter = new OrcaTaskRuntimeAdapter({ runJson: runJson as never });
    expect(adapter.resolveAssignmentWorker({ provider: 'orca', bindingKey: 'dispatch-1' })).toEqual({
      status: 'failed',
      operation: 'resolve_assignment_worker',
      reason: 'assignment_target_inactive',
    });
  });

  it('does not reinterpret invented gone when exactWorker is not true', () => {
    const runJson = vi.fn((): OrcaJsonResponse => ({
      ok: true,
      result: {
        worker: { agent_terminal_handle: 'term-owned' },
        observation: { exactWorker: false, status: 'gone' },
      },
    }));
    const adapter = new OrcaTaskRuntimeAdapter({ runJson: runJson as never });
    expect(adapter.resolveAssignmentWorker({ provider: 'orca', bindingKey: 'dispatch-1' })).toEqual({
      status: 'failed',
      operation: 'resolve_assignment_worker',
      reason: 'assignment_target_unresolved',
    });
  });

  it.each([undefined, '', 'unknown', 'unverifiable', 'ambiguous'])(
    'fails closed on missing/ambiguous exact observation status %s',
    (status) => {
      const runJson = vi.fn((): OrcaJsonResponse => ({
        ok: true,
        result: {
          worker: { agent_terminal_handle: 'term-owned' },
          terminal: { handle: 'term-owned' },
          observation: { exactWorker: true, ...(status === undefined ? {} : { status }) },
        },
      }));
      const adapter = new OrcaTaskRuntimeAdapter({ runJson: runJson as never });
      expect(adapter.resolveAssignmentWorker({ provider: 'orca', bindingKey: 'dispatch-1' })).toEqual({
        status: 'failed',
        operation: 'resolve_assignment_worker',
        reason: 'assignment_target_unresolved',
      });
    },
  );

  it('requires a terminal handle on an exact active observation', () => {
    const runJson = vi.fn((): OrcaJsonResponse => ({
      ok: true,
      result: {
        dispatch: {
          status: 'dispatched',
          last_heartbeat_at: currentOrcaHeartbeat(),
        },
        worker: {
          agent_terminal_handle: null,
          state: 'ready',
          stage: 'input_accepted',
        },
        terminal: null,
        observation: { exactWorker: true, status: 'live' },
      },
    }));
    const adapter = new OrcaTaskRuntimeAdapter({ runJson: runJson as never });
    expect(adapter.resolveAssignmentWorker({ provider: 'orca', bindingKey: 'dispatch-1' })).toEqual({
      status: 'failed',
      operation: 'resolve_assignment_worker',
      reason: 'assignment_target_unresolved',
    });
  });

  it('preserves worker-show transport/runtime failure as unresolved failure, never gone', () => {
    const runJson = vi.fn((): OrcaJsonResponse => ({
      ok: false,
      outcomeCategory: 'empty_stdout',
      error: { code: 'empty_stdout', message: 'no receipt' },
    }));
    const adapter = new OrcaTaskRuntimeAdapter({ runJson: runJson as never });
    expect(adapter.resolveAssignmentWorker({ provider: 'orca', bindingKey: 'dispatch-1' })).toMatchObject({
      status: 'failed',
      operation: 'resolve_assignment_worker',
    });
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
      return { ok: false, error: { code: 'unexpected_effect', message: operation } };
    });
    const adapter = new OrcaTaskRuntimeAdapter({ runJson: runJson as never });
    expect(adapter.resolveAssignmentWorker({ provider: 'orca', bindingKey: 'dispatch-1441' })).toEqual({
      status: 'failed',
      operation: 'resolve_assignment_worker',
      reason: 'assignment_target_unresolved',
    });
    expect(runJson).toHaveBeenCalledTimes(1);
    expect(runJson.mock.calls[0]?.[0]).toEqual(['orchestration','worker-show','--dispatch','dispatch-1441']);
  });
});

describe('Issue #1489 rendered screen observation', () => {
  it('accepts a cursorless screen frame and preserves its source witness', () => {
    const runJson = vi.fn((args: readonly string[]): OrcaJsonResponse => {
      if (args[0] === 'terminal' && args[1] === 'show') return {
        ok: true,
        result: { terminal: { handle: 'screen-terminal', incarnationId: 'screen-generation', worktreePath: '/tmp/screen', status: 'running' } },
      };
      return {
        ok: true,
        result: { terminal: { handle: 'screen-terminal', status: 'running', tail: ['visible'], nextCursor: null, source: 'screen' } },
      };
    });
    const adapter = new OrcaRuntimeAdapter({ runJson: runJson as never });
    const result = adapter.readBoundedOutput({
      worker: { runtime: 'orca', id: 'screen-terminal', generation: 'screen-generation' },
      screen: true,
    });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.value.source).toBe('screen');
      expect(result.value.lines).toEqual(['visible']);
    }
  });

  it('omits --cursor when paging from a synthetic screen-frame observation token', () => {
    let readCount = 0;
    const runJson = vi.fn((args: readonly string[]): OrcaJsonResponse => {
      if (args[0] === 'terminal' && args[1] === 'show') return {
        ok: true,
        result: { terminal: { handle: 'screen-terminal', incarnationId: 'screen-generation', worktreePath: '/tmp/screen', status: 'running' } },
      };
      if (args[0] === 'terminal' && args[1] === 'list') return {
        ok: true,
        result: { terminals: [{ handle: 'screen-terminal', incarnationId: 'screen-generation', worktreePath: '/tmp/screen', title: 'screen' }], totalCount: 1, truncated: false },
      };
      if (args[0] === 'terminal' && args[1] === 'read') {
        readCount += 1;
        expect(args).not.toContain('--cursor');
        return {
          ok: true,
          result: { terminal: { handle: 'screen-terminal', status: 'running', tail: [`frame-${readCount}`], nextCursor: null, source: 'screen' } },
        };
      }
      return { ok: false, error: { code: 'unexpected_effect', message: args.join(' ') } };
    });
    const adapter = new OrcaRuntimeAdapter({ runJson: runJson as never });
    const worker = { runtime: 'orca' as const, id: 'screen-terminal', generation: 'screen-generation' };
    const first = adapter.readBoundedOutput({ worker, limit: 200 });
    expect(first.status).toBe('ok');
    if (first.status !== 'ok') return;
    const second = adapter.readBoundedOutput({ worker, previousToken: first.value.observationToken, limit: 200 });
    expect(second.status).toBe('ok');
    expect(readCount).toBe(2);
  });


  it('uses the async all-workspace census and concurrent screen seam', async () => {
    const runJsonAsync = vi.fn(async (args: readonly string[]): Promise<OrcaJsonResponse> => {
      if (args[0] === 'terminal' && args[1] === 'list') return {
        ok: true,
        result: {
          terminals: [
            { handle: 'async-a', incarnationId: 'generation-a', worktreePath: '/tmp/a', title: 'a' },
            { handle: 'async-b', incarnationId: 'generation-b', worktreePath: '/tmp/b', title: 'b' },
          ],
        },
      };
      if (args[0] === 'terminal' && args[1] === 'show') return {
        ok: true,
        result: { terminal: { handle: args[3], incarnationId: args[3] === 'async-a' ? 'generation-a' : 'generation-b', worktreePath: args[3] === 'async-a' ? '/tmp/a' : '/tmp/b' } },
      };
      return {
        ok: true,
        result: { terminal: { handle: args[3], status: 'running', tail: ['visible'], nextCursor: null, source: 'screen' } },
      };
    });
    const adapter = new OrcaRuntimeAdapter({ runJsonAsync: runJsonAsync as never });
    const listed = await adapter.listWorkersAsync?.();
    expect(listed?.status).toBe('ok');
    expect(runJsonAsync.mock.calls[0]?.[0]).toEqual(['terminal', 'list']);
    const result = await adapter.readBoundedOutputAsync?.({
      worker: { runtime: 'orca', id: 'async-a', generation: 'generation-a' },
      screen: true,
    });
    expect(result?.status).toBe('ok');
    expect(runJsonAsync.mock.calls.map(([args]) => args)).toEqual([
      ['terminal', 'list'],
      ['terminal', 'show', '--terminal', 'async-a'],
      ['terminal', 'read', '--terminal', 'async-a', '--screen'],
    ]);
  });

  it('requests --screen and rejects a stream fallback', () => {
    const runJson = vi.fn((args: readonly string[]): OrcaJsonResponse => {
      if (args[0] === 'terminal' && args[1] === 'show') return {
        ok: true,
        result: { terminal: { handle: 'screen-terminal', incarnationId: 'screen-generation', worktreePath: '/tmp/screen', status: 'running' } },
      };
      if (args[0] === 'terminal' && args[1] === 'read') return {
        ok: true,
        result: { terminal: { handle: 'screen-terminal', status: 'running', tail: ['visible'], nextCursor: 'cursor-1', source: 'stream' } },
      };
      return { ok: false, error: { code: 'unexpected_effect', message: args.join(' ') } };
    });
    const adapter = new OrcaRuntimeAdapter({ runJson: runJson as never });
    const result = adapter.readBoundedOutput({
      worker: { runtime: 'orca', id: 'screen-terminal', generation: 'screen-generation' },
      screen: true,
    });
    expect(result).toEqual({ status: 'unsupported', operation: 'read_bounded_output', reason: 'runtime_output_source_unobservable' });
    expect(runJson.mock.calls.find((call) => call[0]?.[1] === 'read')?.[0]).toEqual([
      'terminal', 'read', '--terminal', 'screen-terminal', '--screen',
    ]);
  });
});

describe('Issue #1441 stale/reused runtime identity', () => {
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
      return { ok: false, error: { code: 'unexpected_effect', message: operation } };
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
});

describe('Issue #1587 accepted terminal-send evidence', () => {
  it('separates accepted write-only and submit-only witnesses from delivery success', () => {
    const runJson = vi.fn((args: readonly string[]): OrcaJsonResponse => {
      const operation = `${args[0] ?? ''} ${args[1] ?? ''}`;
      if (operation === 'terminal show') {
        return {
          ok: true,
          result: {
            terminal: {
              handle: 'busy-agent',
              incarnationId: 'generation-1587',
              worktreePath: '/tmp/worktree-1587',
              title: 'busy-agent',
              status: 'running',
            },
          },
        };
      }
      if (operation === 'terminal list') {
        return {
          ok: true,
          result: {
            terminals: [{
              handle: 'busy-agent',
              incarnationId: 'generation-1587',
              worktreePath: '/tmp/worktree-1587',
              title: 'busy-agent',
              status: 'running',
            }],
            totalCount: 1,
            truncated: false,
          },
        };
      }
      if (operation === 'terminal send') {
        return { ok: true, result: { send: { accepted: true } } };
      }
      return { ok: false, error: { code: 'unexpected_operation', message: operation } };
    });
    const adapter = new OrcaRuntimeAdapter({ runJson: runJson as never });
    const worker = { runtime: 'orca', id: 'busy-agent', generation: 'generation-1587' } as const;

    expect(adapter.dispatchInput({ worker, text: 'exact pointer', writeOnly: true })).toEqual({
      status: 'dispatch_unknown',
      reason: 'submit_witness_unavailable',
      witness: { operation: 'write', accepted: true, source: 'runtime-response' },
    });
    expect(adapter.dispatchInput({ worker, submitOnly: true })).toEqual({
      status: 'dispatched',
      witness: { operation: 'submit', accepted: true, source: 'runtime-response' },
    });
    expect(runJson.mock.calls.filter((call) => call[0]?.[1] === 'send').map((call) => call[0])).toEqual([
      ['terminal', 'send', '--terminal', 'busy-agent', '--text', 'exact pointer'],
      ['terminal', 'send', '--terminal', 'busy-agent', '--enter'],
    ]);
  });
});

type ClosePresence = 'present' | 'absent' | 'mismatch' | 'unavailable' | 'truncated' | 'duplicate';

function boundedCloseFixture(input: {
  readonly closeResponses: readonly OrcaJsonResponse[];
  readonly presence: readonly ClosePresence[];
}) {
  const handle = 'retry-terminal';
  const generation = 'retry-generation';
  let closeCount = 0;
  let presenceCount = 0;
  let lastPresence: ClosePresence = 'absent';
  const runJson = vi.fn((args: readonly string[]): OrcaJsonResponse => {
    const operation = `${args[0] ?? ''} ${args[1] ?? ''}`;
    if (operation === 'terminal create') {
      return {
        ok: true,
        result: { terminal: { handle, incarnationId: generation, title: 'owned' } },
      };
    }
    if (operation === 'worktree current') {
      return {
        ok: true,
        result: { worktree: { path: '/tmp/worktree-1248', head: 'a'.repeat(40) } },
      };
    }
    if (operation === 'terminal show') {
      if (lastPresence === 'mismatch') {
        return {
          ok: true,
          result: { terminal: { handle, incarnationId: 'other-generation', title: 'owned', worktreePath: '/tmp/worktree-1248' } },
        };
      }
      return { ok: false, error: { code: 'tab_not_found', message: 'tab_not_found' } };
    }
    if (operation === 'terminal list') {
      const state = input.presence[Math.min(presenceCount++, input.presence.length - 1)] ?? 'absent';
      lastPresence = state;
      if (state === 'unavailable') {
        return {
          ok: false,
          error: { code: 'inventory_unavailable', message: 'inventory unavailable' },
        };
      }
      if (state === 'absent') {
        return { ok: true, result: { terminals: [], totalCount: 0, truncated: false } };
      }
      if (state === 'truncated') {
        return { ok: true, result: { terminals: [], totalCount: 1, truncated: true } };
      }
      if (state === 'duplicate') {
        return {
          ok: true,
          result: {
            totalCount: 2,
            truncated: false,
            terminals: [
              { handle, incarnationId: generation, worktreeId: 'worktree-1248', worktreePath: '/tmp/worktree-1248', title: 'owned', status: 'running' },
              { handle, incarnationId: 'other-generation', worktreeId: 'worktree-1248', worktreePath: '/tmp/worktree-1248', title: 'replacement', status: 'running' },
            ],
          },
        };
      }
      return {
        ok: true,
        result: {
          totalCount: 1,
          truncated: false,
          terminals: [{
            handle,
            incarnationId: state === 'mismatch' ? 'other-generation' : generation,
            worktreeId: 'worktree-1248',
            worktreePath: '/tmp/worktree-1248',
            title: 'owned',
            status: 'running',
          }],
        },
      };
    }
    if (operation === 'terminal close') {
      return input.closeResponses[closeCount++]
        ?? { ok: false, error: { code: 'unexpected_close', message: 'unexpected close' } };
    }
    return { ok: false, error: { code: 'unexpected_operation', message: operation } };
  });
  const adapter = new OrcaTaskRuntimeAdapter({ runJson: runJson as never });
  const spawned = adapter.spawnWorker({ title: 'owned', command: 'cursor-agent' });
  if (spawned.status !== 'ok') throw new Error(`fixture spawn failed: ${spawned.reason}`);
  return {
    adapter,
    worker: spawned.value.identity,
    runJson,
    closeCalls: () => closeCount,
  };
}

describe('Orca task adapter bounded tab-not-found close retry', () => {
  const tabNotFound = (): OrcaJsonResponse => ({
    ok: false,
    error: { code: 'runtime_error', message: 'tab_not_found' },
  });

  it('retries once for an exact present identity and succeeds', () => {
    const fixture = boundedCloseFixture({
      closeResponses: [tabNotFound(), { ok: true, result: {} }],
      presence: ['present', 'present'],
    });

    expect(fixture.adapter.stopWorker(fixture.worker)).toEqual({
      status: 'ok',
      value: { stopped: true },
    });
    expect(fixture.closeCalls()).toBe(2);
    expect(fixture.runJson.mock.calls
      .filter((call) => call[0]?.[1] === 'close')
      .every((call) => call[0]?.at(-1) === fixture.worker.id)).toBe(true);
    expect(fixture.adapter.stopWorker(fixture.worker)).toEqual({
      status: 'failed',
      operation: 'stop_worker',
      reason: 'worker_not_owned_by_runtime_instance',
    });
  });

  it('accepts exact absence after the bounded retry fails', () => {
    const fixture = boundedCloseFixture({
      closeResponses: [tabNotFound(), {
        ok: false,
        error: { code: 'runtime_error', message: 'close_failed_again' },
      }],
      presence: ['present', 'present', 'present', 'absent'],
    });

    expect(fixture.adapter.stopWorker(fixture.worker)).toEqual({
      status: 'ok',
      value: { stopped: true },
    });
    expect(fixture.closeCalls()).toBe(2);
  });

  it('fails closed after the second close failure while the exact identity remains', () => {
    const fixture = boundedCloseFixture({
      closeResponses: [tabNotFound(), {
        ok: false,
        error: { code: 'runtime_error', message: 'close_failed_again' },
      }],
      presence: ['present', 'present', 'present'],
    });

    expect(fixture.adapter.stopWorker(fixture.worker)).toMatchObject({
      status: 'failed',
      operation: 'stop_worker',
      reason: 'runtime_operation_failed',
    });
    expect(fixture.closeCalls()).toBe(2);
    expect(fixture.adapter.stopWorker(fixture.worker)).toEqual({
      status: 'failed',
      operation: 'stop_worker',
      reason: 'worker_not_owned_by_runtime_instance',
    });
  });

  it('fails closed when post-error inventory is unavailable and does not retry', () => {
    const fixture = boundedCloseFixture({
      closeResponses: [tabNotFound()],
      presence: ['present', 'unavailable'],
    });

    expect(fixture.adapter.stopWorker(fixture.worker)).toMatchObject({
      status: 'failed',
      operation: 'stop_worker',
      reason: expect.stringContaining('unproven_already_absent;'),
    });
    expect(fixture.closeCalls()).toBe(1);
  });

  it('fails closed when post-error inventory contains duplicate handles', () => {
    const fixture = boundedCloseFixture({
      closeResponses: [tabNotFound()],
      presence: ['present', 'duplicate'],
    });

    expect(fixture.adapter.stopWorker(fixture.worker)).toMatchObject({
      status: 'failed',
      operation: 'stop_worker',
      reason: expect.stringContaining('worker_identity_ambiguous'),
    });
    expect(fixture.closeCalls()).toBe(1);
  });

  it('falls through to a complete absence census after the primary lookup is unavailable', () => {
    const fixture = boundedCloseFixture({
      closeResponses: [tabNotFound()],
      presence: ['present', 'unavailable', 'absent'],
    });

    expect(fixture.adapter.stopWorker(fixture.worker)).toEqual({
      status: 'ok',
      value: { stopped: true },
    });
    expect(fixture.closeCalls()).toBe(1);
  });

  it('fails closed when post-error inventory is truncated', () => {
    const fixture = boundedCloseFixture({
      closeResponses: [tabNotFound()],
      presence: ['present', 'truncated'],
    });

    expect(fixture.adapter.stopWorker(fixture.worker)).toMatchObject({
      status: 'failed',
      operation: 'stop_worker',
      reason: expect.stringContaining('runtime_worker_list_incomplete'),
    });
    expect(fixture.closeCalls()).toBe(1);
  });

  it('does not retry a different native error', () => {
    const fixture = boundedCloseFixture({
      closeResponses: [{
        ok: false,
        error: { code: 'runtime_error', message: 'permission_denied' },
      }],
      presence: ['present', 'present'],
    });

    expect(fixture.adapter.stopWorker(fixture.worker)).toMatchObject({
      status: 'failed',
      operation: 'stop_worker',
      reason: 'runtime_operation_failed',
    });
    expect(fixture.closeCalls()).toBe(1);
  });

  it('rejects a stale generation after the first close error without retrying', () => {
    const fixture = boundedCloseFixture({
      closeResponses: [tabNotFound()],
      presence: ['present', 'mismatch'],
    });

    expect(fixture.adapter.stopWorker(fixture.worker)).toMatchObject({
      status: 'failed',
      operation: 'stop_worker',
      reason: expect.stringContaining('worker_generation_mismatch'),
    });
    expect(fixture.closeCalls()).toBe(1);
  });
});


describe('Orca readiness path fallback', () => {
  const registered = {
    path: '/home/che/orca/workspaces/orchestrator-pack/wrk-ff-smoke-decl-path-skip',
    head: 'a'.repeat(40),
    linkedIssue: null,
  };

  it('does not call worktree show when worktree current succeeds', () => {
    const runJson = vi.fn((args: readonly string[]) => {
      const operation = `${args[0] ?? ''} ${args[1] ?? ''}`;
      if (operation === 'worktree current') {
        return { ok: true, result: { worktree: registered } };
      }
      return { ok: false, error: { code: 'unexpected_operation', message: operation } };
    });
    const adapter = new OrcaRuntimeAdapter({ runJson: runJson as never });
    expect(adapter.readiness({ cwd: registered.path })).toMatchObject({
      status: 'ok',
      value: { ready: true, workspacePath: registered.path, headSha: registered.head },
    });
    expect(runJson.mock.calls.map((call) => call[0])).toEqual([['worktree', 'current']]);
  });

  it('resolves a registered worktree via show path:cwd when current returns selector_not_found', () => {
    const runJson = vi.fn((args: readonly string[]) => {
      const operation = `${args[0] ?? ''} ${args[1] ?? ''}`;
      if (operation === 'worktree current') {
        return {
          ok: false,
          error: {
            code: 'selector_not_found',
            message: `No Orca-managed worktree contains the current directory: ${registered.path}`,
          },
        };
      }
      if (operation === 'worktree show') {
        expect(args).toEqual(['worktree', 'show', '--worktree', `path:${registered.path}`]);
        return { ok: true, result: { worktree: registered } };
      }
      return { ok: false, error: { code: 'unexpected_operation', message: operation } };
    });
    const adapter = new OrcaRuntimeAdapter({ runJson: runJson as never });
    expect(adapter.readiness({ cwd: registered.path })).toMatchObject({
      status: 'ok',
      value: { ready: true, workspacePath: registered.path, headSha: registered.head },
    });
  });
});
