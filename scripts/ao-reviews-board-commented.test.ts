import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  mapEngineToBoardStatus,
  PR_REVIEW_STATUSES,
} from './lib/review-producer-contract.js';
import {
  GithubReviewPostError,
  reconcileGithubCommentReview,
  selectActiveSameActorBlockingReviewIds,
  type GithubReviewCaptureAction,
  type GithubReviewSummary,
  type GithubReviewTransport,
} from './lib/github-review-reconciliation.js';
import {
  createPackReviewRun,
  getPackReviewRun,
  type PackReviewRunRecord,
} from './lib/pack-review-run-store.js';
import {
  mapEngineStateToBoardStatus as mapMjsEngineStateToBoardStatus,
  PR_REVIEW_STATUSES as MJS_PR_REVIEW_STATUSES,
} from '../docs/review-producer-contract.mjs';
import { aggregateReviewsBoard } from '../tests/ao-reviews-board-runtime/src/aggregate.js';
import { createCaptureReplayDaemonClient } from '../tests/ao-reviews-board-runtime/src/daemon-client.js';

const HEAD_SHA = 'c'.repeat(40);
const NEWER_HEAD_SHA = 'd'.repeat(40);
const ACTOR = 'pack-reviewer';
const SAME_TIMESTAMP = '2026-07-16T10:00:00.000Z';
const tempRoots: string[] = [];

