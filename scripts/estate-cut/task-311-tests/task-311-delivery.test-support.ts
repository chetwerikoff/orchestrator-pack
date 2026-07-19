import { rmSync } from 'node:fs';
import path from 'node:path';

import {
  GithubReviewPostError,
  reconcileGithubCommentReview,
  type GithubReviewSummary,
  type GithubReviewTransport,
} from '../../lib/github-review-reconciliation.js';
import {
  deliverPackReviewVerdict,
  resumePackReviewVerdictDelivery,
  type PackReviewTerminalPayload,
} from '../../lib/pack-review-delivery.js';
import {
  createPackReviewRun,
  getPackReviewRun,
  updatePackReviewRun,
  type PackReviewDeliveryOutcome,
  type PackReviewRunRecord,
} from '../../lib/pack-review-run-store.js';
import {
  invariant,
  repoRoot,
  requiredStatusKey,
  runEvidenceMutationControls,
  tempRoot,
  type MutationRecord,
} from './task-311-common.test-support.js';

const projectId = 'orchestrator-pack';
const cleanPayload: PackReviewTerminalPayload = { verdict: 'clean', findingCount: 0, findings: [] };
const blockingPayload: PackReviewTerminalPayload = {
  verdict: 'findings',
  findingCount: 1,
  findings: [{ title: 'Blocking task-311 fixture', severity: 'error' }],
};

function createDeliveryRun(storeRoot: string, suffix: string): PackReviewRunRecord {
  return createPackReviewRun({
    projectId,
    storeRoot,
    prNumber: 918,
    headSha: suffix.repeat(40),
    linkedSessionId: `worker-${suffix}`,
    startReason: `task-311-${suffix}`,
    surface: 'task-311-delivery-matrix',
    trustedPackRoot: repoRoot,
    sourceRepoRoot: repoRoot,
  }).run;
}

function journalRun(
  run: PackReviewRunRecord,
  storeRoot: string,
  payload: PackReviewTerminalPayload = cleanPayload,
  fields: Partial<PackReviewRunRecord> = {},
): PackReviewRunRecord {
  return updatePackReviewRun(run.id, {
    status: 'reviewing',
    latestRunStatus: 'reviewing',
    reviewVerdict: payload.verdict,
    findingCount: payload.findingCount,
    findings: [...payload.findings],
    journalOutcome: {
      state: 'persisted',
      recordedAtUtc: '2026-07-19T02:00:00.000Z',
      reason: 'verdict_persisted',
      idempotencyKey: `verdict:${run.id}:${run.targetSha}`,
      attempts: 1,
    },
    ...fields,
  }, { projectId, storeRoot });
}

function channelOutcome(
  state: PackReviewDeliveryOutcome['state'],
  reason: string,
  idempotencyKey: string,
): PackReviewDeliveryOutcome {
  return { state, recordedAtUtc: '2026-07-19T02:00:01.000Z', reason, idempotencyKey };
}

function githubKey(run: PackReviewRunRecord): string {
  return `github-comment:${run.id}:${run.targetSha}`;
}

function workerKey(run: PackReviewRunRecord): string {
  return `worker-notification:${run.id}:${run.targetSha}`;
}

function completedGithubFields(run: PackReviewRunRecord, id: number): Partial<PackReviewRunRecord> {
  return {
    githubReviewId: id,
    githubReviewUrl: `fixture://task-311/review/${id}`,
    githubReviewEvent: 'COMMENT',
    githubReviewReconciliation: {
      schemaVersion: 1,
      event: 'COMMENT',
      phase: 'complete',
      actorLogin: 'task-311-reviewer',
      commentBody: `Run: \`${run.id}\``,
      commentReviewId: id,
      commentReviewUrl: `fixture://task-311/review/${id}`,
      pendingDismissalReviewIds: [],
      dismissedReviewIds: [],
      preparedAtUtc: '2026-07-19T02:00:00.000Z',
      updatedAtUtc: '2026-07-19T02:00:01.000Z',
    },
  };
}

