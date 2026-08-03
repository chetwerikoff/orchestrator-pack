import { describe, expect, it, vi } from 'vitest';
import { executeWatchRequest } from './watch.ts';
import type { WatchRequest } from '../lib/launch-watch/contract.ts';
import { selectRuntimeAdapter } from '../runtime/registry.ts';
import { DeterministicRuntimeAdapter } from '../runtime/test-adapter.ts';
import { OrcaRuntimeAdapter } from '../orca-runtime/adapter.ts';
import { readOrcaTerminal } from '../orca-runtime/compat.ts';
import { runOrcaJson, type OrcaJsonResponse } from '../orca-runtime/native.ts';

type FakeResult = {
  readonly outcome: 'exit';
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly signal: null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
};

function result(stdout: string, ok = true): FakeResult {
  return { outcome: 'exit', ok, exitCode: ok ? 0 : 1, signal: null, stdout, stderr: '', timedOut: false, cancelled: false };
}

function spawned(adapter: DeterministicRuntimeAdapter) {
  const created = adapter.spawnWorker({ title: 'worker', command: 'codex' });
  if (created.status !== 'ok') throw new Error(created.reason);
  return created.value;
}

const orcaIdentity = { runtime: 'orca', id: 'term-1', generation: 'pty-1' } as const;

function terminalList(
  handle = 'term-1',
  generation = 'pty-1',
  workspacePath = '/repo',
  title = 'worker',
): OrcaJsonResponse {
  return {
    ok: true,
    result: {
      terminals: [{ handle, ptyId: generation, worktreePath: workspacePath, title }],
    },
  };
}

function orcaResponseFor(args: readonly string[]): OrcaJsonResponse {
  if (args[0] === 'terminal' && args[1] === 'list') return terminalList();
  if (args[0] === 'terminal' && args[1] === 'wait') {
    return { ok: true, result: { wait: { satisfied: false, status: 'running' } } };
  }
  if (args[0] === 'terminal' && args[1] === 'read') {
    return {
      ok: true,
      result: {
        terminal: { handle: 'term-1', status: 'running', tail: ['line'], nextCursor: 'cursor-1' },
      },
    };
  }
  return { ok: true, result: {} };
}

