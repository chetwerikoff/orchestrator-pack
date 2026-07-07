import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RECOVERY_REASON_AMBIGUOUS_STALE,
  RECOVERY_REASON_LEGACY_AMBIGUOUS,
  RECOVERY_REASON_PROVABLY_DEAD,
  captureReviewerLiveness,
  classifyReviewerLiveness,
  classifyReviewStatus,
  evaluateRecoveryForRun,
  fingerprintRun,
  runRecoveryTick,
  terminalizeRunRecord,
  validateRecoveryConfig,
} from '../docs/review-run-recovery.mjs';
import {
  drainTempRoots,
  readRecoveryAudit,
  readRecoveryRun,
  tempRecoveryStore,
  writeRecoveryRun,
} from './lib/review-recovery-test-fixtures.js';

function tempStore() {
  return tempRecoveryStore();
}

function writeRun(store: string, patch: Record<string, unknown> = {}) {
  return writeRecoveryRun(store, patch);
}

function currentBootHash() {
  return createHash('sha256').update(readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()).digest('hex').slice(0, 16);
}

function procStartTicks(pid: number) {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const end = stat.lastIndexOf(')');
  return stat.slice(end + 2).trim().split(/\s+/)[19];
}

function writeSidecar(store: string, run: Record<string, unknown>, patch: Record<string, unknown> = {}) {
  mkdirSync(join(store, 'reviewer-liveness'), { recursive: true });
  const sidecar = {
    schemaVersion: 1,
    runId: run.id,
    runFingerprint: fingerprintRun(run),
    reviewerSessionId: run.reviewerSessionId,
    capturedAt: '2026-06-13T00:00:01.000Z',
    windows: {
      crashGraceMs: 120_000,
      maxReviewDurationMs: 600_000,
      ambiguousStaleMs: 900_000,
    },
    identity: {
      kind: 'linux_proc_pid_starttime_boot',
      process: { pid: 4242, startTimeTicks: '100', bootIdHash: 'boot-a' },
    },
    ...patch,
  };
  writeFileSync(join(store, 'reviewer-liveness', `${run.id}.json`), `${JSON.stringify(sidecar, null, 2)}\n`);
  return sidecar;
}

function readAudit(store: string) {
  return readRecoveryAudit(store);
}

function readRun(store: string, id = 'review-run-a') {
  return readRecoveryRun(store, id);
}

afterEach(() => {
  drainTempRoots((root: string) => rmSync(root, { recursive: true, force: true }));
});

