import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  mapEngineToBoardStatus,
  PR_REVIEW_STATUSES,
} from './lib/review-producer-contract.js';
import {
  reconcileGithubCommentReview,
  selectActiveSameActorBlockingReviewIds,
  type GithubReviewCaptureAction,
  type GithubReviewSummary,
  type GithubReviewTransport,
} from './lib/github-review-reconciliation.js';
import {
  createPackReviewRun,
  getPackReviewRun,
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

class ConcurrentReviewTransport implements GithubReviewTransport {
  readonly actions: GithubReviewCaptureAction[] = [];
  readonly reviews: GithubReviewSummary[] = [review(9, 'CHANGES_REQUESTED')];
  timeoutAfterAccept = false;
  failListAfterAcceptedPostOnce = false;
  private acceptedPost = false;
  private insertedNewerBlocker = false;

  async resolveActorLogin(): Promise<string> {
    return ACTOR;
  }

  async listReviews(): Promise<GithubReviewSummary[]> {
    if (this.acceptedPost && !this.insertedNewerBlocker) {
      this.reviews.push(review(11, 'CHANGES_REQUESTED', NEWER_HEAD_SHA));
      this.insertedNewerBlocker = true;
    }
    if (this.failListAfterAcceptedPostOnce) {
      this.failListAfterAcceptedPostOnce = false;
      throw new Error('injected list outage after accepted COMMENT');
    }
    return this.reviews.map((entry) => ({ ...entry }));
  }

  async postReview(input: {
    event: 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES';
    body: string;
    commitId: string;
  }): Promise<{ id: number | string; url: string }> {
    this.actions.push({ kind: 'post', event: input.event, body: input.body });
    const posted = review(
      10,
      input.event === 'COMMENT'
        ? 'COMMENTED'
        : input.event === 'APPROVE'
          ? 'APPROVED'
          : 'CHANGES_REQUESTED',
      input.commitId,
      input.body,
    );
    this.reviews.push(posted);
    this.acceptedPost = true;
    if (this.timeoutAfterAccept) {
      throw new Error('injected COMMENT timeout after acceptance');
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

    const result = await reconcileGithubCommentReview({
      run,
      body,
      transport,
      projectId: 'orchestrator-pack',
      storeRoot,
    });

    expect(result.dismissedReviewIds).toEqual([9]);
    expect(transport.actions.map((action) => [action.kind, action.reviewId ?? null])).toEqual([
      ['post', null],
      ['dismiss', 9],
    ]);
    expect(transport.activeBlockingIds()).toEqual([11]);
  });

  it('preserves the COMMENT fence during restart recovery', async () => {
    const storeRoot = tempRoot('opk-comment-fence-restart-');
    const run = createRun(storeRoot);
    const transport = new ConcurrentReviewTransport();
    transport.timeoutAfterAccept = true;
    transport.failListAfterAcceptedPostOnce = true;
    const body = `Advisory only.\n\nRun: \`${run.id}\``;

    await expect(reconcileGithubCommentReview({
      run,
      body,
      transport,
      projectId: 'orchestrator-pack',
      storeRoot,
    })).rejects.toThrow('injected COMMENT timeout after acceptance');
    expect(getPackReviewRun(run.id, { projectId: 'orchestrator-pack', storeRoot })?.githubReviewReconciliation)
      .toMatchObject({ phase: 'prepared' });

    transport.timeoutAfterAccept = false;
    const recoveredRun = getPackReviewRun(run.id, { projectId: 'orchestrator-pack', storeRoot });
    if (!recoveredRun) throw new Error('missing recovery run');
    const result = await reconcileGithubCommentReview({
      run: recoveredRun,
      body,
      transport,
      projectId: 'orchestrator-pack',
      storeRoot,
    });

    expect(result.dismissedReviewIds).toEqual([9]);
    expect(transport.activeBlockingIds()).toEqual([11]);
    expect(transport.actions.filter((action) => action.kind === 'post')).toHaveLength(1);
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