function tempRoot(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function review(
  id: number | string,
  state: string,
  commitId = HEAD_SHA,
  body = '',
): GithubReviewSummary {
  return {
    id,
    state,
    userLogin: ACTOR,
    submittedAt: SAME_TIMESTAMP,
    body,
    commitId,
    url: `fixture://review/${id}`,
  };
}

function numericId(value: number | string): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

class ConcurrentReviewTransport implements GithubReviewTransport {
  readonly actions: GithubReviewCaptureAction[];
  readonly reviews: GithubReviewSummary[];
  timeoutAfterAccept = false;
  failListAfterAcceptedPostOnce = false;
  hiddenAcceptedCommentLists = 0;
  duplicateCommentOnFirstList = false;
  postedCommitIdOverride: string | undefined;
  forbidPost = false;
  private acceptedPost: boolean;
  private insertedNewerBlocker: boolean;
  private insertedDuplicateComment = false;
  private nextId: number;

  constructor(
    reviews: GithubReviewSummary[] = [review(9, 'CHANGES_REQUESTED')],
    actions: GithubReviewCaptureAction[] = [],
  ) {
    this.reviews = reviews;
    this.actions = actions;
    this.acceptedPost = reviews.some((entry) => entry.state === 'COMMENTED');
    this.insertedNewerBlocker = reviews.some((entry) => String(entry.id) === '11');
    this.nextId = Math.max(9, ...reviews.map((entry) => numericId(entry.id))) + 1;
  }

  async resolveActorLogin(): Promise<string> {
    return ACTOR;
  }

  async listReviews(): Promise<GithubReviewSummary[]> {
    if (this.acceptedPost && !this.insertedNewerBlocker) {
      const blockerId = this.nextId++;
      this.reviews.push(review(blockerId, 'CHANGES_REQUESTED', NEWER_HEAD_SHA));
      this.insertedNewerBlocker = true;
    }
    if (this.acceptedPost && this.duplicateCommentOnFirstList && !this.insertedDuplicateComment) {
      const original = this.reviews.find((entry) => entry.state === 'COMMENTED');
      if (!original) throw new Error('missing accepted COMMENT for duplicate injection');
      const duplicateId = this.nextId++;
      this.reviews.push({ ...original, id: duplicateId, url: `fixture://review/${duplicateId}` });
      this.insertedDuplicateComment = true;
    }
    if (this.failListAfterAcceptedPostOnce) {
      this.failListAfterAcceptedPostOnce = false;
      throw new Error('injected list outage after accepted COMMENT');
    }
    const snapshot = this.reviews.map((entry) => ({ ...entry }));
    if (this.acceptedPost && this.hiddenAcceptedCommentLists > 0) {
      this.hiddenAcceptedCommentLists -= 1;
      return snapshot.filter((entry) => entry.state !== 'COMMENTED');
    }
    return snapshot;
  }

  async postReview(input: {
    event: 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES';
    body: string;
    commitId: string;
  }): Promise<{ id: number | string; url: string }> {
    if (this.forbidPost) throw new Error('duplicate COMMENT POST attempted after restart');
    this.actions.push({ kind: 'post', event: input.event, body: input.body });
    const id = this.nextId++;
    const posted = review(
      id,
      input.event === 'COMMENT'
        ? 'COMMENTED'
        : input.event === 'APPROVE'
          ? 'APPROVED'
          : 'CHANGES_REQUESTED',
      this.postedCommitIdOverride ?? input.commitId,
      input.body,
    );
    this.reviews.push(posted);
    this.acceptedPost = true;
    if (this.timeoutAfterAccept) {
      throw new GithubReviewPostError('ambiguous', 'injected COMMENT timeout after acceptance');
    }
    return { id: posted.id, url: posted.url };
  }

  async dismissReview(reviewId: number | string): Promise<void> {
    const target = this.reviews.find((entry) => String(entry.id) === String(reviewId));
    if (!target) throw new Error(`missing fixture review ${reviewId}`);
    target.state = 'DISMISSED';
    this.actions.push({ kind: 'dismiss', reviewId, event: 'DISMISS' });
  }

  activeBlockingIds(): Array<number | string> {
    return selectActiveSameActorBlockingReviewIds(this.reviews, ACTOR);
  }
}

function createRun(storeRoot: string) {
  return createPackReviewRun({
    projectId: 'orchestrator-pack',
    storeRoot,
    prNumber: 868,
    headSha: HEAD_SHA,
    trustedPackRoot: storeRoot,
    sourceRepoRoot: storeRoot,
  }).run;
}

function reloadRun(storeRoot: string, runId: string): PackReviewRunRecord {
  const run = getPackReviewRun(runId, { projectId: 'orchestrator-pack', storeRoot });
  if (!run) throw new Error(`missing recovery run ${runId}`);
  return run;
}

function postOutcome(run: PackReviewRunRecord): string | undefined {
  return (run.githubReviewReconciliation as { postOutcome?: string } | undefined)?.postOutcome;
}

async function reconcile(
  storeRoot: string,
  run: PackReviewRunRecord,
  transport: GithubReviewTransport,
  body: string,
) {
  return reconcileGithubCommentReview({
    run,
    body,
    transport,
    projectId: 'orchestrator-pack',
    storeRoot,
  });
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('reviews-board commented status parity (Issue #866)', () => {
  it('renders a realistic persisted commented review as terminal clean', async () => {
    const sessionId = 'orchestrator-pack-commented';
    const head = HEAD_SHA;
    const client = createCaptureReplayDaemonClient({
      sessions: {
        sessions: [{
          id: sessionId,
          projectId: 'orchestrator-pack',
          branch: 'issue-866',
          status: 'working',
          prs: ['https://github.com/chetwerikoff/orchestrator-pack/pull/868'],
          terminalHandleId: 'runtime-commented',
        }],
      },
      projects: { projects: [{ id: 'orchestrator-pack', name: 'orchestrator-pack' }] },
      reviewsBySessionId: {
        [sessionId]: {
          reviewerHandleId: 'review-commented',
          reviews: [{
            prUrl: 'https://github.com/chetwerikoff/orchestrator-pack/pull/868',
            targetSha: head,
            headSha: head,
            status: 'commented',
            latestRun: {
              id: 'rr-commented',
              status: 'commented',
              targetSha: head,
              verdict: 'commented',
              githubReviewId: 86801,
            },
          }],
        },
      },
    });

    const board = await aggregateReviewsBoard(client, { projectId: 'orchestrator-pack' });
    expect(board.dashboardLoadError).toBeNull();
    expect(board.runs).toEqual([
      expect.objectContaining({
        prReviewStatus: 'commented',
        latestRunStatus: 'commented',
        status: 'clean',
      }),
    ]);
  });

  it('keeps TypeScript and MJS producer contracts exactly aligned', () => {
    expect([...PR_REVIEW_STATUSES].sort()).toEqual([...MJS_PR_REVIEW_STATUSES].sort());
    const head = NEWER_HEAD_SHA;
    expect(mapEngineToBoardStatus({
      prReviewStatus: 'commented',
      latestRun: { status: 'commented', targetSha: head },
      headSha: head,
      targetSha: head,
    })).toBe('clean');
    expect(mapMjsEngineStateToBoardStatus({
      prReviewStatus: 'commented',
      latestRun: { status: 'commented', targetSha: head },
      headSha: head,
      entryHeadSha: head,
    })).toBe('clean');
  });

  it('dismisses only blockers strictly older than the confirmed COMMENT', async () => {
    const storeRoot = tempRoot('opk-comment-fence-');
    const run = createRun(storeRoot);
    const transport = new ConcurrentReviewTransport();
    const body = `Advisory only.\n\nRun: \`${run.id}\``;

    const result = await reconcile(storeRoot, run, transport, body);

    expect(result.dismissedReviewIds).toEqual([9]);
    expect(transport.actions.map((action) => [action.kind, action.reviewId ?? null])).toEqual([
      ['post', null],
      ['dismiss', 9],
    ]);
    expect(transport.activeBlockingIds()).toEqual([11]);
  });

  it('preserves the COMMENT fence during restart recovery after a list error', async () => {
    const storeRoot = tempRoot('opk-comment-fence-restart-');
    const run = createRun(storeRoot);
    const transport = new ConcurrentReviewTransport();
    transport.timeoutAfterAccept = true;
    transport.failListAfterAcceptedPostOnce = true;
    const body = `Advisory only.\n\nRun: \`${run.id}\``;

    await expect(reconcile(storeRoot, run, transport, body))
      .rejects.toThrow('injected COMMENT timeout after acceptance');
    const pending = reloadRun(storeRoot, run.id);
    expect(pending.githubReviewReconciliation).toMatchObject({ phase: 'prepared' });
    expect(postOutcome(pending)).toBe('ambiguous');

    transport.timeoutAfterAccept = false;
    const result = await reconcile(storeRoot, pending, transport, body);

    expect(result.dismissedReviewIds).toEqual([9]);
    expect(transport.activeBlockingIds()).toEqual([11]);
    expect(transport.actions.filter((action) => action.kind === 'post')).toHaveLength(1);
  });

  it('does not repost while an accepted COMMENT is temporarily omitted by successful list responses', async () => {
    const storeRoot = tempRoot('opk-comment-eventual-consistency-');
    const run = createRun(storeRoot);
    const transport = new ConcurrentReviewTransport();
    transport.timeoutAfterAccept = true;
    transport.hiddenAcceptedCommentLists = 2;
    const body = `Advisory only.\n\nRun: \`${run.id}\``;

    await expect(reconcile(storeRoot, run, transport, body))
      .rejects.toThrow('injected COMMENT timeout after acceptance');
    const ambiguous = reloadRun(storeRoot, run.id);
    expect(postOutcome(ambiguous)).toBe('ambiguous');
    expect(transport.actions.filter((action) => action.kind === 'post')).toHaveLength(1);
    expect(transport.actions.filter((action) => action.kind === 'dismiss')).toHaveLength(0);

    transport.timeoutAfterAccept = false;
    await expect(reconcile(storeRoot, ambiguous, transport, body))
      .rejects.toThrow('accepted review is not yet observable');
    expect(transport.actions.filter((action) => action.kind === 'post')).toHaveLength(1);
    expect(transport.activeBlockingIds()).toEqual([9, 11]);

    const result = await reconcile(storeRoot, reloadRun(storeRoot, run.id), transport, body);
    expect(result.dismissedReviewIds).toEqual([9]);
    expect(transport.actions.filter((action) => action.kind === 'post')).toHaveLength(1);
    expect(transport.activeBlockingIds()).toEqual([11]);
  });

  it('preserves ambiguous POST state across process restart without posting a duplicate COMMENT', async () => {
    const storeRoot = tempRoot('opk-comment-eventual-consistency-restart-');
    const run = createRun(storeRoot);
    const sharedReviews = [review(9, 'CHANGES_REQUESTED')];
    const sharedActions: GithubReviewCaptureAction[] = [];
    const firstProcess = new ConcurrentReviewTransport(sharedReviews, sharedActions);
    firstProcess.timeoutAfterAccept = true;
    firstProcess.hiddenAcceptedCommentLists = 1;
    const body = `Advisory only.\n\nRun: \`${run.id}\``;

    await expect(reconcile(storeRoot, run, firstProcess, body))
      .rejects.toThrow('injected COMMENT timeout after acceptance');
    const persisted = reloadRun(storeRoot, run.id);
    expect(postOutcome(persisted)).toBe('ambiguous');

    const restartedProcess = new ConcurrentReviewTransport(sharedReviews, sharedActions);
    restartedProcess.forbidPost = true;
    restartedProcess.hiddenAcceptedCommentLists = 1;
    await expect(reconcile(storeRoot, persisted, restartedProcess, body))
      .rejects.toThrow('accepted review is not yet observable');

    const result = await reconcile(
      storeRoot,
      reloadRun(storeRoot, run.id),
      restartedProcess,
      body,
    );
    expect(result.dismissedReviewIds).toEqual([9]);
    expect(sharedActions.filter((action) => action.kind === 'post')).toHaveLength(1);
    expect(restartedProcess.activeBlockingIds()).toEqual([11]);
  });

  it('fails closed when ambiguous recovery finds multiple same-run COMMENT reviews', async () => {
    const storeRoot = tempRoot('opk-comment-duplicate-boundary-');
    const run = createRun(storeRoot);
    const transport = new ConcurrentReviewTransport();
    transport.timeoutAfterAccept = true;
    transport.duplicateCommentOnFirstList = true;
    const body = `Advisory only.\n\nRun: \`${run.id}\``;

    await expect(reconcile(storeRoot, run, transport, body))
      .rejects.toThrow('ambiguous GitHub COMMENT recovery found 2 matching reviews');
    expect(transport.actions.filter((action) => action.kind === 'post')).toHaveLength(1);
    expect(transport.actions.filter((action) => action.kind === 'dismiss')).toHaveLength(0);
    expect(transport.activeBlockingIds()).toEqual([9, 11]);
  });

  it.each([
    ['missing', ''],
    ['wrong-head', NEWER_HEAD_SHA],
  ])('rejects %s commit evidence for a confirmed COMMENT boundary', async (_label, commitId) => {
    const storeRoot = tempRoot('opk-comment-boundary-commit-evidence-');
    const run = createRun(storeRoot);
    const transport = new ConcurrentReviewTransport();
    transport.postedCommitIdOverride = commitId;
    const body = `Advisory only.\n\nRun: \`${run.id}\``;

    await expect(reconcile(storeRoot, run, transport, body))
      .rejects.toThrow(`does not match reconciliation ${run.id}`);
    expect(transport.actions.filter((action) => action.kind === 'dismiss')).toHaveLength(0);
    expect(transport.activeBlockingIds()).toEqual([9, 11]);
  });

  it.each([
    ['missing', ''],
    ['wrong-head', NEWER_HEAD_SHA],
  ])('rejects %s commit evidence during ambiguous POST discovery', async (_label, commitId) => {
    const storeRoot = tempRoot('opk-comment-discovery-commit-evidence-');
    const run = createRun(storeRoot);
    const transport = new ConcurrentReviewTransport();
    transport.timeoutAfterAccept = true;
    transport.postedCommitIdOverride = commitId;
    const body = `Advisory only.\n\nRun: \`${run.id}\``;

    await expect(reconcile(storeRoot, run, transport, body))
      .rejects.toThrow(`expected '${HEAD_SHA}'`);
    expect(transport.actions.filter((action) => action.kind === 'post')).toHaveLength(1);
    expect(transport.actions.filter((action) => action.kind === 'dismiss')).toHaveLength(0);
    expect(transport.activeBlockingIds()).toEqual([9, 11]);
  });

  it('accepts exact target-head commit evidence during ambiguous POST discovery', async () => {
    const storeRoot = tempRoot('opk-comment-discovery-exact-head-');
    const run = createRun(storeRoot);
    const transport = new ConcurrentReviewTransport();
    transport.timeoutAfterAccept = true;
    transport.postedCommitIdOverride = HEAD_SHA;
    const body = `Advisory only.\n\nRun: \`${run.id}\``;

    const result = await reconcile(storeRoot, run, transport, body);
    expect(result.dismissedReviewIds).toEqual([9]);
    expect(transport.activeBlockingIds()).toEqual([11]);
  });

  it.each([
    [9, 10],
    [99, 100],
    ['9', '10'],
    ['99', '100'],
  ])('orders equal-timestamp approval %s before blocker %s numerically', (approvalId, blockerId) => {
    expect(selectActiveSameActorBlockingReviewIds([
      review(approvalId, 'APPROVED'),
      review(blockerId, 'CHANGES_REQUESTED'),
    ], ACTOR)).toEqual([blockerId]);
  });

  it.each([
    [9, 10],
    [99, 100],
    ['9', '10'],
    ['99', '100'],
  ])('orders equal-timestamp blocker %s before later approval %s numerically', (blockerId, approvalId) => {
    expect(selectActiveSameActorBlockingReviewIds([
      review(blockerId, 'CHANGES_REQUESTED'),
      review(approvalId, 'APPROVED'),
    ], ACTOR)).toEqual([]);
  });
});
