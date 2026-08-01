import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runOrcaJson } from './orca-cli.ts';
import {
  abandonAmbiguousUnbound,
  bindSmokeTerminalHandle,
  canAbandonAmbiguousUnbound,
  createSmokeLifecycleReservation,
  evaluateSmokeLifecycleCleanliness,
  markSmokeCreateAmbiguous,
  preflightSmokeLifecycle,
  readSmokeLifecycleRegistry,
  releaseSmokeAdmission,
  smokeAdmissionLockPath,
  smokeLifecycleRegistryPath,
  smokeProgressPath,
  smokeTerminalRecordPath,
} from './worker-smoke-lifecycle.ts';
import {
  computeSmokeCompletionBodyDigest,
  smokeCompletionBodyPath,
  smokeCompletionSealPath,
} from './worker-smoke-core.ts';

export function registerWorkerSmokeFindingsRegressionTests(input: {
  describe: typeof import('vitest').describe;
  expect: typeof import('vitest').expect;
  it: typeof import('vitest').it;
  vi: typeof import('vitest').vi;
  waitForSmokeChildCompletion: typeof import('../worker-smoke-run.ts').waitForSmokeChildCompletion;
}): void {
  const { describe, expect, it, vi, waitForSmokeChildCompletion } = input;
  const head = 'b'.repeat(40);
  const minute = 60_000;

  function runDir(root: string, runId: string): string {
    return join(root, '.orca-worker-smoke', 'runs', runId);
  }

  function writeValidCompletion(artifactDir: string, runId: string, suffix = ''): string {
    mkdirSync(artifactDir, { recursive: true });
    const body = [
      '```worker-smoke-report',
      'result: FAIL',
      'tracked-files-unmodified: true',
      'scenarios:',
      `  - action: scenario${suffix} | expected: pass | observed: failed | outcome: fail`,
      '```',
    ].join('\n');
    const digest = computeSmokeCompletionBodyDigest(body);
    writeFileSync(smokeCompletionBodyPath(artifactDir, digest), body, 'utf8');
    writeFileSync(
      smokeCompletionSealPath(artifactDir, digest),
      JSON.stringify({ runId, bodySha256: digest }),
      'utf8',
    );
    return digest;
  }

  function seedBoundRun(root: string, runId: string): string {
    const artifactDir = runDir(root, runId);
    createSmokeLifecycleReservation({
      runId,
      artifactDir,
      issueNumber: 1138,
      prNumber: 1163,
      headSha: head,
      nowMs: 0,
      scenarioCount: 2,
    });
    bindSmokeTerminalHandle(artifactDir, `term_${runId}`, 1);
    return artifactDir;
  }

  describe('review findings: deadline and bounded I/O (#1138)', () => {
    it('terminalizes at the stall deadline before accepting progress first observed by that poll', () => {
      const root = mkdtempSync(join(tmpdir(), 'worker-smoke-late-progress-'));
      const runId = 'late-progress';
      const artifactDir = runDir(root, runId);
      mkdirSync(artifactDir, { recursive: true });
      let now = 0;
      const runner = vi.fn(() => {
        now = 20 * minute;
        writeFileSync(
          smokeProgressPath(artifactDir),
          `${JSON.stringify({ runId, scenarioOrdinal: 1, phase: 'started' })}\n`,
          'utf8',
        );
        return {
          stdout: JSON.stringify({ ok: true, result: { lines: [] } }),
          stderr: '',
          status: 0,
        };
      });
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
        runner: runner as never,
        now: () => now,
        sleepMs: () => undefined,
      });
      expect(result.ok).toBe(false);
      expect(result.terminalReason).toBe('progress_stall');
      expect(result.progress?.acceptedCount ?? 0).toBe(0);
      rmSync(root, { recursive: true, force: true });
    });

    it('applies a non-catchable timeout to lifecycle-critical Orca operations', () => {
      const timeout = Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
      const runner = vi.fn((_command: string, _args: readonly string[], options: {
        timeout?: number;
        killSignal?: string;
      }) => ({ stdout: '', stderr: '', status: null, error: timeout, options }));
      const result = runOrcaJson(
        ['terminal', 'read', '--terminal', 'term_owned'],
        { timeoutMs: 1234, runner: runner as never },
      );
      expect(result).toMatchObject({
        ok: false,
        operation: 'terminal_read',
        outcomeCategory: 'supported_operation_failure',
        error: { code: 'orca_operation_timeout' },
      });
      expect(runner.mock.calls[0]?.[2]?.timeout).toBe(1234);
      expect(runner.mock.calls[0]?.[2]?.killSignal).toBe('SIGKILL');
    });
  });

  describe('review findings: fail-closed lifecycle evidence (#1138)', () => {
    it('does not abandon ambiguous state when any non-empty invalid progress evidence exists', () => {
      const root = mkdtempSync(join(tmpdir(), 'worker-smoke-invalid-progress-'));
      const runId = 'invalid-progress';
      const artifactDir = runDir(root, runId);
      createSmokeLifecycleReservation({
        runId,
        artifactDir,
        issueNumber: 1138,
        prNumber: 1163,
        headSha: head,
        scenarioCount: 2,
      });
      markSmokeCreateAmbiguous(artifactDir, 'timeout');
      writeFileSync(
        smokeProgressPath(artifactDir),
        `${JSON.stringify({ runId, scenarioOrdinal: 1, phase: 'terminal', outcome: 'pass' })}\n`,
        'utf8',
      );
      expect(canAbandonAmbiguousUnbound(readSmokeLifecycleRegistry(artifactDir)!)).toBe(false);
      rmSync(root, { recursive: true, force: true });
    });

    it('fails closed when the lifecycle root exists but cannot be enumerated', () => {
      const root = mkdtempSync(join(tmpdir(), 'worker-smoke-unreadable-root-'));
      const runsRoot = join(root, '.orca-worker-smoke', 'runs');
      mkdirSync(dirname(runsRoot), { recursive: true });
      writeFileSync(runsRoot, 'not-a-directory', 'utf8');
      expect(evaluateSmokeLifecycleCleanliness(root)).toMatchObject({
        clean: false,
        reasons: ['lifecycle_root_unreadable'],
      });
      const preflight = preflightSmokeLifecycle({
        repoRoot: root,
        runId: 'next',
        closeBoundHandle: () => 'closed_owned_handle',
      });
      expect(preflight).toMatchObject({ admitted: false, reason: 'lifecycle_root_unreadable' });
      rmSync(root, { recursive: true, force: true });
    });

    it.each(['delivery', 'progress', 'completion'] as const)(
      'blocks a registryless run containing %s execution evidence',
      (kind) => {
        const root = mkdtempSync(join(tmpdir(), `worker-smoke-registryless-${kind}-`));
        const artifactDir = runDir(root, `registryless-${kind}`);
        mkdirSync(artifactDir, { recursive: true });
        if (kind === 'delivery') {
          writeFileSync(join(artifactDir, 'delivery.sealed.json'), '{}', 'utf8');
        } else if (kind === 'progress') {
          writeFileSync(smokeProgressPath(artifactDir), '{"phase":"started"}\n', 'utf8');
        } else {
          writeFileSync(join(artifactDir, 'completion.pending.body'), 'partial', 'utf8');
        }
        expect(evaluateSmokeLifecycleCleanliness(root).clean).toBe(false);
        const preflight = preflightSmokeLifecycle({
          repoRoot: root,
          runId: 'next',
          closeBoundHandle: () => 'closed_owned_handle',
        });
        expect(preflight.admitted).toBe(false);
        expect(preflight.reason).toContain('unregistered_execution_evidence');
        rmSync(root, { recursive: true, force: true });
      },
    );

    it('rejects a registry whose run id disagrees with its containing directory', () => {
      const root = mkdtempSync(join(tmpdir(), 'worker-smoke-runid-mismatch-'));
      const artifactDir = runDir(root, 'container-run');
      const registry = createSmokeLifecycleReservation({
        runId: 'container-run',
        artifactDir,
        issueNumber: 1138,
        prNumber: 1163,
        headSha: head,
        scenarioCount: 2,
      });
      writeFileSync(
        smokeLifecycleRegistryPath(artifactDir),
        JSON.stringify({ ...registry, runId: 'different-run' }),
        'utf8',
      );
      expect(readSmokeLifecycleRegistry(artifactDir)).toBeUndefined();
      expect(evaluateSmokeLifecycleCleanliness(root).reasons).toContain(
        'corrupt_lifecycle_state:container-run',
      );
      rmSync(root, { recursive: true, force: true });
    });
  });

  describe('review findings: recovery and admission races (#1138)', () => {
    it('serializes stale-lock reclamation so a second starter cannot delete the winner lock', () => {
      const root = mkdtempSync(join(tmpdir(), 'worker-smoke-stale-lock-race-'));
      const lockPath = smokeAdmissionLockPath(root);
      mkdirSync(dirname(lockPath), { recursive: true });
      writeFileSync(lockPath, JSON.stringify({
        version: 1,
        runId: 'stale',
        supervisorPid: 999,
        startedAtMs: 0,
      }), 'utf8');
      let contender: ReturnType<typeof preflightSmokeLifecycle> | undefined;
      const winner = preflightSmokeLifecycle({
        repoRoot: root,
        runId: 'winner',
        supervisorPid: 111,
        nowMs: 10,
        isProcessAlive: (pid) => pid === 111,
        closeBoundHandle: () => 'closed_owned_handle',
        afterAdmissionReclaimMarker: () => {
          contender = preflightSmokeLifecycle({
            repoRoot: root,
            runId: 'contender',
            supervisorPid: 222,
            nowMs: 11,
            isProcessAlive: (pid) => pid === 111 || pid === 222,
            closeBoundHandle: () => 'closed_owned_handle',
          });
        },
      });
      expect(winner.admitted).toBe(true);
      expect(contender?.admitted).toBe(false);
      expect(contender?.reason).toContain('active_smoke_admission_reclaim');
      expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toMatchObject({ runId: 'winner' });
      releaseSmokeAdmission(root, 'winner');
      rmSync(root, { recursive: true, force: true });
    });

    it('reconciles a crash after close side effect before lifecycle finalization', () => {
      const root = mkdtempSync(join(tmpdir(), 'worker-smoke-close-crash-'));
      const runId = 'close-crash';
      const artifactDir = seedBoundRun(root, runId);
      const bound = readSmokeLifecycleRegistry(artifactDir)!;
      writeFileSync(smokeLifecycleRegistryPath(artifactDir), JSON.stringify({
        ...bound,
        spawnState: 'cleanup_pending',
        closeAttemptedAtMs: 2,
        updatedAtMs: 2,
      }), 'utf8');
      const close = vi.fn(() => 'close_failed:channel_stale_handle');
      const result = preflightSmokeLifecycle({
        repoRoot: root,
        runId: 'next',
        supervisorPid: 333,
        nowMs: 3,
        shutdownMs: 0,
        isProcessAlive: () => false,
        closeBoundHandle: close,
      });
      expect(result.admitted).toBe(true);
      expect(close).toHaveBeenCalledWith(`term_${runId}`, artifactDir);
      expect(readSmokeLifecycleRegistry(artifactDir)).toMatchObject({
        spawnState: 'clean',
        cleanup: { closeOutcome: 'closed_owned_handle_already_absent' },
      });
      releaseSmokeAdmission(root, 'next');
      rmSync(root, { recursive: true, force: true });
    });

    it.each(['missing-body', 'digest-mismatch', 'malformed-body', 'duplicate'] as const)(
      'does not treat %s completion publication as cooperative shutdown acknowledgement',
      (kind) => {
        const root = mkdtempSync(join(tmpdir(), `worker-smoke-completion-${kind}-`));
        const runId = `completion-${kind}`;
        const artifactDir = seedBoundRun(root, runId);
        if (kind === 'missing-body') {
          const digest = '1'.repeat(64);
          writeFileSync(
            smokeCompletionSealPath(artifactDir, digest),
            JSON.stringify({ runId, bodySha256: digest }),
            'utf8',
          );
        } else if (kind === 'digest-mismatch') {
          const digest = '2'.repeat(64);
          writeFileSync(smokeCompletionBodyPath(artifactDir, digest), 'different bytes', 'utf8');
          writeFileSync(
            smokeCompletionSealPath(artifactDir, digest),
            JSON.stringify({ runId, bodySha256: digest }),
            'utf8',
          );
        } else if (kind === 'malformed-body') {
          const body = 'not a smoke report';
          const digest = computeSmokeCompletionBodyDigest(body);
          writeFileSync(smokeCompletionBodyPath(artifactDir, digest), body, 'utf8');
          writeFileSync(
            smokeCompletionSealPath(artifactDir, digest),
            JSON.stringify({ runId, bodySha256: digest }),
            'utf8',
          );
        } else {
          writeValidCompletion(artifactDir, runId, '-one');
          writeValidCompletion(artifactDir, runId, '-two');
        }
        let now = 0;
        const result = preflightSmokeLifecycle({
          repoRoot: root,
          runId: 'next',
          supervisorPid: 444,
          nowMs: 10,
          now: () => now,
          sleepMs: (milliseconds) => { now += milliseconds; },
          shutdownMs: 1,
          isProcessAlive: () => false,
          closeBoundHandle: () => 'closed_owned_handle',
        });
        expect(result.admitted).toBe(true);
        const terminal = JSON.parse(readFileSync(smokeTerminalRecordPath(artifactDir), 'utf8'));
        expect(terminal.cooperativeAcknowledgementObserved).toBe(false);
        releaseSmokeAdmission(root, 'next');
        rmSync(root, { recursive: true, force: true });
      },
    );
  });

  describe('review findings: honest abandonment cleanup (#1138)', () => {
    it('tombstones operator files before recording clean abandonment', () => {
      const root = mkdtempSync(join(tmpdir(), 'worker-smoke-abandon-operator-'));
      const runId = 'abandon-operator';
      const artifactDir = runDir(root, runId);
      createSmokeLifecycleReservation({
        runId,
        artifactDir,
        issueNumber: 1138,
        prNumber: 1163,
        headSha: head,
        scenarioCount: 2,
      });
      markSmokeCreateAmbiguous(artifactDir, 'timeout');
      const live = join(artifactDir, 'live');
      mkdirSync(live, { recursive: true });
      writeFileSync(join(live, 'OPERATOR-ACTION-stale.txt'), 'stale', 'utf8');
      const abandoned = abandonAmbiguousUnbound(artifactDir);
      expect(abandoned.spawnState).toBe('abandoned_unbound');
      expect(readdirSync(live).some((entry) => entry.includes('.tombstoned-'))).toBe(true);
      expect(JSON.parse(readFileSync(smokeTerminalRecordPath(artifactDir), 'utf8'))).toMatchObject({
        operatorFilesCleared: true,
        cleanupClean: true,
      });
      rmSync(root, { recursive: true, force: true });
    });

    it('keeps ambiguity blocking when operator-file cleanup cannot be completed', () => {
      const root = mkdtempSync(join(tmpdir(), 'worker-smoke-abandon-operator-fail-'));
      const runId = 'abandon-operator-fail';
      const artifactDir = runDir(root, runId);
      createSmokeLifecycleReservation({
        runId,
        artifactDir,
        issueNumber: 1138,
        prNumber: 1163,
        headSha: head,
        scenarioCount: 2,
      });
      markSmokeCreateAmbiguous(artifactDir, 'timeout');
      writeFileSync(join(artifactDir, 'live'), 'not-a-directory', 'utf8');
      expect(() => abandonAmbiguousUnbound(artifactDir)).toThrow(/operator cleanup failed/u);
      expect(readSmokeLifecycleRegistry(artifactDir)?.spawnState).toBe('ambiguous_unbound');
      expect(() => readFileSync(smokeTerminalRecordPath(artifactDir), 'utf8')).toThrow();
      rmSync(root, { recursive: true, force: true });
    });
  });
}
