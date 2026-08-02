import { describe, expect, it } from 'vitest';
import { executeWatchRequest } from './watch.ts';
import type { WatchRequest } from '../lib/launch-watch/contract.ts';

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
      run: async () => result('{"ok":false,"error":{"opaque":"keep"}}'),
    });
    expect(unavailable).toMatchObject({ outcome: 'source-unavailable', reasonCode: 'orca_read_ok_false' });
    expect(unavailable.evidence).toHaveProperty('response.error');
  });
});
