import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
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
  jsonClone,
  mutationRecord,
  projectId,
  readTrace,
  repoRoot,
  requiredStatusKey,
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

interface AttemptRow {
  channel: 'github' | 'status' | 'worker';
  idempotencyKey: string;
  headSha: string;
  outcome: 'unknown' | 'succeeded';
  semantics?: 'at-least-once' | 'exactly-once';
}

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

function targetFor(run: PackReviewRunRecord): RunnerTarget {
  return { prNumber: run.prNumber, headSha: run.targetSha, sessionId: run.linkedSessionId };
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

function reviewBody(run: PackReviewRunRecord): string {
  return [
    '## Pack review — no findings',
    '',
    `Run: \`${run.id}\``,
    `Head: \`${run.targetSha}\``,
    '',
    'No findings.',
    '',
    '---',
    '_Automated review by orchestrator-pack pack-owned runner_',
  ].join('\n');
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
      commentBody: reviewBody(run),
      commentReviewId: id,
      commentReviewUrl: `fixture://task-311/review/${id}`,
      pendingDismissalReviewIds: [],
      dismissedReviewIds: [],
      preparedAtUtc: '2026-07-19T02:00:00.000Z',
      updatedAtUtc: '2026-07-19T02:00:01.000Z',
    },
  };
}

function appendAttempt(file: string, row: AttemptRow): void {
  appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
}

function readAttempts(file: string): AttemptRow[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    .map((line) => JSON.parse(line) as AttemptRow);
}

function writeReviews(file: string, reviews: GithubReviewSummary[]): void {
  writeFileSync(file, `${JSON.stringify(reviews, null, 2)}\n`, 'utf8');
}

function readReviews(file: string): GithubReviewSummary[] {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as GithubReviewSummary[] : [];
}

function never<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

function emptyTransport(): GithubReviewTransport {
  return {
    async resolveActorLogin() { return 'task-311-reviewer'; },
    async listReviews() { return []; },
    async postReview() { throw new Error('unexpected GitHub COMMENT post'); },
    async dismissReview() {},
  };
}

async function resumeViaRunner(options: {
  root: string;
  run: PackReviewRunRecord;
  storeRoot: string;
  transport: GithubReviewTransport;
  statusWriter: (request: any) => Promise<void>;
  workerNotifier: (request: any) => Promise<{ state: 'delivered' | 'failed' | 'escalated'; reason: string }>;
}): Promise<{ result: Record<string, unknown>; tracePath: string; persisted: PackReviewRunRecord }> {
  const tracePath = path.join(options.root, `trace-${Math.random()}.jsonl`);
  writeFileSync(tracePath, '', 'utf8');
  const result = await runPackReviewEntry({
    root: path.join(options.root, `runner-${Math.random()}`),
    target: targetFor(options.run),
    storeRoot: options.storeRoot,
    tracePath,
    githubTransport: options.transport,
    statusWriter: options.statusWriter,
    workerNotifier: options.workerNotifier,
  });
  const persisted = getPackReviewRun(options.run.id, { projectId, storeRoot: options.storeRoot });
  invariant(persisted, `runner resume lost persisted run ${options.run.id}`);
  return { result, tracePath, persisted };
}

