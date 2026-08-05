import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runProcessSync } from '../kernel/subprocess.ts';
import { runOrcaJson } from './orca-cli.ts';
import * as lifecycle from './worker-smoke-lifecycle.ts';
import * as core from './worker-smoke-core.ts';

type FindingsRegressionInput = Pick<
  typeof import('vitest'),
  'describe' | 'expect' | 'it' | 'vi'
> & {
  waitForSmokeChildCompletion: typeof import('../worker-smoke-run.ts').waitForSmokeChildCompletion;
};

export function registerWorkerSmokeFindingsRegressionTests(
  input: FindingsRegressionInput,
): void {
  const { describe, expect, it, vi, waitForSmokeChildCompletion } = input;
  const head = 'b'.repeat(40);
  const minute = 60_000;

  const runDir = (root: string, runId: string): string =>
    path.join(root, '.orca-worker-smoke', 'runs', runId);

  function reserve(root: string, runId: string, supervisorPid = process.pid): string {
    const artifactDir = runDir(root, runId);
    lifecycle.createSmokeLifecycleReservation({
      runId,
      artifactDir,
      issueNumber: 1138,
      prNumber: 1163,
      headSha: head,
      supervisorPid,
      nowMs: 0,
      scenarioCount: 2,
    });
    return artifactDir;
  }

  function seedBound(root: string, runId: string, supervisorPid = process.pid): string {
    const artifactDir = reserve(root, runId, supervisorPid);
    lifecycle.bindSmokeTerminalHandle(artifactDir, `term_${runId}`, 1);
    return artifactDir;
  }

  function rewriteRegistry(
    artifactDir: string,
    mutate: (registry: lifecycle.SmokeLifecycleRegistry) => lifecycle.SmokeLifecycleRegistry,
  ): void {
    const registry = lifecycle.readSmokeLifecycleRegistry(artifactDir)!;
    fs.writeFileSync(
      lifecycle.smokeLifecycleRegistryPath(artifactDir),
      JSON.stringify(mutate(registry)),
      'utf8',
    );
  }

  function publishCompletion(artifactDir: string, runId: string, suffix = ''): void {
    fs.mkdirSync(artifactDir, { recursive: true });
    const body = [
      '```worker-smoke-report',
      'result: FAIL',
      'tracked-files-unmodified: true',
      'scenarios:',
      `  - action: scenario${suffix} | expected: pass | observed: failed | outcome: fail`,
      '```',
    ].join('\n');
    const digest = core.computeSmokeCompletionBodyDigest(body);
    fs.writeFileSync(core.smokeCompletionBodyPath(artifactDir, digest), body, 'utf8');
    fs.writeFileSync(
      core.smokeCompletionSealPath(artifactDir, digest),
      JSON.stringify({ runId, bodySha256: digest }),
      'utf8',
    );
  }

  describe('review findings: deadline and bounded I/O (#1138)', () => {
    it('terminalizes before accepting progress first observed at the stall deadline', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-smoke-late-progress-'));
      const runId = 'late-progress';
      const artifactDir = runDir(root, runId);
      fs.mkdirSync(artifactDir, { recursive: true });
      let now = 0;
      const runner = vi.fn(() => {
        now = 20 * minute;
        fs.writeFileSync(
          lifecycle.smokeProgressPath(artifactDir),
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
        runBinding: { runId, artifactDir },
        ownedChildHandle: 'child',
        cwd: root,
        scenarioCount: 2,
        suppressPtyReads: true,
        deadlineMs: 60 * minute,
        stallMs: 20 * minute,
        lifecycleStartedAtMs: 0,
        absoluteCeilingMs: 90 * minute,
        now: () => now,
        runner: runner as never,
        sleepMs: () => undefined,
      });
      expect(result.ok).toBe(false);
      expect(result.terminalReason).toBe('progress_stall');
      expect(result.progress?.acceptedCount ?? 0).toBe(0);
      fs.rmSync(root, { recursive: true, force: true });
    });

    it('applies SIGKILL-backed timeout to lifecycle-critical Orca calls', () => {
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
    it('keeps ambiguous state blocking when invalid progress bytes exist', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-smoke-invalid-progress-'));
      const runId = 'invalid-progress';
      const artifactDir = reserve(root, runId);
      lifecycle.markSmokeCreateAmbiguous(artifactDir, 'timeout');
      fs.writeFileSync(
        lifecycle.smokeProgressPath(artifactDir),
        `${JSON.stringify({ runId, scenarioOrdinal: 1, phase: 'terminal', outcome: 'pass' })}\n`,
        'utf8',
      );
      expect(lifecycle.canAbandonAmbiguousUnbound(
        lifecycle.readSmokeLifecycleRegistry(artifactDir)!,
      )).toBe(false);
      fs.rmSync(root, { recursive: true, force: true });
    });

    it('blocks when the lifecycle root exists but cannot be enumerated', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-smoke-unreadable-root-'));
      const runsRoot = path.join(root, '.orca-worker-smoke', 'runs');
      fs.mkdirSync(path.dirname(runsRoot), { recursive: true });
      fs.writeFileSync(runsRoot, 'not-a-directory', 'utf8');
      expect(lifecycle.evaluateSmokeLifecycleCleanliness(root)).toMatchObject({
        clean: false,
        reasons: ['lifecycle_root_unreadable'],
      });
      expect(lifecycle.preflightSmokeLifecycle({
        repoRoot: root,
        runId: 'next',
        closeBoundHandle: () => 'closed_owned_handle',
      })).toMatchObject({ admitted: false, reason: 'lifecycle_root_unreadable' });
      fs.rmSync(root, { recursive: true, force: true });
    });

    it.each([
      'delivery',
      'progress',
      'completion',
      'cancel-request',
      'terminal-record',
      'close-receipt',
    ] as const)(
      'blocks registryless %s lifecycle evidence',
      (kind) => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), `worker-smoke-registryless-${kind}-`));
        const artifactDir = runDir(root, `registryless-${kind}`);
        fs.mkdirSync(artifactDir, { recursive: true });
        if (kind === 'delivery') {
          fs.writeFileSync(path.join(artifactDir, 'delivery.sealed.json'), '{}', 'utf8');
        } else if (kind === 'progress') {
          fs.writeFileSync(lifecycle.smokeProgressPath(artifactDir), '{"phase":"started"}\n', 'utf8');
        } else if (kind === 'completion') {
          fs.writeFileSync(path.join(artifactDir, 'completion.pending.body'), 'partial', 'utf8');
        } else if (kind === 'cancel-request') {
          fs.writeFileSync(lifecycle.smokeCancelRequestPath(artifactDir), '{}', 'utf8');
        } else if (kind === 'terminal-record') {
          fs.writeFileSync(lifecycle.smokeTerminalRecordPath(artifactDir), '{}', 'utf8');
        } else {
          fs.writeFileSync(lifecycle.smokeCloseReceiptPath(artifactDir), '{}', 'utf8');
        }
        expect(lifecycle.evaluateSmokeLifecycleCleanliness(root).clean).toBe(false);
        const preflight = lifecycle.preflightSmokeLifecycle({
          repoRoot: root,
          runId: 'next',
          closeBoundHandle: () => 'closed_owned_handle',
        });
        expect(preflight.admitted).toBe(false);
        expect(preflight.reason).toContain('unregistered_execution_evidence');
        fs.rmSync(root, { recursive: true, force: true });
      },
    );

    it('rejects registry runId mismatch with the containing directory', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-smoke-runid-mismatch-'));
      const artifactDir = reserve(root, 'container-run');
      const registry = lifecycle.readSmokeLifecycleRegistry(artifactDir)!;
      fs.writeFileSync(
        lifecycle.smokeLifecycleRegistryPath(artifactDir),
        JSON.stringify({ ...registry, runId: 'different-run' }),
        'utf8',
      );
      expect(lifecycle.readSmokeLifecycleRegistry(artifactDir)).toBeUndefined();
      expect(lifecycle.evaluateSmokeLifecycleCleanliness(root).reasons).toContain(
        'corrupt_lifecycle_state:container-run',
      );
      fs.rmSync(root, { recursive: true, force: true });
    });
  });

  describe('review findings: recovery and admission races (#1138)', () => {
    it('serializes stale-lock reclamation against a second starter', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-smoke-stale-lock-race-'));
      const lockPath = lifecycle.smokeAdmissionLockPath(root);
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fs.writeFileSync(lockPath, JSON.stringify({
        version: 1,
        runId: 'stale',
        supervisorPid: 999,
        startedAtMs: 0,
      }), 'utf8');
      let contender: ReturnType<typeof lifecycle.preflightSmokeLifecycle> | undefined;
      const winner = lifecycle.preflightSmokeLifecycle({
        repoRoot: root,
        runId: 'winner',
        supervisorPid: 111,
        nowMs: 10,
        isProcessAlive: (pid) => pid === 111,
        closeBoundHandle: () => 'closed_owned_handle',
        afterAdmissionReclaimMarker: () => {
          contender = lifecycle.preflightSmokeLifecycle({
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
      expect(JSON.parse(fs.readFileSync(lockPath, 'utf8'))).toMatchObject({ runId: 'winner' });
      lifecycle.releaseSmokeAdmission(root, 'winner');
      fs.rmSync(root, { recursive: true, force: true });
    });

    it('keeps settled stale-handle recovery smoke-only blocking without an exact receipt', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-smoke-before-close-crash-'));
      const runId = 'before-close-crash';
      const artifactDir = seedBound(root, runId, 9001);
      rewriteRegistry(artifactDir, (bound) => ({
        ...bound,
        spawnState: 'cleanup_pending',
        closeAttemptedAtMs: 2,
        updatedAtMs: 2,
      }));
      const close = vi.fn(() => 'close_failed:channel_stale_handle');
      const result = lifecycle.preflightSmokeLifecycle({
        repoRoot: root,
        runId: 'next',
        supervisorPid: 333,
        nowMs: 3,
        shutdownMs: 0,
        isProcessAlive: () => false,
        closeBoundHandle: close,
      });
      expect(result).toMatchObject({
        admitted: false,
        allowed: false,
        blockingScope: 'worker_smoke_only',
        workerMayContinue: true,
        reason: `cleanup_attempt_already_settled:${runId}`,
      });
      expect(close).not.toHaveBeenCalled();
      expect(lifecycle.readSmokeLifecycleRegistry(artifactDir)).toMatchObject({
        spawnState: 'cleanup_pending',
        closeAttemptedAtMs: 2,
      });
      fs.rmSync(root, { recursive: true, force: true });
    });

    it('uses an exact v2 post-close receipt after crash-before-finalization', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-smoke-after-close-crash-'));
      const runId = 'after-close-crash';
      const artifactDir = seedBound(root, runId, 9002);
      const firstClose = vi.fn(() => 'closed_owned_handle');
      const freshCleanup = lifecycle.cleanupSmokeLifecycle({
        artifactDir,
        runId,
        reason: 'child_completed',
        requestCancellation: false,
        cooperativeAcknowledgementObserved: true,
        closeBoundHandle: firstClose,
        nowMs: 2,
      });
      expect(freshCleanup.clean).toBe(true);
      expect(firstClose).toHaveBeenCalledTimes(1);

      const staleOutcome = 'close_failed:terminal_handle_stale';
      const staleCompletedAtMs = 3;
      rewriteRegistry(artifactDir, (clean) => ({
        ...clean,
        spawnState: 'cleanup_failed',
        updatedAtMs: staleCompletedAtMs,
        cleanup: {
          reason: 'restart_recovery',
          cooperativeAcknowledgementObserved: true,
          closeOutcome: staleOutcome,
          operatorFilesCleared: true,
          completedAtMs: staleCompletedAtMs,
        },
      }));
      fs.writeFileSync(lifecycle.smokeTerminalRecordPath(artifactDir), JSON.stringify({
        version: 1,
        runId,
        reason: 'restart_recovery',
        cooperativeAcknowledgementObserved: true,
        closeOutcome: staleOutcome,
        operatorFilesCleared: true,
        cleanupClean: false,
        completedAtMs: staleCompletedAtMs,
      }), 'utf8');

      const close = vi.fn(() => 'close_failed:channel_stale_handle');
      const result = lifecycle.preflightSmokeLifecycle({
        repoRoot: root,
        runId: 'next',
        supervisorPid: 333,
        nowMs: 4,
        shutdownMs: 0,
        isProcessAlive: () => false,
        closeBoundHandle: close,
      });
      expect(result.admitted).toBe(true);
      expect(close).not.toHaveBeenCalled();
      expect(lifecycle.readSmokeLifecycleRegistry(artifactDir)).toMatchObject({
        spawnState: 'clean',
        cleanup: { closeOutcome: 'closed_owned_handle' },
      });
      lifecycle.releaseSmokeAdmission(root, 'next');
      fs.rmSync(root, { recursive: true, force: true });
    });

    it('does not recover a bound child while its recorded supervisor is alive', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-smoke-live-supervisor-'));
      const runId = 'live-supervisor';
      const artifactDir = seedBound(root, runId, 777);
      const close = vi.fn(() => 'closed_owned_handle');
      const result = lifecycle.preflightSmokeLifecycle({
        repoRoot: root,
        runId: 'contender',
        supervisorPid: 888,
        nowMs: 10,
        isProcessAlive: (pid) => pid === 777 || pid === 888,
        closeBoundHandle: close,
      });
      expect(result).toMatchObject({
        admitted: false,
        reason: `active_smoke_supervisor:${runId}`,
      });
      expect(close).not.toHaveBeenCalled();
      expect(fs.existsSync(lifecycle.smokeCancelRequestPath(artifactDir))).toBe(false);
      fs.rmSync(root, { recursive: true, force: true });
    });

    it('keeps a parent-crashed create phase blocking without a terminal outcome witness', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-smoke-create-parent-crash-'));
      const runId = 'create-parent-crash';
      const artifactDir = reserve(root, runId, 999);
      lifecycle.markSmokeCreateInProgress(artifactDir, 1);
      const close = vi.fn(() => 'closed_owned_handle');
      const result = lifecycle.preflightSmokeLifecycle({
        repoRoot: root,
        runId: 'next',
        supervisorPid: 1000,
        nowMs: lifecycle.SMOKE_CREATE_TIMEOUT_MS + 10,
        isProcessAlive: () => false,
        closeBoundHandle: close,
      });
      expect(result).toMatchObject({
        admitted: false,
        reason: `blocking_create_phase:${runId}:create_in_progress`,
      });
      expect(lifecycle.readSmokeLifecycleRegistry(artifactDir)?.spawnState).toBe('create_in_progress');
      expect(close).not.toHaveBeenCalled();
      fs.rmSync(root, { recursive: true, force: true });
    });

    it.each(['missing-body', 'digest-mismatch', 'malformed-body', 'duplicate'] as const)(
      'does not accept %s completion as shutdown acknowledgement',
      (kind) => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), `worker-smoke-completion-${kind}-`));
        const runId = `completion-${kind}`;
        const artifactDir = seedBound(root, runId, 5000);
        if (kind === 'missing-body') {
          const digest = '1'.repeat(64);
          fs.writeFileSync(
            core.smokeCompletionSealPath(artifactDir, digest),
            JSON.stringify({ runId, bodySha256: digest }),
            'utf8',
          );
        } else if (kind === 'digest-mismatch') {
          const digest = '2'.repeat(64);
          fs.writeFileSync(core.smokeCompletionBodyPath(artifactDir, digest), 'different bytes', 'utf8');
          fs.writeFileSync(
            core.smokeCompletionSealPath(artifactDir, digest),
            JSON.stringify({ runId, bodySha256: digest }),
            'utf8',
          );
        } else if (kind === 'malformed-body') {
          const body = 'not a smoke report';
          const digest = core.computeSmokeCompletionBodyDigest(body);
          fs.writeFileSync(core.smokeCompletionBodyPath(artifactDir, digest), body, 'utf8');
          fs.writeFileSync(
            core.smokeCompletionSealPath(artifactDir, digest),
            JSON.stringify({ runId, bodySha256: digest }),
            'utf8',
          );
        } else {
          publishCompletion(artifactDir, runId, '-one');
          publishCompletion(artifactDir, runId, '-two');
        }
        let now = 0;
        const result = lifecycle.preflightSmokeLifecycle({
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
        const terminal = JSON.parse(fs.readFileSync(
          lifecycle.smokeTerminalRecordPath(artifactDir),
          'utf8',
        ));
        expect(terminal.cooperativeAcknowledgementObserved).toBe(false);
        lifecycle.releaseSmokeAdmission(root, 'next');
        fs.rmSync(root, { recursive: true, force: true });
      },
    );
  });

  describe('worker smoke cleanup structured proof (#1318)', () => {
    it('executes the exact fixed-input producer and emits one proved record', () => {
      const script = path.join(import.meta.dirname, '..', 'worker-smoke-cleanup-proof.ts');
      const result = runProcessSync({
        command: process.execPath,
        args: ['--experimental-strip-types', script],
        cwd: path.join(import.meta.dirname, '..'),
        inheritParentEnv: true,
      });
      expect(result.ok).toBe(true);
      expect(result.stderr).toBe('');
      const lines = result.stdout.trim().split(/\r?\n/u);
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
        schema: 'worker-smoke-cleanup-proof/v1',
        status: 'proved',
        runtimeOperations: 0,
        closeAttempts: 0,
        freshReservationAdmitted: true,
        smokeOnlyDenial: true,
      });
    });
  });

  describe('review findings: honest abandonment cleanup (#1138)', () => {
    it('tombstones operator files before recording clean abandonment', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-smoke-abandon-operator-'));
      const runId = 'abandon-operator';
      const artifactDir = reserve(root, runId);
      lifecycle.markSmokeCreateAmbiguous(artifactDir, 'timeout');
      const live = path.join(artifactDir, 'live');
      fs.mkdirSync(live, { recursive: true });
      fs.writeFileSync(path.join(live, 'OPERATOR-ACTION-stale.txt'), 'stale', 'utf8');
      const abandoned = lifecycle.abandonAmbiguousUnbound(artifactDir);
      expect(abandoned.spawnState).toBe('abandoned_unbound');
      expect(fs.readdirSync(live).some((entry) => entry.includes('.tombstoned-'))).toBe(true);
      expect(JSON.parse(fs.readFileSync(
        lifecycle.smokeTerminalRecordPath(artifactDir),
        'utf8',
      ))).toMatchObject({ operatorFilesCleared: true, cleanupClean: true });
      fs.rmSync(root, { recursive: true, force: true });
    });

    it('keeps ambiguity blocking when operator cleanup fails', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-smoke-abandon-operator-fail-'));
      const runId = 'abandon-operator-fail';
      const artifactDir = reserve(root, runId);
      lifecycle.markSmokeCreateAmbiguous(artifactDir, 'timeout');
      fs.writeFileSync(path.join(artifactDir, 'live'), 'not-a-directory', 'utf8');
      expect(() => lifecycle.abandonAmbiguousUnbound(artifactDir)).toThrow(/operator cleanup failed/u);
      expect(lifecycle.readSmokeLifecycleRegistry(artifactDir)?.spawnState).toBe('ambiguous_unbound');
      expect(() => fs.readFileSync(lifecycle.smokeTerminalRecordPath(artifactDir), 'utf8')).toThrow();
      fs.rmSync(root, { recursive: true, force: true });
    });
  });
}
