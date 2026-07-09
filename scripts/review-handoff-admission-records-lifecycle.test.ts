import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  HANDOFF_LISTENER_RECOVERY_MAX_MS,
  HANDOFF_RECEIPT_TO_RUN_MAX_MS,
  HANDOFF_REPLAY_BATCH_SIZE_MAX,
  clearHandoffAdmissionRecord,
  deriveHandoffAdmissionId,
  formatHandoffRecordTransitionLine,
  isHandoffAdmissionIdActedOn,
  loadHandoffAdmissionState,
  prepareHandoffAdmissionRecordsForReplay,
  pruneHandoffAdmissionRecords,
  seedHandoffAdmissionRecord,
  selectHandoffAdmissionReplay,
  supersedeHandoffAdmissionRecords,
  updateHandoffAdmissionRecordOutcome,
} from '../docs/review-handoff-wake-admission.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const goldenFixture = JSON.parse(
  readFileSync(
    path.join(repoRoot, 'scripts/fixtures/review-handoff-admission/golden-prefix-bloated-store.json'),
    'utf8',
  ),
);

function baseAdmission(overrides: Record<string, unknown> = {}) {
  const listenerReadyMs = 1_700_000_000_000;
  const { subject: subjectOverride, ...rest } = overrides;
  return {
    subject: {
      projectId: 'orchestrator-pack',
      prNumber: 234,
      prUrl: 'https://github.com/chetwerikoff/orchestrator-pack/pull/234',
      sessionId: 'opk-27',
      priority: 'info',
      eventId: 'evt-handoff-234',
      receivedAtMs: listenerReadyMs,
      ...((subjectOverride as Record<string, unknown>) ?? {}),
    },
    admittedHeadSha: 'handoff234',
    admittedBaseRef: 'main',
    outcome: 'promoted',
    ...rest,
  };
}

function seedPair(headSha: string, prNumber: number, receivedAtMs: number, existing: Record<string, unknown> = {}) {
  return seedHandoffAdmissionRecord({
    existing,
    admission: baseAdmission({
      subject: {
        prNumber,
        receivedAtMs,
        eventId: `evt-${prNumber}-${headSha.slice(0, 6)}`,
      },
      admittedHeadSha: headSha,
    }),
    nowMs: receivedAtMs,
    openPrs: [{ number: prNumber, headRefOid: headSha, repoSlug: 'chetwerikoff/orchestrator-pack' }],
    openPrIndexTrusted: true,
  }) as { seeded: boolean; records: Record<string, unknown> };
}

