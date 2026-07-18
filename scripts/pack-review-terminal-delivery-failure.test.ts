import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GithubReviewPostError,
  type GithubReviewCaptureAction,
  type GithubReviewSummary,
  type GithubReviewTransport,
} from './lib/github-review-reconciliation.js';
import type { PackReviewRequiredStatusRequest } from './lib/pack-review-delivery.js';
import { listPackReviewRuns } from './lib/pack-review-run-store.js';
import { startPackReview } from './pack-review-runner.js';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEAD_SHA = '7'.repeat(40);
const originalEnv = { ...process.env };
const tempRoots: string[] = [];

function tempRoot(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

class TerminalFailureGithubTransport implements GithubReviewTransport {
  readonly actions: GithubReviewCaptureAction[] = [];
  readonly reviews: GithubReviewSummary[] = [];
  mode: 'ok' | 'definitely-rejected' = 'ok';
  private nextId = 89500;

  async resolveActorLogin(): Promise<string> {
    return 'pack-reviewer';
  }

  async listReviews(): Promise<GithubReviewSummary[]> {
    return this.reviews.map((review) => ({ ...review }));
  }

  async postReview(input: { event: 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES'; body: string; commitId: string }) {
    this.actions.push({ kind: 'post', event: input.event, body: input.body });
    if (this.mode === 'definitely-rejected') {
      throw new GithubReviewPostError(
        'definitely_rejected',
        'GitHub PR review post failed: HTTP 422 validation failed',
      );
    }
    const id = this.nextId++;
    const review: GithubReviewSummary = {
      id,
      state: 'COMMENTED',
      userLogin: 'pack-reviewer',
      submittedAt: new Date(Date.parse('2026-07-18T04:00:00.000Z') + id).toISOString(),
      body: input.body,
      commitId: input.commitId,
      url: `fixture://review/${id}`,
    };
    this.reviews.push(review);
    return { id, url: review.url };
  }

  async dismissReview(reviewId: number | string): Promise<void> {
    this.actions.push({ kind: 'dismiss', event: 'DISMISS', reviewId });
  }
}

async function startFixture(options: {
  storeRoot: string;
  transport: GithubReviewTransport;
  writeRequiredStatus: (request: PackReviewRequiredStatusRequest) => Promise<void>;
  notifyWorker: () => Promise<{ state: 'delivered'; reason: string }>;
  fixtureReviewStdout: string;
}) {
  process.env.OPK_VITEST_HARNESS = '1';
  process.env.AO_BASE_DIR = path.join(options.storeRoot, 'ao-base');
  return startPackReview({
    projectId: 'orchestrator-pack',
    storeRoot: options.storeRoot,
    sourceRepoRoot: repoRoot,
    prNumber: 895,
    headSha: HEAD_SHA,
    claimMode: 'preacquired',
    fixtureRepoSlug: 'chetwerikoff/orchestrator-pack',
    fixtureGithubReviewTransport: options.transport,
    fixtureRequiredStatusWriter: options.writeRequiredStatus,
    fixtureWorkerNotifier: options.notifyWorker,
    fixtureReviewStdout: options.fixtureReviewStdout,
  });
}

const cleanStdout = JSON.stringify({
  verdict: 'clean',
  findingCount: 0,
  findings: [],
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('pack review terminal delivery failures (Issue #894)', () => {
  it('does not retry a definitely rejected GitHub COMMENT on a subsequent start', async () => {
    const storeRoot = tempRoot('opk-terminal-comment-rejection-');
    const transport = new TerminalFailureGithubTransport();
    transport.mode = 'definitely-rejected';
    const writeRequiredStatus = vi.fn(async (_request: PackReviewRequiredStatusRequest) => undefined);
    const notifyWorker = vi.fn(async () => ({ state: 'delivered' as const, reason: 'fixture_dispatched' }));

    const first = await startFixture({
      storeRoot,
      transport,
      writeRequiredStatus,
      notifyWorker,
      fixtureReviewStdout: cleanStdout,
    });

    expect(first).toMatchObject({
      ok: true,
      created: true,
      reused: false,
      reason: 'completed_with_delivery_failures',
      status: 'up_to_date',
    });
    expect(transport.actions.filter((action) => action.kind === 'post')).toHaveLength(1);
    expect(writeRequiredStatus).toHaveBeenCalledTimes(2);
    expect(notifyWorker).toHaveBeenCalledTimes(1);

    const before = listPackReviewRuns({ projectId: 'orchestrator-pack', storeRoot })[0]!;
    expect(before).toMatchObject({
      status: 'up_to_date',
      githubReviewReconciliation: {
        phase: 'prepared',
        postOutcome: 'definitely_rejected',
      },
      deliveryOutcomes: {
        githubComment: { state: 'failed' },
        requiredStatus: { state: 'succeeded' },
        workerNotification: { state: 'delivered' },
      },
    });
    const recordedFailure = before.deliveryOutcomes.githubComment;

    const second = await startFixture({
      storeRoot,
      transport,
      writeRequiredStatus,
      notifyWorker,
      fixtureReviewStdout: 'reviewer_must_not_restart',
    });

    expect(second).toMatchObject({ ok: true, created: false, reused: true, status: 'up_to_date' });
    expect(second).not.toHaveProperty('recovered', true);
    expect(transport.actions.filter((action) => action.kind === 'post')).toHaveLength(1);
    expect(writeRequiredStatus).toHaveBeenCalledTimes(2);
    expect(notifyWorker).toHaveBeenCalledTimes(1);

    const after = listPackReviewRuns({ projectId: 'orchestrator-pack', storeRoot });
    expect(after).toHaveLength(1);
    expect(after[0]?.deliveryOutcomes.githubComment).toEqual(recordedFailure);
  });

  it('does not retry a failed required-status write on a subsequent start', async () => {
    const storeRoot = tempRoot('opk-terminal-required-status-failure-');
    const transport = new TerminalFailureGithubTransport();
    const writeRequiredStatus = vi.fn(async (request: PackReviewRequiredStatusRequest) => {
      if (request.state !== 'pending') throw new Error('required status authorization denied');
    });
    const notifyWorker = vi.fn(async () => ({ state: 'delivered' as const, reason: 'fixture_dispatched' }));

    const first = await startFixture({
      storeRoot,
      transport,
      writeRequiredStatus,
      notifyWorker,
      fixtureReviewStdout: cleanStdout,
    });

    expect(first).toMatchObject({
      ok: true,
      created: true,
      reused: false,
      reason: 'completed_with_delivery_failures',
      status: 'up_to_date',
    });
    expect(transport.actions.filter((action) => action.kind === 'post')).toHaveLength(1);
    expect(writeRequiredStatus).toHaveBeenCalledTimes(2);
    expect(notifyWorker).toHaveBeenCalledTimes(1);

    const before = listPackReviewRuns({ projectId: 'orchestrator-pack', storeRoot })[0]!;
    expect(before).toMatchObject({
      status: 'up_to_date',
      githubReviewReconciliation: { phase: 'complete' },
      deliveryOutcomes: {
        githubComment: { state: 'succeeded' },
        requiredStatus: { state: 'failed' },
        workerNotification: { state: 'delivered' },
      },
    });
    const recordedFailure = before.deliveryOutcomes.requiredStatus;

    const second = await startFixture({
      storeRoot,
      transport,
      writeRequiredStatus,
      notifyWorker,
      fixtureReviewStdout: 'reviewer_must_not_restart',
    });

    expect(second).toMatchObject({ ok: true, created: false, reused: true, status: 'up_to_date' });
    expect(second).not.toHaveProperty('recovered', true);
    expect(transport.actions.filter((action) => action.kind === 'post')).toHaveLength(1);
    expect(writeRequiredStatus).toHaveBeenCalledTimes(2);
    expect(notifyWorker).toHaveBeenCalledTimes(1);

    const after = listPackReviewRuns({ projectId: 'orchestrator-pack', storeRoot });
    expect(after).toHaveLength(1);
    expect(after[0]?.deliveryOutcomes.requiredStatus).toEqual(recordedFailure);
  });
});
