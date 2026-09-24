// @vitest-ci-lane light
// @vitest-pre-topology-seconds 1
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FLEET_ALARM_INTERVAL_MS,
  buildDeliveryPointer,
  runOrcaFleetAlarmTick,
  runOrchestrationMailReconcileTick,
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
  type FixtureInboxMessage = {
    readonly id: string;
    readonly run_id: string;
    readonly to_handle: string;
    readonly created_at: number;
    readonly read: boolean;
  };
  const messages: FixtureInboxMessage[] = [];
  let activeComposerMessageId: string | undefined;
  let activeComposerPointerVisible = false;
  const submitCounts = new Map<string, number>();
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
      messages.unshift({ id, run_id: 'run_alarm', to_handle: 'run:run_alarm', created_at: current, read: false });
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
    productionOptions(lockPath: string, reconcileLedgerPath: string): OrcaFleetAlarmOptions {
      return {
        now: () => current,
        lockPath,
        runJson,
        reconcileLedgerPath,
      };
    },
    advance(ms: number) { current += ms; },
    addMail() {
      messages.unshift({
        id: 'msg_external_' + String(messages.length),
        run_id: 'run_alarm',
        to_handle: 'run:run_alarm',
        created_at: current,
        read: false,
      });
    },
    markRead(messageId: string) {
      const index = messages.findIndex((message) => message.id === messageId);
      if (index < 0) throw new Error(`fixture message not found: ${messageId}`);
      messages[index] = { ...messages[index]!, read: true };
    },
    lookupMessage(messageId: string) {
      const row = messages.find((message) => message.id === messageId);
      if (!row) return { ok: false as const, reason: 'fixture_message_missing' };
      return {
        ok: true as const,
        message: {
          id: row.id,
          runId: row.run_id,
          recipient: row.to_handle,
          consumed: row.read,
        },
      };
    },
    activateComposer(messageId: string) {
      if (!messages.some((message) => message.id === messageId)) {
        throw new Error(`fixture composer message not found: ${messageId}`);
      }
      activeComposerMessageId = messageId;
      activeComposerPointerVisible = true;
    },
    readComposer() {
      const row = messages.find((message) => message.id === activeComposerMessageId);
      if (!row) return { ok: false as const, reason: 'fixture_active_composer_missing' };
      const lookedUp = {
        id: row.id,
        runId: row.run_id,
        recipient: row.to_handle,
        consumed: row.read,
      };
      return {
        ok: true as const,
        lines: activeComposerPointerVisible ? [buildDeliveryPointer(lookedUp)] : ['→ Add a follow-up'],
        source: 'screen' as const,
      };
    },
    submitComposer() {
      if (!activeComposerMessageId) return { status: 'send_failed' as const, reason: 'fixture_active_composer_missing' };
      submitCounts.set(activeComposerMessageId, (submitCounts.get(activeComposerMessageId) ?? 0) + 1);
      activeComposerPointerVisible = false;
      return { status: 'dispatched' as const };
    },
    submitCount(messageId: string) { return submitCounts.get(messageId) ?? 0; },
    settleWorkers() { workers = [{ dispatchStatus: 'completed' }]; },
    setReadyTasks(value: unknown[]) { tasks = value; },
    fail(operation: string) { failOperation = operation; },
    get sent() { return sent; },
    get delivered() { return delivered; },
    get inbox(): readonly FixtureInboxMessage[] {
      return messages.map((message) => ({ ...message }));
    },
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

  it('joins the exact alarm inbox row to one busy coordinator reconcile episode', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-fleet-alarm-reconcile-'));
    try {
      const state = fixture();
      const alarm = await runOrcaFleetAlarmTick(adapter(), state.options(join(root, 'alarm.lock')));
      const sentMessageId = alarm.records[0]?.sentMessageId;
      expect(sentMessageId).toBe('msg_alarm_1');
      const inboxRow = state.inbox.find((message) => message.id === sentMessageId);
      expect(inboxRow).toMatchObject({
        id: sentMessageId,
        run_id: 'run_alarm',
        to_handle: 'run:run_alarm',
        read: false,
      });
      expect(inboxRow).toBeDefined();
      const lookedUpMessage = {
        id: inboxRow!.id,
        runId: inboxRow!.run_id,
        recipient: inboxRow!.to_handle,
        consumed: inboxRow!.read,
      };
      const coordinator = coordinatorWorker();
      const pointer = buildDeliveryPointer(lookedUpMessage);
      let pointerVisible = true;
      let submitOnlyEnters = 0;
      const submitDeps = {
        listWorkers: () => ({ ok: true as const, workers: [coordinator] }),
        read: () => ({
          ok: true as const,
          lines: pointerVisible ? [pointer] : ['→ Add a follow-up'],
          source: 'screen' as const,
        }),
        liveness: () => 'busy' as const,
        submit: () => {
          submitOnlyEnters += 1;
          pointerVisible = false;
          return { status: 'dispatched' as const };
        },
      };
      const reconcileDeps = {
        readInbox: () => ({ ok: true as const, result: { messages: state.inbox } }),
        lookupMessage: (messageId: string) => {
          expect(messageId).toBe(sentMessageId);
          return { ok: true as const, message: lookedUpMessage };
        },
        resolveWorker: (message: typeof lookedUpMessage) => {
          expect(message).toEqual(lookedUpMessage);
          return { ok: true as const, worker: coordinator };
        },
        isMessageRetrievable: (message: typeof lookedUpMessage) => {
          expect(message).toEqual(lookedUpMessage);
          return { ok: true as const };
        },
        submitDeps,
      };
      const options = {
        ledgerPath: join(root, 'reconcile-ledger.json'),
        lockPath: join(root, 'reconcile.lock'),
        now: () => 1_800_000_000_000,
      };
      const first = await runOrchestrationMailReconcileTick(reconcileDeps, options);
      expect(submitOnlyEnters).toBe(2);
      expect(first.deliveryEvidence).toEqual([{
        workerGeneration: coordinator.identity.generation,
        runId: 'run_alarm',
        messageId: sentMessageId,
        delivery: 'delivered-looking',
        terminalReceipt: 'unproven',
      }]);
      expect(first.reasons).toEqual([`${sentMessageId}:enter_sent`]);
      expect(pointerVisible).toBe(false);
      const second = await runOrchestrationMailReconcileTick(reconcileDeps, options);
      expect(second.deliveryEvidence).toEqual([]);
      expect(second.reasons).toEqual([`${sentMessageId}:orchestration_episode_already_delivered`]);
      expect(submitOnlyEnters).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('runs six production five-minute live ticks, then suppresses settled alarms', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-fleet-alarm-scenario-6-'));
    try {
      const state = fixture();
      const lockPath = join(root, 'reconcile.lock');
      const ledgerPath = join(root, 'reconcile-ledger.json');
      const coordinator = coordinatorWorker();
      const t0 = 1_800_000_000_000;
      for (let tick = 0; tick < 6; tick += 1) {
        if (tick > 0) state.advance(FLEET_ALARM_INTERVAL_MS);
        const alarmOptions = state.productionOptions(lockPath, ledgerPath);
        const alarm = await runOrcaFleetAlarmTick(adapter(), alarmOptions);
        const sentMessageId = alarm.records[0]?.sentMessageId;
        expect(alarm.records).toHaveLength(1);
        expect(alarm.records[0]).toMatchObject({
          runId: 'run_alarm',
          lastWakeAt: tick === 0 ? null : t0 + (tick - 1) * FLEET_ALARM_INTERVAL_MS,
        });
        expect(sentMessageId).toBe(`msg_alarm_${tick + 1}`);
        if (sentMessageId === undefined) throw new Error('fleet alarm message id missing');
        expect(state.sent).toBe(tick + 1);
        const inboxRow = state.inbox.find((message) => message.id === sentMessageId);
        expect(inboxRow).toMatchObject({
          id: sentMessageId,
          run_id: 'run_alarm',
          to_handle: 'run:run_alarm',
          read: false,
        });
        expect(inboxRow).toBeDefined();
        const lookedUpMessage = {
          id: inboxRow!.id,
          runId: inboxRow!.run_id,
          recipient: inboxRow!.to_handle,
          consumed: inboxRow!.read,
        };
        state.activateComposer(sentMessageId);
        const submitDeps = {
          listWorkers: () => ({ ok: true as const, workers: [coordinator] }),
          read: () => state.readComposer(),
          liveness: () => 'busy' as const,
          submit: () => state.submitComposer(),
        };
        const reconcileDeps = {
          readInbox: () => ({ ok: true as const, result: { messages: state.inbox } }),
          lookupMessage: (messageId: string) => {
            const lookedUp = state.lookupMessage(messageId);
            if (!lookedUp.ok) return lookedUp;
            expect(lookedUp.message.id).toBe(sentMessageId);
            return lookedUp;
          },
          resolveWorker: (message: typeof lookedUpMessage) => {
            expect(message.id).toBe(sentMessageId);
            expect(message.runId).toBe('run_alarm');
            expect(message.recipient).toBe('run:run_alarm');
            return { ok: true as const, worker: coordinator };
          },
          isMessageRetrievable: (message: typeof lookedUpMessage) => {
            expect(message.id).toBe(sentMessageId);
            return { ok: true as const };
          },
          submitDeps,
        };
        const reconcileOptions = {
          ledgerPath,
          lockPath,
          now: alarmOptions.now,
          maxMessages: 1,
        };
        const first = await runOrchestrationMailReconcileTick(reconcileDeps, reconcileOptions);
        expect(first.deliveryEvidence).toEqual([{
          workerGeneration: coordinator.identity.generation,
          runId: 'run_alarm',
          messageId: sentMessageId,
          delivery: 'delivered-looking',
          terminalReceipt: 'unproven',
        }]);
        expect(first.deliveryEvidence[0]?.messageId).toBe(sentMessageId);
        expect(state.submitCount(sentMessageId)).toBe(2);
        expect(state.inbox.find((message) => message.id === sentMessageId)?.read).toBe(false);
        state.markRead(sentMessageId);
        expect(state.inbox.find((message) => message.id === sentMessageId)?.read).toBe(true);
        const duplicate = await runOrchestrationMailReconcileTick(reconcileDeps, reconcileOptions);
        expect(duplicate.deliveryEvidence).toEqual([]);
        expect(duplicate.reasons).toEqual([`${sentMessageId}:orchestration_episode_already_delivered`]);
        expect(state.submitCount(sentMessageId)).toBe(2);
      }
      expect(state.sent).toBe(6);
      state.settleWorkers();
      for (let tick = 0; tick < 3; tick += 1) {
        state.advance(FLEET_ALARM_INTERVAL_MS);
        const settled = await runOrcaFleetAlarmTick(
          adapter(),
          state.productionOptions(lockPath, ledgerPath),
        );
        expect(settled.records).toHaveLength(1);
        expect(settled.records[0]).toMatchObject({ skippedReason: 'no_live_units' });
        expect(settled.records[0]?.sentMessageId).toBeUndefined();
        expect(state.sent).toBe(6);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
