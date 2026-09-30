// @vitest-ci-lane light
// @vitest-pre-topology-seconds 60
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runSchedulerTick, SCHEDULER_RUN_TICK_PHASE_INVENTORY, type SchedulerBoundary } from './scheduler.ts';

function epochEnv(root: string): NodeJS.ProcessEnv {
  const authority = path.join(root, 'epoch.json');
  const epochId = 'epoch-2250-scheduler';
  const nonce = 'nonce-2250-scheduler';
  writeFileSync(authority, JSON.stringify({
    schemaVersion: 1,
    currentEpochId: epochId,
    records: [{
      epochId,
      nonce,
      hostId: 'host-test',
      repoRoot: process.cwd(),
      installedCommitSha: 'a'.repeat(40),
      snapshotDigests: {},
      importDigests: {},
      registryHash: 'a',
      preCommitLogDigest: 'b',
      commitAt: '2026-08-19T00:00:00.000Z',
    }],
  }), 'utf8');
  return {
    ...process.env,
    ORCHESTRATOR_CUTOVER_EPOCH_AUTHORITY: authority,
    ORCHESTRATOR_CUTOVER_EPOCH_ID: epochId,
    ORCHESTRATOR_CUTOVER_NONCE: nonce,
  };
}

function makeBoundary() {
  const headSha = 'c'.repeat(40);
  const start = vi.fn(async () => ({ ok: true }));
  const readChecks = vi.fn(async () => [
    { name: 'Verify orchestrator-pack structure', state: 'success' },
    { name: 'PR scope guard', state: 'success' },
    { name: 'Run pack contract tests', state: 'success' },
    { name: 'Self-architect lint', state: 'success' },
  ]);
  const boundary: SchedulerBoundary = {
    listCandidates: () => [{ sessionId: 'session-2250', repoSlug: 'example/smoke', prNumber: 10, boundHeadSha: headSha }],
    readCurrentPr: async () => ({ number: 10, headRefOid: headSha, state: 'OPEN', isDraft: false }),
    readChecks,
    listReviewRuns: () => [],
    start,
  };
  return { boundary, start, readChecks };
}

describe('Issue #2250 scheduler current-head CI after smoke reconciler removal', () => {
  it('continues to defer pack review when required CI is not green', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'scheduler-2250-negative-'));
    try {
      const { boundary, start, readChecks } = makeBoundary();
      readChecks.mockResolvedValue([{ name: 'PR scope guard', state: 'failure' }]);
      const result = await runSchedulerTick(boundary, epochEnv(root));
      expect(result).toMatchObject({ attempted: 1, started: 0, skipped: 1 });
      expect(start).not.toHaveBeenCalled();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
