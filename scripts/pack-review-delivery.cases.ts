import { mkdtempSync, rmSync } from 'node:fs';
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
  type PackReviewRequiredStatusRequest,
  type PackReviewTerminalPayload,
} from './lib/pack-review-delivery.js';
import {
  createPackReviewRun,
  getPackReviewRun,
  updatePackReviewRun,
} from './lib/pack-review-run-store.js';

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
    expect(getPackReviewRun(run.id, { projectId: 'orchestrator-pack', storeRoot })).toMatchObject({
      status: 'changes_requested',
      exitCode: 0,
      failureReason: 'journal_write_failed',
      journalOutcome: { state: 'journal_write_failed' },
      deliveryOutcomes: {},
    });

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
      failureReason: 'reviewer_output_malformed:invalid JSON',
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
