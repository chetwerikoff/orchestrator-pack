import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bindSmokeTerminalHandle,
  cleanupSmokeLifecycle,
  createSmokeLifecycleReservation,
  hasValidSmokeCloseReceipt,
  readSmokeLifecycleRegistry,
} from './worker-smoke-lifecycle.ts';
import { readCloseReceipt } from './worker-smoke-receipt.ts';

export function registerWorkerSmokeCleanupClockRegressionTests(input: {
  expect: typeof import('vitest').expect;
  it: typeof import('vitest').it;
  vi: typeof import('vitest').vi;
}): void {
  const { expect, it, vi } = input;

  it('advancing clock between cleanup layers preserves one cleanup timestamp', () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-smoke-advancing-clock-'));
    const runId = 'advancing-clock-between-cleanup-layers';
    const artifactDir = join(root, '.orca-worker-smoke', 'runs', runId);
    try {
      createSmokeLifecycleReservation({
        runId,
        artifactDir,
        issueNumber: 1315,
        prNumber: 1315,
        headSha: 'c'.repeat(40),
        supervisorPid: process.pid,
        nowMs: 10,
        scenarioCount: 1,
      });
      bindSmokeTerminalHandle(artifactDir, 'term_advancing_clock', 20);

      let tick = 1_000;
      const advancingClock = vi.fn(() => tick++);
      const globalDateNow = vi.spyOn(Date, 'now').mockImplementation(() => advancingClock());
      const close = vi.fn(() => 'closed_owned_handle');
      try {
        const result = cleanupSmokeLifecycle({
          artifactDir,
          runId,
          reason: 'child_completed',
          requestCancellation: false,
          cooperativeAcknowledgementObserved: true,
          closeBoundHandle: close,
          now: advancingClock,
        });

        expect(advancingClock).toHaveBeenCalledTimes(1);
        expect(globalDateNow).not.toHaveBeenCalled();
        expect(close).toHaveBeenCalledTimes(1);
        expect(close).toHaveBeenCalledWith('term_advancing_clock');
        expect(result).toMatchObject({
          clean: true,
          closeOutcome: 'closed_owned_handle',
          operatorFilesCleared: true,
        });

        const registry = readSmokeLifecycleRegistry(artifactDir);
        expect(registry).toMatchObject({
          spawnState: 'clean',
          closeAttemptedAtMs: 1_000,
          updatedAtMs: 1_000,
          cleanup: {
            closeOutcome: 'closed_owned_handle',
            completedAtMs: 1_000,
          },
        });
        expect(registry).toBeDefined();
        const receipt = readCloseReceipt(artifactDir, registry!);
        expect(receipt.state).toBe('closed');
        if (receipt.state === 'closed') {
          expect(receipt.receipt).toMatchObject({
            settlementAtMs: 1_000,
            closeAttemptedAtMs: 1_000,
            recordedAtMs: 1_000,
            closeOutcome: 'closed_owned_handle',
          });
        }
        expect(hasValidSmokeCloseReceipt(artifactDir)).toBe(true);
      } finally {
        globalDateNow.mockRestore();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