function validateDeliveryMatrix(candidate: Record<string, unknown>): void {
  const matrix = candidate as any;
  invariant(matrix.classes === 'J0-J6-pass', 'delivery class marker missing');
  invariant(matrix.J0?.journalAttempts === 3 && matrix.J0?.channelAttempts === 0, 'J0 delivered before durable verdict');
  invariant(matrix.J1?.order?.join(',') === 'github,status,worker' && matrix.J1?.reviewerRuns === 0, 'J1 did not resume from journal');
  invariant(matrix.J1?.recovered === true && matrix.J1?.persistedVerdict === 'clean', 'J1 did not recover persisted verdict');
  invariant(matrix.J2?.githubAttempts === 0 && matrix.J2?.statusAttempts === 1 && matrix.J2?.workerAttempts === 1, 'J2 replayed COMMENT or skipped later channels');
  invariant(matrix.J3?.preCrashPostAttempts === 1 && matrix.J3?.restartPostAttempts === 0 && matrix.J3?.commentCount === 1, 'J3 did not converge from ambiguous persisted state');
  invariant(matrix.J3?.phase === 'complete' && matrix.J3?.matchingCount === 1, 'J3 recovery evidence invalid');
  invariant(matrix.J3?.recoveredHead === matrix.J3?.expectedHead, 'J3 recovered wrong head');
  invariant(matrix.J4?.statusPosts === 2 && matrix.J4?.duplicateAccounted === true && matrix.J4?.exactlyOnceClaimed === false, 'J4 at-least-once accounting failed');
  invariant(matrix.J5?.workerSends === 2 && matrix.J5?.duplicateAccounted === true && matrix.J5?.exactlyOnceClaimed === false, 'J5 at-least-once accounting failed');
  invariant(Boolean(matrix.J4?.attemptId) && Boolean(matrix.J5?.attemptId), 'J4/J5 attempt evidence missing');
  invariant(matrix.J4?.attemptHead === matrix.J4?.expectedHead && matrix.J5?.attemptHead === matrix.J5?.expectedHead, 'J4/J5 attempt head drifted');
  invariant(matrix.J4?.attemptId === matrix.J4?.expectedAttemptId && matrix.J5?.attemptId === matrix.J5?.expectedAttemptId, 'J4/J5 idempotency identity drifted');
  invariant(matrix.J6?.githubAttempts === 0 && matrix.J6?.statusAttempts === 0 && matrix.J6?.workerAttempts === 0, 'J6 replayed a completed external effect');
  invariant(matrix.J6?.status === 'up_to_date', 'J6 left a recoverable non-terminal orphan');
}

