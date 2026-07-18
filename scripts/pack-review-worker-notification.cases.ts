import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
import {
  packReviewDeliveryNeedsResume,
  resumePackReviewVerdictDelivery,
  sendPackReviewWorkerNotification,
  type PackReviewRequiredStatusRequest,
} from './lib/pack-review-delivery.js';
import {
  createPackReviewRun,
  getPackReviewRun,
  listPackReviewRuns,
  updatePackReviewRun,
  type PackReviewDeliveryOutcome,
  type PackReviewRunRecord,
} from './lib/pack-review-run-store.js';
import { startPackReview } from './pack-review-runner.js';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEAD_SHA = '8'.repeat(40);
const originalEnv = { ...process.env };
const tempRoots: string[] = [];

function tempRoot(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function deliveryOutcome(
  state: PackReviewDeliveryOutcome['state'],
  idempotencyKey: string,
  reason: string = state,
): PackReviewDeliveryOutcome {
  return {
    state,
    recordedAtUtc: '2026-07-17T12:00:00.000Z',
    reason,
    idempotencyKey,
  };
}

function createRun(storeRoot: string): PackReviewRunRecord {
  return createPackReviewRun({
    projectId: 'orchestrator-pack',
    storeRoot,
    prNumber: 894,
    headSha: HEAD_SHA,
    linkedSessionId: 'worker-894',
    startReason: 'test',
    surface: 'pack-review-worker-notification-test',
    trustedPackRoot: repoRoot,
    sourceRepoRoot: repoRoot,
  }).run;
}

function journalFields(run: PackReviewRunRecord): Pick<PackReviewRunRecord,
  'reviewVerdict' | 'findingCount' | 'findings' | 'journalOutcome'> {
  return {
    reviewVerdict: 'findings',
    findingCount: 1,
    findings: [{ severity: 'error' }],
    journalOutcome: {
      state: 'persisted',
      recordedAtUtc: '2026-07-17T12:00:00.000Z',
      reason: 'verdict_persisted',
      idempotencyKey: `verdict:${run.id}:${HEAD_SHA}`,
      attempts: 1,
    },
  };
}

class TerminalFailureGithubTransport implements GithubReviewTransport {
  readonly actions: GithubReviewCaptureAction[] = [];
  readonly reviews: GithubReviewSummary[] = [];
  mode: 'ok' | 'definitely-rejected' = 'ok';
  private nextId = 89450;

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

async function startTerminalFailureFixture(options: {
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
    prNumber: 894,
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

describe('pack review worker notification admission (Issue #894)', () => {
  it.each(['failed', 'escalated'] as const)(
    'treats terminal %s worker outcomes as complete instead of automatic resume',
    (workerState) => {
      const storeRoot = tempRoot(`opk-worker-terminal-${workerState}-`);
      const run = createRun(storeRoot);
      const terminal = updatePackReviewRun(run.id, {
        status: 'changes_requested',
        latestRunStatus: 'changes_requested',
        ...journalFields(run),
        githubReviewId: 89401,
        githubReviewReconciliation: {
          phase: 'complete',
        } as PackReviewRunRecord['githubReviewReconciliation'],
        deliveryOutcomes: {
          githubComment: deliveryOutcome('succeeded', `github-comment:${run.id}:${HEAD_SHA}`),
          requiredStatus: deliveryOutcome(
            'succeeded',
            `required-status:orchestrator-pack/pack-review:${HEAD_SHA}`,
          ),
          workerNotification: deliveryOutcome(
            workerState,
            `worker-notification:${run.id}:${HEAD_SHA}`,
          ),
        },
      }, { projectId: 'orchestrator-pack', storeRoot });

      expect(packReviewDeliveryNeedsResume(terminal)).toBe(false);
    },
  );

  it.each(['failed', 'escalated'] as const)(
    'preserves terminal %s worker outcome while another channel resumes',
    async (workerState) => {
      const storeRoot = tempRoot(`opk-worker-terminal-other-channel-${workerState}-`);
      const run = createRun(storeRoot);
      const workerOutcome = deliveryOutcome(
        workerState,
        `worker-notification:${run.id}:${HEAD_SHA}`,
        `worker_${workerState}`,
      );
      const journaled = updatePackReviewRun(run.id, {
        status: 'changes_requested',
        latestRunStatus: 'changes_requested',
        ...journalFields(run),
        deliveryOutcomes: {
          githubComment: deliveryOutcome(
            'failed',
            `github-comment:${run.id}:${HEAD_SHA}`,
            'comment_channel_down',
          ),
          requiredStatus: deliveryOutcome(
            'succeeded',
            `required-status:orchestrator-pack/pack-review:${HEAD_SHA}`,
          ),
          workerNotification: workerOutcome,
        },
      }, { projectId: 'orchestrator-pack', storeRoot });
      const postGithubComment = vi.fn(async () => {
        updatePackReviewRun(run.id, {
          githubReviewId: 89402,
          githubReviewUrl: 'fixture://review/89402',
          githubReviewEvent: 'COMMENT',
          githubReviewReconciliation: {
            phase: 'complete',
          } as PackReviewRunRecord['githubReviewReconciliation'],
        }, { projectId: 'orchestrator-pack', storeRoot });
        return { id: 89402, url: 'fixture://review/89402', event: 'COMMENT' as const };
      });
      const writeRequiredStatus = vi.fn(async () => undefined);
      const notifyWorker = vi.fn(async () => ({ state: 'delivered' as const, reason: 'unexpected_retry' }));

      expect(packReviewDeliveryNeedsResume(journaled)).toBe(true);
      const result = await resumePackReviewVerdictDelivery({
        projectId: 'orchestrator-pack',
        storeRoot,
        run: journaled,
        postGithubComment,
        writeRequiredStatus,
        notifyWorker,
      });

      expect(result).toMatchObject({ ok: true, status: 'changes_requested' });
      expect(postGithubComment).toHaveBeenCalledTimes(1);
      expect(writeRequiredStatus).not.toHaveBeenCalled();
      expect(notifyWorker).not.toHaveBeenCalled();
      expect(getPackReviewRun(run.id, { projectId: 'orchestrator-pack', storeRoot })).toMatchObject({
        status: 'changes_requested',
        deliveryOutcomes: {
          githubComment: { state: 'succeeded' },
          requiredStatus: { state: 'succeeded' },
          workerNotification: workerOutcome,
        },
      });
    },
  );

  it.each(['failed', 'escalated'] as const)(
    'terminalizes a reviewing run after persisted %s worker outcome without retrying any channel',
    async (workerState) => {
      const storeRoot = tempRoot(`opk-worker-terminal-before-run-terminal-${workerState}-`);
      const run = createRun(storeRoot);
      const workerOutcome = deliveryOutcome(
        workerState,
        `worker-notification:${run.id}:${HEAD_SHA}`,
        `worker_${workerState}`,
      );
      const journaled = updatePackReviewRun(run.id, {
        status: 'reviewing',
        latestRunStatus: 'reviewing',
        ...journalFields(run),
        githubReviewId: 89403,
        githubReviewUrl: 'fixture://review/89403',
        githubReviewEvent: 'COMMENT',
        githubReviewReconciliation: {
          phase: 'complete',
        } as PackReviewRunRecord['githubReviewReconciliation'],
        deliveryOutcomes: {
          githubComment: deliveryOutcome('succeeded', `github-comment:${run.id}:${HEAD_SHA}`),
          requiredStatus: deliveryOutcome(
            'succeeded',
            `required-status:orchestrator-pack/pack-review:${HEAD_SHA}`,
          ),
          workerNotification: workerOutcome,
        },
      }, { projectId: 'orchestrator-pack', storeRoot });
      const postGithubComment = vi.fn(async () => ({
        id: 89404,
        url: 'fixture://review/89404',
        event: 'COMMENT' as const,
      }));
      const writeRequiredStatus = vi.fn(async () => undefined);
      const notifyWorker = vi.fn(async () => ({ state: 'delivered' as const, reason: 'unexpected_retry' }));

      expect(packReviewDeliveryNeedsResume(journaled)).toBe(true);
      const result = await resumePackReviewVerdictDelivery({
        projectId: 'orchestrator-pack',
        storeRoot,
        run: journaled,
        postGithubComment,
        writeRequiredStatus,
        notifyWorker,
      });

      expect(result).toMatchObject({ ok: true, status: 'changes_requested' });
      expect(postGithubComment).not.toHaveBeenCalled();
      expect(writeRequiredStatus).not.toHaveBeenCalled();
      expect(notifyWorker).not.toHaveBeenCalled();
      expect(getPackReviewRun(run.id, { projectId: 'orchestrator-pack', storeRoot })).toMatchObject({
        status: 'changes_requested',
        latestRunStatus: 'changes_requested',
        deliveryOutcomes: {
          workerNotification: workerOutcome,
        },
      });
    },
  );

  it('does not retry a definitely rejected GitHub COMMENT on a subsequent start', async () => {
    const storeRoot = tempRoot('opk-terminal-comment-rejection-');
    const transport = new TerminalFailureGithubTransport();
    transport.mode = 'definitely-rejected';
    const writeRequiredStatus = vi.fn(async (_request: PackReviewRequiredStatusRequest) => undefined);
    const notifyWorker = vi.fn(async () => ({ state: 'delivered' as const, reason: 'fixture_dispatched' }));

    const first = await startTerminalFailureFixture({
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

    const second = await startTerminalFailureFixture({
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

    const first = await startTerminalFailureFixture({
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

    const second = await startTerminalFailureFixture({
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

  it.skipIf(process.platform === 'win32')(
    'uses gated deterministic send and suppresses a crash retry after dispatch',
    async () => {
      const root = tempRoot('opk-worker-notification-gated-');
      const fakeBin = path.join(root, 'bin');
      const aoLog = path.join(root, 'ao-send.log');
      const dispatchJournal = path.join(root, 'worker-message-dispatch.json');
      mkdirSync(fakeBin, { recursive: true });
      const fakeAo = path.join(fakeBin, 'ao');
      writeFileSync(fakeAo, [
        '#!/usr/bin/env node',
        "const { appendFileSync } = require('node:fs');",
        "appendFileSync(process.env.PACK_REVIEW_FAKE_AO_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');",
        '',
      ].join('\n'), 'utf8');
      chmodSync(fakeAo, 0o755);

      const sessionId = 'worker-894-gated';
      const runId = 'prr-worker-notification-crash-boundary';
      const deliveryKey = `worker-notification:${runId}:${HEAD_SHA}`;
      const message = [
        'Pack review completed for PR #894.',
        `Run: ${runId}`,
        `Head: ${HEAD_SHA}`,
        'Verdict: findings',
        'Findings: 1',
        'Merge status: failure',
      ].join('\n');

      Object.assign(process.env, {
        OPK_VITEST_HARNESS: '1',
        PACK_REVIEW_WORKER_NOTIFICATION_REAL_ADAPTER: '1',
        PACK_REVIEW_WORKER_NOTIFICATION_FIXTURE_TARGET: `${sessionId}:${sessionId}`,
        AO_SESSION_ID: 'orchestrator-autonomous-surface',
        AO_BASE_DIR: path.join(root, 'ao-base'),
        AO_JOURNALED_SEND_ASSUME_CONTRACT: '1',
        AO_WORKER_MESSAGE_DISPATCH_JOURNAL: dispatchJournal,
        PACK_REVIEW_FAKE_AO_LOG: aoLog,
        PATH: `${fakeBin}:${originalEnv.PATH ?? ''}`,
      });

      const notify = () => sendPackReviewWorkerNotification({
        trustedPackRoot: repoRoot,
        sessionId,
        request: { message, idempotencyKey: deliveryKey },
      });
      expect(await notify()).toMatchObject({
        state: 'delivered',
        reason: 'explicit_send_dispatched',
      });
      expect(await notify()).toMatchObject({
        state: 'delivered',
        reason: 'journal_duplicate_no_op',
      });

      const invocations = readFileSync(aoLog, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]);
      const sends = invocations.filter((args) => args[0] === 'send'
        && args.includes('--session')
        && args.includes('--message'));
      expect(sends).toHaveLength(1);
      expect(readFileSync(dispatchJournal, 'utf8')).toContain(deliveryKey);
    },
  );
});