describe('watch wrapper producers', () => {
  it('uses the requested repository and PR number and returns matched', async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const request: WatchRequest = {
      requestVersion: 'watch-request/v1', sourceId: 'github.pull-request', predicateId: 'pr.merged',
      repo: 'other/repo', prNumber: 42, deadlineMs: 10_000,
    };
    const output = await executeWatchRequest(request, {
      root: '/pack',
      now: (() => {
        let time = 0;
        return () => time;
      })(),
      run: async (command, args) => {
        calls.push({ command, args });
        return result('{"state":"MERGED","mergedAt":"2026-08-02T00:00:00Z"}');
      },
    });
    expect(output.outcome).toBe('matched');
    expect(calls[0]).toEqual({
      command: '/pack/scripts/gh',
      args: ['pr', 'view', '42', '--repo', 'other/repo', '--json', 'state,mergedAt'],
    });
  });

  it('returns predicate-failed for a closed but unmerged PR', async () => {
    const request: WatchRequest = {
      requestVersion: 'watch-request/v1', sourceId: 'github.pull-request', predicateId: 'pr.merged',
      repo: 'owner/repo', prNumber: 5, deadlineMs: 10_000,
    };
    const output = await executeWatchRequest(request, {
      now: () => 0,
      run: async () => result('{"state":"CLOSED","mergedAt":null}'),
    });
    expect(output).toMatchObject({ outcome: 'predicate-failed', reasonCode: 'github_pr_not_merged', sourceId: 'github.pull-request' });
  });

  it('preserves explicit missing GitHub fields', async () => {
    const request: WatchRequest = {
      requestVersion: 'watch-request/v1', sourceId: 'github.pull-request', predicateId: 'pr.merged',
      repo: 'owner/repo', prNumber: 5, deadlineMs: 10_000,
    };
    const missingState = await executeWatchRequest(request, {
      now: () => 0,
      run: async () => result('{"mergedAt":null}'),
    });
    const missingMergedAt = await executeWatchRequest(request, {
      now: () => 0,
      run: async () => result('{"state":"OPEN"}'),
    });
    expect(missingState.primaryReasonCode).toBe('github_missing_state');
    expect(missingMergedAt.primaryReasonCode).toBe('github_missing_mergedAt');
  });

  it('accepts an empty terminal read and treats ok:false as source unavailable', async () => {
    const request: WatchRequest = {
      requestVersion: 'watch-request/v1', sourceId: 'orca.terminal', predicateId: 'terminal.read',
      terminalHandle: 'h', deadlineMs: 10_000,
    };
    const matched = await executeWatchRequest(request, {
      now: () => 0,
      run: async () => result('{"ok":true,"result":{"lines":[],"nextCursor":null}}'),
    });
    expect(matched.outcome).toBe('matched');
    const unavailable = await executeWatchRequest(request, {
      now: () => 0,
      run: async () => result('{"ok":false,"error":{"opaque":"keep"}}', false),
    });
    expect(unavailable).toMatchObject({
      outcome: 'partial-cleanup',
      primaryOutcome: 'source-unavailable',
      reasonCode: 'orca_read_ok_false',
      cleanup: { cleanupOutcome: 'completed', cleanupErrorCode: null },
    });
    expect(unavailable.evidence).toHaveProperty('response.error');
  });

  it('bounds and records cleanup for failed watch helpers', async () => {
    const request: WatchRequest = {
      requestVersion: 'watch-request/v1', sourceId: 'orca.terminal', predicateId: 'terminal.read',
      terminalHandle: 'h', deadlineMs: 10_000,
    };
    let timeoutMs = 0;
    const failed = await executeWatchRequest(request, {
      now: () => 0,
      run: async () => result('{"ok":false}'),
      cleanupHelpers: async (options) => {
        timeoutMs = options.timeoutMs;
        return { completed: false, evidence: { processOutcome: 'timeout' } };
      },
    });
    expect(timeoutMs).toBe(5_000);
    expect(failed).toMatchObject({
      outcome: 'cleanup-failed',
      primaryOutcome: 'source-unavailable',
      cleanup: { cleanupOutcome: 'failed', cleanupErrorCode: 'cleanup_timeout' },
    });
  });
});

describe('runtime-neutral boundary', () => {
  it('defaults to Orca and fails unknown selection before invoking any factory', async () => {
    expect((await selectRuntimeAdapter({ env: {} })).id).toBe('orca');
    const factory = vi.fn(() => new DeterministicRuntimeAdapter());
    await expect(selectRuntimeAdapter({ adapter: 'missing', factories: { test: factory } }))
      .rejects.toThrow('unsupported_runtime_adapter:missing');
    expect(factory).not.toHaveBeenCalled();
  });

  it('loads only the selected deterministic adapter without caller branches', async () => {
    const selectedFactory = vi.fn(() => new DeterministicRuntimeAdapter());
    const unselectedFactory = vi.fn(() => {
      throw new Error('unselected factory must not load');
    });
    const adapter = await selectRuntimeAdapter({
      adapter: 'test',
      factories: { test: selectedFactory, unselected: unselectedFactory },
    });
    const worker = adapter.spawnWorker({ title: 'worker', command: 'codex' });
    expect(worker.status).toBe('ok');
    expect(selectedFactory).toHaveBeenCalledTimes(1);
    expect(unselectedFactory).not.toHaveBeenCalled();
  });

  it('keeps output observations opaque and reports runtime-owned workers as internal', () => {
    const adapter = new DeterministicRuntimeAdapter();
    const worker = spawned(adapter);
    expect(adapter.listWorkers()).toEqual({
      status: 'ok',
      value: [expect.objectContaining({ identity: worker.identity, provenance: 'internal' })],
    });

    const first = adapter.readBoundedOutput({ worker: worker.identity });
    expect(first.status).toBe('ok');
    if (first.status !== 'ok') return;
    expect(first.value.changed).toBe(true);
    expect(first.value.observationToken).toEqual({ opaque: 'v1' });
    expect(first.value.observationToken).not.toHaveProperty('cursor');

    const unchanged = adapter.readBoundedOutput({
      worker: worker.identity,
      previousToken: first.value.observationToken,
    });
    expect(unchanged.status === 'ok' && unchanged.value.changed).toBe(false);

    expect(adapter.dispatchInput({ worker: worker.identity, text: 'continue' }).status)
      .toBe('dispatched');
    const changed = adapter.readBoundedOutput({
      worker: worker.identity,
      previousToken: first.value.observationToken,
    });
    expect(changed.status === 'ok' && changed.value.changed).toBe(true);
  });

  it('invalidates prior observations when the same opaque id is recreated', () => {
    const adapter = new DeterministicRuntimeAdapter();
    const original = spawned(adapter);
    const observed = adapter.readBoundedOutput({ worker: original.identity });
    expect(observed.status).toBe('ok');
    if (observed.status !== 'ok') return;

    const recreated = adapter.recreateWorker(original.identity);
    expect(recreated.identity.id).toBe(original.identity.id);
    expect(recreated.identity.generation).not.toBe(original.identity.generation);
    expect(adapter.findWorker(original.identity)).toEqual({ status: 'ok', value: null });
    expect(adapter.readBoundedOutput({
      worker: original.identity,
      previousToken: observed.value.observationToken,
    })).toMatchObject({ status: 'failed', reason: 'worker_not_found' });
    expect(adapter.readBoundedOutput({ worker: recreated.identity }).status).toBe('ok');
  });

  it('uses the closed liveness vocabulary and invalidates stopped generations', () => {
    const adapter = new DeterministicRuntimeAdapter();
    const worker = spawned(adapter);
    expect(adapter.liveness({ worker: worker.identity, observationWindowMs: 10 }).status).toBe('busy');
    adapter.setLiveness(worker.identity, 'idle');
    expect(adapter.liveness({ worker: worker.identity, observationWindowMs: 10 }).status).toBe('idle');
    expect(adapter.liveness({ worker: worker.identity, observationWindowMs: 0 }).status).toBe('unknown');
    expect(adapter.stopWorker(worker.identity).status).toBe('ok');
    expect(adapter.liveness({ worker: worker.identity, observationWindowMs: 10 }).status).toBe('gone');
  });
});

