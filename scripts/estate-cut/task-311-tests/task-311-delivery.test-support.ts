import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  type GithubReviewSummary,
  type GithubReviewTransport,
} from '../../lib/github-review-reconciliation.js';
import {
  deliverPackReviewVerdict,
  type PackReviewTerminalPayload,
} from '../../lib/pack-review-delivery.js';
import {
  createPackReviewRun,
  getPackReviewRun,
  updatePackReviewRun,
  type PackReviewDeliveryOutcome,
  type PackReviewRunRecord,
} from '../../lib/pack-review-run-store.js';
import { runProcessSync } from '../../kernel/subprocess.js';
import {
  invariant,
  jsonClone,
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
const checkedOutHead = runGit(['rev-parse', 'HEAD']).trim().toLowerCase();
invariant(/^[0-9a-f]{40}$/.test(checkedOutHead), `TASK-311 delivery fixture received invalid checkout head ${checkedOutHead}`);

interface AttemptRow {
  channel: 'status' | 'worker';
  idempotencyKey: string;
  headSha: string;
  outcome: 'unknown' | 'succeeded';
  semantics: 'at-least-once' | 'exactly-once';
}

interface Counter {
  value: number;
}

function createDeliveryRun(storeRoot: string, suffix: string): PackReviewRunRecord {
  return createPackReviewRun({
    projectId,
    storeRoot,
    prNumber: 918,
    headSha: checkedOutHead,
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

function readReviews(file: string): GithubReviewSummary[] {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as GithubReviewSummary[] : [];
}

function makeReview(
  run: PackReviewRunRecord,
  id: number,
  body = reviewBody(run),
  commitId = run.targetSha,
  actorLogin = 'task-311-reviewer',
): GithubReviewSummary {
  return {
    id,
    state: 'COMMENTED',
    userLogin: actorLogin,
    submittedAt: new Date().toISOString(),
    body,
    commitId,
    url: `fixture://task-311/review/${id}`,
  };
}

function listBackedTransport(options: {
  reviews: GithubReviewSummary[];
  run: PackReviewRunRecord;
  postCounter?: Counter;
  onPost?: (input: { event: 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES'; body: string; commitId: string }) => Promise<{ id: number | string; url: string }>;
}): GithubReviewTransport {
  return {
    async resolveActorLogin() { return 'task-311-reviewer'; },
    async listReviews() { return [...options.reviews]; },
    async postReview(input) {
      if (options.postCounter) options.postCounter.value += 1;
      if (options.onPost) return options.onPost(input);
      const review = makeReview(options.run, 31000 + options.reviews.length, input.body, input.commitId);
      options.reviews.push(review);
      return { id: review.id, url: review.url };
    },
    async dismissReview() {},
  };
}

function noPostTransport(run: PackReviewRunRecord, counter?: Counter): GithubReviewTransport {
  return listBackedTransport({
    run,
    reviews: [],
    postCounter: counter,
    onPost: async () => { throw new Error('unexpected GitHub COMMENT post'); },
  });
}

async function resumeViaRunner(options: {
  root: string;
  run: PackReviewRunRecord;
  storeRoot: string;
  transport: GithubReviewTransport;
  statusWriter: (request: any) => Promise<void>;
  workerNotifier: (request: any) => Promise<{ state: 'delivered' | 'failed' | 'escalated'; reason: string }>;
}): Promise<{ result: Record<string, unknown>; tracePath: string; persisted: PackReviewRunRecord }> {
  mkdirSync(options.root, { recursive: true });
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
  invariant(result.ok === true, `runner recovery failed: ${String(result.reason)}`);
  const persisted = getPackReviewRun(options.run.id, { projectId, storeRoot: options.storeRoot });
  invariant(persisted, `runner resume lost persisted run ${options.run.id}`);
  return { result, tracePath, persisted };
}

function moduleUrl(relativePath: string): string {
  return pathToFileURL(path.join(repoRoot, relativePath)).href;
}

function runCrashChild(root: string, name: string, source: string): void {
  const script = path.join(root, `${name}.mjs`);
  writeFileSync(script, source, 'utf8');
  const result = runProcessSync({
    command: 'node',
    args: [script],
    cwd: repoRoot,
    env: process.env,
    inheritParentEnv: false,
    encoding: 'utf8',
  });
  invariant(
    result.exitCode === 0,
    `${name} crash child failed: ${result.stderr || result.stdout || result.error || result.outcome}`,
  );
}

function crashGithubPost(options: {
  root: string;
  name: string;
  storeRoot: string;
  run: PackReviewRunRecord;
  reviewFile: string;
  reviewId: number;
  commitId?: string;
}): void {
  const reconciliationUrl = moduleUrl('scripts/lib/github-review-reconciliation.js');
  const runStoreUrl = moduleUrl('scripts/lib/pack-review-run-store.js');
  runCrashChild(options.root, options.name, `
import fs from 'node:fs';
import { reconcileGithubCommentReview } from ${JSON.stringify(reconciliationUrl)};
import { getPackReviewRun } from ${JSON.stringify(runStoreUrl)};
const projectId = ${JSON.stringify(projectId)};
const storeRoot = ${JSON.stringify(options.storeRoot)};
const runId = ${JSON.stringify(options.run.id)};
const reviewFile = ${JSON.stringify(options.reviewFile)};
const reviewId = ${options.reviewId};
const forcedCommitId = ${JSON.stringify(options.commitId ?? '')};
const run = getPackReviewRun(runId, { projectId, storeRoot });
if (!run) throw new Error('missing crash run ' + runId);
const body = ${JSON.stringify(reviewBody(options.run))};
void reconcileGithubCommentReview({
  projectId,
  storeRoot,
  run,
  body,
  transport: {
    async resolveActorLogin() { return 'task-311-reviewer'; },
    async listReviews() { return []; },
    async postReview(input) {
      const review = {
        id: reviewId,
        state: 'COMMENTED',
        userLogin: 'task-311-reviewer',
        submittedAt: new Date().toISOString(),
        body: input.body,
        commitId: forcedCommitId || input.commitId,
        url: 'fixture://task-311/review/' + reviewId,
      };
      fs.writeFileSync(reviewFile, JSON.stringify([review], null, 2) + '\\n', 'utf8');
      return new Promise(() => undefined);
    },
    async dismissReview() {},
  },
});
for (let attempt = 0; attempt < 400; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 5));
  const persisted = getPackReviewRun(runId, { projectId, storeRoot });
  if (persisted?.githubReviewReconciliation?.postOutcome === 'ambiguous') process.exit(0);
}
throw new Error('ambiguous github attempt was not persisted');
`);
}

function crashDeliveryAttempt(options: {
  root: string;
  name: string;
  storeRoot: string;
  run: PackReviewRunRecord;
  attemptFile: string;
  channel: 'status' | 'worker';
  semantics: 'at-least-once' | 'exactly-once';
}): void {
  const deliveryUrl = moduleUrl('scripts/lib/pack-review-delivery.js');
  const runStoreUrl = moduleUrl('scripts/lib/pack-review-run-store.js');
  runCrashChild(options.root, options.name, `
import fs from 'node:fs';
import { resumePackReviewVerdictDelivery } from ${JSON.stringify(deliveryUrl)};
import { getPackReviewRun } from ${JSON.stringify(runStoreUrl)};
const projectId = ${JSON.stringify(projectId)};
const storeRoot = ${JSON.stringify(options.storeRoot)};
const runId = ${JSON.stringify(options.run.id)};
const attemptFile = ${JSON.stringify(options.attemptFile)};
const channel = ${JSON.stringify(options.channel)};
const semantics = ${JSON.stringify(options.semantics)};
const run = getPackReviewRun(runId, { projectId, storeRoot });
if (!run) throw new Error('missing crash run ' + runId);
process.on('unhandledRejection', (error) => { console.error(error); process.exit(97); });
setTimeout(() => { console.error(channel + ' crash seam not reached'); process.exit(98); }, 3000);
const recordAndCrash = (idempotencyKey) => {
  fs.appendFileSync(attemptFile, JSON.stringify({
    channel,
    idempotencyKey,
    headSha: run.targetSha,
    outcome: 'unknown',
    semantics,
  }) + '\\n', 'utf8');
  process.exit(0);
};
void resumePackReviewVerdictDelivery({
  projectId,
  storeRoot,
  run,
  postGithubComment: async () => { throw new Error('crash seam reposted COMMENT'); },
  writeRequiredStatus: async (request) => {
    if (channel !== 'status') throw new Error('crash seam reposted status');
    recordAndCrash(request.idempotencyKey);
  },
  notifyWorker: async (request) => {
    if (channel !== 'worker') throw new Error('worker crash seam reached wrong channel');
    recordAndCrash(request.idempotencyKey);
    return { state: 'delivered', reason: 'unreachable' };
  },
});
`);
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

function attemptEvidence(attempts: AttemptRow[]): {
  count: number;
  duplicateAccounted: boolean;
  exactlyOnceClaimed: boolean;
  attemptId?: string;
  attemptHead?: string;
} {
  return {
    count: attempts.length,
    duplicateAccounted: attempts.length > 1
      && new Set(attempts.map((row) => `${row.idempotencyKey}:${row.headSha}`)).size === 1,
    exactlyOnceClaimed: attempts.some((row) => row.semantics === 'exactly-once'),
    attemptId: attempts[0]?.idempotencyKey,
    attemptHead: attempts[0]?.headSha,
  };
}

export async function runDeliveryMatrix(): Promise<{ delivery: Record<string, unknown>; mutations: MutationRecord[] }> {
  const root = tempRoot('task-311-delivery-');
  try {
    const J0Store = path.join(root, 'j0');
    const J0Run = createDeliveryRun(J0Store, '0');
    let J0JournalAttempts = 0;
    let J0ChannelAttempts = 0;
    const J0Result = await deliverPackReviewVerdict({
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
    invariant(J0Result.reason === 'journal_write_failed', `J0 reason drifted: ${J0Result.reason}`);

    const J1Store = path.join(root, 'j1');
    const J1Run = journalRun(createDeliveryRun(J1Store, '1'), J1Store);
    const J1Order: string[] = [];
    const J1Reviews: GithubReviewSummary[] = [];
    const J1Resumed = await resumeViaRunner({
      root: path.join(root, 'j1-runner'),
      run: J1Run,
      storeRoot: J1Store,
      transport: listBackedTransport({
        run: J1Run,
        reviews: J1Reviews,
        onPost: async (input) => {
          J1Order.push('github');
          const review = makeReview(J1Run, 11, input.body, input.commitId);
          J1Reviews.push(review);
          return { id: review.id, url: review.url };
        },
      }),
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
    const J2Github = { value: 0 };
    let J2Status = 0;
    let J2Worker = 0;
    await resumeViaRunner({
      root: path.join(root, 'j2-runner'),
      run: J2Run,
      storeRoot: J2Store,
      transport: noPostTransport(J2Run, J2Github),
      statusWriter: async (request) => { if (request.state !== 'pending') J2Status += 1; },
      workerNotifier: async () => { J2Worker += 1; return { state: 'delivered', reason: 'delivered' }; },
    });

    const J3Store = path.join(root, 'j3');
    const J3Run = journalRun(createDeliveryRun(J3Store, '3'), J3Store);
    const J3ReviewFile = path.join(root, 'j3-reviews.json');
    crashGithubPost({ root, name: 'j3-crash', storeRoot: J3Store, run: J3Run, reviewFile: J3ReviewFile, reviewId: 33 });
    const J3Reviews = readReviews(J3ReviewFile);
    const J3Restart = { value: 0 };
    const J3Resumed = await resumeViaRunner({
      root: path.join(root, 'j3-runner'),
      run: getPackReviewRun(J3Run.id, { projectId, storeRoot: J3Store })!,
      storeRoot: J3Store,
      transport: listBackedTransport({
        run: J3Run,
        reviews: J3Reviews,
        postCounter: J3Restart,
        onPost: async () => { throw new Error('J3 must recover, not repost'); },
      }),
      statusWriter: async () => undefined,
      workerNotifier: async () => ({ state: 'delivered', reason: 'delivered' }),
    });

    const J4Store = path.join(root, 'j4');
    const J4Base = createDeliveryRun(J4Store, '4');
    const J4Run = journalRun(J4Base, J4Store, cleanPayload, {
      ...completedGithubFields(J4Base, 44),
      deliveryOutcomes: { githubComment: channelOutcome('succeeded', 'comment_posted', githubKey(J4Base)) },
    });
    const J4AttemptFile = path.join(root, 'j4-attempts.jsonl');
    writeFileSync(J4AttemptFile, '', 'utf8');
    crashDeliveryAttempt({ root, name: 'j4-crash', storeRoot: J4Store, run: J4Run, attemptFile: J4AttemptFile, channel: 'status', semantics: 'at-least-once' });
    await resumeViaRunner({
      root: path.join(root, 'j4-runner'),
      run: getPackReviewRun(J4Run.id, { projectId, storeRoot: J4Store })!,
      storeRoot: J4Store,
      transport: noPostTransport(J4Run),
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
    crashDeliveryAttempt({ root, name: 'j5-crash', storeRoot: J5Store, run: J5Run, attemptFile: J5AttemptFile, channel: 'worker', semantics: 'at-least-once' });
    await resumeViaRunner({
      root: path.join(root, 'j5-runner'),
      run: getPackReviewRun(J5Run.id, { projectId, storeRoot: J5Store })!,
      storeRoot: J5Store,
      transport: noPostTransport(J5Run),
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
    const J6Github = { value: 0 };
    let J6Status = 0;
    let J6Worker = 0;
    const J6Resumed = await resumeViaRunner({
      root: path.join(root, 'j6-runner'),
      run: J6Run,
      storeRoot: J6Store,
      transport: noPostTransport(J6Run, J6Github),
      statusWriter: async () => { J6Status += 1; },
      workerNotifier: async () => { J6Worker += 1; return { state: 'delivered', reason: 'unexpected' }; },
    });

    const J4Evidence = attemptEvidence(J4Attempts);
    const J5Evidence = attemptEvidence(J5Attempts);
    const delivery = {
      classes: 'J0-J6-pass',
      J0: { journalAttempts: J0JournalAttempts, channelAttempts: J0ChannelAttempts },
      J1: {
        order: J1Order,
        reviewerRuns: J1ReviewerRuns,
        recovered: J1Resumed.result.recovered === true,
        persistedVerdict: J1Resumed.persisted.reviewVerdict,
      },
      J2: { githubAttempts: J2Github.value, statusAttempts: J2Status, workerAttempts: J2Worker },
      J3: {
        preCrashPostAttempts: 1,
        restartPostAttempts: J3Restart.value,
        commentCount: J3Reviews.length,
        matchingCount: J3Reviews.filter((review) => review.body.includes(`Run: \`${J3Run.id}\``)).length,
        phase: J3Resumed.persisted.githubReviewReconciliation?.phase,
        recoveredHead: J3Reviews[0]?.commitId,
        expectedHead: J3Run.targetSha,
      },
      J4: {
        statusPosts: J4Evidence.count,
        duplicateAccounted: J4Evidence.duplicateAccounted,
        exactlyOnceClaimed: J4Evidence.exactlyOnceClaimed,
        attemptId: J4Evidence.attemptId,
        expectedAttemptId: requiredStatusKey(J4Run),
        attemptHead: J4Evidence.attemptHead,
        expectedHead: J4Run.targetSha,
      },
      J5: {
        workerSends: J5Evidence.count,
        duplicateAccounted: J5Evidence.duplicateAccounted,
        exactlyOnceClaimed: J5Evidence.exactlyOnceClaimed,
        attemptId: J5Evidence.attemptId,
        expectedAttemptId: workerKey(J5Run),
        attemptHead: J5Evidence.attemptHead,
        expectedHead: J5Run.targetSha,
      },
      J6: { githubAttempts: J6Github.value, statusAttempts: J6Status, workerAttempts: J6Worker, status: J6Resumed.persisted.status },
    };
    validateDeliveryMatrix(delivery);

    const mutations: MutationRecord[] = [];

    const M0Store = path.join(root, 'm0');
    const M0Run = createDeliveryRun(M0Store, 'a');
    let M0Journal = 0;
    let M0Channels = 0;
    const faultyPreJournalComment = async () => {
      M0Channels += 1;
      return { id: 701, url: 'fixture://task-311/pre-journal', event: 'COMMENT' as const };
    };
    await faultyPreJournalComment();
    await deliverPackReviewVerdict({
      projectId,
      storeRoot: M0Store,
      run: M0Run,
      payload: cleanPayload,
      journalWriter: () => { M0Journal += 1; throw new Error('faulty flow omitted durable verdict'); },
      postGithubComment: faultyPreJournalComment,
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
    const M1Result = await runPackReviewEntry({
      root: path.join(root, 'm1-runner'),
      target: targetFor(M1Base),
      storeRoot: M1Store,
      tracePath: M1Trace,
      githubTransport: listBackedTransport({ run: M1Base, reviews: [] }),
      statusWriter: async () => undefined,
      workerNotifier: async () => ({ state: 'delivered', reason: 'delivered' }),
    });
    invariant(M1Result.ok === true, `reviewer-rerun control failed: ${String(M1Result.reason)}`);
    mutations.push(actualRowRed(delivery, 'reviewer-rerun-after-journal', 'J1', {
      order: ['github', 'status', 'worker'],
      reviewerRuns: readTrace(M1Trace).filter((row) => row.event === 'reviewer-wrapper').length,
      recovered: false,
      persistedVerdict: 'clean',
    }));

    const M2Store = path.join(root, 'm2');
    const M2Run = journalRun(createDeliveryRun(M2Store, 'c'), M2Store);
    const M2Posts = { value: 0 };
    await resumeViaRunner({
      root: path.join(root, 'm2-runner'),
      run: M2Run,
      storeRoot: M2Store,
      transport: listBackedTransport({
        run: M2Run,
        reviews: [makeReview(M2Run, 201, 'unrelated external comment', M2Run.targetSha, 'someone-else')],
        postCounter: M2Posts,
      }),
      statusWriter: async () => undefined,
      workerNotifier: async () => ({ state: 'delivered', reason: 'delivered' }),
    });
    mutations.push(actualRowRed(delivery, 'blind-comment-replay', 'J2', { githubAttempts: M2Posts.value, statusAttempts: 1, workerAttempts: 1 }));

    const M3Store = path.join(root, 'm3');
    const M3Run = journalRun(createDeliveryRun(M3Store, 'd'), M3Store);
    const M3ReviewFile = path.join(root, 'm3-reviews.json');
    const wrongHead = 'e'.repeat(40);
    crashGithubPost({ root, name: 'm3-crash', storeRoot: M3Store, run: M3Run, reviewFile: M3ReviewFile, reviewId: 301, commitId: wrongHead });
    const M3Reviews = readReviews(M3ReviewFile);
    const M3Restart = { value: 0 };
    const M3Resumed = await resumeViaRunner({
      root: path.join(root, 'm3-runner'),
      run: getPackReviewRun(M3Run.id, { projectId, storeRoot: M3Store })!,
      storeRoot: M3Store,
      transport: listBackedTransport({
        run: M3Run,
        reviews: M3Reviews,
        postCounter: M3Restart,
        onPost: async () => { throw new Error('wrong-head recovery must not post'); },
      }),
      statusWriter: async () => undefined,
      workerNotifier: async () => ({ state: 'delivered', reason: 'delivered' }),
    });
    mutations.push(actualRowRed(delivery, 'invalid-comment-recovery', 'J3', {
      preCrashPostAttempts: 1,
      restartPostAttempts: M3Restart.value,
      commentCount: M3Reviews.length,
      matchingCount: M3Reviews.filter((review) => review.body.includes(`Run: \`${M3Run.id}\``)).length,
      phase: M3Resumed.persisted.githubReviewReconciliation?.phase,
      recoveredHead: M3Reviews[0]?.commitId,
      expectedHead: M3Run.targetSha,
    }));

    const M4Store = path.join(root, 'm4');
    const M4Base = createDeliveryRun(M4Store, 'f');
    const M4Run = journalRun(M4Base, M4Store, cleanPayload, {
      ...completedGithubFields(M4Base, 404),
      deliveryOutcomes: { githubComment: channelOutcome('succeeded', 'comment_posted', githubKey(M4Base)) },
    });
    const M4File = path.join(root, 'm4-attempts.jsonl');
    writeFileSync(M4File, '', 'utf8');
    crashDeliveryAttempt({ root, name: 'm4-crash', storeRoot: M4Store, run: M4Run, attemptFile: M4File, channel: 'status', semantics: 'at-least-once' });
    await resumeViaRunner({
      root: path.join(root, 'm4-runner'),
      run: getPackReviewRun(M4Run.id, { projectId, storeRoot: M4Store })!,
      storeRoot: M4Store,
      transport: noPostTransport(M4Run),
      statusWriter: async (request) => {
        appendAttempt(M4File, { channel: 'status', idempotencyKey: `changed:${request.idempotencyKey}`, headSha: 'f'.repeat(40), outcome: 'succeeded', semantics: 'at-least-once' });
      },
      workerNotifier: async () => ({ state: 'delivered', reason: 'delivered' }),
    });
    const M4Rows = readAttempts(M4File);
    const M4Evidence = attemptEvidence(M4Rows);
    mutations.push(actualRowRed(delivery, 'changed-idempotency-or-head', 'J4', {
      statusPosts: M4Evidence.count,
      duplicateAccounted: M4Evidence.duplicateAccounted,
      exactlyOnceClaimed: M4Evidence.exactlyOnceClaimed,
      attemptId: M4Rows[1]?.idempotencyKey,
      expectedAttemptId: requiredStatusKey(M4Run),
      attemptHead: M4Rows[1]?.headSha,
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
    crashDeliveryAttempt({ root, name: 'm5-lost-crash', storeRoot: M5LostStore, run: M5LostRun, attemptFile: M5LostFile, channel: 'status', semantics: 'at-least-once' });
    writeFileSync(M5LostFile, '', 'utf8');
    await resumeViaRunner({
      root: path.join(root, 'm5-lost-runner'),
      run: getPackReviewRun(M5LostRun.id, { projectId, storeRoot: M5LostStore })!,
      storeRoot: M5LostStore,
      transport: noPostTransport(M5LostRun),
      statusWriter: async (request) => {
        appendAttempt(M5LostFile, { channel: 'status', idempotencyKey: request.idempotencyKey, headSha: M5LostRun.targetSha, outcome: 'succeeded', semantics: 'at-least-once' });
      },
      workerNotifier: async () => ({ state: 'delivered', reason: 'delivered' }),
    });
    const M5LostEvidence = attemptEvidence(readAttempts(M5LostFile));
    mutations.push(actualRowRed(delivery, 'j4-j5-attempt-evidence-lost', 'J4', {
      statusPosts: M5LostEvidence.count,
      duplicateAccounted: M5LostEvidence.duplicateAccounted,
      exactlyOnceClaimed: M5LostEvidence.exactlyOnceClaimed,
      attemptId: M5LostEvidence.attemptId,
      expectedAttemptId: requiredStatusKey(M5LostRun),
      attemptHead: M5LostEvidence.attemptHead,
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
    crashDeliveryAttempt({ root, name: 'm5-false-crash', storeRoot: M5FalseStore, run: M5FalseRun, attemptFile: M5FalseFile, channel: 'worker', semantics: 'exactly-once' });
    await resumeViaRunner({
      root: path.join(root, 'm5-false-runner'),
      run: getPackReviewRun(M5FalseRun.id, { projectId, storeRoot: M5FalseStore })!,
      storeRoot: M5FalseStore,
      transport: noPostTransport(M5FalseRun),
      statusWriter: async () => { throw new Error('M5-false must not repost status'); },
      workerNotifier: async (request) => {
        appendAttempt(M5FalseFile, { channel: 'worker', idempotencyKey: request.idempotencyKey, headSha: M5FalseRun.targetSha, outcome: 'succeeded', semantics: 'exactly-once' });
        return { state: 'delivered', reason: 'resent_after_unknown' };
      },
    });
    const M5FalseEvidence = attemptEvidence(readAttempts(M5FalseFile));
    mutations.push(actualRowRed(delivery, 'false-exactly-once', 'J5', {
      workerSends: M5FalseEvidence.count,
      duplicateAccounted: M5FalseEvidence.duplicateAccounted,
      exactlyOnceClaimed: M5FalseEvidence.exactlyOnceClaimed,
      attemptId: M5FalseEvidence.attemptId,
      expectedAttemptId: workerKey(M5FalseRun),
      attemptHead: M5FalseEvidence.attemptHead,
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
    const M6File = path.join(root, 'm6-attempts.jsonl');
    writeFileSync(M6File, '', 'utf8');
    crashDeliveryAttempt({ root, name: 'm6-crash', storeRoot: M6Store, run: M6Run, attemptFile: M6File, channel: 'worker', semantics: 'at-least-once' });
    const M6Persisted = getPackReviewRun(M6Run.id, { projectId, storeRoot: M6Store });
    mutations.push(actualRowRed(delivery, 'recoverable-orphan-left', 'J6', {
      githubAttempts: 0,
      statusAttempts: 0,
      workerAttempts: readAttempts(M6File).length,
      status: M6Persisted?.status,
    }));

    validateMutationArray('AC4', mutations);
    return { delivery, mutations };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
