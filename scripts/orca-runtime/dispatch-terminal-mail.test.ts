// @vitest-ci-lane light
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DISPATCH_TERMINAL_MAIL_TYPE,
  maybeNotifyRunOnTerminalDispatch,
  runDispatchTerminalMailPulse,
  snapshotFromWorkerShow,
  type DispatchTerminalSnapshot,
} from './dispatch-terminal-mail.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function ledgerPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'dispatch-terminal-mail-'));
  roots.push(root);
  return join(root, 'ledger.json');
}

function terminalSnapshot(overrides: Partial<DispatchTerminalSnapshot> = {}): DispatchTerminalSnapshot {
  return {
    dispatchId: 'ctx_terminal',
    runId: 'run_coordinator',
    state: 'failed',
    stage: 'settled',
    lastError: 'process_exited',
    dispatchStatus: 'failed',
    observationStatus: 'exited',
    ...overrides,
  };
}

describe('dispatch-terminal-mail', () => {
  it('parses worker-show run binding and terminal fields', () => {
    const snapshot = snapshotFromWorkerShow('ctx_terminal', {
      dispatch: {
        id: 'ctx_terminal',
        run_id: 'run_coordinator',
        status: 'failed',
      },
      worker: {
        state: 'failed',
        stage: 'settled',
        last_error: 'process_exited',
      },
      observation: { exactWorker: true, status: 'exited' },
    });
    expect(snapshot).toEqual(terminalSnapshot());
  });

  it('sends exactly one orchestration message to the bound Run on terminal transition', () => {
    const file = ledgerPath();
    const sends: unknown[][] = [];
    const runJson = vi.fn((args: readonly string[]) => {
      sends.push([...args]);
      return {
        ok: true,
        result: { message_id: 'msg_terminal_once' },
      };
    });
    const snapshot = terminalSnapshot();
    const first = maybeNotifyRunOnTerminalDispatch(snapshot, { ledgerPath: file, runJson, deliverMessage: null });
    const second = maybeNotifyRunOnTerminalDispatch(snapshot, { ledgerPath: file, runJson, deliverMessage: null });
    expect(first).toMatchObject({ outcome: 'sent', messageId: 'msg_terminal_once' });
    expect(second).toMatchObject({ outcome: 'duplicate', reason: 'terminal_already_notified' });
    expect(sends).toHaveLength(1);
    expect(sends[0]).toEqual([
      'orchestration', 'send',
      '--run', 'run_coordinator',
      '--type', DISPATCH_TERMINAL_MAIL_TYPE,
      '--subject', 'Worker dispatch terminal: failed',
      '--body', 'A supervised worker Dispatch reached a terminal lifecycle state.',
      '--dispatch-id', 'ctx_terminal',
      '--payload', JSON.stringify({
        dispatch_id: 'ctx_terminal',
        state: 'failed',
        stage: 'settled',
        last_error: 'process_exited',
      }),
      '--json',
    ]);
    const ledger = JSON.parse(readFileSync(file, 'utf8')) as { notified: Record<string, string> };
    expect(Object.keys(ledger.notified)).toEqual(['ctx_terminal']);
  });

  it('observes worker-show and notifies through the scheduler pulse seam', () => {
    const file = ledgerPath();
    const runJson = vi.fn((args: readonly string[]) => {
      if (args[0] === 'orchestration' && args[1] === 'worker-show') {
        return {
          ok: true,
          result: {
            dispatch: { id: 'ctx_pulse', run_id: 'run_pulse', status: 'failed' },
            worker: { state: 'succeeded', stage: 'settled', last_error: null },
            observation: { exactWorker: true, status: 'running' },
          },
        };
      }
      return { ok: true, result: { message_id: 'msg_pulse' } };
    });
    const pulse = runDispatchTerminalMailPulse({
      dispatchIds: ['ctx_pulse', 'ctx_pulse'],
      deps: { ledgerPath: file, runJson, deliverMessage: null },
    });
    expect(pulse).toMatchObject({ examined: 2, sent: 1, duplicate: 1, failed: 0 });
    expect(runJson.mock.calls.filter((call) => call[0]?.[1] === 'send')).toHaveLength(1);
  });

  it('suppresses a second send when terminal observation fields evolve for the same dispatch', () => {
    const file = ledgerPath();
    const sends: unknown[][] = [];
    const runJson = vi.fn((args: readonly string[]) => {
      if (args[0] === 'orchestration' && args[1] === 'send') {
        sends.push([...args]);
        return { ok: true, result: { message_id: 'msg_evolve_once' } };
      }
      return { ok: true, result: {} };
    });
    const firstSnapshot = terminalSnapshot({ observationStatus: 'running' });
    const evolvedSnapshot = terminalSnapshot({ observationStatus: 'exited', state: 'failed' });
    expect(maybeNotifyRunOnTerminalDispatch(firstSnapshot, { ledgerPath: file, runJson, deliverMessage: null }).outcome).toBe('sent');
    expect(maybeNotifyRunOnTerminalDispatch(evolvedSnapshot, { ledgerPath: file, runJson, deliverMessage: null })).toMatchObject({
      outcome: 'duplicate',
      reason: 'terminal_already_notified',
    });
    expect(sends).toHaveLength(1);
  });
});