describe('review-run-recovery', () => {
  it('classifies the committed AO status map and fails closed on unknown statuses', () => {
    expect(classifyReviewStatus('running')).toBe('non_terminal');
    expect(classifyReviewStatus('reviewing')).toBe('non_terminal');
    expect(classifyReviewStatus('failed')).toBe('terminal');
    expect(classifyReviewStatus('clean')).toBe('terminal');
    expect(classifyReviewStatus('mystery')).toBe('unknown');
  });

  it('terminalizes a provably dead running run after the crash-stability grace', () => {
    const store = tempStore();
    const { run } = writeRun(store);
    writeSidecar(store, run, { identity: { kind: 'linux_proc_pid_starttime_boot', process: { pid: 99999999, startTimeTicks: '100', bootIdHash: currentBootHash() } } });
    const result = runRecoveryTick({ storeDir: store, nowMs: Date.parse('2026-06-13T00:03:00Z') });
    expect(result.ok).toBe(true);
    expect(result.actions).toContainEqual(expect.objectContaining({ terminalized: true, terminalReason: RECOVERY_REASON_PROVABLY_DEAD }));
    const updated = readRun(store);
    expect(updated.status).toBe('failed');
    expect(updated.body).toBe(RECOVERY_REASON_PROVABLY_DEAD);
    expect(updated.recovery.evidence.livenessReason).toBe('proc_entry_missing');
  });

  it('leaves an alive reviewer untouched even after long elapsed time', () => {
    const store = tempStore();
    const { run } = writeRun(store);
    const sidecar = writeSidecar(store, run, { identity: { kind: 'linux_proc_pid_starttime_boot', process: { pid: process.pid, startTimeTicks: procStartTicks(process.pid), bootIdHash: currentBootHash() } } });
    const decision = evaluateRecoveryForRun({
      run,
      sidecar,
      state: { observations: {}, escalations: {}, auditBackfills: {} },
      nowMs: Date.parse('2026-06-13T01:00:00Z'),
      config: { crashGraceMs: 1, maxReviewDurationMs: 10, ambiguousStaleMs: 20 },
    });
    // evaluateRecoveryForRun uses real /proc, so exercise liveness exact-instance helper directly.
    expect(classifyReviewerLiveness(sidecar).outcome).toBe('alive');
    expect(decision.action).not.toBe('terminalize');
  });

  it('treats pid reuse as not alive, never as the original reviewer', () => {
    const store = tempStore();
    const { run } = writeRun(store);
    const sidecar = writeSidecar(store, run);
    const liveness = classifyReviewerLiveness(sidecar, { bootIdHash: 'boot-a', procStartTimeTicks: '999' });
    expect(liveness).toMatchObject({ outcome: 'provably_not_alive', reason: 'pid_reused_or_wrong_instance' });
  });

  it('audits ambiguous missing identity once before stale threshold, then terminalizes with legacy reason', () => {
    const store = tempStore();
    writeRun(store, { createdAt: 'bad-date', startedAt: undefined });
    const first = runRecoveryTick({ storeDir: store, nowMs: 1_000, config: { crashGraceMs: 100, maxReviewDurationMs: 500, ambiguousStaleMs: 1_000 } });
    expect(first.actions).toContainEqual(expect.objectContaining({ decision: 'skip_audit_once', reason: 'ambiguous_before_stale_threshold' }));
    const second = runRecoveryTick({ storeDir: store, nowMs: 2_100, config: { crashGraceMs: 100, maxReviewDurationMs: 500, ambiguousStaleMs: 1_000 } });
    expect(second.actions).toContainEqual(expect.objectContaining({ terminalized: true, terminalReason: RECOVERY_REASON_LEGACY_AMBIGUOUS }));
    expect(readAudit(store).records.filter((r: any) => r.type === 'recovery_skip')).toHaveLength(1);
  });



  it('does not retroactively time legacy missing-identity runs from old createdAt', () => {
    const store = tempStore();
    writeRun(store, { createdAt: '2026-06-12T00:00:00.000Z', startedAt: '2026-06-12T00:00:00.000Z' });
    const first = runRecoveryTick({ storeDir: store, nowMs: Date.parse('2026-06-13T00:00:00Z'), config: { crashGraceMs: 100, maxReviewDurationMs: 500, ambiguousStaleMs: 1_000 } });
    expect(first.actions).toContainEqual(expect.objectContaining({ decision: 'skip_audit_once', reason: 'ambiguous_before_stale_threshold' }));
    expect(readRun(store).status).toBe('running');
    const second = runRecoveryTick({ storeDir: store, nowMs: Date.parse('2026-06-13T00:00:02Z'), config: { crashGraceMs: 100, maxReviewDurationMs: 500, ambiguousStaleMs: 1_000 } });
    expect(second.actions).toContainEqual(expect.objectContaining({ terminalized: true, terminalReason: RECOVERY_REASON_LEGACY_AMBIGUOUS }));
  });

  it('terminalizes captured ambiguous stale runs with a distinct reason', () => {
    const store = tempStore();
    const { run } = writeRun(store);
    writeSidecar(store, run, { identity: { kind: 'partial' } });
    const result = runRecoveryTick({ storeDir: store, nowMs: Date.parse('2026-06-13T00:20:00Z') });
    expect(result.actions).toContainEqual(expect.objectContaining({ terminalized: true, terminalReason: RECOVERY_REASON_AMBIGUOUS_STALE }));
    expect(readRun(store).body).toBe(RECOVERY_REASON_AMBIGUOUS_STALE);
  });

  it('does not overwrite a normal terminal completion that wins the race', () => {
    const store = tempStore();
    const { run, path } = writeRun(store);
    const sidecar = writeSidecar(store, run);
    writeRun(store, { status: 'clean', completedAt: '2026-06-13T00:01:00.000Z' });
    const result = terminalizeRunRecord({
      path,
      expectedRun: run,
      expectedSidecar: sidecar,
      terminalReason: RECOVERY_REASON_PROVABLY_DEAD,
      evidence: { livenessOutcome: 'provably_not_alive', livenessReason: 'fixture' },
      now: new Date('2026-06-13T00:02:00Z'),
    });
    expect(result).toMatchObject({ ok: false, reason: 'authoritative_not_non_terminal' });
    expect(readRun(store).status).toBe('clean');
  });

  it('preserves foreign fields when atomically terminalizing the latest record', () => {
    const store = tempStore();
    const { run, path } = writeRun(store, { operatorNote: 'keep me' });
    const result = terminalizeRunRecord({
      path,
      expectedRun: run,
      expectedSidecar: null,
      terminalReason: RECOVERY_REASON_AMBIGUOUS_STALE,
      evidence: { livenessOutcome: 'ambiguous', livenessReason: 'fixture' },
      now: new Date('2026-06-13T00:02:00Z'),
    });
    expect(result.ok).toBe(true);
    expect(readRun(store).operatorNote).toBe('keep me');
  });

  it('escalates unknown statuses and invalid config without terminalizing', () => {
    const store = tempStore();
    writeRun(store, { status: 'busy_new_status' });
    const result = runRecoveryTick({ storeDir: store, nowMs: 1000, config: { crashGraceMs: 100, maxReviewDurationMs: 1000, ambiguousStaleMs: 2000 } });
    expect(result.actions).toContainEqual(expect.objectContaining({ escalated: true, reason: 'unknown_status' }));
    expect(readRun(store).status).toBe('busy_new_status');
    expect(validateRecoveryConfig({ crashGraceMs: 1, maxReviewDurationMs: 10, ambiguousStaleMs: 10 }).ok).toBe(false);
  });

  it('backfills exactly one transition audit after a crash between terminal write and audit write', () => {
    const store = tempStore();
    writeRun(store, { status: 'failed', body: RECOVERY_REASON_PROVABLY_DEAD, completedAt: '2026-06-13T00:01:00.000Z' });
    runRecoveryTick({ storeDir: store, nowMs: 1000 });
    runRecoveryTick({ storeDir: store, nowMs: 2000 });
    const records = readAudit(store).records.filter((r: any) => r.type === 'recovery_transition');
    expect(records).toHaveLength(1);
    expect(records[0].backfilled).toBe(true);
  });

  it('captures liveness in a sidecar bound to run id plus fingerprint without leaking command/cwd/env', () => {
    const store = tempStore();
    const { run } = writeRun(store);
    const result = captureReviewerLiveness({
      storeDir: store,
      reviewerSessionId: 'opk-rev-a',
      pid: 123,
      startTimeTicks: '456',
      bootIdHash: 'boot-hash',
    });
    expect(result.ok).toBe(true);
    const raw = readFileSync(join(store, 'reviewer-liveness', `${run.id}.json`), 'utf8');
    expect(raw).not.toMatch(/command|cwd|env|token|secret|profile/i);
    const sidecar = JSON.parse(raw);
    expect(sidecar.runFingerprint).toBe(fingerprintRun(run));
  });

  it('does not freeze default recovery windows into captured sidecars', () => {
    const store = tempStore();
    writeRun(store);
    const result = captureReviewerLiveness({
      storeDir: store,
      reviewerSessionId: 'opk-rev-a',
      pid: 99999999,
      startTimeTicks: '456',
      bootIdHash: currentBootHash(),
    });
    expect(result.ok).toBe(true);
    const raw = readFileSync(join(store, 'reviewer-liveness', 'review-run-a.json'), 'utf8');
    expect(JSON.parse(raw).windows).toBeUndefined();

    const tick = runRecoveryTick({
      storeDir: store,
      nowMs: Date.parse('2026-06-13T00:00:01Z'),
      config: { crashGraceMs: 1, maxReviewDurationMs: 10, ambiguousStaleMs: 20 },
    });
    expect(tick.actions).toContainEqual(expect.objectContaining({ terminalized: true, terminalReason: RECOVERY_REASON_PROVABLY_DEAD }));
  });

  it('preserves explicit capture window overrides when supplied', () => {
    const store = tempStore();
    writeRun(store);
    const result = captureReviewerLiveness({
      storeDir: store,
      reviewerSessionId: 'opk-rev-a',
      pid: 123,
      startTimeTicks: '456',
      bootIdHash: 'boot-hash',
      windows: { crashGraceMs: 5000 },
    });
    expect(result.ok).toBe(true);
    const sidecar = JSON.parse(readFileSync(join(store, 'reviewer-liveness', 'review-run-a.json'), 'utf8'));
    expect(sidecar.windows).toEqual({ crashGraceMs: 5000 });
  });

  it('does not classify captured sidecars without window overrides as legacy', () => {
    const store = tempStore();
    writeRun(store);
    const result = captureReviewerLiveness({
      storeDir: store,
      reviewerSessionId: 'opk-rev-a',
      pid: 123,
      startTimeTicks: '456',
      bootIdHash: 'different-boot',
    });
    expect(result.ok).toBe(true);
    const tick = runRecoveryTick({
      storeDir: store,
      nowMs: Date.parse('2026-06-13T00:00:30Z'),
      config: { crashGraceMs: 1, maxReviewDurationMs: 10, ambiguousStaleMs: 20 },
    });
    expect(tick.actions).toContainEqual(expect.objectContaining({ terminalized: true, terminalReason: RECOVERY_REASON_AMBIGUOUS_STALE }));
    expect(readRun(store).body).toBe(RECOVERY_REASON_AMBIGUOUS_STALE);
  });
});
