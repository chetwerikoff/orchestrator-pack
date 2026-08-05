#!/usr/bin/env -S node --experimental-strip-types

import './toolchain/native-entrypoint-preflight.ts';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bindSmokeTerminalHandle,
  cleanupSmokeLifecycle,
  createSmokeLifecycleReservation,
  preflightSmokeLifecycle,
  readSmokeLifecycleRegistry,
  releaseSmokeAdmission,
  smokeCloseReceiptPath,
  smokeLifecycleRegistryPath,
  smokeTerminalRecordPath,
} from './lib/worker-smoke-lifecycle.ts';

const HEAD = 'a'.repeat(40);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function runDir(root: string, runId: string): string {
  return join(root, '.orca-worker-smoke', 'runs', runId);
}

function seedProvenHistoricalCleanup(root: string, runId: string): string {
  const artifactDir = runDir(root, runId);
  createSmokeLifecycleReservation({
    runId,
    artifactDir,
    issueNumber: 1318,
    prNumber: 1319,
    headSha: HEAD,
    supervisorPid: 111,
    nowMs: 100,
    scenarioCount: 1,
  });
  bindSmokeTerminalHandle(artifactDir, `term_${runId}`, 110);
  const cleanup = cleanupSmokeLifecycle({
    artifactDir,
    runId,
    reason: 'child_completed',
    requestCancellation: false,
    cooperativeAcknowledgementObserved: true,
    closeBoundHandle: () => 'closed_owned_handle',
    nowMs: 120,
  });
  assert(cleanup.clean, 'fresh cleanup must produce accepted closed proof');
  const cleanRegistry = readSmokeLifecycleRegistry(artifactDir);
  assert(cleanRegistry?.spawnState === 'clean', 'fresh lifecycle must be clean');
  assert(cleanRegistry.closeAttemptedAtMs === 120, 'close attempt must follow settlement');

  const staleCompletedAtMs = 130;
  const staleOutcome = 'close_failed:terminal_handle_stale';
  const staleCleanup = {
    reason: 'restart_recovery',
    cooperativeAcknowledgementObserved: true,
    closeOutcome: staleOutcome,
    operatorFilesCleared: true,
    completedAtMs: staleCompletedAtMs,
  };
  writeFileSync(smokeLifecycleRegistryPath(artifactDir), `${JSON.stringify({
    ...cleanRegistry,
    spawnState: 'cleanup_failed',
    updatedAtMs: staleCompletedAtMs,
    cleanup: staleCleanup,
  }, null, 2)}\n`, 'utf8');
  writeFileSync(smokeTerminalRecordPath(artifactDir), `${JSON.stringify({
    version: 1,
    runId,
    reason: staleCleanup.reason,
    cooperativeAcknowledgementObserved: true,
    closeOutcome: staleOutcome,
    operatorFilesCleared: true,
    cleanupClean: false,
    completedAtMs: staleCompletedAtMs,
  }, null, 2)}\n`, 'utf8');
  return artifactDir;
}

function proveRecoveryAndContinuation(): {
  runtimeOperations: number;
  closeAttempts: number;
  freshReservationAdmitted: boolean;
} {
  const root = mkdtempSync(join(tmpdir(), 'worker-smoke-proof-positive-'));
  let runtimeOperations = 0;
  let closeAttempts = 0;
  try {
    const oldArtifactDir = seedProvenHistoricalCleanup(root, 'historical');
    mkdirSync(join(oldArtifactDir, 'live'), { recursive: true });
    writeFileSync(join(oldArtifactDir, 'live', 'OPERATOR-ACTION-stale.txt'), 'stale', 'utf8');

    const admission = preflightSmokeLifecycle({
      repoRoot: root,
      runId: 'fresh',
      supervisorPid: 222,
      nowMs: 200,
      isProcessAlive: () => {
        runtimeOperations += 1;
        throw new Error('historical reconciliation must not inspect a process');
      },
      closeBoundHandle: () => {
        closeAttempts += 1;
        throw new Error('historical reconciliation must not close again');
      },
    });
    assert(admission.admitted, `proven historical cleanup must reconcile: ${admission.reason ?? ''}`);
    assert(runtimeOperations === 0, 'reconciliation performed a runtime/process operation');
    assert(closeAttempts === 0, 'reconciliation performed a second close');

    const reconciled = readSmokeLifecycleRegistry(oldArtifactDir);
    assert(reconciled?.spawnState === 'clean', 'historical lifecycle was not reconciled clean');
    assert(
      reconciled.cleanup?.reason.startsWith('receipt_first_historical_cleanup:'),
      'receipt-first reconciliation provenance was not recorded',
    );
    assert(
      readFileSync(smokeCloseReceiptPath(oldArtifactDir), 'utf8').includes('"phase": "closed"'),
      'accepted receipt was not preserved',
    );

    const freshArtifactDir = runDir(root, 'fresh');
    createSmokeLifecycleReservation({
      runId: 'fresh',
      artifactDir: freshArtifactDir,
      issueNumber: 1318,
      prNumber: 1319,
      headSha: HEAD,
      supervisorPid: 222,
      nowMs: 201,
      scenarioCount: 1,
    });
    assert(readSmokeLifecycleRegistry(freshArtifactDir)?.spawnState === 'reserved', 'fresh reservation missing');
    assert(releaseSmokeAdmission(root, 'fresh'), 'fresh admission lock was not owned');
    return { runtimeOperations, closeAttempts, freshReservationAdmitted: true };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function proveScopedDenial(): boolean {
  const root = mkdtempSync(join(tmpdir(), 'worker-smoke-proof-negative-'));
  let runtimeOperations = 0;
  let closeAttempts = 0;
  try {
    const artifactDir = seedProvenHistoricalCleanup(root, 'unproven');
    unlinkSync(smokeCloseReceiptPath(artifactDir));
    const admission = preflightSmokeLifecycle({
      repoRoot: root,
      runId: 'next',
      supervisorPid: 333,
      nowMs: 300,
      isProcessAlive: () => {
        runtimeOperations += 1;
        throw new Error('unproven history must not trigger process inspection');
      },
      closeBoundHandle: () => {
        closeAttempts += 1;
        throw new Error('unproven history must not trigger close');
      },
    });
    assert(!admission.admitted, 'missing receipt must deny new smoke');
    assert(runtimeOperations === 0, 'smoke-only denial inspected runtime state');
    assert(closeAttempts === 0, 'smoke-only denial attempted close');
    assert(admission.allowed === false, 'smoke-only denial unexpectedly allowed smoke');
    assert(admission.blockingScope === 'worker_smoke_only', 'blocking scope is not capability-local');
    assert(admission.workerMayContinue === true, 'worker continuation was not preserved');
    return true;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

try {
  const positive = proveRecoveryAndContinuation();
  const smokeOnlyDenial = proveScopedDenial();
  process.stdout.write(`${JSON.stringify({
    schema: 'worker-smoke-cleanup-proof/v1',
    status: 'proved',
    runtimeOperations: positive.runtimeOperations,
    closeAttempts: positive.closeAttempts,
    freshReservationAdmitted: positive.freshReservationAdmitted,
    smokeOnlyDenial,
  })}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`worker-smoke-cleanup-proof: ${message}\n`);
  process.exitCode = 1;
}
