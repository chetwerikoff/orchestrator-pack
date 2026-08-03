import { describe, expect, it, vi } from 'vitest';
import { OrcaTaskRuntimeAdapter } from '../orca-runtime/task-adapter.ts';
import { DeterministicRuntimeAdapter } from './test-adapter.ts';
import { executeRuntimeTaskLifecycle } from './task-lifecycle.ts';

function fakeOrcaRunner() {
  const handle = 'term-1248';
  const generation = 'incarnation-1248';
  const lines = ['started:cursor-agent'];
  return vi.fn((_command: string, args: readonly string[]) => {
    const operation = `${args[0] ?? ''} ${args[1] ?? ''}`;
    let payload: unknown;
    switch (operation) {
      case 'worktree current':
        payload = {
          ok: true,
          result: { worktree: { path: process.cwd(), head: 'a'.repeat(40) } },
        };
        break;
      case 'terminal create':
        payload = {
          ok: true,
          result: { terminal: { handle, incarnationId: generation, title: 'issue-1248' } },
        };
        break;
      case 'terminal list':
        payload = {
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
        break;
      case 'terminal send': {
        const textIndex = args.indexOf('--text');
        if (textIndex >= 0) lines.push(String(args[textIndex + 1] ?? ''));
        payload = { ok: true, result: { send: { accepted: true } } };
        break;
      }
      case 'terminal read':
        payload = {
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
        break;
      case 'terminal wait':
        payload = {
          ok: true,
          result: {
            wait: { handle, condition: 'tui-idle', satisfied: true, status: 'running' },
          },
        };
        break;
      case 'terminal close':
        payload = { ok: true, result: { close: { handle, closed: true } } };
        break;
      default:
        payload = { ok: false, error: { code: 'unexpected_operation', message: operation } };
        break;
    }
    return { stdout: JSON.stringify(payload), stderr: '', status: 0 };
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
    const runner = fakeOrcaRunner();
    const result = exercise(new OrcaTaskRuntimeAdapter({ runner: runner as never }));
    expect(result.status).toBe('ok');
    expect(runner).toHaveBeenCalled();
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
    const runner = fakeOrcaRunner();
    const adapter = new OrcaTaskRuntimeAdapter({ runner: runner as never });
    const created = adapter.spawnWorker({ title: 'owned', command: 'cursor-agent' });
    expect(created.status).toBe('ok');
    if (created.status !== 'ok') return;

    const stale = {
      ...created.value.identity,
      generation: `${created.value.identity.generation}-stale`,
    };
    const before = runner.mock.calls.filter((call) => call[1]?.[1] === 'close').length;
    const stopped = adapter.stopWorker(stale);
    const after = runner.mock.calls.filter((call) => call[1]?.[1] === 'close').length;

    expect(stopped).toEqual({
      status: 'failed',
      operation: 'stop_worker',
      reason: 'worker_not_owned_by_runtime_instance',
    });
    expect(after).toBe(before);
  });
});
