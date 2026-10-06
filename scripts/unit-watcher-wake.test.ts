import { describe, expect, it } from 'vitest';
import type { ProcessResult, RunProcessSyncOptions } from './kernel/subprocess.ts';
import {
  runUnitWatcherWake,
  type UnitWatcherWakeConfig,
  type WatcherCommandRunner,
} from './unit-watcher-wake.ts';

const config: UnitWatcherWakeConfig = {
  watchTerminal: 'term_job',
  targetTerminal: 'term_unit',
  wakeText: 'WATCHER: term_job exited; resume and inspect its result',
  waitTimeoutMs: 1_000,
};

function result(
  stdout: string,
  options: { readonly status?: number; readonly stderr?: string } = {},
): ProcessResult {
  const status = options.status ?? 0;
  return {
    outcome: 'exit',
    ok: status === 0,
    exitCode: status,
    signal: null,
    stdout,
    stderr: options.stderr ?? '',
    timedOut: false,
    cancelled: false,
  };
}

function runner(
  queued: readonly ProcessResult[],
  calls: RunProcessSyncOptions[],
): WatcherCommandRunner {
  let index = 0;
  return (options) => {
    calls.push(options);
    const next = queued[index];
    index += 1;
    if (!next) throw new Error('unexpected command invocation');
    return next;
  };
}

const waitConfirmed = result(JSON.stringify({
  ok: true,
  result: {
    wait: {
      condition: 'exit',
      satisfied: true,
      status: 'exited',
      exitCode: 0,
    },
  },
}) + '\n');

const sendConfirmed = result(JSON.stringify({
  ok: true,
  result: { send: { accepted: true } },
}) + '\n');

describe('unit watcher wake', () => {
  it('includes --enter in the submitted wake payload path', () => {
    const calls: RunProcessSyncOptions[] = [];
    const output = runUnitWatcherWake(config, {
      executable: 'orca',
      run: runner([waitConfirmed, sendConfirmed], calls),
    });

    expect(output.exitCode).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.args).toEqual([
      'terminal', 'send',
      '--terminal', 'term_unit',
      '--text', config.wakeText,
      '--enter',
      '--json',
    ]);
  });

  it('reports success only when Orca confirms accepted:true', () => {
    const output = runUnitWatcherWake(config, {
      executable: 'orca',
      run: runner([waitConfirmed, sendConfirmed], []),
    });

    expect(output).toEqual({
      exitCode: 0,
      stdout: 'watcher wake submission confirmed: accepted:true target=term_unit\n',
      stderr: '',
    });
  });

  it('returns non-zero for delivery-unknown output and surfaces the exact command output', () => {
    const raw = '{"ok":true,"result":{"delivery":"unknown"}}\n';
    const output = runUnitWatcherWake(config, {
      executable: 'orca',
      run: runner([waitConfirmed, result(raw)], []),
    });

    expect(output.exitCode).toBe(1);
    expect(output.stderr).toContain('delivery-unknown');
    expect(output.stderr).toContain(raw);
  });

  it('fails loudly for a missing target and surfaces the exact failing command output', () => {
    const raw = '{"ok":false,"error":{"code":"terminal_not_found","message":"term_missing"}}\n';
    const output = runUnitWatcherWake(
      { ...config, targetTerminal: 'term_missing' },
      {
        executable: 'orca',
        run: runner([waitConfirmed, result(raw)], []),
      },
    );

    expect(output.exitCode).toBe(1);
    expect(output.stderr).toContain('terminal send was not accepted');
    expect(output.stderr).toContain(raw);
  });
});
