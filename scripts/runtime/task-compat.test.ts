import { describe, expect, it, vi } from 'vitest';
import { OrcaTaskRuntimeAdapter } from '../orca-runtime/task-adapter.ts';
import { DeterministicRuntimeAdapter } from './test-adapter.ts';
import { RuntimeTaskCompatibilityFacade } from './task-compat.ts';

function exerciseTaskCaller(facade: RuntimeTaskCompatibilityFacade): void {
  const created = facade.createTerminal({
    cwd: process.cwd(),
    title: 'issue-1248',
    command: 'cursor-agent',
  });
  expect(created.ok).toBe(true);
  if (!created.ok) return;

  const handle = created.terminal.handle;
  const sent = facade.dispatch(handle, { text: 'implement the issue' });
  expect(sent.ok).toBe(true);

  const first = facade.readTerminal(handle, { limit: 50 });
  expect(first.ok).toBe(true);
  expect(first.result?.lines?.join('\n')).toContain('implement the issue');
  expect(first.result?.nextCursor).toBeTypeOf('number');

  const second = facade.readTerminal(handle, {
    cursor: first.result?.nextCursor,
    limit: 50,
  });
  expect(second.ok).toBe(true);

  const liveness = facade.waitTerminal(handle, { for: 'tui-idle', timeoutMs: 25 });
  expect(liveness.ok).toBe(true);

  const closed = facade.closeTerminal(handle);
  expect(closed.ok).toBe(true);
}

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

describe('runtime-neutral task caller', () => {
  it('runs unchanged with the deterministic adapter', () => {
    const adapter = new DeterministicRuntimeAdapter();
    exerciseTaskCaller(new RuntimeTaskCompatibilityFacade({ adapter }));
  });

  it('runs unchanged with the Orca adapter', () => {
    const runner = fakeOrcaRunner();
    const adapter = new OrcaTaskRuntimeAdapter({ runner: runner as never });
    exerciseTaskCaller(new RuntimeTaskCompatibilityFacade({ adapter }));
    expect(runner).toHaveBeenCalled();
  });

  it('refuses stale-generation destructive cleanup before the close transport', () => {
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