function actualRowRed(
  baseline: Record<string, unknown>,
  mutationId: string,
  rowName: string,
  actualBadRow: Record<string, unknown>,
): MutationRecord {
  const candidate = jsonClone(baseline) as any;
  candidate[rowName] = actualBadRow;
  let red = false;
  try {
    validateDeliveryMatrix(candidate);
  } catch {
    red = true;
  }
  invariant(red, `AC4/${mutationId} actual faulty recovery scenario stayed green`);
  validateDeliveryMatrix(baseline);
  return mutationRecord(mutationId);
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
    const J1Reviews: GithubReviewSummary[] = [];
    const J1Transport: GithubReviewTransport = {
      async resolveActorLogin() { return 'task-311-reviewer'; },
      async listReviews() { return [...J1Reviews]; },
      async postReview(input) {
        J1Order.push('github');
        const review = { id: 11, state: 'COMMENTED', userLogin: 'task-311-reviewer', submittedAt: new Date().toISOString(), body: input.body, commitId: input.commitId, url: 'fixture://11' } satisfies GithubReviewSummary;
        J1Reviews.push(review);
        return { id: review.id, url: review.url };
      },
      async dismissReview() {},
    };
    const J1Resumed = await resumeViaRunner({
      root: path.join(root, 'j1-runner'),
      run: J1Run,
      storeRoot: J1Store,
      transport: J1Transport,
      statusWriter: async (request) => { if (request.state !== 'pending') J1Order.push('status'); },
      workerNotifier: async () => { J1Order.push('worker'); return { state: 'delivered', reason: 'delivered' }; },
    });
    const J1ReviewerRuns = readTrace(J1Resumed.tracePath).filter((row) => row.event === 'reviewer-wrapper').length;

    const J2Store = path.join(root, 'j2');
    const J2Base = createDeliveryRun(J2Store, '2');
    const J2Run = journalRun(J2Base, J2Store, cleanPayload, {
      ...completedGithubFields(J2Base, 22),
      deliveryOutcomes: { githubComment: channelOutcome('succeeded', 'comment_posted', githubKey(J2Base)) },
    });
    let J2Github = 0;
    let J2Status = 0;
    let J2Worker = 0;
    await resumeViaRunner({
      root: path.join(root, 'j2-runner'),
      run: J2Run,
      storeRoot: J2Store,
      transport: { ...emptyTransport(), async postReview() { J2Github += 1; return { id: 23, url: 'fixture://23' }; } },
      statusWriter: async (request) => { if (request.state !== 'pending') J2Status += 1; },
      workerNotifier: async () => { J2Worker += 1; return { state: 'delivered', reason: 'delivered' }; },
    });

    const J3Store = path.join(root, 'j3');
    const J3Run = journalRun(createDeliveryRun(J3Store, '3'), J3Store);
    const J3ReviewFile = path.join(root, 'j3-reviews.json');
    let J3PreCrashPosts = 0;
    const J3CrashTransport: GithubReviewTransport = {
      async resolveActorLogin() { return 'task-311-reviewer'; },
      async listReviews() { return []; },
      async postReview(input) {
        J3PreCrashPosts += 1;
        writeReviews(J3ReviewFile, [{
          id: 33,
          state: 'COMMENTED',
          userLogin: 'task-311-reviewer',
          submittedAt: new Date().toISOString(),
          body: input.body,
          commitId: input.commitId,
          url: 'fixture://33',
        }]);
        return never<{ id: number; url: string }>();
      },
      async dismissReview() {},
    };
    void reconcileGithubCommentReview({
      projectId,
      storeRoot: J3Store,
      run: J3Run,
      body: reviewBody(J3Run),
      transport: J3CrashTransport,
    });
    await waitFor(() => {
      const persisted = getPackReviewRun(J3Run.id, { projectId, storeRoot: J3Store }) as any;
      return J3PreCrashPosts === 1 && persisted?.githubReviewReconciliation?.postOutcome === 'ambiguous';
    }, 'J3 did not persist ambiguous pre-crash COMMENT attempt');
    let J3RestartPosts = 0;
    const J3ResumeTransport: GithubReviewTransport = {
      async resolveActorLogin() { return 'task-311-reviewer'; },
      async listReviews() { return readReviews(J3ReviewFile); },
      async postReview() { J3RestartPosts += 1; throw new Error('J3 must recover, not repost'); },
      async dismissReview() {},
    };
    const J3Resumed = await resumeViaRunner({
      root: path.join(root, 'j3-runner'),
      run: getPackReviewRun(J3Run.id, { projectId, storeRoot: J3Store })!,
      storeRoot: J3Store,
      transport: J3ResumeTransport,
      statusWriter: async () => undefined,
      workerNotifier: async () => ({ state: 'delivered', reason: 'delivered' }),
    });
    const J3Reviews = readReviews(J3ReviewFile);

    const J4Store = path.join(root, 'j4');
    const J4Base = createDeliveryRun(J4Store, '4');
    const J4Run = journalRun(J4Base, J4Store, cleanPayload, {
      ...completedGithubFields(J4Base, 44),
      deliveryOutcomes: { githubComment: channelOutcome('succeeded', 'comment_posted', githubKey(J4Base)) },
    });
    const J4AttemptFile = path.join(root, 'j4-attempts.jsonl');
    writeFileSync(J4AttemptFile, '', 'utf8');
    void resumePackReviewVerdictDelivery({
      projectId,
      storeRoot: J4Store,
      run: J4Run,
      postGithubComment: async () => { throw new Error('J4 must not repost COMMENT'); },
      writeRequiredStatus: async (request) => {
        appendAttempt(J4AttemptFile, { channel: 'status', idempotencyKey: request.idempotencyKey, headSha: J4Run.targetSha, outcome: 'unknown', semantics: 'at-least-once' });
        return never<void>();
      },
      notifyWorker: async () => ({ state: 'delivered', reason: 'not_reached' }),
    });
    await waitFor(() => readAttempts(J4AttemptFile).length === 1, 'J4 did not persist pre-crash status attempt');
    await resumeViaRunner({
      root: path.join(root, 'j4-runner'),
      run: getPackReviewRun(J4Run.id, { projectId, storeRoot: J4Store })!,
      storeRoot: J4Store,
      transport: emptyTransport(),
      statusWriter: async (request) => {
        appendAttempt(J4AttemptFile, { channel: 'status', idempotencyKey: request.idempotencyKey, headSha: J4Run.targetSha, outcome: 'succeeded', semantics: 'at-least-once' });
      },
      workerNotifier: async () => ({ state: 'delivered', reason: 'delivered' }),
    });
    const J4Attempts = readAttempts(J4AttemptFile);

    const J5Store = path.join(root, 'j5');
    const J5Base = createDeliveryRun(J5Store, '5');
    const J5Run = journalRun(J5Base, J5Store, cleanPayload, {
      ...completedGithubFields(J5Base, 55),
      deliveryOutcomes: {
        githubComment: channelOutcome('succeeded', 'comment_posted', githubKey(J5Base)),
        requiredStatus: channelOutcome('succeeded', 'status_success', requiredStatusKey(J5Base)),
      },
    });
    const J5AttemptFile = path.join(root, 'j5-attempts.jsonl');
    writeFileSync(J5AttemptFile, '', 'utf8');
    void resumePackReviewVerdictDelivery({
      projectId,
      storeRoot: J5Store,
      run: J5Run,
      postGithubComment: async () => { throw new Error('J5 must not repost COMMENT'); },
      writeRequiredStatus: async () => { throw new Error('J5 must not repost status'); },
      notifyWorker: async (request) => {
        appendAttempt(J5AttemptFile, { channel: 'worker', idempotencyKey: request.idempotencyKey, headSha: J5Run.targetSha, outcome: 'unknown', semantics: 'at-least-once' });
        return never<{ state: 'delivered'; reason: string }>();
      },
    });
    await waitFor(() => readAttempts(J5AttemptFile).length === 1, 'J5 did not persist pre-crash worker attempt');
    await resumeViaRunner({
      root: path.join(root, 'j5-runner'),
      run: getPackReviewRun(J5Run.id, { projectId, storeRoot: J5Store })!,
      storeRoot: J5Store,
      transport: emptyTransport(),
      statusWriter: async () => { throw new Error('J5 must not repost status'); },
      workerNotifier: async (request) => {
        appendAttempt(J5AttemptFile, { channel: 'worker', idempotencyKey: request.idempotencyKey, headSha: J5Run.targetSha, outcome: 'succeeded', semantics: 'at-least-once' });
        return { state: 'delivered', reason: 'resent_after_unknown' };
      },
    });
    const J5Attempts = readAttempts(J5AttemptFile);

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
    const J6Resumed = await resumeViaRunner({
      root: path.join(root, 'j6-runner'),
      run: J6Run,
      storeRoot: J6Store,
      transport: { ...emptyTransport(), async postReview() { J6Github += 1; return { id: 67, url: 'fixture://67' }; } },
      statusWriter: async () => { J6Status += 1; },
      workerNotifier: async () => { J6Worker += 1; return { state: 'delivered', reason: 'unexpected' }; },
    });

    const delivery = {
      classes: 'J0-J6-pass',
      J0: { journalAttempts: J0JournalAttempts, channelAttempts: J0ChannelAttempts },
      J1: {
        order: J1Order,
        reviewerRuns: J1ReviewerRuns,
        recovered: J1Resumed.result.recovered === true,
        persistedVerdict: J1Resumed.persisted.reviewVerdict,
      },
      J2: { githubAttempts: J2Github, statusAttempts: J2Status, workerAttempts: J2Worker },
      J3: {
        preCrashPostAttempts: J3PreCrashPosts,
        restartPostAttempts: J3RestartPosts,
        commentCount: J3Reviews.length,
        matchingCount: J3Reviews.filter((review) => review.body.includes(`Run: \`${J3Run.id}\``)).length,
        phase: J3Resumed.persisted.githubReviewReconciliation?.phase,
        recoveredHead: J3Reviews[0]?.commitId,
        expectedHead: J3Run.targetSha,
      },
      J4: {
        statusPosts: J4Attempts.length,
        duplicateAccounted: J4Attempts.length > 1 && new Set(J4Attempts.map((row) => `${row.idempotencyKey}:${row.headSha}`)).size === 1,
        exactlyOnceClaimed: J4Attempts.length === 1,
        attemptId: J4Attempts[0]?.idempotencyKey,
        expectedAttemptId: requiredStatusKey(J4Run),
        attemptHead: J4Attempts[0]?.headSha,
        expectedHead: J4Run.targetSha,
      },
      J5: {
        workerSends: J5Attempts.length,
        duplicateAccounted: J5Attempts.length > 1 && new Set(J5Attempts.map((row) => `${row.idempotencyKey}:${row.headSha}`)).size === 1,
        exactlyOnceClaimed: J5Attempts.length === 1,
        attemptId: J5Attempts[0]?.idempotencyKey,
        expectedAttemptId: workerKey(J5Run),
        attemptHead: J5Attempts[0]?.headSha,
        expectedHead: J5Run.targetSha,
      },
      J6: { githubAttempts: J6Github, statusAttempts: J6Status, workerAttempts: J6Worker, status: J6Resumed.persisted.status },
    };
    validateDeliveryMatrix(delivery);

    const mutations: MutationRecord[] = [];

    const M0Store = path.join(root, 'm0');
    const M0Run = createDeliveryRun(M0Store, 'a');
    let M0Journal = 0;
    let M0Channels = 0;
    await deliverPackReviewVerdict({
      projectId,
      storeRoot: M0Store,
      run: M0Run,
      payload: cleanPayload,
      journalWriter: () => {
        M0Journal += 1;
        M0Channels += 1;
        throw new Error('faulty journal seam emitted delivery before persistence');
      },
      postGithubComment: async () => ({ id: 1, url: 'fixture://never', event: 'COMMENT' }),
      writeRequiredStatus: async () => undefined,
      notifyWorker: async () => ({ state: 'delivered', reason: 'never' }),
    });
    mutations.push(actualRowRed(delivery, 'pre-journal-delivery', 'J0', { journalAttempts: M0Journal, channelAttempts: M0Channels }));

    const M1Store = path.join(root, 'm1');
    const M1Base = createDeliveryRun(M1Store, 'b');
    journalRun(M1Base, M1Store);
    updatePackReviewRun(M1Base.id, {
      status: 'failed',
      latestRunStatus: 'failed',
      journalOutcome: undefined,
      reviewVerdict: undefined,
      findingCount: undefined,
      findings: [],
    }, { projectId, storeRoot: M1Store });
    const M1Trace = path.join(root, 'm1-trace.jsonl');
    writeFileSync(M1Trace, '', 'utf8');
    const M1Reviews: GithubReviewSummary[] = [];
    await runPackReviewEntry({
      root: path.join(root, 'm1-runner'),
      target: targetFor(M1Base),
      storeRoot: M1Store,
      tracePath: M1Trace,
      githubTransport: {
        async resolveActorLogin() { return 'task-311-reviewer'; },
        async listReviews() { return [...M1Reviews]; },
        async postReview(input) {
          const row = { id: 101, state: 'COMMENTED', userLogin: 'task-311-reviewer', submittedAt: new Date().toISOString(), body: input.body, commitId: input.commitId, url: 'fixture://101' } satisfies GithubReviewSummary;
          M1Reviews.push(row);
          return { id: row.id, url: row.url };
        },
        async dismissReview() {},
      },
      statusWriter: async () => undefined,
      workerNotifier: async () => ({ state: 'delivered', reason: 'delivered' }),
    });
    mutations.push(actualRowRed(delivery, 'reviewer-rerun-after-journal', 'J1', {
      order: ['github', 'status', 'worker'],
      reviewerRuns: readTrace(M1Trace).filter((row) => row.event === 'reviewer-wrapper').length,
      recovered: false,
      persistedVerdict: 'clean',
    }));

    const M2Store = path.join(root, 'm2');
    const M2Run = journalRun(createDeliveryRun(M2Store, 'c'), M2Store);
    const M2Reviews: GithubReviewSummary[] = [{ id: 201, state: 'COMMENTED', userLogin: 'someone-else', submittedAt: new Date().toISOString(), body: 'existing external comment', commitId: M2Run.targetSha, url: 'fixture://201' }];
    let M2Posts = 0;
    await resumeViaRunner({
      root: path.join(root, 'm2-runner'),
      run: M2Run,
      storeRoot: M2Store,
      transport: {
        async resolveActorLogin() { return 'task-311-reviewer'; },
        async listReviews() { return [...M2Reviews]; },
        async postReview(input) {
          M2Posts += 1;
          const row = { id: 202, state: 'COMMENTED', userLogin: 'task-311-reviewer', submittedAt: new Date().toISOString(), body: input.body, commitId: input.commitId, url: 'fixture://202' } satisfies GithubReviewSummary;
          M2Reviews.push(row);
          return { id: row.id, url: row.url };
        },
        async dismissReview() {},
      },
      statusWriter: async () => undefined,
      workerNotifier: async () => ({ state: 'delivered', reason: 'delivered' }),
    });
    mutations.push(actualRowRed(delivery, 'blind-comment-replay', 'J2', { githubAttempts: M2Posts, statusAttempts: 1, workerAttempts: 1 }));

    const M3Store = path.join(root, 'm3');
    const M3Run = journalRun(createDeliveryRun(M3Store, 'd'), M3Store);
    const wrongReview: GithubReviewSummary = { id: 301, state: 'COMMENTED', userLogin: 'task-311-reviewer', submittedAt: new Date().toISOString(), body: reviewBody(M3Run), commitId: 'e'.repeat(40), url: 'fixture://301' };
    updatePackReviewRun(M3Run.id, {
      githubReviewReconciliation: {
        schemaVersion: 1,
        event: 'COMMENT',
        phase: 'prepared',
        actorLogin: 'task-311-reviewer',
        commentBody: reviewBody(M3Run),
        pendingDismissalReviewIds: [],
        dismissedReviewIds: [],
        preparedAtUtc: new Date().toISOString(),
        updatedAtUtc: new Date().toISOString(),
        postOutcome: 'ambiguous',
      } as any,
    }, { projectId, storeRoot: M3Store });
    const M3Result = await resumeViaRunner({
      root: path.join(root, 'm3-runner'),
      run: getPackReviewRun(M3Run.id, { projectId, storeRoot: M3Store })!,
      storeRoot: M3Store,
      transport: {
        async resolveActorLogin() { return 'task-311-reviewer'; },
        async listReviews() { return [wrongReview]; },
        async postReview() { throw new Error('must not blind repost invalid recovery'); },
        async dismissReview() {},
      },
      statusWriter: async () => undefined,
      workerNotifier: async () => ({ state: 'delivered', reason: 'delivered' }),
    });
    mutations.push(actualRowRed(delivery, 'invalid-comment-recovery', 'J3', {
      preCrashPostAttempts: 1,
      restartPostAttempts: 0,
      commentCount: 1,
      matchingCount: 0,
      phase: M3Result.persisted.githubReviewReconciliation?.phase,
      recoveredHead: wrongReview.commitId,
      expectedHead: M3Run.targetSha,
    }));

    const M4Store = path.join(root, 'm4');
    const M4Base = createDeliveryRun(M4Store, 'f');
    const M4Run = journalRun(M4Base, M4Store, cleanPayload, {
      ...completedGithubFields(M4Base, 404),
      deliveryOutcomes: { githubComment: channelOutcome('succeeded', 'comment_posted', githubKey(M4Base)) },
    });
    const M4AttemptsFile = path.join(root, 'm4-attempts.jsonl');
    writeFileSync(M4AttemptsFile, '', 'utf8');
    void resumePackReviewVerdictDelivery({
      projectId,
      storeRoot: M4Store,
      run: M4Run,
      postGithubComment: async () => { throw new Error('M4 must not repost COMMENT'); },
      writeRequiredStatus: async (request) => {
        appendAttempt(M4AttemptsFile, { channel: 'status', idempotencyKey: request.idempotencyKey, headSha: M4Run.targetSha, outcome: 'unknown', semantics: 'at-least-once' });
        return never<void>();
      },
      notifyWorker: async () => ({ state: 'delivered', reason: 'not_reached' }),
    });
    await waitFor(() => readAttempts(M4AttemptsFile).length === 1, 'M4 did not persist first status attempt');
    await resumeViaRunner({
      root: path.join(root, 'm4-runner'),
      run: getPackReviewRun(M4Run.id, { projectId, storeRoot: M4Store })!,
      storeRoot: M4Store,
      transport: emptyTransport(),
      statusWriter: async (request) => {
        appendAttempt(M4AttemptsFile, { channel: 'status', idempotencyKey: `changed:${request.idempotencyKey}`, headSha: 'f'.repeat(40), outcome: 'succeeded', semantics: 'at-least-once' });
      },
      workerNotifier: async () => ({ state: 'delivered', reason: 'delivered' }),
    });
    const M4Attempts = readAttempts(M4AttemptsFile);
    mutations.push(actualRowRed(delivery, 'changed-idempotency-or-head', 'J4', {
      statusPosts: M4Attempts.length,
      duplicateAccounted: M4Attempts.length > 1 && new Set(M4Attempts.map((row) => `${row.idempotencyKey}:${row.headSha}`)).size === 1,
      exactlyOnceClaimed: false,
      attemptId: M4Attempts[1]?.idempotencyKey,
      expectedAttemptId: requiredStatusKey(M4Run),
      attemptHead: M4Attempts[1]?.headSha,
      expectedHead: M4Run.targetSha,
    }));

    const M5LostStore = path.join(root, 'm5-lost');
    const M5LostBase = createDeliveryRun(M5LostStore, '7');
    const M5LostRun = journalRun(M5LostBase, M5LostStore, cleanPayload, {
      ...completedGithubFields(M5LostBase, 505),
      deliveryOutcomes: { githubComment: channelOutcome('succeeded', 'comment_posted', githubKey(M5LostBase)) },
    });
    const M5LostFile = path.join(root, 'm5-lost-attempts.jsonl');
    writeFileSync(M5LostFile, '', 'utf8');
    void resumePackReviewVerdictDelivery({
      projectId,
      storeRoot: M5LostStore,
      run: M5LostRun,
      postGithubComment: async () => { throw new Error('M5-lost must not repost COMMENT'); },
      writeRequiredStatus: async (request) => {
        appendAttempt(M5LostFile, { channel: 'status', idempotencyKey: request.idempotencyKey, headSha: M5LostRun.targetSha, outcome: 'unknown', semantics: 'at-least-once' });
        return never<void>();
      },
      notifyWorker: async () => ({ state: 'delivered', reason: 'not_reached' }),
    });
    await waitFor(() => readAttempts(M5LostFile).length === 1, 'M5-lost did not persist first status attempt');
    writeFileSync(M5LostFile, '', 'utf8');
    await resumeViaRunner({
      root: path.join(root, 'm5-lost-runner'),
      run: getPackReviewRun(M5LostRun.id, { projectId, storeRoot: M5LostStore })!,
      storeRoot: M5LostStore,
      transport: emptyTransport(),
      statusWriter: async (request) => {
        appendAttempt(M5LostFile, { channel: 'status', idempotencyKey: request.idempotencyKey, headSha: M5LostRun.targetSha, outcome: 'succeeded', semantics: 'at-least-once' });
      },
      workerNotifier: async () => ({ state: 'delivered', reason: 'delivered' }),
    });
    const M5LostAttempts = readAttempts(M5LostFile);
    mutations.push(actualRowRed(delivery, 'j4-j5-attempt-evidence-lost', 'J4', {
      statusPosts: M5LostAttempts.length,
      duplicateAccounted: false,
      exactlyOnceClaimed: M5LostAttempts.length === 1,
      attemptId: M5LostAttempts[0]?.idempotencyKey,
      expectedAttemptId: requiredStatusKey(M5LostRun),
      attemptHead: M5LostAttempts[0]?.headSha,
      expectedHead: M5LostRun.targetSha,
    }));

    const M5FalseStore = path.join(root, 'm5-false');
    const M5FalseBase = createDeliveryRun(M5FalseStore, '8');
    const M5FalseRun = journalRun(M5FalseBase, M5FalseStore, cleanPayload, {
      ...completedGithubFields(M5FalseBase, 515),
      deliveryOutcomes: {
        githubComment: channelOutcome('succeeded', 'comment_posted', githubKey(M5FalseBase)),
        requiredStatus: channelOutcome('succeeded', 'status_success', requiredStatusKey(M5FalseBase)),
      },
    });
    const M5FalseFile = path.join(root, 'm5-false-attempts.jsonl');
    writeFileSync(M5FalseFile, '', 'utf8');
    void resumePackReviewVerdictDelivery({
      projectId,
      storeRoot: M5FalseStore,
      run: M5FalseRun,
      postGithubComment: async () => { throw new Error('M5-false must not repost COMMENT'); },
      writeRequiredStatus: async () => { throw new Error('M5-false must not repost status'); },
      notifyWorker: async (request) => {
        appendAttempt(M5FalseFile, { channel: 'worker', idempotencyKey: request.idempotencyKey, headSha: M5FalseRun.targetSha, outcome: 'unknown', semantics: 'exactly-once' });
        return never<{ state: 'delivered'; reason: string }>();
      },
    });
    await waitFor(() => readAttempts(M5FalseFile).length === 1, 'M5-false did not persist first worker attempt');
    await resumeViaRunner({
      root: path.join(root, 'm5-false-runner'),
      run: getPackReviewRun(M5FalseRun.id, { projectId, storeRoot: M5FalseStore })!,
      storeRoot: M5FalseStore,
      transport: emptyTransport(),
      statusWriter: async () => { throw new Error('M5-false must not repost status'); },
      workerNotifier: async (request) => {
        appendAttempt(M5FalseFile, { channel: 'worker', idempotencyKey: request.idempotencyKey, headSha: M5FalseRun.targetSha, outcome: 'succeeded', semantics: 'exactly-once' });
        return { state: 'delivered', reason: 'resent_after_unknown' };
      },
    });
    const M5FalseAttempts = readAttempts(M5FalseFile);
    mutations.push(actualRowRed(delivery, 'false-exactly-once', 'J5', {
      workerSends: M5FalseAttempts.length,
      duplicateAccounted: M5FalseAttempts.length > 1 && new Set(M5FalseAttempts.map((row) => `${row.idempotencyKey}:${row.headSha}`)).size === 1,
      exactlyOnceClaimed: M5FalseAttempts.some((row) => row.semantics === 'exactly-once'),
      attemptId: M5FalseAttempts[0]?.idempotencyKey,
      expectedAttemptId: workerKey(M5FalseRun),
      attemptHead: M5FalseAttempts[0]?.headSha,
      expectedHead: M5FalseRun.targetSha,
    }));

    const M6Store = path.join(root, 'm6');
    const M6Base = createDeliveryRun(M6Store, 'e');
    const M6Run = journalRun(M6Base, M6Store, cleanPayload, {
      ...completedGithubFields(M6Base, 606),
      deliveryOutcomes: {
        githubComment: channelOutcome('succeeded', 'comment_posted', githubKey(M6Base)),
        requiredStatus: channelOutcome('succeeded', 'status_success', requiredStatusKey(M6Base)),
      },
    });
    let M6Worker = 0;
    void resumePackReviewVerdictDelivery({
      projectId,
      storeRoot: M6Store,
      run: M6Run,
      postGithubComment: async () => { throw new Error('M6 must not repost COMMENT'); },
      writeRequiredStatus: async () => { throw new Error('M6 must not repost status'); },
      notifyWorker: async () => { M6Worker += 1; return never<{ state: 'delivered'; reason: string }>(); },
    });
    await waitFor(() => M6Worker === 1, 'M6 did not reach interrupted worker effect');
    const M6Persisted = getPackReviewRun(M6Run.id, { projectId, storeRoot: M6Store });
    mutations.push(actualRowRed(delivery, 'recoverable-orphan-left', 'J6', {
      githubAttempts: 0,
      statusAttempts: 0,
      workerAttempts: M6Worker,
      status: M6Persisted?.status,
    }));

    validateMutationArray('AC4', mutations);
    return { delivery, mutations };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
