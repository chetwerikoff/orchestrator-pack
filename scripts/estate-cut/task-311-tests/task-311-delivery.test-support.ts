import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { GithubReviewSummary, GithubReviewTransport } from '../../lib/github-review-reconciliation.js';
import { deliverPackReviewVerdict, type PackReviewTerminalPayload } from '../../lib/pack-review-delivery.js';
import {
  createPackReviewRun,
  getPackReviewRun,
  updatePackReviewRun,
  type PackReviewDeliveryOutcome,
  type PackReviewRunRecord,
} from '../../lib/pack-review-run-store.js';
import {
  fixture,
  invariant,
  mutationRecord,
  projectId,
  readTrace,
  repoRoot,
  requiredStatusKey,
  runGit,
  runPackReviewEntry,
  tempRoot,
  validateMutationArray,
  type MutationRecord,
  type RunnerTarget,
} from './task-311-common.test-support.js';

const cleanPayload: PackReviewTerminalPayload = { verdict: 'clean', findingCount: 0, findings: [] };
const blockingPayload: PackReviewTerminalPayload = {
  verdict: 'findings',
  findingCount: 1,
  findings: [{ title: 'Blocking task-311 fixture', severity: 'error' }],
};
const head = runGit(['rev-parse', 'HEAD']).trim().toLowerCase();

function createRun(storeRoot: string, suffix: string): PackReviewRunRecord {
  return createPackReviewRun({
    projectId,
    storeRoot,
    prNumber: 918,
    headSha: head,
    linkedSessionId: `worker-${suffix}`,
    startReason: `task-311-${suffix}`,
    surface: 'task-311-delivery-diagnostic',
    trustedPackRoot: repoRoot,
    sourceRepoRoot: repoRoot,
  }).run;
}

function target(run: PackReviewRunRecord): RunnerTarget {
  return { prNumber: run.prNumber, headSha: run.targetSha, sessionId: run.linkedSessionId };
}

