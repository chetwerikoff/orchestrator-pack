import type { spawnSync } from 'node:child_process';
import { createOrcaRuntimeAdapter } from './adapter.ts';

function runnerFrom(payloads: readonly unknown[], calls: string[][]): typeof spawnSync {
  let index = 0;
  return ((command: string, args: readonly string[]) => {
    calls.push([command, ...args]);
    const payload = payloads[index];
    index += 1;
    return {
      pid: 1,
      output: [null, JSON.stringify(payload), ''],
      stdout: JSON.stringify(payload),
      stderr: '',
      status: 0,
      signal: null,
      error: undefined,
    };
  }) as unknown as typeof spawnSync;
}

export function registerOrcaAdapterCases(input: {
  readonly describe: typeof import('vitest').describe;
  readonly expect: typeof import('vitest').expect;
  readonly it: typeof import('vitest').it;
}): void {
  const { describe, expect, it } = input;
  describe('Orca runtime adapter', () => {
    it('maps spawn, one-attempt dispatch, bounded output, and busy/idle liveness', () => {
      const calls: string[][] = [];
      const adapter = createOrcaRuntimeAdapter({
        cwd: '/workspace',
        executable: 'orca-test',
        runner: runnerFrom([
          { ok: true, result: { terminal: { handle: 'term-a', worktreeId: 'wt', title: 'worker' } } },
          { ok: true, result: { send: { handle: 'term-a', bytesWritten: 4 } } },
          { ok: true, result: { lines: [], nextCursor: 7 } },
          { ok: true, result: { lines: ['new'], nextCursor: 8 } },
          { ok: true, result: { wait: { satisfied: false, status: 'running' } } },
          { ok: true, result: { wait: { satisfied: true, status: 'running' } } },
        ], calls),
      });
      const spawned = adapter.spawnWorker({
        workspacePath: '/workspace', title: 'worker', command: 'codex', timeoutMs: 100,
      });
      expect(spawned.status).toBe('ok');
      if (spawned.status !== 'ok') return;
      expect(spawned.value.provenance).toBe('internal');
      expect(spawned.value.runtime).toBe('orca');

      expect(adapter.sendInput({ identity: spawned.value.identity, text: 'work', timeoutMs: 100 }))
        .toEqual({ status: 'dispatched', attempts: 1 });

      const baseline = adapter.readBoundedOutput({ identity: spawned.value.identity, limit: 20 });
      expect(baseline.status).toBe('ok');
      if (baseline.status !== 'ok') return;
      const changed = adapter.readBoundedOutput({
        identity: spawned.value.identity,
        previousObservationToken: baseline.value.observationToken,
        limit: 20,
      });
      expect(changed.status === 'ok' && changed.value.changed).toBe(true);
      expect(adapter.liveness({ identity: spawned.value.identity, boundMs: 25 })).toBe('busy');
      expect(adapter.liveness({ identity: spawned.value.identity, boundMs: 25 })).toBe('idle');
      expect(calls.filter((call) => call[1] === 'terminal' && call[2] === 'send')).toHaveLength(1);
    });

    it('returns same-workspace external workers without granting ownership', () => {
      const calls: string[][] = [];
      const adapter = createOrcaRuntimeAdapter({
        executable: 'orca-test',
        runner: runnerFrom([
          {
            ok: true,
            result: {
              terminals: [{
                handle: 'external-handle', title: 'outside', connected: true,
                worktreePath: '/workspace', tabId: 'tab', leafId: 'leaf',
              }],
            },
          },
        ], calls),
      });
      const listed = adapter.listWorkers({ workspacePath: '/workspace' });
      expect(listed.status).toBe('ok');
      if (listed.status !== 'ok') return;
      expect(listed.value).toHaveLength(1);
      expect(listed.value[0]?.provenance).toBe('external');
      expect(adapter.stopWorker({ identity: listed.value[0]!.identity }))
        .toEqual({ status: 'not_owned', reason: 'external_worker_not_owned' });
      expect(calls).toHaveLength(1);
    });

    it('changes generation when Orca reports a new terminal incarnation', () => {
      const adapter = createOrcaRuntimeAdapter({
        executable: 'orca-test',
        runner: runnerFrom([
          { ok: true, result: { terminals: [{
            handle: 'same-handle', worktreePath: '/workspace', title: 'worker',
            tabId: 'tab', leafId: 'leaf', ptyId: 'pty', incarnationId: 'incarnation-a',
          }] } },
          { ok: true, result: { terminals: [{
            handle: 'same-handle', worktreePath: '/workspace', title: 'worker',
            tabId: 'tab', leafId: 'leaf', ptyId: 'pty', incarnationId: 'incarnation-b',
          }] } },
        ], []),
      });
      const first = adapter.listWorkers({ workspacePath: '/workspace' });
      const second = adapter.listWorkers({ workspacePath: '/workspace' });
      if (first.status !== 'ok' || second.status !== 'ok') throw new Error('list failed');
      expect(second.value[0]?.identity.id).toBe(first.value[0]?.identity.id);
      expect(second.value[0]?.identity.generation).not.toBe(first.value[0]?.identity.generation);
    });

    it('accepts string native cursors but exposes only opaque observation tokens', () => {
      const adapter = createOrcaRuntimeAdapter({
        executable: 'orca-test',
        runner: runnerFrom([
          { ok: true, result: { terminal: { handle: 'term-b' } } },
          { ok: true, result: { terminal: { tail: [], nextCursor: 'cursor-a' } } },
          { ok: true, result: { terminal: { tail: [], nextCursor: 'cursor-a' } } },
        ], []),
      });
      const spawned = adapter.spawnWorker({ workspacePath: '/workspace', title: 'worker', command: 'codex' });
      if (spawned.status !== 'ok') throw new Error('spawn failed');
      const first = adapter.readBoundedOutput({ identity: spawned.value.identity });
      if (first.status !== 'ok') throw new Error('read failed');
      const second = adapter.readBoundedOutput({
        identity: spawned.value.identity,
        previousObservationToken: first.value.observationToken,
      });
      expect(second.status).toBe('ok');
      if (second.status !== 'ok') return;
      expect(second.value.changed).toBe(false);
      expect(second.value.observationToken).toBe(first.value.observationToken);
      expect(String(second.value.observationToken)).not.toContain('cursor-a');
    });

    it('maps ambiguous dispatch to dispatch_unknown without an automatic resend', () => {
      const calls: string[][] = [];
      const adapter = createOrcaRuntimeAdapter({
        executable: 'orca-test',
        runner: runnerFrom([
          { ok: true, result: { terminal: { handle: 'term-c' } } },
          { ok: false, error: { code: 'orca_operation_timeout' } },
        ], calls),
      });
      const spawned = adapter.spawnWorker({ workspacePath: '/workspace', title: 'worker', command: 'codex' });
      if (spawned.status !== 'ok') throw new Error('spawn failed');
      expect(adapter.sendInput({ identity: spawned.value.identity, text: 'work' }))
        .toEqual({ status: 'dispatch_unknown', attempts: 1, reason: 'orca_operation_timeout' });
      expect(calls.filter((call) => call[2] === 'send')).toHaveLength(1);
    });

    it('fails closed when a consumed Orca response field drifts', () => {
      const adapter = createOrcaRuntimeAdapter({
        executable: 'orca-test',
        runner: runnerFrom([
          { ok: true, result: { terminal: { handle: 'term-d' } } },
          { ok: true, result: { terminal: { tail: [] } } },
        ], []),
      });
      const spawned = adapter.spawnWorker({ workspacePath: '/workspace', title: 'worker', command: 'codex' });
      if (spawned.status !== 'ok') throw new Error('spawn failed');
      expect(adapter.readBoundedOutput({ identity: spawned.value.identity }))
        .toEqual({ status: 'unsupported', reason: 'orca_read_invalid_response_shape' });
    });
  });
}