describe('handoff admission records lifecycle (#712)', () => {
  it('AC1: evicts terminal and closed-merged records before replay', () => {
    const nowMs = 1_700_000_030_000;
    const openPrs = [{ number: 234, headRefOid: 'handoff234', repoSlug: 'chetwerikoff/orchestrator-pack' }];
    const terminal = seedPair('handoff234', 234, nowMs - 1_000);
    const closed = seedPair('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', 460, nowMs - 2_000, terminal.records);
    closed.records[Object.keys(closed.records).find((k) => k.includes('|460|'))!] = {
      ...(Object.values(closed.records).find((r) => (r as { prNumber: number }).prNumber === 460) as object),
      outcome: 'claim_win',
      reason: 'head_ready_for_review',
    };

    const pruned = pruneHandoffAdmissionRecords({
      records: closed.records,
      actedOn: {},
      openPrs: [],
      openPrIndexTrusted: true,
      nowMs,
    });
    expect(Object.keys(pruned.records)).toHaveLength(0);
    expect(pruned.evicted.length).toBeGreaterThanOrEqual(2);

    const fresh = seedPair('handoff234', 234, nowMs - 1_000);
    const kept = pruneHandoffAdmissionRecords({
      records: fresh.records,
      actedOn: {},
      openPrs,
      openPrIndexTrusted: true,
      nowMs,
    });
    expect(Object.keys(kept.records)).toHaveLength(1);

    const untrusted = pruneHandoffAdmissionRecords({
      records: fresh.records,
      actedOn: {},
      openPrs: [],
      openPrIndexTrusted: false,
      nowMs,
    });
    expect(Object.keys(untrusted.records)).toHaveLength(1);
  });

  it('AC2: delete-on-durable-trigger removes record and retains acted-on identity', () => {
    const seed = seedPair('handoff234', 234, 1_700_000_000_000);
    const key = Object.keys(seed.records)[0]!;
    const record = seed.records[key] as { admissionId: string };
    const cleared = clearHandoffAdmissionRecord({
      existing: seed.records,
      actedOn: {},
      key,
      nowMs: 1_700_000_001_000,
    }) as { cleared: boolean; records: Record<string, unknown>; actedOn: Record<string, unknown> };
    expect(cleared.cleared).toBe(true);
    expect(cleared.records[key]).toBeUndefined();
    expect(cleared.actedOn[record.admissionId]).toBeTruthy();

    const replay = selectHandoffAdmissionReplay({
      records: cleared.records,
      actedOn: cleared.actedOn,
      listenerReadyMs: 1_700_000_001_000,
      nowMs: 1_700_000_002_000,
      openPrs: [{ number: 234, headRefOid: 'handoff234' }],
      openPrIndexTrusted: true,
    }) as { replay: unknown[] };
    expect(replay.replay).toHaveLength(0);
  });

  it('AC3: newer head supersedes prior record for same PR', () => {
    const t0 = 1_700_000_000_000;
    const first = seedPair('aaaa'.repeat(10), 234, t0);
    const second = seedPair('bbbb'.repeat(10), 234, t0 + 1_000, first.records);
    expect(Object.keys(second.records)).toHaveLength(1);
    expect(Object.values(second.records)[0]).toMatchObject({ headSha: 'bbbb'.repeat(10) });

    const otherPr = seedPair('aaaa'.repeat(10), 519, t0, second.records);
    expect(Object.keys(otherPr.records)).toHaveLength(2);

    const stale = seedPair('aaaa'.repeat(10), 234, t0 - 5_000, second.records);
    expect(stale.seeded).toBe(false);
    expect(stale).toMatchObject({ reason: 'stale_head_regressed', noop: true });
  });

  it('AC4/AC7: aged-out and receipt-bound replay uses original receivedAtMs', () => {
    const listenerReadyMs = 1_700_000_000_000;
    const originalReceipt = listenerReadyMs - HANDOFF_RECEIPT_TO_RUN_MAX_MS - 5_000;
    const seed = seedPair('handoff234', 234, originalReceipt);
    const replay = selectHandoffAdmissionReplay({
      records: seed.records,
      actedOn: {},
      listenerReadyMs,
      nowMs: listenerReadyMs + 1_000,
      openPrs: [{ number: 234, headRefOid: 'handoff234' }],
      openPrIndexTrusted: true,
    }) as { replay: Array<{ originalReceivedAtMs?: number }>; evicted: unknown[] };
    expect(replay.replay).toHaveLength(0);
    expect(replay.evicted.length).toBeGreaterThan(0);

    const fresh = seedPair('handoff234', 234, listenerReadyMs - 2_000);
    const eligible = selectHandoffAdmissionReplay({
      records: fresh.records,
      actedOn: {},
      listenerReadyMs,
      nowMs: listenerReadyMs + 1_000,
      openPrs: [{ number: 234, headRefOid: 'handoff234' }],
      openPrIndexTrusted: true,
    }) as { replay: Array<{ originalReceivedAtMs?: number }> };
    expect(eligible.replay[0]?.originalReceivedAtMs).toBe(listenerReadyMs - 2_000);
  });

  it('AC5/AC18: replay batch cap and continuation cursor advance fairly', () => {
    const t0 = 1_700_000_000_000;
    let records: Record<string, unknown> = {};
    for (let i = 0; i < HANDOFF_REPLAY_BATCH_SIZE_MAX + 3; i += 1) {
      const seeded = seedPair(`head${String(i).padStart(32, '0')}`, 500 + i, t0 + i * 100, records);
      records = seeded.records;
    }
    const first = selectHandoffAdmissionReplay({
      records,
      actedOn: {},
      replayCursor: 0,
      listenerReadyMs: t0,
      nowMs: t0 + 1_000,
      openPrs: Object.keys(records).map((key, idx) => ({
        number: 500 + idx,
        headRefOid: (Object.values(records)[idx] as { headSha: string }).headSha,
      })),
      openPrIndexTrusted: true,
      batchSize: HANDOFF_REPLAY_BATCH_SIZE_MAX,
    }) as { replay: unknown[]; replayCursor: number; hasMore: boolean };
    expect(first.replay.length).toBe(HANDOFF_REPLAY_BATCH_SIZE_MAX);
    expect(first.hasMore).toBe(true);
    expect(first.replayCursor).toBeGreaterThan(0);

    const second = selectHandoffAdmissionReplay({
      records: first.records,
      actedOn: first.actedOn ?? {},
      replayCursor: first.replayCursor,
      listenerReadyMs: t0,
      nowMs: t0 + 2_000,
      openPrs: Object.keys(records).map((key, idx) => ({
        number: 500 + idx,
        headRefOid: (Object.values(records)[idx] as { headSha: string }).headSha,
      })),
      openPrIndexTrusted: true,
      batchSize: HANDOFF_REPLAY_BATCH_SIZE_MAX,
    }) as { replay: unknown[] };
    expect(second.replay.length).toBeGreaterThan(0);
  });

  it('AC6: per-record recovery-bound blocks replay after window elapses', () => {
    const listenerReadyMs = 1_700_000_000_000;
    const nowMs = listenerReadyMs + HANDOFF_LISTENER_RECOVERY_MAX_MS + 1_000;
    const seed = seedPair('handoff234', 234, nowMs - 2_000);
    const replay = selectHandoffAdmissionReplay({
      records: seed.records,
      actedOn: {},
      listenerReadyMs,
      nowMs,
      openPrs: [{ number: 234, headRefOid: 'handoff234' }],
      openPrIndexTrusted: true,
    }) as { replay: unknown[] };
    expect(replay.replay).toHaveLength(0);
  });

  it('AC8: idempotent re-seed and acted-on tombstone block duplicate records', () => {
    const seed = seedPair('handoff234', 234, 1_700_000_000_000);
    const key = Object.keys(seed.records)[0]!;
    const admissionId = (seed.records[key] as { admissionId: string }).admissionId;
    const dup = seedHandoffAdmissionRecord({
      existing: seed.records,
      actedOn: {},
      admission: baseAdmission({
        subject: {
          eventId: admissionId,
          receivedAtMs: 1_700_000_000_000,
        },
      }),
      nowMs: 1_700_000_000_100,
      openPrs: [{ number: 234, headRefOid: 'handoff234' }],
      openPrIndexTrusted: true,
    }) as { seeded: boolean; noop?: boolean };
    expect(dup.seeded).toBe(false);
    expect(dup.noop).toBe(true);

    const cleared = clearHandoffAdmissionRecord({ existing: seed.records, actedOn: {}, key, nowMs: 1_700_000_001_000 }) as {
      records: Record<string, unknown>;
      actedOn: Record<string, unknown>;
    };
    const afterDelete = seedHandoffAdmissionRecord({
      existing: cleared.records,
      actedOn: cleared.actedOn,
      admission: baseAdmission({
        subject: {
          eventId: admissionId,
          receivedAtMs: 1_700_000_000_000,
        },
      }),
      nowMs: 1_700_000_002_000,
      openPrs: [{ number: 234, headRefOid: 'handoff234' }],
      openPrIndexTrusted: true,
    }) as { seeded: boolean; noop?: boolean };
    expect(afterDelete.seeded).toBe(false);
    expect(isHandoffAdmissionIdActedOn({ admissionId, actedOn: cleared.actedOn }).actedOn).toBe(true);
  });

  it('AC9/AC10/AC19: closed PR eviction, supersede on replay, and repo normalization', () => {
    const t0 = 1_700_000_000_000;
    const seeded = seedPair('handoff234', 234, t0);
    const prepared = prepareHandoffAdmissionRecordsForReplay({
      records: seeded.records,
      actedOn: {},
      openPrs: [],
      openPrIndexTrusted: true,
      nowMs: t0 + 1_000,
    });
    expect(Object.keys(prepared.records)).toHaveLength(0);

    const oldHead = seedPair('aaaa'.repeat(10), 234, t0);
    const newHead = seedPair('bbbb'.repeat(10), 234, t0 + 1_000, oldHead.records);
    const superseded = supersedeHandoffAdmissionRecords({
      records: { ...oldHead.records, ...newHead.records },
      openPrs: [{ number: 234, headRefOid: 'bbbb'.repeat(10), repoSlug: 'ChetWerikoff/Orchestrator-Pack' }],
      openPrIndexTrusted: true,
      nowMs: t0 + 2_000,
    }) as { records: Record<string, unknown> };
    expect(Object.keys(superseded.records)).toHaveLength(1);
  });

  it('AC12: corrupt store loads fail-closed without replay storm defaults', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'handoff-corrupt-'));
    const statePath = path.join(dir, 'review-handoff-wake-admission.json');
    writeFileSync(statePath, '{not-json');
    const loaded = loadHandoffAdmissionState(statePath);
    expect(loaded.corrupt).toBe(true);
    expect(loaded.records).toEqual({});
    expect(loaded.actedOn).toEqual({});
  });

  it('AC14/AC20: golden pre-fix store shrinks after one recovery prepare pass', () => {
    const prepared = prepareHandoffAdmissionRecordsForReplay({
      records: goldenFixture.records,
      actedOn: goldenFixture.actedOn ?? {},
      openPrs: goldenFixture.openPrs,
      openPrIndexTrusted: true,
      nowMs: goldenFixture.nowMs,
    }) as { records: Record<string, unknown>; evicted: unknown[]; superseded: unknown[] };
    const remaining = Object.keys(prepared.records).length;
    expect(remaining).toBeLessThan(Object.keys(goldenFixture.records).length);
    expect(prepared.evicted.length + prepared.superseded.length).toBeGreaterThan(0);

    const secondPass = prepareHandoffAdmissionRecordsForReplay({
      records: prepared.records,
      actedOn: prepared.actedOn,
      openPrs: goldenFixture.openPrs,
      openPrIndexTrusted: true,
      nowMs: goldenFixture.nowMs + 60_000,
    });
    expect(Object.keys(secondPass.records).length).toBe(remaining);
  });

  it('AC15: crash between durable-start and delete clears without duplicate trigger', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'handoff-crash-'));
    const stateRoot = dir;
    const t0 = 1_700_000_000_000;
    const seed = seedPair('handoff234', 234, t0);
    const key = Object.keys(seed.records)[0]!;
    const updated = updateHandoffAdmissionRecordOutcome({
      existing: seed.records,
      key,
      outcome: 'claim_win',
      reason: 'durable_trigger',
      durableTriggerPersisted: true,
      nowMs: t0 + 1_000,
    }) as { records: Record<string, unknown> };
    writeFileSync(
      path.join(dir, 'review-handoff-wake-admission.json'),
      JSON.stringify({
        records: updated.records,
        pendingRetries: {},
        actedOn: {},
        replayCursor: 0,
        lastUpdatedMs: t0,
      }),
    );
    const lib = path.join(repoRoot, 'scripts/lib/Record-ReviewHandoffWakeAdmission.ps1');
    const triggerCalls = { value: 0 };
    const script = [
      `. '${lib.replace(/'/g, "''")}'`,
      `$calls = 0`,
      `Invoke-ReviewHandoffWakeAdmissionRecovery -StateRoot '${stateRoot.replace(/'/g, "''")}' -ListenerReadyMs ${t0} \``,
      '  -InvokeWakeFilter { throw "filter should not run" } `',
      '  -ResolveOpenPrs { return @(@{ number = 234; headRefOid = \'handoff234\'; baseRefName = \'main\' }) } `',
      '  -InvokeTrigger { $script:calls++; throw "trigger should not run after durable persist" } `',
      '  -LogWriter { param($Message) }',
      '$calls',
    ].join('\n');
    const result = spawnSync('pwsh', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(Number(result.stdout.trim())).toBe(0);
    const state = JSON.parse(readFileSync(path.join(dir, 'review-handoff-wake-admission.json'), 'utf8'));
    expect(Object.keys(state.records)).toHaveLength(0);
    expect(Object.keys(state.actedOn).length).toBeGreaterThan(0);
  });

  it('AC16: destructive transitions emit structured listener-log lines', () => {
    const line = formatHandoffRecordTransitionLine({
      transition: 'evict',
      reason: 'closed_merged_absent_from_index',
      key: 'orchestrator-pack|chetwerikoff/orchestrator-pack|234|abc',
      admissionId: 'evt-handoff-234',
      prNumber: 234,
      headSha: 'abc',
    });
    expect(line).toContain('transition=evict');
    expect(line).toContain('admissionId=evt-handoff-234');
    expect(line).toContain('pr=#234');
  });

  it('AC17: stale receipt-bound outcomes are reclassified before terminal eviction', () => {
    const t0 = 1_700_000_000_000;
    const key = 'orchestrator-pack|chetwerikoff/orchestrator-pack|234|handoff234';
    const records = {
      [key]: {
        key,
        admissionId: 'evt-1',
        projectId: 'orchestrator-pack',
        repoSlug: 'chetwerikoff/orchestrator-pack',
        prNumber: 234,
        headSha: 'handoff234',
        sessionId: 'opk-27',
        receivedAtMs: t0 - 5_000,
        outcome: 'handoff_receipt_bound_exceeded',
        reason: 'handoff_receipt_bound_exceeded',
      },
    };
    const kept = pruneHandoffAdmissionRecords({
      records,
      actedOn: {},
      openPrs: [{ number: 234, headRefOid: 'handoff234' }],
      openPrIndexTrusted: true,
      nowMs: t0,
    }) as { records: Record<string, unknown>; evicted: unknown[] };
    expect(Object.keys(kept.records)).toHaveLength(1);
    expect(kept.evicted).toHaveLength(0);

    const aged = pruneHandoffAdmissionRecords({
      records,
      actedOn: {},
      openPrs: [{ number: 234, headRefOid: 'handoff234' }],
      openPrIndexTrusted: true,
      nowMs: t0 + HANDOFF_RECEIPT_TO_RUN_MAX_MS + 10_000,
    }) as { evicted: unknown[] };
    expect(aged.evicted).toHaveLength(1);
  });

  it('derives stable admission ids from event id or receipt tuple', () => {
    expect(deriveHandoffAdmissionId({ eventId: 'evt-1' })).toBe('evt-1');
    expect(
      deriveHandoffAdmissionId({
        sessionId: 'opk-27',
        prNumber: 234,
        receivedAtMs: 1,
        headSha: 'abc',
      }),
    ).toContain('opk-27|234|');
  });
});
