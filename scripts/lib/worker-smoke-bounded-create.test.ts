// @vitest-ci-lane light
// @vitest-pre-topology-seconds 1
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  openCodeHttpSubprocessTimeoutMs,
} from '../orca-runtime/adapter.ts';
import type { OrcaJsonResponse, OrcaTerminalSummary } from '../orca-runtime/native.ts';
import { OrcaTaskRuntimeAdapter } from '../orca-runtime/task-adapter.ts';
import { installStableWorkerSmokeSpawnPatch } from './worker-smoke-bounded-create.ts';

const STARTUP_TIMEOUT_MS = 10_000;
const COMMAND = 'opencode --hostname 127.0.0.1 --port 18891 --agent pack-opk-fixture';
const HANDLE = 'term-opencode-readiness';
const GENERATION = 'generation-opencode';

function ok<T>(result: T): OrcaJsonResponse<T> {
  return { ok: true, result };
}

function terminal(root: string, generation = GENERATION): OrcaTerminalSummary {
  return {
    handle: HANDLE,
    title: 'opencode',
    incarnationId: generation,
    worktreePath: root,
    status: 'running',
  };
}

describe('OpenCode readiness probe budget', () => {
  const restores: Array<() => void> = [];
  const roots: string[] = [];

  afterEach(() => {
    while (restores.length > 0) restores.pop()?.();
    while (roots.length > 0) {
      const root = roots.pop();
      if (root) rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps one HTTP subprocess strictly inside its outer deadline', () => {
    expect(openCodeHttpSubprocessTimeoutMs(1)).toBeNull();
    expect(openCodeHttpSubprocessTimeoutMs(0)).toBeNull();
    for (const remaining of [2, 20, 100, 4_000, 30_000]) {
      const timeoutMs = openCodeHttpSubprocessTimeoutMs(remaining);
      expect(timeoutMs).not.toBeNull();
      expect(timeoutMs!).toBeGreaterThan(0);
      expect(timeoutMs!).toBeLessThan(remaining);
    }
  });

  it('retries a readiness timeout while startup budget remains and then accepts a valid observation', () => {
    const seen: number[] = [];
    const spawned = spawnOpenCode({
      onHttp: (input, clock) => {
        seen.push(input.timeoutMs);
        if (input.url.endsWith('/global/health') && seen.filter((timeout) => timeout > 0).length === 1) {
          clock.advance(input.timeoutMs);
          throw new Error('spawnSync node ETIMEDOUT');
        }
        if (input.url.endsWith('/global/health')) {
          return { status: 200, body: JSON.stringify({ healthy: true, version: '1.18.25' }) };
        }
        return {
          status: 200,
          body: JSON.stringify([{ id: 'ses-visible', directory: input.workspacePath }]),
        };
      },
    });

    expect(spawned.result.status).toBe('ok');
    expect(JSON.stringify(spawned.result)).not.toContain('worker_agent_not_started');
    const healthTimeouts = spawned.requests
      .filter((request) => request.url.endsWith('/global/health'))
      .map((request) => request.timeoutMs);
    expect(healthTimeouts.length).toBeGreaterThanOrEqual(2);
    for (const timeoutMs of spawned.requests.map((request) => request.timeoutMs)) {
      expect(timeoutMs).toBeGreaterThan(0);
      expect(timeoutMs).toBeLessThan(STARTUP_TIMEOUT_MS);
    }
    expect(spawned.closes).toBe(0);
  });

  it('accepts opencode_session_directory_mismatch during readiness', () => {
    const spawned = spawnOpenCode({
      onHttp: (input) => {
        if (input.url.endsWith('/global/health')) {
          return { status: 200, body: JSON.stringify({ healthy: true, version: '1.18.25' }) };
        }
        return {
          status: 200,
          body: JSON.stringify([{ id: 'ses-other', directory: '/tmp/other-workspace' }]),
        };
      },
    });
    expect(spawned.result.status).toBe('ok');
    expect(spawned.closes).toBe(0);
  });

  it('preserves the worker when every readiness observation misses the startup deadline', () => {
    const spawned = spawnOpenCode({
      onHttp: (input, clock) => {
        clock.advance(input.timeoutMs);
        throw new Error('spawnSync node ETIMEDOUT');
      },
    });
    expect(spawned.result.status).toBe('failed');
    if (spawned.result.status !== 'failed') return;
    expect(spawned.result.reason).toContain('worker_agent_not_started');
    expect(spawned.result.reason).toContain('inspect_the_preserved_child_panel_then_retry_from_the_exact_pr_head');
    expect(spawned.requests.length).toBeGreaterThan(1);
    expect(spawned.closes).toBe(0);
  });

  it('does not accept a replaced worker identity', () => {
    let probes = 0;
    const spawned = spawnOpenCode({
      onProbe: (root) => {
        probes += 1;
        return terminal(root, probes === 1 ? GENERATION : 'replacement-generation');
      },
      onHttp: () => ({ status: 200, body: JSON.stringify({ healthy: true, version: '1.18.25' }) }),
    });
    expect(spawned.result.status).toBe('failed');
    if (spawned.result.status !== 'failed') return;
    expect(spawned.result.reason).toContain('worker_agent_not_started');
    expect(spawned.result.reason).not.toContain('replacement-generation');
    expect(spawned.closes).toBe(0);
  });

  function spawnOpenCode(input: {
    readonly onHttp: (
      request: { readonly url: string; readonly timeoutMs: number; readonly workspacePath: string },
      clock: { advance: (milliseconds: number) => void },
    ) => { readonly status: number; readonly body: string };
    readonly onProbe?: (root: string) => OrcaTerminalSummary;
  }): {
    readonly result: ReturnType<OrcaTaskRuntimeAdapter['spawnWorker']>;
    readonly requests: Array<{ readonly url: string; readonly timeoutMs: number }>;
    readonly closes: number;
  } {
    const root = mkdtempSync(join(tmpdir(), 'opencode-probe-budget-'));
    roots.push(root);
    let clock = 0;
    let closes = 0;
    const requests: Array<{ url: string; timeoutMs: number }> = [];
    const runJson = <T>(args: readonly string[]): OrcaJsonResponse<T> => {
      if (args[0] === 'terminal' && args[1] === 'create') {
        return ok({
          terminal: {
            handle: HANDLE,
            title: 'opencode',
            incarnationId: GENERATION,
          },
        } as T);
      }
      if (args[0] === 'terminal' && args[1] === 'close') {
        closes += 1;
        return ok({ closed: true } as T);
      }
      throw new Error(args.join(' '));
    };
    const restore = installStableWorkerSmokeSpawnPatch({
      now: () => clock,
      sleepMs: (milliseconds) => {
        clock += milliseconds;
      },
      probe: (_handle, cwd) => ok({ terminal: input.onProbe?.(cwd) ?? terminal(cwd) }),
    });
    restores.push(restore);
    const adapter = new OrcaTaskRuntimeAdapter({
      cwd: root,
      now: () => clock,
      runJson,
      openCodeHttpRequest: (request) => {
        requests.push({ url: request.url, timeoutMs: request.timeoutMs });
        return input.onHttp({
          url: request.url,
          timeoutMs: request.timeoutMs,
          workspacePath: root,
        }, {
          advance: (milliseconds) => {
            clock += milliseconds;
          },
        });
      },
    });
    const result = adapter.spawnWorker({
      title: 'opencode',
      command: COMMAND,
      workspace: root,
    }, { cwd: root, timeoutMs: STARTUP_TIMEOUT_MS });
    return { result, requests, closes };
  }
});
