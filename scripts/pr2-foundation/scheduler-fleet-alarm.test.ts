// @vitest-ci-lane light
// @vitest-pre-topology-seconds 1
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FLEET_ALARM_INTERVAL_MS,
  runOrcaFleetAlarmTick,
  type OrcaFleetAlarmOptions,
} from '../cursor-unsent-composer-submit.ts';
import type { OrcaJsonResponse } from '../orca-runtime/native.ts';
import type { RuntimeAdapter, RuntimeWorker } from '../runtime/contracts.ts';

function coordinatorWorker(): RuntimeWorker {
  return {
    identity: { runtime: 'orca', id: 'term_coordinator', generation: 'g1' },
    workspacePath: '/tmp',
    title: 'coordinator',
    provenance: 'external',
  };
}

function adapter(): RuntimeAdapter {
  const worker = coordinatorWorker();
  return {
    findWorkerById: (id: string) => ({ status: 'ok', value: id === worker.identity.id ? worker : null }),
    findWorkerByPaneKey: () => ({ status: 'ok', value: worker }),
  } as unknown as RuntimeAdapter;
}

function fixture() {
  let current = 1_800_000_000_000;
  const messages: Array<{ id: string; run_id: string; to_handle: string; created_at: number; read?: boolean }> = [];
  let workers = [{ dispatchStatus: 'dispatched' }];
  let tasks: unknown[] = [];
  let failOperation = '';
  let sent = 0;
  const delivered: string[] = [];
  const runJson = (<T>(args: readonly string[]): OrcaJsonResponse<T> => {
    const operation = args.slice(0, 2).join(' ');
    if (operation === failOperation) return { ok: false, error: { code: 'fixture_failure' } } as OrcaJsonResponse<T>;
    if (operation === 'orchestration run-list') {
      return { ok: true, result: { runs: [{ id: 'run_alarm', coordinator_handle: 'term_coordinator' }] } } as OrcaJsonResponse<T>;
    }
    if (operation === 'orchestration inbox') {
      return { ok: true, result: { messages } } as OrcaJsonResponse<T>;
    }
    if (operation === 'orchestration run-show') {
      return { ok: true, result: { run: {
        id: 'run_alarm',
        coordinator_handle: 'term_coordinator',
        coordinator_pane_key: 'pane_coordinator',
      } } } as OrcaJsonResponse<T>;
    }
    if (operation === 'orchestration worker-list') {
      return { ok: true, result: { workers, page: { nextCursor: null } } } as OrcaJsonResponse<T>;
    }
    if (operation === 'orchestration task-list') {
      return { ok: true, result: { tasks, page: { nextCursor: null } } } as OrcaJsonResponse<T>;
    }
    if (operation === 'orchestration send') {
      sent += 1;
      const id = 'msg_alarm_' + String(sent);
      messages.unshift({ id, run_id: 'run_alarm', to_handle: 'run:run_alarm', created_at: current });
      return { ok: true, result: { message_id: id } } as OrcaJsonResponse<T>;
    }
    return { ok: false, error: { code: 'unexpected:' + operation } } as OrcaJsonResponse<T>;
  }) as typeof import('../orca-runtime/native.ts').runOrcaJson;
  return {
    options(lockPath: string): OrcaFleetAlarmOptions {
      return {
        now: () => current,
        lockPath,
        runJson,
        deliverMessage: async (messageId) => { delivered.push(messageId); },
      };
    },
    advance(ms: number) { current += ms; },
    addMail() {
      messages.unshift({
        id: 'msg_external_' + String(messages.length),
        run_id: 'run_alarm',
        to_handle: 'run:run_alarm',
        created_at: current,
      });
    },
    settleWorkers() { workers = [{ dispatchStatus: 'completed' }]; },
    setReadyTasks(value: unknown[]) { tasks = value; },
    fail(operation: string) { failOperation = operation; },
    get sent() { return sent; },
    get delivered() { return delivered; },
  };
}

describe('scheduler fleet alarm', () => {
  it('requests once per five-minute inbox-derived interval across fresh calls', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-fleet-alarm-'));
    try {
      const state = fixture();
      const first = await runOrcaFleetAlarmTick(adapter(), state.options(join(root, 'mail.lock')));
      expect(first.records[0]).toMatchObject({ runId: 'run_alarm', sentMessageId: 'msg_alarm_1', lastWakeAt: null });
      expect(state.delivered).toEqual(['msg_alarm_1']);

      state.advance(FLEET_ALARM_INTERVAL_MS / 2);
      const middle = await runOrcaFleetAlarmTick(adapter(), state.options(join(root, 'mail.lock')));
      expect(middle.records[0]).toMatchObject({ skippedReason: 'interval_not_elapsed' });
      expect(state.sent).toBe(1);

      state.advance(FLEET_ALARM_INTERVAL_MS / 2);
      const due = await runOrcaFleetAlarmTick(adapter(), state.options(join(root, 'mail.lock')));
      expect(due.records[0]).toMatchObject({ sentMessageId: 'msg_alarm_2' });
      expect(state.sent).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('lets any coordinator-addressed Run mail postpone the request', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-fleet-alarm-mail-'));
    try {
      const state = fixture();
      state.addMail();
      state.advance(200_000);
      const result = await runOrcaFleetAlarmTick(adapter(), state.options(join(root, 'mail.lock')));
      expect(result.records[0]).toMatchObject({ skippedReason: 'interval_not_elapsed' });
      expect(state.sent).toBe(0);
      state.advance(100_000);
      const due = await runOrcaFleetAlarmTick(adapter(), state.options(join(root, 'mail.lock')));
      expect(due.records[0]).toMatchObject({ sentMessageId: 'msg_alarm_1' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses ready Tasks as liveness and fails closed on unit-read uncertainty', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-fleet-alarm-live-'));
    try {
      const state = fixture();
      state.settleWorkers();
      const settled = await runOrcaFleetAlarmTick(adapter(), state.options(join(root, 'mail.lock')));
      expect(settled.records[0]).toMatchObject({ skippedReason: 'no_live_units' });

      state.setReadyTasks([{ id: 'task_ready' }]);
      const ready = await runOrcaFleetAlarmTick(adapter(), state.options(join(root, 'mail.lock')));
      expect(ready.records[0]).toMatchObject({ sentMessageId: 'msg_alarm_1' });

      state.advance(FLEET_ALARM_INTERVAL_MS);
      state.fail('orchestration worker-list');
      const failed = await runOrcaFleetAlarmTick(adapter(), state.options(join(root, 'mail.lock')));
      expect(failed.records[0]).toMatchObject({ skippedReason: 'units_unavailable' });
      expect(state.sent).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