describe('Orca runtime adapter', () => {
  it('marks discovered same-workspace terminals external without adopting ownership', () => {
    const adapter = new OrcaRuntimeAdapter({ runJson: orcaResponseFor });
    const listed = adapter.listWorkers({ workspace: 'active' });
    expect(listed).toEqual({
      status: 'ok',
      value: [{
        identity: orcaIdentity,
        workspacePath: '/repo',
        title: 'worker',
        provenance: 'external',
      }],
    });
    expect(adapter.stopWorker(orcaIdentity)).toMatchObject({
      status: 'failed', reason: 'worker_not_owned_by_runtime_instance',
    });
  });

  it('uses one total deadline for lookup and tui-idle observation', () => {
    let now = 0;
    const calls: Array<{ args: readonly string[]; timeoutMs?: number }> = [];
    const runJson = ((args: readonly string[], options: { readonly timeoutMs?: number } = {}) => {
      calls.push({ args, timeoutMs: options.timeoutMs });
      if (args[1] === 'list') {
        now += 20;
        return terminalList();
      }
      if (args[1] === 'wait') {
        return { ok: true, result: { wait: { satisfied: false, status: 'running' } } };
      }
      return { ok: true, result: {} };
    }) as typeof runOrcaJson;
    const adapter = new OrcaRuntimeAdapter({ runJson, now: () => now });

    expect(adapter.liveness({ worker: orcaIdentity, observationWindowMs: 50 }).status).toBe('busy');
    expect(calls[0]).toMatchObject({ timeoutMs: 50 });
    expect(calls[1]?.args).toEqual([
      'terminal', 'wait', '--terminal', 'term-1', '--for', 'tui-idle', '--timeout-ms', '30',
    ]);
    expect(calls[1]).toMatchObject({ timeoutMs: 30 });
  });

  it('returns unknown within the total bound when lookup exhausts the budget', () => {
    let now = 0;
    const calls: Array<{ args: readonly string[]; timeoutMs?: number }> = [];
    const runJson = ((args: readonly string[], options: { readonly timeoutMs?: number } = {}) => {
      calls.push({ args, timeoutMs: options.timeoutMs });
      now += 50;
      return { ok: false, error: { code: 'orca_operation_timeout' } };
    }) as typeof runOrcaJson;
    const adapter = new OrcaRuntimeAdapter({ runJson, now: () => now });

    expect(adapter.liveness({ worker: orcaIdentity, observationWindowMs: 50 }).status).toBe('unknown');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ timeoutMs: 50 });
  });

  it('finds a worker in its explicitly selected non-active workspace', () => {
    const calls: string[][] = [];
    const runJson = ((args: readonly string[]) => {
      calls.push([...args]);
      if (args[1] === 'create') {
        return { ok: true, result: { terminal: { handle: 'term-other', ptyId: 'pty-other', title: 'worker' } } };
      }
      if (args[1] === 'list') return terminalList('term-other', 'pty-other', '/other');
      if (args[1] === 'wait') {
        return { ok: true, result: { wait: { satisfied: false, status: 'running' } } };
      }
      return { ok: true, result: {} };
    }) as typeof runOrcaJson;
    const adapter = new OrcaRuntimeAdapter({ runJson });
    const created = adapter.spawnWorker({ title: 'worker', command: 'codex', workspace: '/other' });
    expect(created.status).toBe('ok');
    if (created.status !== 'ok') return;

    expect(adapter.findWorker(created.value.identity).status).toBe('ok');
    expect(adapter.liveness({ worker: created.value.identity, observationWindowMs: 25 }).status).toBe('busy');
    expect(calls.filter((args) => args[1] === 'list').every((args) => args.includes('/other'))).toBe(true);
  });

  it('invalidates ownership and blocks effects when Orca reuses a handle with a new generation', () => {
    const calls: string[][] = [];
    const runJson = ((args: readonly string[]) => {
      calls.push([...args]);
      if (args[1] === 'create') {
        return { ok: true, result: { terminal: { handle: 'same', ptyId: 'pty-1', title: 'worker' } } };
      }
      if (args[1] === 'list') return terminalList('same', 'pty-2', '/repo');
      throw new Error(`stale identity reached effect: ${args.join(' ')}`);
    }) as typeof runOrcaJson;
    const adapter = new OrcaRuntimeAdapter({ runJson });
    const created = adapter.spawnWorker({ title: 'worker', command: 'codex', workspace: '/repo' });
    expect(created.status).toBe('ok');
    if (created.status !== 'ok') return;

    expect(adapter.findWorker(created.value.identity)).toEqual({ status: 'ok', value: null });
    expect(adapter.readBoundedOutput({ worker: created.value.identity }))
      .toMatchObject({ status: 'failed', reason: 'worker_generation_not_found' });
    expect(adapter.dispatchInput({ worker: created.value.identity, text: 'work' }))
      .toMatchObject({ status: 'send_failed', reason: 'worker_generation_not_found' });
    expect(adapter.liveness({ worker: created.value.identity, observationWindowMs: 25 }).status)
      .toBe('gone');
    expect(adapter.stopWorker(created.value.identity))
      .toMatchObject({ status: 'failed', reason: 'worker_not_owned_by_runtime_instance' });
    expect(calls.some((args) => ['read', 'send', 'close'].includes(args[1] ?? ''))).toBe(false);
  });

  it('normalizes current Orca output into a generation-scoped opaque token', () => {
    const adapter = new OrcaRuntimeAdapter({ runJson: orcaResponseFor });
    const first = adapter.readBoundedOutput({ worker: orcaIdentity });
    expect(first.status).toBe('ok');
    if (first.status !== 'ok') return;
    expect(first.value.lines).toEqual(['line']);
    expect(first.value.changed).toBe(true);
    expect(first.value.observationToken.opaque).toMatch(/^opk-orca-output-v2\.[0-9a-f-]{36}$/);
    expect(first.value).not.toHaveProperty('nextCursor');

    const second = adapter.readBoundedOutput({
      worker: orcaIdentity,
      previousToken: first.value.observationToken,
    });
    expect(second.status === 'ok' && second.value.changed).toBe(false);

    const wrongGeneration = adapter.readBoundedOutput({
      worker: { ...orcaIdentity, generation: 'pty-2' },
      previousToken: first.value.observationToken,
    });
    expect(wrongGeneration).toMatchObject({
      status: 'failed', reason: 'observation_token_scope_mismatch',
    });
  });

  it('keeps no-cursor observations opaque and detects empty, unchanged, and changed output', () => {
    let reads = 0;
    const runJson = ((args: readonly string[]) => {
      if (args[1] === 'list') return terminalList();
      if (args[1] === 'read') {
        const lines = reads < 2 ? [] : ['new'];
        reads += 1;
        return {
          ok: true,
          result: { terminal: { handle: 'term-1', status: 'running', tail: lines, nextCursor: null } },
        };
      }
      return { ok: true, result: {} };
    }) as typeof runOrcaJson;
    const adapter = new OrcaRuntimeAdapter({ runJson });

    const first = adapter.readBoundedOutput({ worker: orcaIdentity });
    expect(first.status).toBe('ok');
    if (first.status !== 'ok') return;
    expect(first.value.changed).toBe(false);
    expect(first.value.observationToken.opaque).toMatch(/^opk-orca-output-v2\.[0-9a-f-]{36}$/);

    const unchanged = adapter.readBoundedOutput({
      worker: orcaIdentity,
      previousToken: first.value.observationToken,
    });
    expect(unchanged.status).toBe('ok');
    if (unchanged.status !== 'ok') return;
    expect(unchanged.value.changed).toBe(false);
    expect(unchanged.value.observationToken).toEqual(first.value.observationToken);

    const changed = adapter.readBoundedOutput({
      worker: orcaIdentity,
      previousToken: unchanged.value.observationToken,
    });
    expect(changed.status).toBe('ok');
    if (changed.status !== 'ok') return;
    expect(changed.value.changed).toBe(true);
    expect(changed.value.observationToken).not.toEqual(unchanged.value.observationToken);

    expect(adapter.readBoundedOutput({
      worker: { ...orcaIdentity, generation: 'pty-2' },
      previousToken: first.value.observationToken,
    })).toMatchObject({ status: 'failed', reason: 'observation_token_scope_mismatch' });
  });

  it('keeps the existing numeric smoke cursor facade over current string cursors', () => {
    const runner = vi.fn((_executable: string, _args: readonly string[]) => ({
      stdout: JSON.stringify({
        ok: true,
        result: {
          terminal: {
            handle: 'term-compat',
            status: 'running',
            tail: ['line'],
            nextCursor: 'native-cursor-7',
          },
        },
      }),
      stderr: '',
      status: 0,
      signal: null,
      error: undefined,
    })) as unknown as NonNullable<Parameters<typeof readOrcaTerminal>[1]>['runner'];

    const first = readOrcaTerminal('term-compat', { runner, limit: 20 });
    expect(first.ok).toBe(true);
    expect(first.result?.lines).toEqual(['line']);
    expect(first.result?.nextCursor).toEqual(expect.any(Number));

    readOrcaTerminal('term-compat', { runner, cursor: first.result?.nextCursor });
    const secondArgs = runner.mock.calls[1]?.[1] as string[];
    expect(secondArgs).toContain('native-cursor-7');
    expect(secondArgs).not.toContain(String(first.result?.nextCursor));
  });

  it('fails closed when a consumed Orca response field drifts', () => {
    const adapter = new OrcaRuntimeAdapter({
      runJson: (args) => args[1] === 'list'
        ? terminalList()
        : { ok: true, result: { terminal: { status: 'running', nextCursor: 'c' } } },
    });
    expect(adapter.readBoundedOutput({ worker: orcaIdentity })).toMatchObject({
      status: 'unsupported',
      reason: 'orca_terminal_read_shape_unsupported',
    });
  });

  it('attempts dispatch exactly once and preserves ambiguity', () => {
    const runJson = vi.fn((args: readonly string[]) => args[1] === 'list'
      ? terminalList()
      : {
        ok: false,
        error: { code: 'orca_operation_timeout' },
        outcomeCategory: 'supported_operation_failure',
      } as const);
    const adapter = new OrcaRuntimeAdapter({ runJson: runJson as typeof runOrcaJson });
    expect(adapter.dispatchInput({ worker: orcaIdentity, text: 'hello' })).toEqual({
      status: 'dispatch_unknown', reason: 'orca_operation_timeout',
    });
    expect(runJson.mock.calls.filter(([args]) => args[1] === 'send')).toHaveLength(1);
  });
});