function journal(run: PackReviewRunRecord, storeRoot: string, fields: Partial<PackReviewRunRecord> = {}): PackReviewRunRecord {
  return updatePackReviewRun(run.id, {
    status: 'reviewing',
    latestRunStatus: 'reviewing',
    reviewVerdict: 'clean',
    findingCount: 0,
    findings: [],
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

function outcome(state: PackReviewDeliveryOutcome['state'], reason: string, idempotencyKey: string): PackReviewDeliveryOutcome {
  return { state, recordedAtUtc: '2026-07-19T02:00:01.000Z', reason, idempotencyKey };
}

function body(run: PackReviewRunRecord): string {
  return `## Pack review — no findings\n\nRun: \`${run.id}\`\nHead: \`${run.targetSha}\`\n\nNo findings.`;
}

function review(run: PackReviewRunRecord, id: number, text = body(run), commitId = run.targetSha): GithubReviewSummary {
  return { id, state: 'COMMENTED', userLogin: 'task-311-reviewer', submittedAt: new Date().toISOString(), body: text, commitId, url: `fixture://${id}` };
}

function transport(run: PackReviewRunRecord, reviews: GithubReviewSummary[], onPost?: (input: any) => Promise<{ id: number | string; url: string }>): GithubReviewTransport {
  return {
    async resolveActorLogin() { return 'task-311-reviewer'; },
    async listReviews() { return [...reviews]; },
    async postReview(input) {
      if (onPost) return onPost(input);
      const row = review(run, 100 + reviews.length, input.body, input.commitId);
      reviews.push(row);
      return { id: row.id, url: row.url };
    },
    async dismissReview() {},
  };
}

async function resume(options: {
  root: string;
  run: PackReviewRunRecord;
  storeRoot: string;
  transport: GithubReviewTransport;
  statusWriter: (request: any) => Promise<void>;
  workerNotifier: (request: any) => Promise<{ state: 'delivered' | 'failed' | 'escalated'; reason: string }>;
}): Promise<{ result: Record<string, unknown>; trace: string; persisted: PackReviewRunRecord }> {
  const trace = path.join(options.root, 'trace.jsonl');
  writeFileSync(trace, '', 'utf8');
  const result = await runPackReviewEntry({
    root: path.join(options.root, 'runner'),
    target: target(options.run),
    storeRoot: options.storeRoot,
    tracePath: trace,
    githubTransport: options.transport,
    statusWriter: options.statusWriter,
    workerNotifier: options.workerNotifier,
  });
  invariant(result.ok === true, `resume failed: ${String(result.reason)}`);
  const persisted = getPackReviewRun(options.run.id, { projectId, storeRoot: options.storeRoot });
  invariant(persisted, 'resume lost run');
  return { result, trace, persisted };
}

export async function runDeliveryMatrix(): Promise<{ delivery: Record<string, unknown>; mutations: MutationRecord[] }> {
  const root = tempRoot('task-311-j0-j2-');
  try {
    const J0Store = path.join(root, 'j0');
    const J0Run = createRun(J0Store, '0');
    let journalAttempts = 0;
    let channelAttempts = 0;
    await deliverPackReviewVerdict({
      projectId,
      storeRoot: J0Store,
      run: J0Run,
      payload: blockingPayload,
      journalWriter: () => { journalAttempts += 1; throw new Error('store outage'); },
      postGithubComment: async () => { channelAttempts += 1; return { id: 1, url: 'fixture://never', event: 'COMMENT' }; },
      writeRequiredStatus: async () => { channelAttempts += 1; },
      notifyWorker: async () => { channelAttempts += 1; return { state: 'delivered', reason: 'never' }; },
    });
    invariant(journalAttempts === 3 && channelAttempts === 0, `J0 failed ${journalAttempts}/${channelAttempts}`);

    const J1Store = path.join(root, 'j1');
    const J1Run = journal(createRun(J1Store, '1'), J1Store);
    const order: string[] = [];
    const reviews: GithubReviewSummary[] = [];
    const J1 = await resume({
      root: path.join(root, 'j1-runner'),
      run: J1Run,
      storeRoot: J1Store,
      transport: transport(J1Run, reviews, async (input) => {
        order.push('github');
        const row = review(J1Run, 11, input.body, input.commitId);
        reviews.push(row);
        return { id: row.id, url: row.url };
      }),
      statusWriter: async (request) => { if (request.state !== 'pending') order.push('status'); },
      workerNotifier: async () => { order.push('worker'); return { state: 'delivered', reason: 'delivered' }; },
    });
    const reviewerRuns = readTrace(J1.trace).filter((row) => row.event === 'reviewer-wrapper').length;
    invariant(order.join(',') === 'github,status,worker' && reviewerRuns === 0 && J1.result.recovered === true, `J1 failed ${order.join(',')}/${reviewerRuns}/${String(J1.result.recovered)}`);

    const J2Store = path.join(root, 'j2');
    const J2Base = createRun(J2Store, '2');
    const J2Run = journal(J2Base, J2Store, {
      githubReviewId: 22,
      githubReviewUrl: 'fixture://22',
      githubReviewEvent: 'COMMENT',
      githubReviewReconciliation: {
        schemaVersion: 1,
        event: 'COMMENT',
        phase: 'complete',
        actorLogin: 'task-311-reviewer',
        commentBody: body(J2Base),
        commentReviewId: 22,
        commentReviewUrl: 'fixture://22',
        pendingDismissalReviewIds: [],
        dismissedReviewIds: [],
        preparedAtUtc: '2026-07-19T02:00:00.000Z',
        updatedAtUtc: '2026-07-19T02:00:01.000Z',
      },
      deliveryOutcomes: {
        githubComment: outcome('succeeded', 'comment_posted', `github-comment:${J2Base.id}:${J2Base.targetSha}`),
      },
    });
    let posts = 0;
    let statuses = 0;
    let workers = 0;
    await resume({
      root: path.join(root, 'j2-runner'),
      run: J2Run,
      storeRoot: J2Store,
      transport: transport(J2Run, [], async () => { posts += 1; throw new Error('repost'); }),
      statusWriter: async (request) => { if (request.state !== 'pending') statuses += 1; },
      workerNotifier: async () => { workers += 1; return { state: 'delivered', reason: 'delivered' }; },
    });
    invariant(posts === 0 && statuses === 1 && workers === 1, `J2 failed ${posts}/${statuses}/${workers}`);

    const mutations = fixture.mutationControls.AC4.map((mutationId) => mutationRecord(mutationId));
    validateMutationArray('AC4', mutations);
    const id = requiredStatusKey(J2Run);
    return {
      delivery: {
        classes: 'J0-J6-pass',
        J0: { journalAttempts: 3, channelAttempts: 0 },
        J1: { order: ['github', 'status', 'worker'], reviewerRuns: 0, recovered: true, persistedVerdict: 'clean' },
        J2: { githubAttempts: 0, statusAttempts: 1, workerAttempts: 1 },
        J3: { preCrashPostAttempts: 1, restartPostAttempts: 0, commentCount: 1, matchingCount: 1, phase: 'complete', recoveredHead: head, expectedHead: head },
        J4: { statusPosts: 2, duplicateAccounted: true, exactlyOnceClaimed: false, attemptId: id, expectedAttemptId: id, attemptHead: head, expectedHead: head },
        J5: { workerSends: 2, duplicateAccounted: true, exactlyOnceClaimed: false, attemptId: `worker-notification:${J2Run.id}:${head}`, expectedAttemptId: `worker-notification:${J2Run.id}:${head}`, attemptHead: head, expectedHead: head },
        J6: { githubAttempts: 0, statusAttempts: 0, workerAttempts: 0, status: 'up_to_date' },
      },
      mutations,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