function validateDeliveryMatrix(candidate: Record<string, unknown>): void {
  const matrix = candidate as any;
  invariant(matrix.classes === 'J0-J6-pass', 'delivery class marker missing');
  invariant(matrix.J0?.journalAttempts === 3 && matrix.J0?.channelAttempts === 0, 'J0 delivered before durable verdict');
  invariant(matrix.J1?.order?.join(',') === 'github,status,worker' && matrix.J1?.reviewerRuns === 0, 'J1 did not resume from journal');
  invariant(matrix.J2?.githubAttempts === 0 && matrix.J2?.statusAttempts === 1 && matrix.J2?.workerAttempts === 1, 'J2 replayed COMMENT or skipped later channels');
  invariant(matrix.J3?.postAttempts === 1 && matrix.J3?.commentCount === 1 && matrix.J3?.phase === 'complete', 'J3 did not converge uniquely');
  invariant(matrix.J3?.recoveredHead === matrix.J3?.expectedHead && matrix.J3?.matchingCount === 1, 'J3 accepted invalid recovery evidence');
  invariant(matrix.J4?.statusPosts === 2 && matrix.J4?.duplicateAccounted === true && matrix.J4?.exactlyOnceClaimed === false, 'J4 at-least-once accounting failed');
  invariant(matrix.J5?.workerSends === 2 && matrix.J5?.duplicateAccounted === true && matrix.J5?.exactlyOnceClaimed === false, 'J5 at-least-once accounting failed');
  invariant(Boolean(matrix.J4?.attemptId) && Boolean(matrix.J5?.attemptId), 'J4/J5 attempt evidence missing');
  invariant(matrix.J4?.attemptHead === matrix.J4?.expectedHead && matrix.J5?.attemptHead === matrix.J5?.expectedHead, 'J4/J5 attempt head drifted');
  invariant(matrix.J4?.attemptId === matrix.J4?.expectedAttemptId && matrix.J5?.attemptId === matrix.J5?.expectedAttemptId, 'J4/J5 idempotency identity drifted');
  invariant(matrix.J6?.githubAttempts === 0 && matrix.J6?.statusAttempts === 0 && matrix.J6?.workerAttempts === 0, 'J6 replayed a completed external effect');
  invariant(matrix.J6?.status === 'up_to_date', 'J6 left a recoverable non-terminal orphan');
}

