import { describe, expect, it, vi } from 'vitest';
import { OrcaTaskRuntimeAdapter } from '../orca-runtime/task-adapter.ts';
import { DeterministicRuntimeAdapter } from './test-adapter.ts';
import { executeRuntimeTaskLifecycle } from './task-lifecycle.ts';
import type { OrcaJsonResponse } from '../orca-runtime/native.ts';

function fakeOrcaTransport() {
  const handle = 'term-1248';
  const generation = 'incarnation-1248';
  const lines = ['started:cursor-agent'];
  return vi.fn((args: readonly string[]): OrcaJsonResponse => {
    const operation = `${args[0] ?? ''} ${args[1] ?? ''}`;
    switch (operation) {
      case 'worktree current':
        return {
          ok: true,
          result: { worktree: { path: process.cwd(), head: 'a'.repeat(40) } },
        };
      case 'terminal create':
        return {
          ok: true,
          result: { terminal: { handle, incarnationId: generation, title: 'issue-1248' } },
        };
      case 'terminal list':
        return {
          ok: true,
          result: {
            terminals: [{
              handle,
              incarnationId: generation,
              title: 'issue-1248',
              worktreePath: process.cwd(),
              status: 'running',
            }],
          },
        };
      case 'terminal send': {
        const textIndex = args.indexOf('--text');
        if (textIndex >= 0) lines.push(String(args[textIndex + 1] ?? ''));
        return { ok: true, result: { send: { accepted: true } } };
      }
      case 'terminal read':
        return {
          ok: true,
          result: {
            terminal: {
              handle,
              status: 'running',
              tail: [...lines],
              nextCursor: String(lines.length),
              latestCursor: String(lines.length),
            },
          },
        };
      case 'terminal wait':
        return {
          ok: true,
          result: {
            wait: { handle, condition: 'tui-idle', satisfied: true, status: 'running' },
          },
        };
      case 'terminal close':
        return { ok: true, result: { close: { handle, closed: true } } };
      default:
        return { ok: false, error: { code: 'unexpected_operation', message: operation } };
    }
  });
}

function exercise(adapter: DeterministicRuntimeAdapter | OrcaTaskRuntimeAdapter) {
  return executeRuntimeTaskLifecycle({
    adapter,
    title: 'issue-1248',
    command: 'cursor-agent',
    prompt: 'implement the issue',
  });
}

describe('direct runtime-neutral task caller', () => {
  it('runs unchanged with the deterministic adapter', () => {
    const result = exercise(new DeterministicRuntimeAdapter());
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.lines.join('\n')).toContain('implement the issue');
  });

  it('runs unchanged with the Orca adapter', () => {
    const runJson = fakeOrcaTransport();
    const result = exercise(new OrcaTaskRuntimeAdapter({ runJson: runJson as never }));
    expect(result).toMatchObject({ status: 'ok' });
    expect(runJson).toHaveBeenCalled();
  });

  it('acquires the claim before the first runtime side effect', () => {
    const events: string[] = [];
    const adapter = new DeterministicRuntimeAdapter();
    const spawn = adapter.spawnWorker.bind(adapter);
    vi.spyOn(adapter, 'spawnWorker').mockImplementation((...args) => {
      events.push('spawn');
      return spawn(...args);
    });
    const result = executeRuntimeTaskLifecycle({
      adapter,
      title: 'issue-1248',
      command: 'cursor-agent',
      prompt: 'implement the issue',
      acquireClaim: () => {
        events.push('claim');
        return { ok: true };
      },
    });
    expect(result.status).toBe('ok');
    expect(events.slice(0, 2)).toEqual(['claim', 'spawn']);
  });

  it('does not spawn when claim acquisition fails', () => {
    const adapter = new DeterministicRuntimeAdapter();
    const spawn = vi.spyOn(adapter, 'spawnWorker');
    const result = executeRuntimeTaskLifecycle({
      adapter,
      title: 'issue-1248',
      command: 'cursor-agent',
      prompt: 'implement the issue',
      acquireClaim: () => ({ ok: false, reason: 'claim_busy' }),
    });
    expect(result).toEqual({ stage: 'claim', reason: 'claim_busy' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('refuses stale-generation destructive cleanup before close transport', () => {
    const runJson = fakeOrcaTransport();
    const adapter = new OrcaTaskRuntimeAdapter({ runJson: runJson as never });
    const created = adapter.spawnWorker({ title: 'owned', command: 'cursor-agent' });
    expect(created.status).toBe('ok');
    if (created.status !== 'ok') return;

    const stale = {
      ...created.value.identity,
      generation: `${created.value.identity.generation}-stale`,
    };
    const before = runJson.mock.calls.filter((call) => call[0]?.[1] === 'close').length;
    const stopped = adapter.stopWorker(stale);
    const after = runJson.mock.calls.filter((call) => call[0]?.[1] === 'close').length;

    expect(stopped).toEqual({
      status: 'failed',
      operation: 'stop_worker',
      reason: 'worker_not_owned_by_runtime_instance',
    });
    expect(after).toBe(before);
  });
});
