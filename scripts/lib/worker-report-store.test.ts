// @vitest-ci-lane light
// @vitest-pre-topology-seconds 1
import { describe, expect, it } from 'vitest';
import {
  WORKER_REPORT_STORE_SCHEMA_VERSION,
  findPackWorkerAckReportAfterDelivery,
  mergePackWorkerReportsIntoWorkers,
  normalizeWorkerReportStore,
  resolvePackWorkerReportDeliveryRunId,
  resolveWorkerReportTrustedBinding,
  upsertWorkerReportRecordInMemory,
} from '../../docs/worker-report-store.mjs';

const worker = { runtime: 'orca', id: 'worker-1', generation: 'g-7' } as const;
const assignment = { assignmentId: 'wa-1', generation: 3, taskId: 'task-1416' } as const;
const headSha = '0123456789abcdef0123456789abcdef01234567';

describe('worker report store logical assignment authority', () => {
  it('keeps schema v3 and drops pre-v3 session-keyed state instead of migrating it', () => {
    const normalized = normalizeWorkerReportStore({
      schemaVersion: 2,
      sourceRecords: { legacy: { sessionId: 'ao-session', reportState: 'ready_for_review' } },
    });
    expect(normalized.schemaVersion).toBe(WORKER_REPORT_STORE_SCHEMA_VERSION);
    expect(normalized.sourceRecords).toEqual({});
    expect(normalized.generation).toBe(0);
  });

  it('binds a report to exact assignment plus exact PR head', () => {
    const binding = resolveWorkerReportTrustedBinding({
      assignment,
      worker,
      prNumber: 1416,
      worktreeHeadSha: headSha,
      openPrs: [{ number: 1416, state: 'open', headRefOid: headSha }],
    });
    expect(binding).toMatchObject({ ok: true, prNumber: 1416, headSha, assignment, worker });

    const mismatch = upsertWorkerReportRecordInMemory({
      store: {},
      nowMs: 10,
      trustedBinding: binding,
      record: {
        reportState: 'ready_for_review',
        accepted: true,
        assignment: { ...assignment, generation: 4 },
        worker,
        repoSlug: 'chetwerikoff/orchestrator-pack',
        prNumber: 1416,
        headSha,
      },
    });
    expect(mismatch).toEqual({ ok: false, reason: 'trust_boundary_assignment_mismatch' });
  });

  it('stores remote reports without fabricating RuntimeWorker identity and projects by assignment', () => {
    const binding = resolveWorkerReportTrustedBinding({
      assignment,
      prNumber: 1416,
      worktreeHeadSha: headSha,
      openPrs: [{ number: 1416, state: 'open', headRefOid: headSha }],
    });
    const written = upsertWorkerReportRecordInMemory({
      store: {},
      nowMs: 1_000,
      trustedBinding: binding,
      record: {
        reportState: 'fixing_ci',
        accepted: true,
        assignment,
        repoSlug: 'chetwerikoff/orchestrator-pack',
        prNumber: 1416,
        headSha,
      },
    });
    expect(written.ok).toBe(true);
    if (!written.ok || !written.store) throw new Error(written.reason);
    expect(JSON.stringify(written.record)).not.toContain('runtime');

    const merged = mergePackWorkerReportsIntoWorkers([
      { assignment, kind: 'remote', provider: 'browser-gpt', bindingKey: 'remote-1', repoSlug: 'chetwerikoff/orchestrator-pack' },
      { assignment: { ...assignment, generation: 4 }, kind: 'remote', provider: 'browser-gpt', bindingKey: 'remote-2', repoSlug: 'chetwerikoff/orchestrator-pack' },
    ], written.store, 'chetwerikoff/orchestrator-pack');
    expect(merged[0]?.reports).toHaveLength(1);
    expect(merged[1]?.reports).toBeUndefined();
  });

  it('keeps legacy exact RuntimeWorker projection readable as history', () => {
    const binding = resolveWorkerReportTrustedBinding({
      worker,
      prNumber: 1416,
      worktreeHeadSha: headSha,
      openPrs: [{ number: 1416, state: 'open', headRefOid: headSha }],
    });
    const written = upsertWorkerReportRecordInMemory({
      store: {}, nowMs: 1_000, trustedBinding: binding,
      record: { reportState: 'working', accepted: true, worker, repoSlug: 'chetwerikoff/orchestrator-pack', prNumber: 1416, headSha },
    });
    expect(written.ok).toBe(true);
    if (!written.ok || !written.store) throw new Error(written.reason);
    const merged = mergePackWorkerReportsIntoWorkers([
      { identity: worker, workspacePath: '/work/a', title: null, provenance: 'internal' },
      { identity: { ...worker, generation: 'g-8' }, workspacePath: '/work/b', title: null, provenance: 'internal' },
    ], written.store, 'chetwerikoff/orchestrator-pack');
    expect(merged[0]?.reports).toHaveLength(1);
    expect(merged[1]?.reports).toBeUndefined();
  });

  it('resolves and acknowledges review delivery by PR/head/run rather than session id', () => {
    const run = { id: 'run-1', prNumber: 1416, targetSha: headSha, prReviewStatus: 'changes_requested', latestRunStatus: 'delivered', deliveredAt: new Date(1_500).toISOString(), deliveredFindingCount: 1 };
    expect(resolvePackWorkerReportDeliveryRunId({ reportState: 'addressing_reviews', prNumber: 1416, headSha, reviewRuns: [run] })).toBe('run-1');
    const reportWorker = {
      reportSnapshotKind: 'pack-worker-report-store',
      reports: [{ reportState: 'addressing_reviews', headSha, deliveryRunId: 'run-1', reportedAt: new Date(2_000).toISOString() }],
    };
    expect(findPackWorkerAckReportAfterDelivery(reportWorker, run, 1_000)).not.toBeNull();
  });
});