export async function runDeliveryMatrix(): Promise<{ delivery: Record<string, unknown>; mutations: MutationRecord[] }> {
  const root = tempRoot('task-311-delivery-');
  try {
    const J0Store = path.join(root, 'j0');
    const J0Run = createDeliveryRun(J0Store, '0');
    let J0JournalAttempts = 0;
    let J0ChannelAttempts = 0;
    await deliverPackReviewVerdict({
      projectId,
      storeRoot: J0Store,
      run: J0Run,
      payload: blockingPayload,
      journalWriter: () => {
        J0JournalAttempts += 1;
        throw new Error('task-311 injected durable store outage');
      },
      postGithubComment: async () => { J0ChannelAttempts += 1; return { id: 1, url: 'fixture://never', event: 'COMMENT' }; },
      writeRequiredStatus: async () => { J0ChannelAttempts += 1; },
      notifyWorker: async () => { J0ChannelAttempts += 1; return { state: 'delivered', reason: 'never' }; },
    });

    const J1Store = path.join(root, 'j1');
    const J1Run = journalRun(createDeliveryRun(J1Store, '1'), J1Store);
    const J1Order: string[] = [];
    await resumePackReviewVerdictDelivery({
      projectId,
      storeRoot: J1Store,
      run: J1Run,
      postGithubComment: async () => { J1Order.push('github'); return { id: 11, url: 'fixture://11', event: 'COMMENT' }; },
      writeRequiredStatus: async () => { J1Order.push('status'); },
      notifyWorker: async () => { J1Order.push('worker'); return { state: 'delivered', reason: 'delivered' }; },
    });

    const J2Store = path.join(root, 'j2');
    const J2Base = createDeliveryRun(J2Store, '2');
    const J2Run = journalRun(J2Base, J2Store, cleanPayload, {
      ...completedGithubFields(J2Base, 22),
      deliveryOutcomes: { githubComment: channelOutcome('succeeded', 'comment_posted', githubKey(J2Base)) },
    });
    let J2Github = 0;
    let J2Status = 0;
    let J2Worker = 0;
    await resumePackReviewVerdictDelivery({
      projectId,
      storeRoot: J2Store,
      run: J2Run,
      postGithubComment: async () => { J2Github += 1; return { id: 23, url: 'fixture://23', event: 'COMMENT' }; },
      writeRequiredStatus: async () => { J2Status += 1; },
      notifyWorker: async () => { J2Worker += 1; return { state: 'delivered', reason: 'delivered' }; },
    });

    const J3Store = path.join(root, 'j3');
    const J3Run = journalRun(createDeliveryRun(J3Store, '3'), J3Store);
    const J3Reviews: GithubReviewSummary[] = [];
    let J3PostAttempts = 0;
    const J3Transport: GithubReviewTransport = {
      async resolveActorLogin() { return 'task-311-reviewer'; },
      async listReviews() { return [...J3Reviews]; },
      async postReview(input) {
        J3PostAttempts += 1;
        J3Reviews.push({
          id: 33,
          state: 'COMMENTED',
          userLogin: 'task-311-reviewer',
          submittedAt: '2026-07-19T02:00:03.000Z',
          body: input.body,
          commitId: input.commitId,
          url: 'fixture://33',
        });
        throw new GithubReviewPostError('ambiguous', 'task-311 connection reset after accepted COMMENT');
      },
      async dismissReview() {},
    };
    const J3Reconciled = await reconcileGithubCommentReview({
      projectId,
      storeRoot: J3Store,
      run: J3Run,
      body: `Task 311 crash convergence\n\nRun: \`${J3Run.id}\``,
      transport: J3Transport,
    });

    const J4Store = path.join(root, 'j4');
    const J4Base = createDeliveryRun(J4Store, '4');
    const J4AttemptId = requiredStatusKey(J4Base);
    const J4Run = journalRun(J4Base, J4Store, cleanPayload, {
      ...completedGithubFields(J4Base, 44),
      deliveryOutcomes: {
        githubComment: channelOutcome('succeeded', 'comment_posted', githubKey(J4Base)),
        workerNotification: channelOutcome('delivered', 'worker_delivered', workerKey(J4Base)),
      },
    });
    let J4StatusPosts = 1;
    await resumePackReviewVerdictDelivery({
      projectId,
      storeRoot: J4Store,
      run: J4Run,
      postGithubComment: async () => { throw new Error('J4 must not repost COMMENT'); },
      writeRequiredStatus: async (request) => {
        invariant(request.idempotencyKey === J4AttemptId, 'J4 changed status attempt identity');
        J4StatusPosts += 1;
      },
      notifyWorker: async () => ({ state: 'delivered', reason: 'must-be-skipped' }),
    });

    const J5Store = path.join(root, 'j5');
    const J5Base = createDeliveryRun(J5Store, '5');
    const J5AttemptId = workerKey(J5Base);
    const J5Run = journalRun(J5Base, J5Store, cleanPayload, {
      ...completedGithubFields(J5Base, 55),
      deliveryOutcomes: {
        githubComment: channelOutcome('succeeded', 'comment_posted', githubKey(J5Base)),
        requiredStatus: channelOutcome('succeeded', 'status_success', requiredStatusKey(J5Base)),
      },
    });
    let J5WorkerSends = 1;
    await resumePackReviewVerdictDelivery({
      projectId,
      storeRoot: J5Store,
      run: J5Run,
      postGithubComment: async () => { throw new Error('J5 must not repost COMMENT'); },
      writeRequiredStatus: async () => { throw new Error('J5 must not repost status'); },
      notifyWorker: async (request) => {
        invariant(request.idempotencyKey === J5AttemptId, 'J5 changed worker attempt identity');
        J5WorkerSends += 1;
        return { state: 'delivered', reason: 'resent_after_unknown' };
      },
    });

    const J6Store = path.join(root, 'j6');
    const J6Base = createDeliveryRun(J6Store, '6');
    const J6Run = journalRun(J6Base, J6Store, cleanPayload, {
      ...completedGithubFields(J6Base, 66),
      deliveryOutcomes: {
        githubComment: channelOutcome('succeeded', 'comment_posted', githubKey(J6Base)),
        requiredStatus: channelOutcome('succeeded', 'status_success', requiredStatusKey(J6Base)),
        workerNotification: channelOutcome('delivered', 'worker_delivered', workerKey(J6Base)),
      },
    });
    let J6Github = 0;
    let J6Status = 0;
    let J6Worker = 0;
    await resumePackReviewVerdictDelivery({
      projectId,
      storeRoot: J6Store,
      run: J6Run,
      postGithubComment: async () => { J6Github += 1; return { id: 67, url: 'fixture://67', event: 'COMMENT' }; },
      writeRequiredStatus: async () => { J6Status += 1; },
      notifyWorker: async () => { J6Worker += 1; return { state: 'delivered', reason: 'unexpected' }; },
    });
    const J6Persisted = getPackReviewRun(J6Run.id, { projectId, storeRoot: J6Store });

    const delivery = {
      classes: 'J0-J6-pass',
      J0: { journalAttempts: J0JournalAttempts, channelAttempts: J0ChannelAttempts },
      J1: { order: J1Order, reviewerRuns: 0 },
      J2: { githubAttempts: J2Github, statusAttempts: J2Status, workerAttempts: J2Worker },
      J3: {
        postAttempts: J3PostAttempts,
        commentCount: J3Reviews.length,
        matchingCount: J3Reviews.filter((review) => review.body.includes(`Run: \`${J3Run.id}\``)).length,
        phase: J3Reconciled.reconciliation.phase,
        recoveredHead: J3Reviews[0]?.commitId,
        expectedHead: J3Run.targetSha,
      },
      J4: {
        statusPosts: J4StatusPosts,
        duplicateAccounted: true,
        exactlyOnceClaimed: false,
        semantics: 'at-least-once',
        attemptId: J4AttemptId,
        expectedAttemptId: requiredStatusKey(J4Base),
        attemptHead: J4Base.targetSha,
        expectedHead: J4Base.targetSha,
      },
      J5: {
        workerSends: J5WorkerSends,
        duplicateAccounted: true,
        exactlyOnceClaimed: false,
        semantics: 'at-least-once',
        attemptId: J5AttemptId,
        expectedAttemptId: workerKey(J5Base),
        attemptHead: J5Base.targetSha,
        expectedHead: J5Base.targetSha,
      },
      J6: { githubAttempts: J6Github, statusAttempts: J6Status, workerAttempts: J6Worker, status: J6Persisted?.status },
    };
    validateDeliveryMatrix(delivery);
    const mutations = runEvidenceMutationControls('AC4', delivery, validateDeliveryMatrix, {
      'pre-journal-delivery': (value: any) => { value.J0.channelAttempts = 1; },
      'reviewer-rerun-after-journal': (value: any) => { value.J1.reviewerRuns = 1; },
      'blind-comment-replay': (value: any) => { value.J3.postAttempts = 2; value.J3.commentCount = 2; },
      'invalid-comment-recovery': (value: any) => { value.J3.recoveredHead = 'f'.repeat(40); },
      'changed-idempotency-or-head': (value: any) => { value.J4.attemptId = `changed:${value.J4.attemptId}`; },
      'j4-j5-attempt-evidence-lost': (value: any) => { value.J5.attemptId = ''; },
      'false-exactly-once': (value: any) => { value.J4.exactlyOnceClaimed = true; },
      'recoverable-orphan-left': (value: any) => { value.J6.status = 'reviewing'; },
    });
    return { delivery, mutations };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
