import { describe, expect, it, vi } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBoundedOrcaTerminal } from './worker-smoke-bounded-create.ts';
import {
  abandonAmbiguousUnbound,
  bindSmokeTerminalHandle,
  canAbandonAmbiguousUnbound,
  cleanupSmokeLifecycle,
  createSmokeLifecycleReservation,
  evaluateSmokeLifecycleCleanliness,
  inspectSmokeProgress,
  markSmokeCreateAmbiguous,
  preflightSmokeLifecycle,
  readSmokeLifecycleRegistry,
  releaseSmokeAdmission,
  smokeCancelRequestPath,
  smokeProgressPath,
} from './worker-smoke-lifecycle.ts';
import {
  computeSmokeCompletionBodyDigest,
  smokeCompletionBodyPath,
  smokeCompletionSealPath,
} from './worker-smoke-core.ts';
import { waitForSmokeChildCompletion } from '../worker-smoke-run.ts';

const head = 'a'.repeat(40);
const minute = 60_000;

function runDir(root: string, runId: string): string {
  return join(root, '.orca-worker-smoke', 'runs', runId);
}

function appendProgress(artifactDir: string, value: unknown): void {
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(smokeProgressPath(artifactDir), `${JSON.stringify(value)}\n`, {
    encoding: 'utf8',
    flag: 'a',
  });
}

function publishCompletion(artifactDir: string, runId: string): void {
  const body = [
    '```worker-smoke-report',
    'result: PASS',
    'tracked-files-unmodified: true',
    'scenarios:',
    '  - action: scenario 1 | expected: pass | observed: pass | outcome: pass',
    '  - action: scenario 2 | expected: pass | observed: pass | outcome: pass',
    '```',
  ].join('\n');
  const digest = computeSmokeCompletionBodyDigest(body);
  writeFileSync(smokeCompletionBodyPath(artifactDir, digest), body, 'utf8');
  writeFileSync(
    smokeCompletionSealPath(artifactDir, digest),
    JSON.stringify({ runId, bodySha256: digest }),
    'utf8',
  );
}

const quietRunner = vi.fn(() => ({
  stdout: JSON.stringify({ ok: true, result: { lines: [] } }),
  stderr: '',
  status: 0,
}));

