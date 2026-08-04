import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import './pack-review-worker-notification.cases.js';
import {
  classifyPackReviewPayload,
  deliverPackReviewVerdict,
  PACK_REVIEW_REQUIRED_STATUS_CONTEXT,
  recordMalformedPackReviewStatus,
  recordPackReviewPendingStatus,
  recordPackReviewUnfinishedTerminalStatus,
  packReviewRequiredStatusNeedsStaleReconciliation,
  restorePackReviewAuthoritativeRequiredStatus,
  resumePackReviewVerdictDelivery,
  type PackReviewRequiredStatusRequest,
  type PackReviewTerminalPayload,
} from './lib/pack-review-delivery.js';
import {
  createPackReviewRun,
  getPackReviewRun,
  isPackReviewRunStale,
  listPackReviewRuns,
  listPackReviewRunRecordsRaw,
  resolvePackReviewRunOrder,
  terminalizePackReviewStaleRun,
  updatePackReviewRun,
} from './lib/pack-review-run-store.js';
import { resolveRepositorySlug } from './lib/pack-gpt-reviewer.js';
import { reconcileStalePackReviewRuns, startPackReview } from './pack-review-runner.js';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEAD_SHA = '9'.repeat(40);
const tempRoots: string[] = [];

function tempRoot(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function createRun(storeRoot: string) {
  return createPackReviewRun({
    projectId: 'orchestrator-pack',
    storeRoot,
    prNumber: 894,
    headSha: HEAD_SHA,
    linkedSessionId: 'worker-894',
    startReason: 'test',
    surface: 'pack-review-delivery-test',
    trustedPackRoot: repoRoot,
    sourceRepoRoot: repoRoot,
    canonicalRepository: 'chetwerikoff/orchestrator-pack',
  }).run;
}

const blockingPayload: PackReviewTerminalPayload = {
  verdict: 'findings',
  findingCount: 1,
  findings: [{ title: 'Blocking', severity: 'error' }],
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('pack review journal-first delivery (Issue #894)', () => {
  it('persists the verdict before all channel attempts and isolates every channel failure', async () => {
    const storeRoot = tempRoot('opk-review-journal-first-');
    const run = createRun(storeRoot);
    const order: string[] = [];

    const result = await deliverPackReviewVerdict({
      projectId: 'orchestrator-pack',
      storeRoot,
      run,
      payload: blockingPayload,
      journalWriter(runId, fields, options) {
        const persisted = updatePackReviewRun(runId, fields, options);
        order.push('journal');
        expect(persisted.findings).toEqual(blockingPayload.findings);
        return persisted;
      },
      async postGithubComment() {
        order.push('github');
        throw new Error('comment channel down');
      },
      async writeRequiredStatus() {
        order.push('status');
        throw new Error('status channel down');
      },
      async notifyWorker() {
        order.push('worker');
        return { state: 'escalated', reason: 'worker channel down' };
      },
    });

    expect(result).toMatchObject({
      ok: true,
      reason: 'completed_with_delivery_failures',
      status: 'changes_requested',
    });
    expect(order).toEqual(['journal', 'github', 'status', 'worker']);

    const persisted = getPackReviewRun(run.id, { projectId: 'orchestrator-pack', storeRoot });
    expect(persisted).toMatchObject({
      status: 'changes_requested',
      latestRunStatus: 'changes_requested',
      exitCode: 0,
      reviewVerdict: 'findings',
      findingCount: 1,
      journalOutcome: { state: 'persisted', attempts: 1 },
      deliveryOutcomes: {
        githubComment: { state: 'failed' },
        requiredStatus: { state: 'failed' },
        workerNotification: { state: 'escalated' },
      },
    });
    expect(persisted?.findings).toEqual(blockingPayload.findings);
    for (const value of Object.values(persisted?.deliveryOutcomes ?? {})) {
      expect(value?.recordedAtUtc).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(value?.reason).toBeTruthy();
      expect(value?.idempotencyKey).toBeTruthy();
    }
  });

  it.each([
    ['clean', { verdict: 'clean', findingCount: 0, findings: [] }, 'up_to_date', 'success'],
    ['non-blocking', {
      verdict: 'findings',
      findingCount: 2,
      findings: [{ severity: 'warning' }, { severity: 'info' }],
    }, 'commented', 'success'],
    ['blocking', blockingPayload, 'changes_requested', 'failure'],
  ] as const)('maps %s verdicts to terminal and exact-head required-status states', async (
    _label,
    payload,
    expectedStatus,
    expectedRequiredStatus,
  ) => {
    const storeRoot = tempRoot('opk-review-status-map-');
    const run = createRun(storeRoot);
    const statusRequests: PackReviewRequiredStatusRequest[] = [];

    const result = await deliverPackReviewVerdict({
      projectId: 'orchestrator-pack',
      storeRoot,
      run,
      payload: {
        verdict: payload.verdict,
        findingCount: payload.findingCount,
        findings: [...payload.findings],
      },
      async postGithubComment() {
        return { id: 89401, url: 'fixture://review/89401', event: 'COMMENT' };
      },
      async writeRequiredStatus(request) {
        statusRequests.push(request);
      },
      async notifyWorker() {
        return { state: 'delivered', reason: 'fixture_dispatched' };
      },
    });

    expect(result.status).toBe(expectedStatus);
    expect(statusRequests).toEqual([expect.objectContaining({
      state: expectedRequiredStatus,
      context: PACK_REVIEW_REQUIRED_STATUS_CONTEXT,
    })]);
    const persisted = getPackReviewRun(run.id, { projectId: 'orchestrator-pack', storeRoot });
    expect(persisted).toMatchObject({
      status: expectedStatus,
      githubReviewEvent: 'COMMENT',
      deliveryOutcomes: {
        githubComment: { state: 'succeeded' },
        requiredStatus: { state: 'succeeded' },
        workerNotification: { state: 'delivered' },
      },
    });
  });

  it('preserves a verdict when the journal writer throws after durable persistence', async () => {
    const storeRoot = tempRoot('opk-review-verdict-persist-then-throw-');
    const run = createRun(storeRoot);
    const result = await deliverPackReviewVerdict({
      projectId: 'orchestrator-pack',
      storeRoot,
      run,
      payload: { verdict: 'clean', findingCount: 0, findings: [] },
      journalWriter(runId, fields, options) {
        updatePackReviewRun(runId, fields, options);
        throw new Error('post-persist delivery fault');
      },
      async postGithubComment() {
        return { id: 1307, url: 'fixture://review/1307', event: 'COMMENT' };
      },
      async writeRequiredStatus() {},
      async notifyWorker() {
        return { state: 'delivered', reason: 'fixture_dispatched' };
      },
    });
    expect(result.status).toBe('up_to_date');
    expect(getPackReviewRun(run.id, { projectId: 'orchestrator-pack', storeRoot })).toMatchObject({
      status: 'up_to_date',
      reviewVerdict: 'clean',
      journalOutcome: { state: 'persisted' },
    });
    expect(getPackReviewRun(run.id, { projectId: 'orchestrator-pack', storeRoot })?.failureReason).toBeUndefined();
  });

  it('persists a recovered GitHub outcome when reconciliation completed before the channel write', async () => {
    const storeRoot = tempRoot('opk-review-comment-outcome-recovery-');
    const run = createRun(storeRoot);
    const recoveredAt = '2026-07-18T05:10:00.000Z';
    const reviewId = 89405;
    const githubKey = `github-comment:${run.id}:${HEAD_SHA}`;
    const statusKey = `required-status:${PACK_REVIEW_REQUIRED_STATUS_CONTEXT}:${HEAD_SHA}`;
    const workerKey = `worker-notification:${run.id}:${HEAD_SHA}`;
    const journaled = updatePackReviewRun(run.id, {
      status: 'reviewing',
      latestRunStatus: 'reviewing',
      reviewVerdict: 'clean',
      findingCount: 0,
      findings: [],
      journalOutcome: {
        state: 'persisted',
        recordedAtUtc: '2026-07-18T05:00:00.000Z',
        reason: 'verdict_persisted',
        idempotencyKey: `verdict:${run.id}:${HEAD_SHA}`,
        attempts: 1,
      },
      githubReviewReconciliation: {
        schemaVersion: 1,
        event: 'COMMENT',
        phase: 'complete',
        actorLogin: 'pack-reviewer',
        commentBody: 'fixture recovered comment',
        commentReviewId: reviewId,
        commentReviewUrl: `fixture://review/${reviewId}`,
        pendingDismissalReviewIds: [],
        dismissedReviewIds: [],
        preparedAtUtc: '2026-07-18T05:00:00.000Z',
        updatedAtUtc: '2026-07-18T05:00:01.000Z',
      },
      deliveryOutcomes: {
        requiredStatus: {
          state: 'succeeded',
          recordedAtUtc: '2026-07-18T05:00:02.000Z',
          reason: 'status_success',
          idempotencyKey: statusKey,
        },
        workerNotification: {
          state: 'delivered',
          recordedAtUtc: '2026-07-18T05:00:03.000Z',
          reason: 'fixture_dispatched',
          idempotencyKey: workerKey,
        },
      },
    }, { projectId: 'orchestrator-pack', storeRoot });
    expect(journaled.deliveryOutcomes.githubComment).toBeUndefined();

    const postGithubComment = vi.fn(async () => ({
      id: 89406,
      url: 'fixture://review/89406',
      event: 'COMMENT' as const,
    }));
    const writeRequiredStatus = vi.fn(async () => undefined);
    const notifyWorker = vi.fn(async () => ({ state: 'delivered' as const, reason: 'unexpected_retry' }));

    const result = await resumePackReviewVerdictDelivery({
      projectId: 'orchestrator-pack',
      storeRoot,
      run: journaled,
      postGithubComment,
      writeRequiredStatus,
      notifyWorker,
      clock: () => new Date(recoveredAt),
    });

    expect(result).toMatchObject({
      ok: true,
      reason: 'completed',
      status: 'up_to_date',
      githubReviewId: reviewId,
      githubReviewUrl: `fixture://review/${reviewId}`,
    });
    expect(postGithubComment).not.toHaveBeenCalled();
    expect(writeRequiredStatus).not.toHaveBeenCalled();
    expect(notifyWorker).not.toHaveBeenCalled();
    expect(getPackReviewRun(run.id, { projectId: 'orchestrator-pack', storeRoot })).toMatchObject({
      status: 'up_to_date',
      githubReviewId: reviewId,
      githubReviewUrl: `fixture://review/${reviewId}`,
      githubReviewEvent: 'COMMENT',
      deliveryOutcomes: {
        githubComment: {
          state: 'succeeded',
          recordedAtUtc: recoveredAt,
          reason: 'comment_recovered',
          idempotencyKey: githubKey,
        },
        requiredStatus: { state: 'succeeded', idempotencyKey: statusKey },
        workerNotification: { state: 'delivered', idempotencyKey: workerKey },
      },
    });
  });

  it('records exhausted journal retries as a distinct escalation and attempts no delivery channel', async () => {
    const storeRoot = tempRoot('opk-review-journal-fail-');
    const run = createRun(storeRoot);
    const journalWriter = vi.fn(() => {
      throw new Error('injected store outage');
    });
    const postGithubComment = vi.fn(async () => ({ id: 1, url: 'fixture://review/1', event: 'COMMENT' as const }));
    const writeRequiredStatus = vi.fn(async () => undefined);
    const notifyWorker = vi.fn(async () => ({ state: 'delivered' as const, reason: 'unexpected' }));

    const result = await deliverPackReviewVerdict({
      projectId: 'orchestrator-pack',
      storeRoot,
      run,
      payload: blockingPayload,
      journalWriter,
      postGithubComment,
      writeRequiredStatus,
      notifyWorker,
    });

    expect(result).toMatchObject({
      ok: true,
      reason: 'journal_write_failed',
      status: 'changes_requested',
      journalOutcome: { state: 'journal_write_failed', attempts: 3 },
    });
    expect(journalWriter).toHaveBeenCalledTimes(3);
    expect(postGithubComment).not.toHaveBeenCalled();
    expect(writeRequiredStatus).not.toHaveBeenCalled();
    expect(notifyWorker).not.toHaveBeenCalled();
    const persistedRun = getPackReviewRun(run.id, { projectId: 'orchestrator-pack', storeRoot });
    expect(persistedRun).toMatchObject({
      status: 'changes_requested',
      exitCode: 0,
      journalOutcome: { state: 'journal_write_failed' },
      deliveryOutcomes: {},
    });
    expect(persistedRun?.failureReason).toBeUndefined();

    const retry = createPackReviewRun({
      projectId: 'orchestrator-pack',
      storeRoot,
      prNumber: 894,
      headSha: HEAD_SHA,
      linkedSessionId: 'worker-894-retry',
      startReason: 'journal-retry',
      surface: 'pack-review-delivery-test',
      trustedPackRoot: repoRoot,
      sourceRepoRoot: repoRoot,
      canonicalRepository: 'chetwerikoff/orchestrator-pack',
    });
    expect(retry).toMatchObject({ created: true, reused: false, reason: 'created' });
    expect(retry.run.id).not.toBe(run.id);
  });

  it('publishes pending for the admitted exact head without terminating the run', async () => {
    const storeRoot = tempRoot('opk-review-pending-');
    const run = createRun(storeRoot);
    const requests: PackReviewRequiredStatusRequest[] = [];

    const outcome = await recordPackReviewPendingStatus({
      projectId: 'orchestrator-pack',
      storeRoot,
      run,
      async writeRequiredStatus(request) {
        requests.push(request);
      },
    });

    expect(outcome).toMatchObject({ state: 'succeeded', reason: 'status_pending' });
    expect(requests).toEqual([expect.objectContaining({
      state: 'pending',
      context: PACK_REVIEW_REQUIRED_STATUS_CONTEXT,
    })]);
    expect(getPackReviewRun(run.id, { projectId: 'orchestrator-pack', storeRoot })).toMatchObject({
      status: 'queued',
      deliveryOutcomes: { requiredStatus: { state: 'succeeded', reason: 'status_pending' } },
    });
  });

  it('publishes error for malformed stdout without creating a verdict journal', async () => {
    const storeRoot = tempRoot('opk-review-malformed-');
    const run = createRun(storeRoot);
    const requests: PackReviewRequiredStatusRequest[] = [];

    const result = await recordMalformedPackReviewStatus({
      projectId: 'orchestrator-pack',
      storeRoot,
      run,
      failureReason: 'invalid JSON',
      async writeRequiredStatus(request) {
        requests.push(request);
      },
    });

    expect(result).toMatchObject({ ok: false, status: 'failed', reason: 'invalid JSON' });
    expect(requests).toEqual([expect.objectContaining({ state: 'error' })]);
    expect(getPackReviewRun(run.id, { projectId: 'orchestrator-pack', storeRoot })).toMatchObject({
      status: 'failed',
      exitCode: 0,
      failureReason: 'reviewer_output_malformed:invalid_terminal_payload',
      findings: [],
      deliveryOutcomes: { requiredStatus: { state: 'succeeded' } },
    });
    expect(getPackReviewRun(run.id, { projectId: 'orchestrator-pack', storeRoot })?.journalOutcome).toBeUndefined();
  });

  it('classifies unknown and malformed finding shapes as blocking', () => {
    expect(classifyPackReviewPayload({
      verdict: 'findings',
      findingCount: 3,
      findings: [{ severity: 'future' }, null, 'malformed'],
    })).toMatchObject({
      terminalStatus: 'changes_requested',
      requiredStatus: 'failure',
      blocking: true,
    });
  });
});

const STALE_REPO_A = 'fixture/orchestrator-pack';
const STALE_REPO_B = 'fixture/other-repo';
const STALE_HEAD_A = 'a'.repeat(40);
const STALE_HEAD_B = 'b'.repeat(40);
const staleEnvSnapshot = { ...process.env };

function seedActiveStaleRun(storeRoot: string, options: {
  prNumber?: number;
  headSha?: string;
  canonicalRepository?: string;
  sourceRepoRoot?: string;
  runnerPid?: number;
} = {}) {
  const created = createPackReviewRun({
    projectId: 'orchestrator-pack',
    storeRoot,
    prNumber: options.prNumber ?? 1067,
    headSha: options.headSha ?? STALE_HEAD_A,
    linkedSessionId: 'worker-1067',
    startReason: 'stale-reconcile-test',
    surface: 'pack-review-stale-reconcile-test',
    trustedPackRoot: repoRoot,
    sourceRepoRoot: options.sourceRepoRoot ?? repoRoot,
    canonicalRepository: options.canonicalRepository ?? STALE_REPO_A,
  });
  const staleTime = new Date(Date.now() - 15 * 60_000);
  updatePackReviewRun(created.run.id, {
    status: 'running',
    latestRunStatus: 'running',
    runnerPid: options.runnerPid ?? 9_999_999,
  }, { projectId: 'orchestrator-pack', storeRoot, now: staleTime });
  return created.run.id;
}

function markRunStale(storeRoot: string, runId: string, runnerPid = 9_999_999): void {
  const staleTime = new Date(Date.now() - 15 * 60_000);
  updatePackReviewRun(runId, {
    status: 'running',
    latestRunStatus: 'running',
    runnerPid,
  }, { projectId: 'orchestrator-pack', storeRoot, now: staleTime });
}

function harnessStaleEnv(storeRoot: string, capture: string): void {
  process.env.OPK_VITEST_HARNESS = '1';
  process.env.PACK_REVIEW_RUN_STALE_MINUTES = '2';
  process.env.PACK_REVIEW_REQUIRED_STATUS_CAPTURE_FILE = capture;
  process.env.PACK_REVIEWER = 'codex';
}

async function writePendingForStaleRun(storeRoot: string, runId: string, capture: string): Promise<void> {
  const run = getPackReviewRun(runId, { projectId: 'orchestrator-pack', storeRoot });
  if (!run) throw new Error(`missing run ${runId}`);
  await recordPackReviewPendingStatus({
    projectId: 'orchestrator-pack',
    storeRoot,
    run,
    writeRequiredStatus: async (request) => {
      mkdirSync(path.dirname(capture), { recursive: true });
      writeFileSync(capture, `${JSON.stringify(request)}\n`);
    },
  });
}

describe('pack review corrective contracts (Issue #1307)', () => {
  it('persists malformed terminal state before attempting its error status', async () => {
    const storeRoot = tempRoot('opk-1307-malformed-order-');
    const run = createRun(storeRoot);
    const observed: string[] = [];
    const result = await recordPackReviewUnfinishedTerminalStatus({
      projectId: 'orchestrator-pack',
      storeRoot,
      run,
      status: 'failed',
      failureReason: 'reviewer_output_malformed:invalid_terminal_payload',
      writeRequiredStatus: async (request) => {
        observed.push(request.state);
        expect(getPackReviewRun(run.id, { projectId: 'orchestrator-pack', storeRoot })).toMatchObject({
          status: 'failed',
          failureReason: 'reviewer_output_malformed:invalid_terminal_payload',
        });
      },
    });
    expect(result.status).toBe('failed');
    expect(observed).toEqual(['error']);
    expect(result.deliveryOutcome.state).toBe('succeeded');
  });

  it('allocates strict same-key order and rejects equal-time legacy ties', async () => {
    const storeRoot = tempRoot('opk-1307-order-');
    const first = createRun(storeRoot);
    updatePackReviewRun(first.id, { status: 'failed', latestRunStatus: 'failed' }, { projectId: 'orchestrator-pack', storeRoot });
    const second = createRun(storeRoot);
    updatePackReviewRun(second.id, { status: 'failed', latestRunStatus: 'failed' }, { projectId: 'orchestrator-pack', storeRoot });
    expect(second.sameKeyOrder).toBeGreaterThan(first.sameKeyOrder!);
    expect(resolvePackReviewRunOrder(listPackReviewRunRecordsRaw({ projectId: 'orchestrator-pack', storeRoot }), first)).toMatchObject({
      kind: 'newer',
      run: { id: second.id },
    });

    const legacyTime = '2026-08-04T04:00:00.000Z';
    for (const run of [first, second]) {
      const recordPath = path.join(storeRoot, 'runs', `${run.id}.json`);
      const record = JSON.parse(readFileSync(recordPath, 'utf8')) as Record<string, unknown>;
      delete record.sameKeyOrder;
      record.createdAt = legacyTime;
      record.failureReason = 'runner_disappeared_stale';
      writeFileSync(recordPath, `${JSON.stringify(record)}\n`);
    }
    const records = listPackReviewRunRecordsRaw({ projectId: 'orchestrator-pack', storeRoot });
    expect(resolvePackReviewRunOrder(records, first)).toEqual({ kind: 'ambiguous', reason: 'legacy_order_ambiguous' });
  });

  it('matches an unqualified same-repository start to a canonical run', () => {
    const storeRoot = tempRoot('opk-1307-mixed-identity-');
    const canonical = createRun(storeRoot);
    updatePackReviewRun(canonical.id, {
      status: 'failed',
      latestRunStatus: 'failed',
      failureReason: 'reviewer_process_failed',
    }, { projectId: 'orchestrator-pack', storeRoot });

    const recordPath = path.join(storeRoot, 'runs', `${canonical.id}.json`);
    const legacy = JSON.parse(readFileSync(recordPath, 'utf8')) as Record<string, unknown>;
    delete legacy.canonicalRepository;
    writeFileSync(recordPath, `${JSON.stringify(legacy)}\n`);

    const unqualified = createPackReviewRun({
      projectId: 'orchestrator-pack',
      storeRoot,
      prNumber: canonical.prNumber,
      headSha: canonical.targetSha,
      linkedSessionId: 'worker-1307-legacy',
      startReason: 'mixed-identity',
      surface: 'pack-review-delivery-test',
      trustedPackRoot: repoRoot,
      sourceRepoRoot: repoRoot,
      legacyRepositoryBySourceRoot: { [repoRoot]: 'chetwerikoff/orchestrator-pack' },
    });

    expect(unqualified.created).toBe(true);
    expect(unqualified.run.sameKeyOrder).toBeGreaterThan(canonical.sameKeyOrder!);
  });

  it('binds a canonical cross-checkout start to a legacy repository row', () => {
    const storeRoot = tempRoot('opk-1307-cross-checkout-identity-');
    const legacy = createRun(storeRoot);
    updatePackReviewRun(legacy.id, {
      status: 'failed',
      latestRunStatus: 'failed',
      failureReason: 'reviewer_process_failed',
    }, { projectId: 'orchestrator-pack', storeRoot });
    const recordPath = path.join(storeRoot, 'runs', `${legacy.id}.json`);
    const record = JSON.parse(readFileSync(recordPath, 'utf8')) as Record<string, unknown>;
    delete record.canonicalRepository;
    writeFileSync(recordPath, `${JSON.stringify(record)}\n`);

    const next = createPackReviewRun({
      projectId: 'orchestrator-pack',
      storeRoot,
      prNumber: legacy.prNumber,
      headSha: legacy.targetSha,
      linkedSessionId: 'worker-1307-cross-checkout',
      startReason: 'mixed-identity-cross-checkout',
      surface: 'pack-review-delivery-test',
      trustedPackRoot: repoRoot,
      sourceRepoRoot: path.join(storeRoot, 'other-checkout'),
      canonicalRepository: 'chetwerikoff/orchestrator-pack',
      legacyRepositoryBySourceRoot: { [repoRoot]: 'chetwerikoff/orchestrator-pack' },
    });

    expect(next.created).toBe(true);
    expect(next.run.sameKeyOrder).toBeGreaterThan(legacy.sameKeyOrder!);
  });

  it('lets an ordered run outrank an equal-time legacy tie', () => {
    const storeRoot = tempRoot('opk-1307-ordered-over-legacy-tie-');
    const first = createRun(storeRoot);
    updatePackReviewRun(first.id, {
      status: 'failed',
      latestRunStatus: 'failed',
      failureReason: 'runner_disappeared_stale',
    }, { projectId: 'orchestrator-pack', storeRoot });
    const second = createRun(storeRoot);
    updatePackReviewRun(second.id, {
      status: 'failed',
      latestRunStatus: 'failed',
      failureReason: 'runner_disappeared_stale',
    }, { projectId: 'orchestrator-pack', storeRoot });
    const ordered = createRun(storeRoot);
    const legacyTime = '2026-08-04T04:00:00.000Z';
    for (const run of [first, second]) {
      const recordPath = path.join(storeRoot, 'runs', `${run.id}.json`);
      const record = JSON.parse(readFileSync(recordPath, 'utf8')) as Record<string, unknown>;
      delete record.sameKeyOrder;
      record.createdAt = legacyTime;
      writeFileSync(recordPath, `${JSON.stringify(record)}\n`);
    }

    expect(resolvePackReviewRunOrder(
      listPackReviewRunRecordsRaw({ projectId: 'orchestrator-pack', storeRoot }),
      first,
    )).toEqual({ kind: 'newer', run: expect.objectContaining({ id: ordered.id }) });
  });

  it.each([
    ['active', 'running', undefined, 'pending'],
    ['verdict', 'up_to_date', undefined, 'success'],
    ['unfinished', 'timed_out', 'reviewer_process_timeout', 'error'],
  ] as const)('restores newer %s authority without guessing', async (_label, status, failureReason, expectedState) => {
    const storeRoot = tempRoot(`opk-1307-restore-${_label}-`);
    const older = createRun(storeRoot);
    updatePackReviewRun(older.id, {
      status: 'failed',
      latestRunStatus: 'failed',
      failureReason: 'runner_disappeared_stale',
    }, { projectId: 'orchestrator-pack', storeRoot });
    const newer = createRun(storeRoot);
    updatePackReviewRun(newer.id, {
      status,
      latestRunStatus: status,
      ...(failureReason ? { failureReason } : {}),
      ...(status === 'up_to_date' ? {
        reviewVerdict: 'clean',
        findingCount: 0,
        findings: [],
        journalOutcome: {
          state: 'persisted' as const,
          recordedAtUtc: '2026-08-04T04:00:00.000Z',
          reason: 'verdict_persisted',
          idempotencyKey: `verdict:${newer.id}:${HEAD_SHA}`,
          attempts: 1,
        },
      } : {}),
    }, { projectId: 'orchestrator-pack', storeRoot });
    const requests: PackReviewRequiredStatusRequest[] = [];
    const outcome = await restorePackReviewAuthoritativeRequiredStatus({
      projectId: 'orchestrator-pack',
      storeRoot,
      run: newer,
      writeRequiredStatus: async (request) => { requests.push(request); },
    });
    expect(outcome?.state).toBe('succeeded');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.state).toBe(expectedState);
    if (expectedState === 'error') {
      expect(requests[0]?.description).toContain('no reviewer judgment');
    }
    expect(getPackReviewRun(newer.id, { projectId: 'orchestrator-pack', storeRoot })?.status).toBe(status);
  });

  it('restores a persisted verdict even when its run was terminalized as failed', async () => {
    const storeRoot = tempRoot('opk-1307-failed-with-verdict-');
    const run = createRun(storeRoot);
    updatePackReviewRun(run.id, {
      status: 'failed',
      latestRunStatus: 'failed',
      failureReason: 'reviewer_process_failed',
      reviewVerdict: 'clean',
      findingCount: 0,
      findings: [],
      journalOutcome: {
        state: 'persisted',
        recordedAtUtc: '2026-08-04T04:00:00.000Z',
        reason: 'verdict_persisted',
        idempotencyKey: `verdict:${run.id}:${HEAD_SHA}`,
        attempts: 1,
      },
    }, { projectId: 'orchestrator-pack', storeRoot });
    const requests: PackReviewRequiredStatusRequest[] = [];

    const outcome = await restorePackReviewAuthoritativeRequiredStatus({
      projectId: 'orchestrator-pack',
      storeRoot,
      run,
      writeRequiredStatus: async (request) => { requests.push(request); },
    });

    expect(outcome).toMatchObject({ state: 'succeeded', reason: 'status_success_restored' });
    expect(requests).toEqual([expect.objectContaining({ state: 'success' })]);
  });

  it('does not write any status when legacy same-key order is ambiguous', async () => {
    const storeRoot = tempRoot('opk-1307-ambiguous-reconcile-');
    const first = createRun(storeRoot);
    updatePackReviewRun(first.id, { status: 'failed', latestRunStatus: 'failed', failureReason: 'runner_disappeared_stale' }, { projectId: 'orchestrator-pack', storeRoot });
    const second = createRun(storeRoot);
    updatePackReviewRun(second.id, { status: 'failed', latestRunStatus: 'failed', failureReason: 'runner_disappeared_stale' }, { projectId: 'orchestrator-pack', storeRoot });
    for (const run of [first, second]) {
      const recordPath = path.join(storeRoot, 'runs', `${run.id}.json`);
      const record = JSON.parse(readFileSync(recordPath, 'utf8')) as Record<string, unknown>;
      delete record.sameKeyOrder;
      record.createdAt = '2026-08-04T04:00:00.000Z';
      writeFileSync(recordPath, `${JSON.stringify(record)}\n`);
    }
    const writes: PackReviewRequiredStatusRequest[] = [];
    const result = await reconcileStalePackReviewRuns({
      repoSlug: 'chetwerikoff/orchestrator-pack',
      sourceRepoRoot: repoRoot,
      projectId: 'orchestrator-pack',
      storeRoot,
      fixtureRequiredStatusWriter: async (request) => { writes.push(request); },
    });
    expect(result.results).toEqual([
      expect.objectContaining({ reason: 'legacy_order_ambiguous', statusReconciled: false }),
      expect.objectContaining({ reason: 'legacy_order_ambiguous', statusReconciled: false }),
    ]);
    expect(writes).toHaveLength(0);
  });

  it('fails closed before reconciliation when a same-head legacy repository is unresolved', async () => {
    const storeRoot = tempRoot('opk-1307-unresolved-reconcile-');
    const canonical = createRun(storeRoot);
    updatePackReviewRun(canonical.id, {
      status: 'failed',
      latestRunStatus: 'failed',
      failureReason: 'runner_disappeared_stale',
    }, { projectId: 'orchestrator-pack', storeRoot });
    const legacy = createPackReviewRun({
      projectId: 'orchestrator-pack',
      storeRoot,
      prNumber: 894,
      headSha: HEAD_SHA,
      linkedSessionId: 'worker-894-legacy',
      startReason: 'legacy',
      surface: 'pack-review-delivery-test',
      trustedPackRoot: repoRoot,
      sourceRepoRoot: path.join(storeRoot, 'deleted-checkout'),
    }).run;
    const legacyPath = path.join(storeRoot, 'runs', `${legacy.id}.json`);
    const legacyRecord = JSON.parse(readFileSync(legacyPath, 'utf8')) as Record<string, unknown>;
    delete legacyRecord.canonicalRepository;
    writeFileSync(legacyPath, `${JSON.stringify(legacyRecord)}\n`);
    updatePackReviewRun(legacy.id, {
      status: 'failed',
      latestRunStatus: 'failed',
      failureReason: 'runner_disappeared_stale',
    }, { projectId: 'orchestrator-pack', storeRoot });
    const writes: PackReviewRequiredStatusRequest[] = [];

    const result = await reconcileStalePackReviewRuns({
      repoSlug: 'chetwerikoff/orchestrator-pack',
      sourceRepoRoot: repoRoot,
      projectId: 'orchestrator-pack',
      storeRoot,
      resolveRepositorySlug: async (sourceRoot) => {
        if (sourceRoot === path.join(storeRoot, 'deleted-checkout')) {
          throw new Error('legacy checkout unavailable');
        }
        return 'chetwerikoff/orchestrator-pack';
      },
      fixtureRequiredStatusWriter: async (request) => { writes.push(request); },
    });

    expect(result.results).toHaveLength(2);
    expect(result.results.every((entry) => entry.reason === 'repository_identity_unresolved')).toBe(true);
    expect(writes).toHaveLength(0);
  });

  it('does not reconcile a failed pending outcome as unfinished evidence', () => {
    const storeRoot = tempRoot('opk-1307-failed-pending-evidence-');
    const run = createRun(storeRoot);
    updatePackReviewRun(run.id, {
      status: 'failed',
      latestRunStatus: 'failed',
      failureReason: 'reviewer_process_timeout',
      deliveryOutcomes: {
        requiredStatus: {
          state: 'failed',
          recordedAtUtc: '2026-08-04T04:00:00.000Z',
          reason: 'required status unavailable',
          idempotencyKey: `required-status:${PACK_REVIEW_REQUIRED_STATUS_CONTEXT}:${HEAD_SHA}:pending`,
        },
      },
    }, { projectId: 'orchestrator-pack', storeRoot });

    expect(packReviewRequiredStatusNeedsStaleReconciliation(
      getPackReviewRun(run.id, { projectId: 'orchestrator-pack', storeRoot })!,
    )).toBe(false);
  });
});

describe('pack review stale reconciliation (Issue #1067)', () => {
  afterEach(() => {
    process.env = { ...staleEnvSnapshot };
  });

  it('durably terminalizes an active stale run on reconcile (AC1)', async () => {
    const storeRoot = tempRoot('opk-1067-terminalize-');
    const capture = path.join(storeRoot, 'status.json');
    harnessStaleEnv(storeRoot, capture);
    const runId = seedActiveStaleRun(storeRoot);
    await writePendingForStaleRun(storeRoot, runId, capture);
    markRunStale(storeRoot, runId);

    const before = getPackReviewRun(runId, { projectId: 'orchestrator-pack', storeRoot });
    expect(before?.status).toBe('running');
    expect(isPackReviewRunStale(before!)).toBe(true);

    const result = await reconcileStalePackReviewRuns({
      repoSlug: STALE_REPO_A,
      sourceRepoRoot: repoRoot,
      projectId: 'orchestrator-pack',
      storeRoot,
    });

    expect(result.results).toEqual([expect.objectContaining({
      runId,
      terminalized: true,
      statusReconciled: true,
    })]);

    const persisted = getPackReviewRun(runId, { projectId: 'orchestrator-pack', storeRoot });
    expect(persisted).toMatchObject({
      status: 'failed',
      latestRunStatus: 'failed',
      failureReason: 'runner_disappeared_stale',
      prNumber: 1067,
      targetSha: STALE_HEAD_A,
    });
    const status = JSON.parse(readFileSync(capture, 'utf8')) as PackReviewRequiredStatusRequest;
    expect(status.state).toBe('error');
    expect(status.context).toBe(PACK_REVIEW_REQUIRED_STATUS_CONTEXT);
  });

  it('leaves store and status writer untouched on list/status observation (AC2)', async () => {
    const storeRoot = tempRoot('opk-1067-read-purity-');
    const runId = seedActiveStaleRun(storeRoot);
    const beforeBytes = readFileSync(path.join(storeRoot, 'runs', `${runId}.json`), 'utf8');

    listPackReviewRuns({ projectId: 'orchestrator-pack', storeRoot });
    const projected = listPackReviewRuns({ projectId: 'orchestrator-pack', storeRoot })[0];
    expect(projected?.status).toBe('failed');

    const afterBytes = readFileSync(path.join(storeRoot, 'runs', `${runId}.json`), 'utf8');
    expect(afterBytes).toBe(beforeBytes);
    expect(getPackReviewRun(runId, { projectId: 'orchestrator-pack', storeRoot })?.status).toBe('running');
  });

  it('stores canonical repository identity and rejects cross-repository reconciliation (AC3)', async () => {
    const storeRoot = tempRoot('opk-1067-repo-identity-');
    const capture = path.join(storeRoot, 'status.json');
    harnessStaleEnv(storeRoot, capture);
    const runId = seedActiveStaleRun(storeRoot, { canonicalRepository: STALE_REPO_A });
    await writePendingForStaleRun(storeRoot, runId, capture);
    markRunStale(storeRoot, runId);

    expect(getPackReviewRun(runId, { projectId: 'orchestrator-pack', storeRoot })?.canonicalRepository).toBe(STALE_REPO_A);
    updatePackReviewRun(runId, { canonicalRepository: STALE_REPO_B }, { projectId: 'orchestrator-pack', storeRoot });
    expect(getPackReviewRun(runId, { projectId: 'orchestrator-pack', storeRoot })?.canonicalRepository).toBe(STALE_REPO_A);

    markRunStale(storeRoot, runId);
    const mismatch = await reconcileStalePackReviewRuns({
      repoSlug: STALE_REPO_B,
      sourceRepoRoot: repoRoot,
      projectId: 'orchestrator-pack',
      storeRoot,
    });
    expect(mismatch.results[0]).toMatchObject({
      runId,
      terminalized: false,
      statusReconciled: false,
      reason: 'repository_mismatch',
    });
  });

  it('resolves legacy repository identity from sourceRepoRoot when canonical field is absent (AC3)', async () => {
    const storeRoot = tempRoot('opk-1067-legacy-repo-');
    const capture = path.join(storeRoot, 'status.json');
    harnessStaleEnv(storeRoot, capture);
    const runId = seedActiveStaleRun(storeRoot);
    const recordPath = path.join(storeRoot, 'runs', `${runId}.json`);
    const legacy = JSON.parse(readFileSync(recordPath, 'utf8')) as Record<string, unknown>;
    delete legacy.canonicalRepository;
    writeFileSync(recordPath, `${JSON.stringify(legacy)}\n`);
    await writePendingForStaleRun(storeRoot, runId, capture);
    markRunStale(storeRoot, runId);

    const result = await reconcileStalePackReviewRuns({
      repoSlug: STALE_REPO_A,
      sourceRepoRoot: repoRoot,
      projectId: 'orchestrator-pack',
      storeRoot,
      resolveRepositorySlug: async () => STALE_REPO_A,
    });
    expect(result.results[0]).toMatchObject({ statusReconciled: true });
  });

  it('terminalizes stale runs on later same-repository start without list/status reads (AC4, AC7)', async () => {
    const storeRoot = tempRoot('opk-1067-next-start-');
    const staleCapture = path.join(storeRoot, 'stale-status.json');
    const startCapture = path.join(storeRoot, 'start-status.json');
    harnessStaleEnv(storeRoot, staleCapture);
    const staleRunId = seedActiveStaleRun(storeRoot);
    await writePendingForStaleRun(storeRoot, staleRunId, staleCapture);
    markRunStale(storeRoot, staleRunId);

    const result = await startPackReview({
      projectId: 'orchestrator-pack',
      storeRoot,
      sourceRepoRoot: repoRoot,
      prNumber: 1067,
      headSha: STALE_HEAD_B,
      fixturePostReviewHeadSha: STALE_HEAD_B,
      claimMode: 'preacquired',
      fixtureRepoSlug: STALE_REPO_A,
      fixtureReviewStdout: JSON.stringify({ verdict: 'clean', findingCount: 0, findings: [] }),
      fixtureRequiredStatusWriter: async (request) => {
        writeFileSync(startCapture, `${JSON.stringify(request)}\n`);
      },
    });

    expect(result.ok).toBe(true);
    expect(getPackReviewRun(staleRunId, { projectId: 'orchestrator-pack', storeRoot })).toMatchObject({
      status: 'failed',
      failureReason: 'runner_disappeared_stale',
      targetSha: STALE_HEAD_A,
    });
    expect(JSON.parse(readFileSync(staleCapture, 'utf8')).state).toBe('error');
  });

  it('explicit reconcile alone completes stale pending status without starting a review (AC5)', async () => {
    const storeRoot = tempRoot('opk-1067-explicit-reconcile-');
    const capture = path.join(storeRoot, 'status.json');
    harnessStaleEnv(storeRoot, capture);
    const runId = seedActiveStaleRun(storeRoot);
    await writePendingForStaleRun(storeRoot, runId, capture);
    markRunStale(storeRoot, runId);

    const result = await reconcileStalePackReviewRuns({
      repoSlug: STALE_REPO_A,
      sourceRepoRoot: repoRoot,
      projectId: 'orchestrator-pack',
      storeRoot,
    });
    expect(result.results[0]?.statusReconciled).toBe(true);

    const repeat = await reconcileStalePackReviewRuns({
      repoSlug: STALE_REPO_A,
      sourceRepoRoot: repoRoot,
      projectId: 'orchestrator-pack',
      storeRoot,
    });
    expect(repeat.results[0]).toMatchObject({ reason: 'status_already_reconciled' });
    expect(JSON.parse(readFileSync(capture, 'utf8')).state).toBe('error');
  });

  it('does not overwrite a newer same-head run required status (AC6)', async () => {
    const storeRoot = tempRoot('opk-1067-newer-run-');
    const staleCapture = path.join(storeRoot, 'stale.json');
    const newerCapture = path.join(storeRoot, 'newer.json');
    harnessStaleEnv(storeRoot, staleCapture);
    const staleRunId = seedActiveStaleRun(storeRoot);
    await writePendingForStaleRun(storeRoot, staleRunId, staleCapture);
    markRunStale(storeRoot, staleRunId);

    const newer = createPackReviewRun({
      projectId: 'orchestrator-pack',
      storeRoot,
      prNumber: 1067,
      headSha: STALE_HEAD_A,
      linkedSessionId: 'worker-newer',
      startReason: 'newer',
      surface: 'pack-review-stale-reconcile-test',
      trustedPackRoot: repoRoot,
      sourceRepoRoot: repoRoot,
      canonicalRepository: STALE_REPO_A,
    });
    await recordPackReviewPendingStatus({
      projectId: 'orchestrator-pack',
      storeRoot,
      run: newer.run,
      writeRequiredStatus: async (request) => {
        writeFileSync(newerCapture, `${JSON.stringify(request)}\n`);
      },
    });

    const result = await reconcileStalePackReviewRuns({
      repoSlug: STALE_REPO_A,
      sourceRepoRoot: repoRoot,
      projectId: 'orchestrator-pack',
      storeRoot,
    });
    expect(result.results[0]).toMatchObject({
      runId: staleRunId,
      statusReconciled: true,
      reason: 'newer_run_authoritative',
    });
    expect(JSON.parse(readFileSync(newerCapture, 'utf8')).state).toBe('pending');
  });

  it('does not rewrite a completed newer authority on repeated reconciliation', async () => {
    const storeRoot = tempRoot('opk-1307-repeat-newer-reconcile-');
    const staleCapture = path.join(storeRoot, 'stale.json');
    const writes: PackReviewRequiredStatusRequest[] = [];
    harnessStaleEnv(storeRoot, staleCapture);
    const staleRunId = seedActiveStaleRun(storeRoot);
    await writePendingForStaleRun(storeRoot, staleRunId, staleCapture);
    markRunStale(storeRoot, staleRunId);

    createPackReviewRun({
      projectId: 'orchestrator-pack',
      storeRoot,
      prNumber: 1067,
      headSha: STALE_HEAD_A,
      linkedSessionId: 'worker-newer-repeat',
      startReason: 'newer-repeat',
      surface: 'pack-review-stale-reconcile-test',
      trustedPackRoot: repoRoot,
      sourceRepoRoot: repoRoot,
      canonicalRepository: STALE_REPO_A,
    });

    const input = {
      repoSlug: STALE_REPO_A,
      sourceRepoRoot: repoRoot,
      projectId: 'orchestrator-pack',
      storeRoot,
      fixtureRequiredStatusWriter: async (request: PackReviewRequiredStatusRequest) => {
        writes.push(request);
      },
    };
    await reconcileStalePackReviewRuns(input);
    await reconcileStalePackReviewRuns(input);

    expect(writes).toHaveLength(1);
    expect(writes[0]?.state).toBe('pending');
  });

  it('does not claim newer settlement after authority advances on every restore attempt', async () => {
    const storeRoot = tempRoot('opk-1307-newer-authority-race-');
    const staleCapture = path.join(storeRoot, 'stale.json');
    harnessStaleEnv(storeRoot, staleCapture);
    const staleRunId = seedActiveStaleRun(storeRoot);
    await writePendingForStaleRun(storeRoot, staleRunId, staleCapture);
    markRunStale(storeRoot, staleRunId);
    let newerCount = 0;
    const writes: PackReviewRequiredStatusRequest[] = [];
    createPackReviewRun({
      projectId: 'orchestrator-pack',
      storeRoot,
      prNumber: 1067,
      headSha: STALE_HEAD_A,
      linkedSessionId: 'worker-newer-race-0',
      startReason: 'newer-race',
      surface: 'pack-review-stale-reconcile-test',
      trustedPackRoot: repoRoot,
      sourceRepoRoot: repoRoot,
      canonicalRepository: STALE_REPO_A,
    });

    const result = await reconcileStalePackReviewRuns({
      repoSlug: STALE_REPO_A,
      sourceRepoRoot: repoRoot,
      projectId: 'orchestrator-pack',
      storeRoot,
      fixtureRequiredStatusWriter: async (request) => { writes.push(request); },
      fixturePauseAfterPendingRestoreWrite: async () => {
        newerCount += 1;
        createPackReviewRun({
          projectId: 'orchestrator-pack',
          storeRoot,
          prNumber: 1067,
          headSha: STALE_HEAD_A,
          linkedSessionId: `worker-newer-race-${newerCount}`,
          startReason: 'newer-race',
          surface: 'pack-review-stale-reconcile-test',
          trustedPackRoot: repoRoot,
          sourceRepoRoot: repoRoot,
          canonicalRepository: STALE_REPO_A,
        });
      },
    });

    expect(result.results[0]).toMatchObject({
      runId: staleRunId,
      statusReconciled: false,
      reason: 'newer_run_authority_race',
    });
    expect(writes).toHaveLength(3);
  });

  it('force-republishes newer authority after a superseding stale write', async () => {
    const storeRoot = tempRoot('opk-1307-force-republish-');
    const run = createRun(storeRoot);
    updatePackReviewRun(run.id, {
      status: 'running',
      latestRunStatus: 'running',
    }, { projectId: 'orchestrator-pack', storeRoot });
    const writes: PackReviewRequiredStatusRequest[] = [];
    const writeRequiredStatus = async (request: PackReviewRequiredStatusRequest) => {
      writes.push(request);
    };
    const current = getPackReviewRun(run.id, { projectId: 'orchestrator-pack', storeRoot })!;
    await recordPackReviewPendingStatus({
      projectId: 'orchestrator-pack',
      storeRoot,
      run: current,
      writeRequiredStatus,
    });

    const restored = await restorePackReviewAuthoritativeRequiredStatus({
      projectId: 'orchestrator-pack',
      storeRoot,
      run: current,
      writeRequiredStatus,
      forceRepublish: true,
    });

    expect(restored).toMatchObject({ state: 'succeeded', reason: 'status_pending' });
    expect(writes).toHaveLength(2);
    expect(writes[1]?.state).toBe('pending');
  });

  it('reports newer-authority restoration failure instead of claiming reconciliation', async () => {
    const storeRoot = tempRoot('opk-1307-newer-restore-failure-');
    const staleCapture = path.join(storeRoot, 'stale.json');
    harnessStaleEnv(storeRoot, staleCapture);
    const staleRunId = seedActiveStaleRun(storeRoot);
    await writePendingForStaleRun(storeRoot, staleRunId, staleCapture);
    markRunStale(storeRoot, staleRunId);

    createPackReviewRun({
      projectId: 'orchestrator-pack',
      storeRoot,
      prNumber: 1067,
      headSha: STALE_HEAD_A,
      linkedSessionId: 'worker-newer-failure',
      startReason: 'newer-failure',
      surface: 'pack-review-stale-reconcile-test',
      trustedPackRoot: repoRoot,
      sourceRepoRoot: repoRoot,
      canonicalRepository: STALE_REPO_A,
    });

    const result = await reconcileStalePackReviewRuns({
      repoSlug: STALE_REPO_A,
      sourceRepoRoot: repoRoot,
      projectId: 'orchestrator-pack',
      storeRoot,
      fixtureRequiredStatusWriter: async () => {
        throw new Error('required status unavailable');
      },
    });

    expect(result.results[0]).toMatchObject({
      runId: staleRunId,
      statusReconciled: false,
      reason: 'newer_run_restore_failed',
    });
  });

  it('resumes required-status reconciliation after local terminalization only (AC8)', async () => {
    const storeRoot = tempRoot('opk-1067-interrupted-');
    const capture = path.join(storeRoot, 'status.json');
    harnessStaleEnv(storeRoot, capture);
    const runId = seedActiveStaleRun(storeRoot);
    await writePendingForStaleRun(storeRoot, runId, capture);
    markRunStale(storeRoot, runId);

    terminalizePackReviewStaleRun(runId, { projectId: 'orchestrator-pack', storeRoot });
    const resumed = await reconcileStalePackReviewRuns({
      repoSlug: STALE_REPO_A,
      sourceRepoRoot: repoRoot,
      projectId: 'orchestrator-pack',
      storeRoot,
    });
    expect(resumed.results[0]?.statusReconciled).toBe(true);
    expect(JSON.parse(readFileSync(capture, 'utf8')).state).toBe('error');
  });

  it('persists bounded failureReason for reviewer failures with noisy stdout/stderr (AC10)', async () => {
    const storeRoot = tempRoot('opk-1067-failure-hygiene-');
    const capture = path.join(storeRoot, 'status.json');
    harnessStaleEnv(storeRoot, capture);
    process.env.PACK_REVIEW_RUNNER_INVOCATION_LOG = path.join(storeRoot, 'invocations.jsonl');

    const sentinel = 'npm ERR! lifecycle helper --invoke-pack-review.ps1 --secret-argv-token';
    const result = await startPackReview({
      projectId: 'orchestrator-pack',
      storeRoot,
      sourceRepoRoot: repoRoot,
      prNumber: 1067,
      headSha: STALE_HEAD_A,
      claimMode: 'preacquired',
      fixtureRepoSlug: STALE_REPO_A,
      fixtureReviewStdout: sentinel,
      fixtureReviewExitCode: 1,
    });

    expect(result.ok).toBe(false);
    const run = getPackReviewRun(String(result.runId), { projectId: 'orchestrator-pack', storeRoot });
    expect(run?.failureReason).toBe('reviewer_process_failed');
    expect(run?.failureReason).not.toContain('npm ERR!');
  });

  it('does not clobber a newer same-head run required status after reconcile barrier (AC6 race)', async () => {
    const storeRoot = tempRoot('opk-1067-newer-run-race-');
    const staleCapture = path.join(storeRoot, 'stale.json');
    const newerCapture = path.join(storeRoot, 'newer.json');
    harnessStaleEnv(storeRoot, staleCapture);
    const staleRunId = seedActiveStaleRun(storeRoot);
    await writePendingForStaleRun(storeRoot, staleRunId, staleCapture);
    markRunStale(storeRoot, staleRunId);

    let releasePause: () => void = () => undefined;
    const paused = new Promise<void>((resolve) => {
      releasePause = resolve;
    });
    let pauseEntered = false;

    const reconcilePromise = reconcileStalePackReviewRuns({
      repoSlug: STALE_REPO_A,
      sourceRepoRoot: repoRoot,
      projectId: 'orchestrator-pack',
      storeRoot,
      fixturePauseBeforeStaleStatusWrite: async () => {
        pauseEntered = true;
        await paused;
      },
    });

    while (!pauseEntered) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const newer = createPackReviewRun({
      projectId: 'orchestrator-pack',
      storeRoot,
      prNumber: 1067,
      headSha: STALE_HEAD_A,
      linkedSessionId: 'worker-newer-race',
      startReason: 'newer-race',
      surface: 'pack-review-stale-reconcile-test',
      trustedPackRoot: repoRoot,
      sourceRepoRoot: repoRoot,
      canonicalRepository: STALE_REPO_A,
    });
    await recordPackReviewPendingStatus({
      projectId: 'orchestrator-pack',
      storeRoot,
      run: newer.run,
      writeRequiredStatus: async (request) => {
        writeFileSync(newerCapture, `${JSON.stringify(request)}\n`);
      },
    });
    releasePause();
    const result = await reconcilePromise;

    expect(result.results[0]).toMatchObject({
      runId: staleRunId,
      statusReconciled: false,
      reason: 'newer_run_authoritative',
    });
    expect(JSON.parse(readFileSync(newerCapture, 'utf8')).state).toBe('pending');
    expect(JSON.parse(readFileSync(staleCapture, 'utf8')).state).toBe('pending');
  });

  it('reconciles stale error when requiredStatus outcome is missing after pending crash', async () => {
    const storeRoot = tempRoot('opk-1067-missing-outcome-');
    const capture = path.join(storeRoot, 'status.json');
    harnessStaleEnv(storeRoot, capture);
    const runId = seedActiveStaleRun(storeRoot);
    markRunStale(storeRoot, runId);
    terminalizePackReviewStaleRun(runId, { projectId: 'orchestrator-pack', storeRoot });
    expect(getPackReviewRun(runId, { projectId: 'orchestrator-pack', storeRoot })?.deliveryOutcomes?.requiredStatus).toBeUndefined();

    const result = await reconcileStalePackReviewRuns({
      repoSlug: STALE_REPO_A,
      sourceRepoRoot: repoRoot,
      projectId: 'orchestrator-pack',
      storeRoot,
    });
    expect(result.results[0]?.statusReconciled).toBe(true);
    expect(JSON.parse(readFileSync(capture, 'utf8')).state).toBe('error');
  });

  it('restores newer terminal required status after superseded stale write (AC6 in-flight race)', async () => {
    const storeRoot = tempRoot('opk-1067-inflight-repair-');
    const staleCapture = path.join(storeRoot, 'stale.json');
    const repairCapture = path.join(storeRoot, 'repair.json');
    harnessStaleEnv(storeRoot, staleCapture);
    const staleRunId = seedActiveStaleRun(storeRoot);
    await writePendingForStaleRun(storeRoot, staleRunId, staleCapture);
    markRunStale(storeRoot, staleRunId);

    let releaseAfter: () => void = () => undefined;
    const pausedAfter = new Promise<void>((resolve) => {
      releaseAfter = resolve;
    });
    let afterEntered = false;

    const reconcilePromise = reconcileStalePackReviewRuns({
      repoSlug: STALE_REPO_A,
      sourceRepoRoot: repoRoot,
      projectId: 'orchestrator-pack',
      storeRoot,
      fixtureRequiredStatusWriter: async (request) => {
        if (request.state === 'error') {
          writeFileSync(staleCapture, `${JSON.stringify(request)}\n`);
          return;
        }
        writeFileSync(repairCapture, `${JSON.stringify(request)}\n`);
      },
      fixturePauseAfterStaleStatusWrite: async () => {
        afterEntered = true;
        const newer = createPackReviewRun({
          projectId: 'orchestrator-pack',
          storeRoot,
          prNumber: 1067,
          headSha: STALE_HEAD_A,
          linkedSessionId: 'worker-newer-inflight',
          startReason: 'newer-inflight',
          surface: 'pack-review-stale-reconcile-test',
          trustedPackRoot: repoRoot,
          sourceRepoRoot: repoRoot,
          canonicalRepository: STALE_REPO_A,
        });
        updatePackReviewRun(newer.run.id, {
          status: 'up_to_date',
          latestRunStatus: 'up_to_date',
          reviewVerdict: 'clean',
          findingCount: 0,
          findings: [],
          journalOutcome: {
            state: 'persisted',
            recordedAtUtc: '2026-07-28T17:00:00.000Z',
            reason: 'verdict_persisted',
            idempotencyKey: `verdict:${newer.run.id}:${STALE_HEAD_A}`,
            attempts: 1,
          },
        }, { projectId: 'orchestrator-pack', storeRoot });
        await pausedAfter;
      },
    });

    while (!afterEntered) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    releaseAfter();
    const result = await reconcilePromise;

    expect(result.results[0]).toMatchObject({
      runId: staleRunId,
      statusReconciled: false,
      reason: 'newer_run_authoritative',
    });
    expect(JSON.parse(readFileSync(staleCapture, 'utf8')).state).toBe('error');
    expect(JSON.parse(readFileSync(repairCapture, 'utf8')).state).toBe('success');
  });

  it('restores terminal required status when newer run finishes during repair pending POST (AC6 active→terminal)', async () => {
    const storeRoot = tempRoot('opk-1067-repair-active-terminal-');
    const staleCapture = path.join(storeRoot, 'stale.json');
    const repairCapture = path.join(storeRoot, 'repair.json');
    harnessStaleEnv(storeRoot, staleCapture);
    const staleRunId = seedActiveStaleRun(storeRoot);
    await writePendingForStaleRun(storeRoot, staleRunId, staleCapture);
    markRunStale(storeRoot, staleRunId);

    let newerRunId = '';
    let releaseAfter: () => void = () => undefined;
    const pausedAfter = new Promise<void>((resolve) => { releaseAfter = resolve; });
    let afterEntered = false;

    const reconcilePromise = reconcileStalePackReviewRuns({
      repoSlug: STALE_REPO_A,
      sourceRepoRoot: repoRoot,
      projectId: 'orchestrator-pack',
      storeRoot,
      fixtureRequiredStatusWriter: async (request) => {
        if (request.state === 'error') {
          writeFileSync(staleCapture, `${JSON.stringify(request)}\n`);
          return;
        }
        writeFileSync(repairCapture, `${JSON.stringify(request)}\n`);
      },
      fixturePauseAfterStaleStatusWrite: async () => {
        afterEntered = true;
        const newer = createPackReviewRun({
          projectId: 'orchestrator-pack',
          storeRoot,
          prNumber: 1067,
          headSha: STALE_HEAD_A,
          linkedSessionId: 'worker-newer-active',
          startReason: 'newer-active',
          surface: 'pack-review-stale-reconcile-test',
          trustedPackRoot: repoRoot,
          sourceRepoRoot: repoRoot,
          canonicalRepository: STALE_REPO_A,
        });
        newerRunId = newer.run.id;
        updatePackReviewRun(newer.run.id, {
          status: 'running',
          latestRunStatus: 'running',
          runnerPid: 42,
        }, { projectId: 'orchestrator-pack', storeRoot });
        await pausedAfter;
      },
      fixturePauseAfterPendingRestoreWrite: async () => {
        updatePackReviewRun(newerRunId, {
          status: 'up_to_date',
          latestRunStatus: 'up_to_date',
          reviewVerdict: 'clean',
          findingCount: 0,
          findings: [],
          journalOutcome: {
            state: 'persisted',
            recordedAtUtc: '2026-07-28T17:30:00.000Z',
            reason: 'verdict_persisted',
            idempotencyKey: `verdict:${newerRunId}:${STALE_HEAD_A}`,
            attempts: 1,
          },
        }, { projectId: 'orchestrator-pack', storeRoot });
      },
    });

    while (!afterEntered) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    releaseAfter();
    const result = await reconcilePromise;

    expect(result.results[0]).toMatchObject({
      runId: staleRunId,
      statusReconciled: false,
      reason: 'newer_run_authoritative',
    });
    expect(JSON.parse(readFileSync(repairCapture, 'utf8')).state).toBe('success');
  });

  it('clears stale failureReason when resuming a journaled verdict after stale terminalization', async () => {
    const storeRoot = tempRoot('opk-1067-stale-journaled-resume-');
    harnessStaleEnv(storeRoot, path.join(storeRoot, 'status.json'));
    const runId = seedActiveStaleRun(storeRoot);
    updatePackReviewRun(runId, {
      status: 'reviewing',
      latestRunStatus: 'reviewing',
      reviewVerdict: 'clean',
      findingCount: 0,
      findings: [],
      journalOutcome: {
        state: 'persisted',
        recordedAtUtc: '2026-07-28T16:00:00.000Z',
        reason: 'verdict_persisted',
        idempotencyKey: `verdict:${runId}:${STALE_HEAD_A}`,
        attempts: 1,
      },
    }, { projectId: 'orchestrator-pack', storeRoot });
    markRunStale(storeRoot, runId);
    terminalizePackReviewStaleRun(runId, { projectId: 'orchestrator-pack', storeRoot });
    expect(getPackReviewRun(runId, { projectId: 'orchestrator-pack', storeRoot })).toMatchObject({
      status: 'failed',
      failureReason: 'runner_disappeared_stale',
    });

    const run = getPackReviewRun(runId, { projectId: 'orchestrator-pack', storeRoot });
    if (!run) throw new Error(`missing run ${runId}`);
    const result = await resumePackReviewVerdictDelivery({
      projectId: 'orchestrator-pack',
      storeRoot,
      run,
      async postGithubComment() {
        return { id: 106701, url: 'fixture://review/106701', event: 'COMMENT' };
      },
      async writeRequiredStatus() {},
      async notifyWorker() {
        return { state: 'delivered', reason: 'fixture_dispatched' };
      },
    });

    expect(result).toMatchObject({ ok: true, status: 'up_to_date' });
    const resumedRun = getPackReviewRun(runId, { projectId: 'orchestrator-pack', storeRoot });
    expect(resumedRun).toMatchObject({ status: 'up_to_date' });
    expect(resumedRun?.failureReason).toBeUndefined();
    expect(resumedRun?.stale).toBeUndefined();
  });

  it('exposes resolveRepositorySlug for legacy repository resolution', () => {
    expect(typeof resolveRepositorySlug).toBe('function');
  });
});

