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

describe('Issue #2250 scheduler post-review smoke starter retirement', () => {
  it('defers pending shared CI and starts exactly once when the same head becomes green', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'scheduler-2346-required-ci-'));
    try {
      const { boundary, start, readChecks } = makeBoundary();
      const headSha = 'c'.repeat(40);
      let covered = false;
      start.mockImplementation(async () => {
        covered = true;
        return { ok: true };
      });
      boundary.listReviewRuns = () => covered
        ? [{ targetSha: headSha, status: 'reviewing' }] as ReturnType<SchedulerBoundary['listReviewRuns']>
        : [];
      boundary.resolveRequiredCi = vi.fn()
        .mockResolvedValueOnce({
          state: 'pending',
          green: false,
          source: 'project_card',
          reason: 'required_selector_pending',
          expectedHeadSha: headSha,
          postProjectionHeadSha: headSha,
          headBinding: 'inferred_current',
          selectors: [{ kind: 'actions', workflow: 'CI', job: 'checks' }],
          diagnostics: ['required_selector_pending'],
        })
        .mockResolvedValue({
          state: 'green',
          green: true,
          source: 'project_card',
          reason: 'green',
          expectedHeadSha: headSha,
          postProjectionHeadSha: headSha,
          headBinding: 'inferred_current',
          selectors: [{ kind: 'actions', workflow: 'CI', job: 'checks' }],
          diagnostics: [],
        });

      expect(await runSchedulerTick(boundary, epochEnv(root)))
        .toMatchObject({ attempted: 1, started: 0, skipped: 1 });
      expect(await runSchedulerTick(boundary, epochEnv(root)))
        .toMatchObject({ attempted: 1, started: 1, skipped: 0 });
      expect(await runSchedulerTick(boundary, epochEnv(root)))
        .toMatchObject({ attempted: 1, started: 0, skipped: 1 });
      expect(start).toHaveBeenCalledTimes(1);
      expect(readChecks).not.toHaveBeenCalled();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('continues ordinary pack-review scheduling with no smoke reconciliation phase', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'scheduler-2250-'));
    try {
      const { boundary, start, readChecks } = makeBoundary();
      const result = await runSchedulerTick(boundary, epochEnv(root));
      expect(result).toMatchObject({ attempted: 1, started: 1, skipped: 0 });
      expect(readChecks).toHaveBeenCalledTimes(1);
      expect(start).toHaveBeenCalledTimes(1);
      expect(SCHEDULER_RUN_TICK_PHASE_INVENTORY.map((row) => row.phase))
        .not.toContain('detached-post-review-smoke-start-or-observe');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