describe('worker smoke finite progress deadlines', () => {
  it('continues beyond the former 30 minute wall while legal transitions advance', () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-smoke-progressing-'));
    const runId = 'progressing';
    const artifactDir = runDir(root, runId);
    mkdirSync(artifactDir, { recursive: true });
    let now = 0;
    const result = waitForSmokeChildCompletion('child', {
      cwd: root,
      deadlineMs: 60 * minute,
      runBinding: { runId, artifactDir },
      ownedChildHandle: 'child',
      scenarioCount: 2,
      lifecycleStartedAtMs: 0,
      stallMs: 15 * minute,
      absoluteCeilingMs: 90 * minute,
      suppressPtyReads: true,
      runner: quietRunner as never,
      now: () => now,
      sleepMs: () => {
        now += 10 * minute;
        if (now === 10 * minute) appendProgress(artifactDir, { runId, scenarioOrdinal: 1, phase: 'started' });
        if (now === 20 * minute) appendProgress(artifactDir, { runId, scenarioOrdinal: 1, phase: 'terminal', outcome: 'pass' });
        if (now === 30 * minute) appendProgress(artifactDir, { runId, scenarioOrdinal: 2, phase: 'started' });
        if (now === 40 * minute) appendProgress(artifactDir, { runId, scenarioOrdinal: 2, phase: 'terminal', outcome: 'pass' });
        if (now === 50 * minute) publishCompletion(artifactDir, runId);
      },
    });
    expect(now).toBeGreaterThan(30 * minute);
    expect(result.ok).toBe(true);
    expect(result.progress?.acceptedCount).toBe(4);
    rmSync(root, { recursive: true, force: true });
  });

  it('does not refresh stall age for wrong-run, unknown, duplicate, or terminal-before-start events', () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-smoke-stalled-'));
    const runId = 'stalled';
    const artifactDir = runDir(root, runId);
    appendProgress(artifactDir, { runId: 'foreign', scenarioOrdinal: 1, phase: 'started' });
    appendProgress(artifactDir, { runId, scenarioOrdinal: 9, phase: 'started' });
    appendProgress(artifactDir, { runId, scenarioOrdinal: 1, phase: 'terminal', outcome: 'pass' });
    let now = 0;
    const result = waitForSmokeChildCompletion('child', {
      cwd: root,
      deadlineMs: 60 * minute,
      runBinding: { runId, artifactDir },
      ownedChildHandle: 'child',
      scenarioCount: 2,
      lifecycleStartedAtMs: 0,
      stallMs: 20 * minute,
      absoluteCeilingMs: 90 * minute,
      suppressPtyReads: true,
      runner: quietRunner as never,
      now: () => now,
      sleepMs: () => { now += 10 * minute; },
    });
    expect(result.terminalReason).toBe('progress_stall');
    expect(result.progress?.acceptedCount).toBe(0);
    expect(result.progress?.invalidEvents).toEqual(expect.arrayContaining([
      expect.stringContaining('wrong_run'),
      expect.stringContaining('unknown_ordinal'),
      expect.stringContaining('terminal_before_start'),
    ]));
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps the absolute ceiling independent from continuing progress', () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-smoke-ceiling-'));
    const runId = 'ceiling';
    const artifactDir = runDir(root, runId);
    mkdirSync(artifactDir, { recursive: true });
    let now = 0;
    let ordinal = 1;
    let started = false;
    const result = waitForSmokeChildCompletion('child', {
      cwd: root,
      deadlineMs: 60 * minute,
      runBinding: { runId, artifactDir },
      ownedChildHandle: 'child',
      scenarioCount: 10,
      lifecycleStartedAtMs: 0,
      stallMs: 15 * minute,
      absoluteCeilingMs: 35 * minute,
      suppressPtyReads: true,
      runner: quietRunner as never,
      now: () => now,
      sleepMs: () => {
        now += 10 * minute;
        appendProgress(artifactDir, started
          ? { runId, scenarioOrdinal: ordinal++, phase: 'terminal', outcome: 'pass' }
          : { runId, scenarioOrdinal: ordinal, phase: 'started' });
        started = !started;
      },
    });
    expect(result.terminalReason).toBe('absolute_safety_ceiling');
    expect(result.progress?.acceptedCount).toBeGreaterThan(0);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('worker smoke spawn and cleanup lifecycle', () => {
  it('bounds Orca terminal creation and treats timeout as ambiguous unbound', () => {
    const timeout = Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
    const runner = vi.fn(() => ({ stdout: '', stderr: '', status: null, error: timeout }));
    const result = createBoundedOrcaTerminal({
      cwd: '/tmp/worktree',
      title: 'smoke-1138',
      command: 'cursor-agent',
      timeoutMs: 1234,
      runner: runner as never,
      now: (() => { let value = 0; return () => value += 10; })(),
    });
    expect(result).toMatchObject({
      ok: false,
      errorCode: 'orca_create_timeout',
      ambiguousUnbound: true,
    });
    expect(runner).toHaveBeenCalledWith(expect.any(String), expect.any(Array), expect.objectContaining({ timeout: 1234 }));
  });

  it('abandons only ambiguous reservations with no bound or execution evidence', () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-smoke-abandon-'));
    const artifactDir = runDir(root, 'ambiguous');
    createSmokeLifecycleReservation({
      runId: 'ambiguous', artifactDir, issueNumber: 1138, prNumber: 1, headSha: head, nowMs: 0,
    });
    const ambiguous = markSmokeCreateAmbiguous(artifactDir, 'timeout', 1);
    expect(canAbandonAmbiguousUnbound(ambiguous)).toBe(true);
    expect(abandonAmbiguousUnbound(artifactDir, 2).spawnState).toBe('abandoned_unbound');

    const executableDir = runDir(root, 'executable');
    createSmokeLifecycleReservation({
      runId: 'executable', artifactDir: executableDir, issueNumber: 1138, prNumber: 1, headSha: head, nowMs: 0,
    });
    markSmokeCreateAmbiguous(executableDir, 'timeout', 1);
    writeFileSync(join(executableDir, 'delivery.sealed.json'), JSON.stringify({ runId: 'executable' }), 'utf8');
    expect(canAbandonAmbiguousUnbound(readSmokeLifecycleRegistry(executableDir)!)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it('makes cleanup idempotent and never closes anything except the bound handle', () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-smoke-cleanup-'));
    const runId = 'bound';
    const artifactDir = runDir(root, runId);
    createSmokeLifecycleReservation({ runId, artifactDir, issueNumber: 1138, prNumber: 1, headSha: head });
    bindSmokeTerminalHandle(artifactDir, 'term_owned');
    mkdirSync(join(artifactDir, 'live'), { recursive: true });
    writeFileSync(join(artifactDir, 'live', 'OPERATOR-ACTION-old.txt'), 'stale', 'utf8');
    const close = vi.fn(() => 'closed_owned_handle');
    const first = cleanupSmokeLifecycle({
      artifactDir,
      runId,
      reason: 'operator_cancelled',
      requestCancellation: true,
      cooperativeAcknowledgementObserved: false,
      closeBoundHandle: close,
    });
    const second = cleanupSmokeLifecycle({
      artifactDir,
      runId,
      reason: 'restart_retry',
      requestCancellation: true,
      cooperativeAcknowledgementObserved: false,
      closeBoundHandle: close,
    });
    expect(first.clean).toBe(true);
    expect(second.clean).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith('term_owned');
    expect(readFileSync(smokeCancelRequestPath(artifactDir), 'utf8')).toContain(runId);
    expect(readdirSync(join(artifactDir, 'live')).some((entry) => entry.includes('.tombstoned-'))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it('fails lifecycle cleanliness when a required cancel request cannot be persisted', () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-smoke-cancel-write-'));
    const runId = 'cancel-write-failure';
    const artifactDir = runDir(root, runId);
    createSmokeLifecycleReservation({ runId, artifactDir, issueNumber: 1138, prNumber: 1, headSha: head });
    bindSmokeTerminalHandle(artifactDir, 'term_owned');
    mkdirSync(smokeCancelRequestPath(artifactDir));
    const result = cleanupSmokeLifecycle({
      artifactDir,
      runId,
      reason: 'progress_stall',
      requestCancellation: false,
      cooperativeAcknowledgementObserved: false,
      closeBoundHandle: () => 'closed_owned_handle',
    });
    expect(result.clean).toBe(false);
    expect(result.operatorFilesCleared).toBe(false);
    expect(readSmokeLifecycleRegistry(artifactDir)?.spawnState).toBe('cleanup_failed');
    rmSync(root, { recursive: true, force: true });
  });

  it('admits at most one concurrent smoke start and restores cleanliness after release', () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-smoke-admission-'));
    const first = preflightSmokeLifecycle({
      repoRoot: root,
      runId: 'winner',
      supervisorPid: 111,
      isProcessAlive: () => true,
      closeBoundHandle: () => 'closed_owned_handle',
    });
    const second = preflightSmokeLifecycle({
      repoRoot: root,
      runId: 'loser',
      supervisorPid: 222,
      isProcessAlive: () => true,
      closeBoundHandle: () => 'closed_owned_handle',
    });
    expect(first.admitted).toBe(true);
    expect(second.admitted).toBe(false);
    expect(second.reason).toBe('active_smoke_admission:winner');
    expect(evaluateSmokeLifecycleCleanliness(root).clean).toBe(false);
    expect(releaseSmokeAdmission(root, 'winner')).toBe(true);
    expect(evaluateSmokeLifecycleCleanliness(root).clean).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it('recovery closes only a registry-bound child and leaves unrelated work unobserved', () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-smoke-recovery-'));
    const artifactDir = runDir(root, 'prior');
    createSmokeLifecycleReservation({
      runId: 'prior', artifactDir, issueNumber: 1138, prNumber: 1, headSha: head, nowMs: 0,
    });
    bindSmokeTerminalHandle(artifactDir, 'term_prior', 1);
    const close = vi.fn(() => 'closed_owned_handle');
    const result = preflightSmokeLifecycle({
      repoRoot: root,
      runId: 'next',
      supervisorPid: 333,
      nowMs: 100,
      isProcessAlive: () => false,
      closeBoundHandle: close,
    });
    expect(result.admitted).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith('term_prior', artifactDir);
    expect(readSmokeLifecycleRegistry(artifactDir)?.spawnState).toBe('clean');
    releaseSmokeAdmission(root, 'next');
    rmSync(root, { recursive: true, force: true });
  });
});

describe('progress lattice parser', () => {
  it('accepts only current-run declared-order started then terminal transitions', () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-smoke-lattice-'));
    const artifactDir = runDir(root, 'lattice');
    appendProgress(artifactDir, { runId: 'lattice', scenarioOrdinal: 1, phase: 'started' });
    appendProgress(artifactDir, { runId: 'lattice', scenarioOrdinal: 1, phase: 'terminal', outcome: 'pass' });
    appendProgress(artifactDir, { runId: 'lattice', scenarioOrdinal: 1, phase: 'started' });
    appendProgress(artifactDir, { runId: 'lattice', scenarioOrdinal: 2, phase: 'terminal', outcome: 'pass' });
    const inspected = inspectSmokeProgress({ artifactDir, runId: 'lattice', scenarioCount: 2 });
    expect(inspected.acceptedCount).toBe(2);
    expect(inspected.completedScenarios).toBe(1);
    expect(inspected.invalidEvents).toEqual(expect.arrayContaining([
      expect.stringContaining('backward_or_duplicate'),
      expect.stringContaining('terminal_before_start'),
    ]));
    rmSync(root, { recursive: true, force: true });
  });
});
