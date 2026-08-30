// @vitest-ci-lane light
// @vitest-pre-topology-seconds 120
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DeterministicRuntimeAdapter } from '../runtime/test-adapter.ts';
import { executeRuntimeTaskLifecycle } from '../runtime/task-lifecycle.ts';
import type { OrcaJsonResponse } from './native.ts';
import { isOpenCodeComposerEmpty, OrcaRuntimeAdapter } from './adapter.ts';
import { readOrcaTerminal } from './compat.ts';
import { hasExecutorStartupBanner } from '../lib/worker-smoke-bounded-create.ts';
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

describe('OpenCode HTTP control plane', () => {
  function makeAdapter(
    http: (input: { url: string; method: 'GET' | 'POST'; body?: string; timeoutMs: number }) => { status: number; body: string },
    now?: () => number,
    onOperation?: (operation: string) => void,
    screenLines: readonly string[] = ['┃', '╹▀▀▀▀▀▀'],
  ) {
    const handle = 'term-opencode-http';
    const workspacePath = process.cwd();
    const terminal = {
      handle,
      incarnationId: 'generation-opencode-http',
      worktreePath: workspacePath,
      title: 'opencode',
      command: 'opencode --hostname 127.0.0.1 --port 18891 --agent pack-opk-fixture',
      status: 'running' as const,
    };
    const runJson = vi.fn((args: readonly string[]): OrcaJsonResponse => {
      const operation = `${args[0] ?? ''} ${args[1] ?? ''}`;
      onOperation?.(operation);
      if (operation === 'terminal create') return { ok: true, result: { terminal } };
      if (operation === 'worktree current') return { ok: false, error: { code: 'not_available', message: 'fixture' } };
      if (operation === 'terminal show') return { ok: true, result: { terminal } };
      if (operation === 'terminal list') return { ok: true, result: { totalCount: 1, truncated: false, terminals: [terminal] } };
      if (operation === 'terminal read') {
        return { ok: true, result: { terminal: { ...terminal, tail: [...screenLines], nextCursor: null, source: 'screen' } } };
      }
      return { ok: false, error: { code: 'unexpected_operation', message: operation } };
    });
    return new OrcaTaskRuntimeAdapter({
      runJson: runJson as never,
      openCodeHttpRequest: http,
      ...(now ? { now } : {}),
    });
  }

  it('uses health and visible TUI append/submit for an exact spawned OpenCode worker', () => {
    const requests: Array<{ url: string; method: 'GET' | 'POST'; body?: string; timeoutMs: number }> = [];
    const adapter = makeAdapter((input) => {
      requests.push(input);
      if (input.url.endsWith('/global/health')) return { status: 200, body: JSON.stringify({ healthy: true, version: '1.18.25' }) };
      if (input.url.includes('/session?directory=')) return { status: 200, body: JSON.stringify([{ id: 'ses-visible', directory: process.cwd() }]) };
      return { status: 200, body: 'true' };
    });
    const spawned = adapter.spawnWorker({
      title: 'opencode',
      command: 'opencode --hostname 127.0.0.1 --port 18891 --agent pack-opk-fixture',
    });
    expect(spawned.status).toBe('ok');
    if (spawned.status !== 'ok') return;

    expect(adapter.openCodeHealth(spawned.value.identity)).toEqual({
      status: 'ok', value: { healthy: true, version: '1.18.25' },
    });
    const control = adapter.composerControl?.(spawned.value.identity);
    expect(control?.kind).toBe('opencode-http');
    expect(control?.dispatch({
      worker: spawned.value.identity,
      action: 'submit-prompt',
      text: 'delivery pointer',
    }).status).toBe('dispatched');
    expect(requests.map(({ method, url }) => ({ method, url }))).toEqual([
      { method: 'GET', url: 'http://127.0.0.1:18891/global/health' },
      { method: 'GET', url: 'http://127.0.0.1:18891/session?directory=' + encodeURIComponent(process.cwd()) },
      { method: 'POST', url: 'http://127.0.0.1:18891/tui/append-prompt' },
      { method: 'POST', url: 'http://127.0.0.1:18891/tui/submit-prompt' },
    ]);
    expect(requests[2]?.body).toBe(JSON.stringify({ text: 'delivery pointer' }));
    expect(requests[3]?.body).toBeUndefined();
  });

  it('dispatches through the visible TUI when directory has root and fork sessions', () => {
    const requests: Array<{ url: string; method: 'GET' | 'POST'; body?: string; timeoutMs: number }> = [];
    const adapter = makeAdapter((input) => {
      requests.push(input);
      return { status: 200, body: 'true' };
    });
    const spawned = adapter.spawnWorker({
      title: 'opencode',
      command: 'opencode --hostname 127.0.0.1 --port 18891 --agent pack-opk-fixture',
    });
    expect(spawned.status).toBe('ok');
    if (spawned.status !== 'ok') return;

    expect(adapter.composerControl?.(spawned.value.identity)?.dispatch({
      worker: spawned.value.identity,
      action: 'submit-prompt',
      text: 'root-and-fork-safe',
    })).toMatchObject({ status: 'dispatched' });
    expect(requests.map(({ method, url }) => ({ method, url }))).toEqual([
      { method: 'POST', url: 'http://127.0.0.1:18891/tui/append-prompt' },
      { method: 'POST', url: 'http://127.0.0.1:18891/tui/submit-prompt' },
    ]);
  });

  it('bounds each OpenCode dispatch subcall by one aggregate deadline', () => {
    let clock = 0;
    const requests: Array<{ url: string; timeoutMs: number }> = [];
    const adapter = makeAdapter((input) => {
      requests.push({ url: input.url, timeoutMs: input.timeoutMs });
      if (input.method === 'POST' && input.url.endsWith('/tui/append-prompt')) {
        clock = 101;
      }
      return { status: 200, body: 'true' };
    }, () => clock, (operation) => {
      if (operation === 'terminal list') clock = 80;
    });
    const spawned = adapter.spawnWorker({ title: 'opencode', command: 'opencode --hostname 127.0.0.1 --port 18891 --agent pack-opk-fixture' });
    expect(spawned.status).toBe('ok');
    if (spawned.status !== 'ok') return;

    const result = adapter.composerControl?.(spawned.value.identity)?.dispatch({
      worker: spawned.value.identity,
      action: 'submit-prompt',
      text: 'deadline',
    }, { timeoutMs: 100 });
    expect(result).toEqual({ status: 'send_failed', reason: 'runtime_timeout' });
    expect(requests.map(({ timeoutMs }) => timeoutMs)).toEqual([20]);
  });

  it('retains OpenCode control when task adapter upgrades pty identity', () => {
    const handle = 'term-opencode-pty';
    const ptyGeneration = '/tmp/opencode-pty@@pty-generation';
    const exactGeneration = 'incarnation-opencode-generation';
    const command = 'opencode --hostname 127.0.0.1 --port 18891 --agent pack-opk-fixture';
    const terminal = {
      handle,
      incarnationId: exactGeneration,
      worktreePath: process.cwd(),
      title: 'opencode',
      status: 'running' as const,
    };
    const runJson = vi.fn((args: readonly string[]): OrcaJsonResponse => {
      const operation = `${args[0] ?? ''} ${args[1] ?? ''}`;
      if (operation === 'terminal create') {
        return { ok: true, result: { terminal: { handle, ptyId: ptyGeneration, title: 'opencode' } } };
      }
      if (operation === 'terminal show' || operation === 'terminal list') {
        return operation === 'terminal show'
          ? { ok: true, result: { terminal } }
          : { ok: true, result: { totalCount: 1, truncated: false, terminals: [terminal] } };
      }
      if (operation === 'worktree current') {
        return { ok: false, error: { code: 'not_available', message: 'fixture' } };
      }
      return { ok: false, error: { code: 'unexpected_operation', message: operation } };
    });
    const adapter = new OrcaTaskRuntimeAdapter({
      runJson: runJson as never,
      openCodeHttpRequest: (input) => ({
        status: 200,
        body: input.url.includes('/session?directory=')
          ? JSON.stringify([{ id: 'ses-visible', directory: process.cwd() }])
          : JSON.stringify({ healthy: true, version: '1.18.25' }),
      }),
    });

    const spawned = adapter.spawnWorker({ title: 'opencode', command });
    expect(spawned.status).toBe('ok');
    if (spawned.status !== 'ok') return;
    expect(spawned.value.identity.generation).toBe(exactGeneration);
    expect(adapter.openCodeHealth(spawned.value.identity)).toMatchObject({
      status: 'ok',
      value: { healthy: true, version: '1.18.25' },
    });
  });

  it('does not create an OpenCode session when an idle worker has none', () => {
    const requests: Array<{ url: string; method: 'GET' | 'POST'; body?: string }> = [];
    const adapter = makeAdapter((input) => {
      requests.push(input);
      if (input.url.endsWith('/global/health')) {
        return { status: 200, body: JSON.stringify({ healthy: true, version: '1.18.25' }) };
      }
      return { status: 200, body: 'true' };
    });
    const spawned = adapter.spawnWorker({
      title: 'opencode',
      command: 'opencode --hostname 127.0.0.1 --port 18891 --agent pack-opk-fixture',
    });
    expect(spawned.status).toBe('ok');
    if (spawned.status !== 'ok') return;

    const control = adapter.composerControl?.(spawned.value.identity);
    expect(control?.dispatch({
      worker: spawned.value.identity,
      action: 'submit-prompt',
      text: 'first delivery pointer',
    })).toMatchObject({ status: 'dispatched' });
    expect(requests.map(({ method, url }) => ({ method, url }))).toEqual([
      { method: 'POST', url: 'http://127.0.0.1:18891/tui/append-prompt' },
      { method: 'POST', url: 'http://127.0.0.1:18891/tui/submit-prompt' },
    ]);
  });

  it('recovers OpenCode TUI control from terminal metadata on a fresh adapter', () => {
    const requests: string[] = [];
    const first = makeAdapter((input) => {
      requests.push(input.url);
      if (input.url.endsWith('/global/health')) return { status: 200, body: JSON.stringify({ healthy: true, version: '1.18.25' }) };
      return { status: 200, body: 'true' };
    });
    const spawned = first.spawnWorker({
      title: 'opencode',
      command: 'opencode --hostname 127.0.0.1 --port 18891 --agent pack-opk-fixture',
    });
    expect(spawned.status).toBe('ok');
    if (spawned.status !== 'ok') return;

    const second = makeAdapter((input) => {
      requests.push(input.url);
      return { status: 200, body: 'true' };
    });
    const control = second.composerControl?.(spawned.value.identity);
    expect(control?.kind).toBe('opencode-http');
    expect(control?.dispatch({ worker: spawned.value.identity, action: 'submit-prompt', text: 'fresh adapter' })).toMatchObject({ status: 'dispatched' });
    expect(requests.slice(-2)).toEqual(['http://127.0.0.1:18891/tui/append-prompt', 'http://127.0.0.1:18891/tui/submit-prompt']);
  });

  it('bounds health HTTP timeout by the remaining health deadline', () => {
    let clock = 0;
    const requests: Array<{ url: string; timeoutMs: number }> = [];
    const terminal = {
      handle: 'term-opencode-http',
      incarnationId: 'generation-opencode-http',
      worktreePath: process.cwd(),
      title: 'opencode',
      command: 'opencode --hostname 127.0.0.1 --port 18891 --agent pack-opk-fixture',
      status: 'running' as const,
    };
    // The fixture's terminal lookup represents the slow first half of one probe.
    const slow = new OrcaTaskRuntimeAdapter({
      now: () => clock,
      runJson: vi.fn((args: readonly string[]): OrcaJsonResponse => {
        const operation = `${args[0] ?? ''} ${args[1] ?? ''}`;
        if (operation === 'terminal show') return { ok: true, result: { terminal } };
        if (operation === 'terminal list') { clock = 80; return { ok: true, result: { totalCount: 1, truncated: false, terminals: [terminal] } }; }
        return operation === 'worktree current'
          ? { ok: false, error: { code: 'not_available', message: 'fixture' } }
          : operation === 'terminal create'
            ? { ok: true, result: { terminal } }
            : { ok: false, error: { code: 'unexpected_operation', message: operation } };
      }) as never,
      openCodeHttpRequest: (input) => {
        requests.push({ url: input.url, timeoutMs: input.timeoutMs });
        if (input.url.includes('/session')) return { status: 200, body: JSON.stringify([{ id: 'ses-fixture', directory: process.cwd() }]) };
        if (input.url.includes('/event')) return { status: 200, body: '' };
        return { status: 200, body: JSON.stringify({ healthy: true, version: '1.18.25' }) };
      },
    });
    const identity = { runtime: 'orca' as const, id: 'term-opencode-http', generation: 'generation-opencode-http' };
    expect(slow.spawnWorker({ title: 'opencode', command: 'opencode --hostname 127.0.0.1 --port 18891 --agent pack-opk-fixture' }).status).toBe('ok');
    const health = slow.openCodeHealth(identity, { timeoutMs: 100 });
    expect(health.status).toBe('ok');
    expect(requests.at(-1)?.timeoutMs).toBe(20);
  });

  it('requires a session whose directory matches the worker during readiness', () => {
    const adapter = makeAdapter((input) => input.url.endsWith('/global/health')
      ? { status: 200, body: JSON.stringify({ healthy: true, version: '1.18.25' }) }
      : { status: 200, body: JSON.stringify([{ id: 'ses-other', directory: '/tmp/other-workspace' }]) });
    const spawned = adapter.spawnWorker({ title: 'opencode', command: 'opencode --hostname 127.0.0.1 --port 18891 --agent pack-opk-fixture' });
    expect(spawned.status).toBe('ok');
    if (spawned.status !== 'ok') return;

    expect(adapter.openCodeHealth(spawned.value.identity)).toMatchObject({
      status: 'unsupported',
      reason: 'opencode_session_directory_mismatch',
    });
  });

  it('refuses TUI delivery when the screen predicate finds human-authored text', () => {
    const requests: string[] = [];
    const adapter = makeAdapter((input) => {
      requests.push(input.url);
      return { status: 200, body: 'true' };
    }, undefined, undefined, ['┃ human-authored text', '╹▀▀▀▀▀▀']);
    const spawned = adapter.spawnWorker({ title: 'opencode', command: 'opencode --hostname 127.0.0.1 --port 18891 --agent pack-opk-fixture' });
    expect(spawned.status).toBe('ok');
    if (spawned.status !== 'ok') return;

    expect(adapter.composerControl?.(spawned.value.identity)?.dispatch({
      worker: spawned.value.identity,
      action: 'submit-prompt',
      text: 'delivery pointer',
    })).toEqual({ status: 'send_failed', reason: 'opencode_composer_not_empty' });
    expect(requests).toEqual([]);
  });

  it('uses composer geometry to preserve human-authored OpenCode text', () => {
    expect(isOpenCodeComposerEmpty(['idle splash', '┃', '╹▀▀▀▀▀▀'])).toBe(true);
    expect(isOpenCodeComposerEmpty(['idle splash', '┃ human text', '╹▀▀▀▀▀▀'])).toBe(false);
    expect(isOpenCodeComposerEmpty(['OpenCode', 'no composer'])).toBe(false);
  });

  it('rejects malformed TUI prompt API responses', () => {
    const adapter = makeAdapter((input) => {
      return { status: 200, body: '' };
    });
    const spawned = adapter.spawnWorker({ title: 'opencode', command: 'opencode --hostname 127.0.0.1 --port 18891 --agent pack-opk-fixture' });
    expect(spawned.status).toBe('ok');
    if (spawned.status !== 'ok') return;
    const control = adapter.composerControl?.(spawned.value.identity);
    expect(control?.dispatch({ worker: spawned.value.identity, action: 'submit-prompt', text: 'reject' })).toEqual({ status: 'send_failed', reason: 'opencode_tui_response_schema_mismatch' });
  });

  it.each([
    [404, '{}', 'opencode_http_status_404'],
    [200, JSON.stringify({ healthy: true }), 'opencode_health_schema_mismatch'],
  ])('fails loudly on OpenCode health HTTP/schema breakage (%s)', (status, body, reason) => {
    const adapter = makeAdapter(() => ({ status, body }));
    const spawned = adapter.spawnWorker({
      title: 'opencode',
      command: 'opencode --hostname 127.0.0.1 --port 18891 --agent pack-opk-fixture',
    });
    expect(spawned.status).toBe('ok');
    if (spawned.status !== 'ok') return;
    expect(adapter.openCodeHealth(spawned.value.identity)).toMatchObject({ status: expect.any(String), reason });
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
  it('accepts cursorless sync screen replay without issuing --cursor', () => {
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
      readCount += 1;
      expect(args).not.toContain('--cursor');
      return {
        ok: true,
        result: { terminal: { handle: 'screen-terminal', status: 'running', tail: [`visible-${readCount}`], nextCursor: null, source: 'screen' } },
      };
    });
    const adapter = new OrcaRuntimeAdapter({ runJson: runJson as never });
    const worker = { runtime: 'orca' as const, id: 'screen-terminal', generation: 'screen-generation' };
    const first = adapter.readBoundedOutput({ worker, screen: true });
    expect(first.status).toBe('ok');
    if (first.status !== 'ok') return;
    expect(first.value.source).toBe('screen');
    expect(first.value.lines).toEqual(['visible-1']);
    const second = adapter.readBoundedOutput({
      worker,
      previousToken: first.value.observationToken,
      screen: true,
    });
    expect(second.status).toBe('ok');
    expect(readCount).toBe(2);
  });

  it('uses the async all-workspace census and cursorless screen replay', async () => {
    let readCount = 0;
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
      readCount += 1;
      expect(args).not.toContain('--cursor');
      return {
        ok: true,
        result: { terminal: { handle: args[3], status: 'running', tail: [`visible-${readCount}`], nextCursor: null, source: 'screen' } },
      };
    });
    const adapter = new OrcaRuntimeAdapter({ runJsonAsync: runJsonAsync as never });
    const listed = await adapter.listWorkersAsync?.();
    expect(listed?.status).toBe('ok');
    expect(runJsonAsync.mock.calls[0]?.[0]).toEqual(['terminal', 'list']);
    const worker = { runtime: 'orca' as const, id: 'async-a', generation: 'generation-a' };
    const first = await adapter.readBoundedOutputAsync?.({ worker, screen: true });
    expect(first?.status).toBe('ok');
    if (first?.status !== 'ok') return;
    const second = await adapter.readBoundedOutputAsync?.({
      worker,
      previousToken: first.value.observationToken,
      screen: true,
    });
    expect(second?.status).toBe('ok');
    expect(readCount).toBe(2);
    expect(runJsonAsync.mock.calls.map(([args]) => args)).toEqual([
      ['terminal', 'list'],
      ['terminal', 'show', '--terminal', 'async-a'],
      ['terminal', 'read', '--terminal', 'async-a', '--screen'],
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

describe('Issue #1835 executor-aware worker-smoke observation', () => {
  it('does not infer OpenCode startup from screen chrome because readiness is HTTP-backed', () => {
    const openCodeLines = ['OpenCode 1.18.25', 'OpenCode Zen · high'];
    expect(hasExecutorStartupBanner('opencode --hostname 127.0.0.1 --port 18891 --agent pack-opk-fixture', openCodeLines)).toBe(false);
    expect(hasExecutorStartupBanner('cursor-agent', openCodeLines)).toBe(false);
  });

  it('keeps Cursor startup and ambiguity fail-closed', () => {
    expect(hasExecutorStartupBanner('cursor-agent', ['Cursor Agent', 'v1.2.3'])).toBe(true);
    expect(hasExecutorStartupBanner('opencode --hostname 127.0.0.1 --port 18891 --agent pack-opk-fixture', ['OpenCode'])).toBe(false);
    expect(hasExecutorStartupBanner('other-agent', ['OpenCode 1.18.25'])).toBe(false);
  });

  it('does not expose or replay a synthetic screen cursor through the compatibility facade', () => {
    const runner = vi.fn((_command: string, args: readonly string[]) => ({
      ok: true,
      stdout: JSON.stringify({
        ok: true,
        result: {
          terminal: {
            handle: args[args.indexOf('--terminal') + 1],
            status: 'running',
            tail: ['visible'],
            nextCursor: 'screen-frame',
            source: 'screen',
          },
        },
      }),
      stderr: '',
      status: 0,
      signal: null,
      error: undefined,
    })) as unknown as NonNullable<Parameters<typeof readOrcaTerminal>[1]>['runner'];

    const first = readOrcaTerminal('screen-terminal', { runner });
    expect(first.ok).toBe(true);
    expect(first.result?.source).toBe('screen');
    expect(first.result?.nextCursor).toBeUndefined();
    readOrcaTerminal('screen-terminal', { runner, cursor: first.result?.nextCursor });
    expect((runner as unknown as { mock: { calls: readonly [string, readonly string[]][] } }).mock.calls[1]?.[1]).not.toContain('--cursor');
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
