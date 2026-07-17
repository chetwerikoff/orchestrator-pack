import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { runProcess, type ProcessResult } from '../kernel/subprocess.js';
import {
  getPackReviewRun,
  listPackReviewRuns,
  setPackReviewRunTerminal,
  updatePackReviewRun,
  type GithubCommentReviewReconciliation,
  type PackReviewRunRecord,
  type PackReviewStoreOptions,
} from './pack-review-run-store.js';

export type GithubReviewEvent = 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES';
export type GithubReviewPostOutcome = 'not_attempted' | 'definitely_rejected' | 'ambiguous' | 'accepted';

type DurableGithubCommentReviewReconciliation = GithubCommentReviewReconciliation & {
  postOutcome?: GithubReviewPostOutcome;
  postAttemptedAtUtc?: string;
};

export interface GithubReviewSummary {
  id: number | string;
  state: string;
  userLogin: string;
  submittedAt: string;
  body: string;
  commitId: string;
  url: string;
}

export interface GithubReviewCaptureAction {
  kind: 'dismiss' | 'post';
  reviewId?: number | string;
  event: 'DISMISS' | GithubReviewEvent;
  body?: string;
}

export class GithubReviewPostError extends Error {
  readonly outcome: Extract<GithubReviewPostOutcome, 'definitely_rejected' | 'ambiguous'>;

  constructor(
    outcome: Extract<GithubReviewPostOutcome, 'definitely_rejected' | 'ambiguous'>,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'GithubReviewPostError';
    this.outcome = outcome;
  }
}

export interface GithubReviewTransport {
  readonly actions?: GithubReviewCaptureAction[];
  resolveActorLogin(): Promise<string>;
  listReviews(): Promise<GithubReviewSummary[]>;
  postReview(input: {
    event: GithubReviewEvent;
    body: string;
    commitId: string;
  }): Promise<{ id: number | string; url: string }>;
  dismissReview(reviewId: number | string): Promise<void>;
}

interface CreateGithubReviewTransportOptions {
  repoRoot: string;
  repoSlug: string;
  prNumber: number;
  fixtureReviewId?: number;
  fixtureTransport?: GithubReviewTransport;
}

interface CommentReconciliationOptions extends PackReviewStoreOptions {
  run: PackReviewRunRecord;
  body: string;
  transport: GithubReviewTransport;
}

function trim(value: unknown): string {
  return String(value ?? '').trim();
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function processFailureMessage(result: ProcessResult, label: string): string {
  const detail = trim(result.stderr || result.error || result.stdout);
  return `${label} failed${detail ? `: ${detail}` : ''}`;
}

export async function requireProcess(result: ProcessResult, label: string): Promise<string> {
  if (!result.ok) throw new Error(processFailureMessage(result, label));
  return result.stdout.trim();
}

function classifyPostProcessFailure(
  result: ProcessResult,
): Extract<GithubReviewPostOutcome, 'definitely_rejected' | 'ambiguous'> {
  if (result.outcome === 'spawn-failure') return 'definitely_rejected';
  const detail = trim(result.stderr || result.error || result.stdout);
  const status = Number(detail.match(/\bHTTP\s+(\d{3})\b/i)?.[1] ?? NaN);
  if (result.outcome === 'exit'
    && Number.isInteger(status)
    && status >= 400
    && status < 500
    && status !== 408
    && status !== 429) {
    return 'definitely_rejected';
  }
  return 'ambiguous';
}

function classifyPostError(
  error: unknown,
): Extract<GithubReviewPostOutcome, 'definitely_rejected' | 'ambiguous'> {
  return error instanceof GithubReviewPostError ? error.outcome : 'ambiguous';
}

function numericReviewId(value: number | string): bigint | null {
  const raw = String(value);
  if (!/^\d+$/.test(raw)) return null;
  try {
    return BigInt(raw);
  } catch {
    return null;
  }
}

function reviewIdKey(value: number | string): string {
  const numeric = numericReviewId(value);
  return numeric === null ? `${typeof value}:${String(value)}` : `numeric:${numeric}`;
}

function sameReviewId(left: number | string, right: number | string): boolean {
  return reviewIdKey(left) === reviewIdKey(right);
}

function compareReviewIds(left: number | string, right: number | string): number {
  const leftNumeric = numericReviewId(left);
  const rightNumeric = numericReviewId(right);
  if (leftNumeric !== null && rightNumeric !== null) {
    if (leftNumeric < rightNumeric) return -1;
    if (leftNumeric > rightNumeric) return 1;
    return 0;
  }
  if (leftNumeric !== null) return -1;
  if (rightNumeric !== null) return 1;
  return reviewIdKey(left).localeCompare(reviewIdKey(right));
}

export function compareReviewOrder(left: GithubReviewSummary, right: GithubReviewSummary): number {
  const leftMs = Date.parse(left.submittedAt);
  const rightMs = Date.parse(right.submittedAt);
  if (leftMs !== rightMs) return leftMs - rightMs;
  return compareReviewIds(left.id, right.id);
}

export function normalizeGithubReviewSummaries(value: unknown, label: string): GithubReviewSummary[] {
  if (!Array.isArray(value)) throw new Error(`${label} returned a non-array payload`);
  const rows = value.flatMap((entry) => Array.isArray(entry) ? entry : [entry]);
  return rows.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${label} returned a malformed review at index ${index + 1}`);
    }
    const raw = entry as Record<string, unknown>;
    const id = raw.id;
    if ((typeof id !== 'number' && typeof id !== 'string') || !trim(id)) {
      throw new Error(`${label} returned a review without an id at index ${index + 1}`);
    }
    const user = raw.user;
    const userLogin = user && typeof user === 'object' && !Array.isArray(user)
      ? trim((user as Record<string, unknown>).login)
      : trim(raw.userLogin);
    const state = trim(raw.state).toUpperCase();
    const submittedAt = trim(raw.submitted_at ?? raw.submittedAt);
    if (!userLogin || !state || !submittedAt || !Number.isFinite(Date.parse(submittedAt))) {
      throw new Error(`${label} returned an incomplete review at index ${index + 1}`);
    }
    return {
      id,
      state,
      userLogin,
      submittedAt,
      body: trim(raw.body),
      commitId: trim(raw.commit_id ?? raw.commitId).toLowerCase(),
      url: trim(raw.html_url ?? raw.url),
    };
  });
}

export function selectActiveSameActorBlockingReviewIds(
  reviews: GithubReviewSummary[],
  actorLogin: string,
  strictlyBeforeReview?: GithubReviewSummary,
): Array<number | string> {
  const actor = trim(actorLogin).toLowerCase();
  if (!actor) throw new Error('GitHub review reconciliation requires an actor login');
  const ordered = reviews
    .filter((review) => review.userLogin.toLowerCase() === actor)
    .sort(compareReviewOrder);
  const boundaryIndex = strictlyBeforeReview
    ? ordered.findIndex((review) => sameReviewId(review.id, strictlyBeforeReview.id))
    : ordered.length;
  if (strictlyBeforeReview && boundaryIndex < 0) {
    throw new Error(`confirmed GitHub COMMENT review ${strictlyBeforeReview.id} is absent from actor review order`);
  }
  const eligible = ordered.slice(0, boundaryIndex);
  let lastApprovalIndex = -1;
  eligible.forEach((review, index) => {
    if (review.state === 'APPROVED') lastApprovalIndex = index;
  });
  return eligible
    .filter((review, index) => index > lastApprovalIndex && review.state === 'CHANGES_REQUESTED')
    .map((review) => review.id);
}

function reconciliationMarker(runId: string): string {
  return `Run: \`${runId}\``;
}

function findUniquePostedComment(
  reviews: GithubReviewSummary[],
  actorLogin: string,
  run: PackReviewRunRecord,
): GithubReviewSummary | null {
  const marker = reconciliationMarker(run.id);
  const candidates = reviews
    .filter((review) => review.userLogin.toLowerCase() === actorLogin.toLowerCase()
      && review.state === 'COMMENTED'
      && review.body.includes(marker))
    .sort(compareReviewOrder);
  if (candidates.length > 1) {
    throw new Error(`ambiguous GitHub COMMENT recovery found ${candidates.length} matching reviews for ${run.id}`);
  }
  const candidate = candidates[0];
  if (!candidate) return null;
  if (candidate.commitId !== run.targetSha) {
    const evidence = candidate.commitId || '<missing>';
    throw new Error(
      `GitHub COMMENT recovery for ${run.id} has target commit '${evidence}', expected '${run.targetSha}'`,
    );
  }
  return candidate;
}

function requireConfirmedCommentReview(
  reviews: GithubReviewSummary[],
  state: DurableGithubCommentReviewReconciliation,
  run: PackReviewRunRecord,
): GithubReviewSummary {
  const commentReviewId = state.commentReviewId;
  if (commentReviewId === undefined) {
    throw new Error(`GitHub COMMENT reconciliation has no posted review id for ${run.id}`);
  }
  const matches = reviews.filter((review) => sameReviewId(review.id, commentReviewId));
  if (matches.length !== 1) {
    throw new Error(`GitHub COMMENT review ${commentReviewId} lookup returned ${matches.length} matches`);
  }
  const review = matches[0]!;
  const marker = reconciliationMarker(run.id);
  if (review.userLogin.toLowerCase() !== state.actorLogin.toLowerCase()
    || review.state !== 'COMMENTED'
    || !review.body.includes(marker)
    || review.commitId !== run.targetSha) {
    throw new Error(`GitHub COMMENT review ${commentReviewId} does not match reconciliation ${run.id}`);
  }
  return review;
}

function normalizedState(run: PackReviewRunRecord): DurableGithubCommentReviewReconciliation | null {
  const raw = run.githubReviewReconciliation as DurableGithubCommentReviewReconciliation | undefined;
  if (!raw) return null;
  if (raw.schemaVersion !== 1 || raw.event !== 'COMMENT') {
    throw new Error(`corrupt GitHub review reconciliation state for ${run.id}`);
  }
  if (!trim(raw.actorLogin) || !trim(raw.commentBody)) {
    throw new Error(`incomplete GitHub review reconciliation state for ${run.id}`);
  }
  const postOutcome = raw.postOutcome
    ?? (raw.phase === 'prepared' ? 'ambiguous' : 'accepted');
  if (!['not_attempted', 'definitely_rejected', 'ambiguous', 'accepted'].includes(postOutcome)) {
    throw new Error(`corrupt GitHub COMMENT POST outcome for ${run.id}`);
  }
  if ((raw.phase !== 'prepared' && postOutcome !== 'accepted')
    || (raw.phase === 'prepared' && postOutcome === 'accepted')) {
    throw new Error(`inconsistent GitHub COMMENT POST outcome for ${run.id}`);
  }
  return {
    ...raw,
    postOutcome,
    pendingDismissalReviewIds: [...(raw.pendingDismissalReviewIds ?? [])],
    dismissedReviewIds: [...(raw.dismissedReviewIds ?? [])],
  };
}

function persistState(
  runId: string,
  state: DurableGithubCommentReviewReconciliation,
  options: PackReviewStoreOptions,
): DurableGithubCommentReviewReconciliation {
  const next: DurableGithubCommentReviewReconciliation = {
    ...state,
    updatedAtUtc: new Date().toISOString(),
  };
  updatePackReviewRun(runId, { githubReviewReconciliation: next }, options);
  return next;
}

function uniqueIds(values: Array<number | string>): Array<number | string> {
  const seen = new Set<string>();
  const result: Array<number | string> = [];
  for (const value of values) {
    const key = reviewIdKey(value);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

async function listReviewsForRecovery(
  options: CommentReconciliationOptions,
  current: PackReviewRunRecord,
  state: DurableGithubCommentReviewReconciliation,
  storeOptions: PackReviewStoreOptions,
  prefix: string,
): Promise<{ reviews: GithubReviewSummary[]; state: DurableGithubCommentReviewReconciliation }> {
  try {
    return { reviews: await options.transport.listReviews(), state };
  } catch (error) {
    const next = persistState(current.id, {
      ...state,
      lastError: `${prefix}: ${describeError(error)}`,
    }, storeOptions);
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { reconciliation: next });
  }
}

export async function reconcileGithubCommentReview(
  options: CommentReconciliationOptions,
): Promise<{
  id: number | string;
  url: string;
  dismissedReviewIds: Array<number | string>;
  reconciliation: GithubCommentReviewReconciliation;
}> {
  const storeOptions = { projectId: options.projectId, storeRoot: options.storeRoot };
  const current = getPackReviewRun(options.run.id, storeOptions) ?? options.run;
  let state = normalizedState(current);
  if (!state) {
    const actorLogin = trim(await options.transport.resolveActorLogin());
    if (!actorLogin) throw new Error('GitHub authenticated actor lookup returned no login');
    const now = new Date().toISOString();
    state = persistState(current.id, {
      schemaVersion: 1,
      event: 'COMMENT',
      phase: 'prepared',
      actorLogin,
      commentBody: options.body,
      postOutcome: 'not_attempted',
      pendingDismissalReviewIds: [],
      dismissedReviewIds: [],
      preparedAtUtc: now,
      updatedAtUtc: now,
    }, storeOptions);
  } else if (state.commentBody !== options.body) {
    throw new Error(`GitHub review reconciliation body changed for ${current.id}`);
  }

  if (state.phase === 'prepared') {
    let posted: { id: number | string; url: string } | null = null;

    if (state.postOutcome === 'ambiguous') {
      const listed = await listReviewsForRecovery(
        options,
        current,
        state,
        storeOptions,
        'ambiguous POST recovery lookup failed',
      );
      state = listed.state;
      const observed = findUniquePostedComment(listed.reviews, state.actorLogin, current);
      if (!observed) {
        const message = `GitHub COMMENT POST outcome remains ambiguous for ${current.id}; accepted review is not yet observable`;
        state = persistState(current.id, { ...state, lastError: message }, storeOptions);
        throw new Error(message);
      }
      posted = { id: observed.id, url: observed.url };
    } else {
      const attemptedAtUtc = new Date().toISOString();
      state = persistState(current.id, {
        ...state,
        postOutcome: 'ambiguous',
        postAttemptedAtUtc: attemptedAtUtc,
        lastError: undefined,
      }, storeOptions);
      try {
        posted = await options.transport.postReview({
          event: 'COMMENT',
          body: state.commentBody,
          commitId: current.targetSha,
        });
      } catch (postError) {
        const postOutcome = classifyPostError(postError);
        state = persistState(current.id, {
          ...state,
          postOutcome,
          lastError: describeError(postError),
        }, storeOptions);
        if (postOutcome === 'definitely_rejected') throw postError;

        let reviews: GithubReviewSummary[];
        try {
          reviews = await options.transport.listReviews();
        } catch (listError) {
          state = persistState(current.id, {
            ...state,
            lastError: `${describeError(postError)}; recovery lookup failed: ${describeError(listError)}`,
          }, storeOptions);
          throw postError;
        }

        let observed: GithubReviewSummary | null;
        try {
          observed = findUniquePostedComment(reviews, state.actorLogin, current);
        } catch (observationError) {
          state = persistState(current.id, {
            ...state,
            lastError: `${describeError(postError)}; ${describeError(observationError)}`,
          }, storeOptions);
          throw observationError;
        }
        if (!observed) throw postError;
        posted = { id: observed.id, url: observed.url };
      }
    }

    state = persistState(current.id, {
      ...state,
      phase: 'comment_posted',
      postOutcome: 'accepted',
      commentReviewId: posted.id,
      commentReviewUrl: posted.url,
      lastError: undefined,
    }, storeOptions);
  }

  const commentReviewId = state.commentReviewId;
  if (commentReviewId === undefined) {
    throw new Error(`GitHub COMMENT reconciliation has no posted review id for ${current.id}`);
  }

  if (state.phase === 'comment_posted' || state.phase === 'dismissals_pending') {
    const reviews = await options.transport.listReviews();
    const confirmedComment = requireConfirmedCommentReview(reviews, state, current);
    const active = selectActiveSameActorBlockingReviewIds(
      reviews,
      state.actorLogin,
      confirmedComment,
    );
    const alreadyDismissed = new Set(state.dismissedReviewIds.map(reviewIdKey));
    const pending = active.filter((id) => !alreadyDismissed.has(reviewIdKey(id)));
    state = persistState(current.id, {
      ...state,
      phase: 'dismissals_pending',
      pendingDismissalReviewIds: pending,
      lastError: undefined,
    }, storeOptions);

    for (const reviewId of [...state.pendingDismissalReviewIds]) {
      try {
        await options.transport.dismissReview(reviewId);
      } catch (error) {
        state = persistState(current.id, {
          ...state,
          lastError: describeError(error),
        }, storeOptions);
        throw error;
      }
      const dismissedReviewIds = uniqueIds([...state.dismissedReviewIds, reviewId]);
      const pendingDismissalReviewIds = state.pendingDismissalReviewIds
        .filter((value) => reviewIdKey(value) !== reviewIdKey(reviewId));
      state = persistState(current.id, {
        ...state,
        dismissedReviewIds,
        pendingDismissalReviewIds,
        lastError: undefined,
      }, storeOptions);
    }

    state = persistState(current.id, {
      ...state,
      phase: 'complete',
      pendingDismissalReviewIds: [],
      lastError: undefined,
    }, storeOptions);
  }

  return {
    id: commentReviewId,
    url: trim(state.commentReviewUrl),
    dismissedReviewIds: [...state.dismissedReviewIds],
    reconciliation: state,
  };
}

export async function recoverIncompleteGithubCommentReviewForHead(options: {
  projectId: string;
  storeRoot: string;
  prNumber: number;
  headSha: string;
  transport: GithubReviewTransport;
}): Promise<PackReviewRunRecord | null> {
  const candidates = listPackReviewRuns({ projectId: options.projectId, storeRoot: options.storeRoot })
    .filter((run) => run.prNumber === options.prNumber
      && run.targetSha === options.headSha
      && run.githubReviewReconciliation
      && (run.githubReviewReconciliation.phase !== 'complete' || run.githubReviewId === undefined));
  if (candidates.length > 1) {
    throw new Error(`ambiguous incomplete GitHub COMMENT reconciliations for PR #${options.prNumber} head ${options.headSha}`);
  }
  const run = candidates[0];
  if (!run) return null;
  const state = normalizedState(run);
  if (!state) return null;
  const result = await reconcileGithubCommentReview({
    run,
    body: state.commentBody,
    transport: options.transport,
    projectId: options.projectId,
    storeRoot: options.storeRoot,
  });
  const findings = run.findings ?? [];
  const hasBlockingFinding = findings.length > 0
    ? findings.some((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return true;
      const severity = trim((value as Record<string, unknown>).severity).toLowerCase();
      return severity !== 'warning' && severity !== 'info' && severity !== 'non-blocking';
    })
    : run.reviewVerdict === 'findings';
  const recoveredStatus = run.status === 'up_to_date' || run.status === 'commented' || run.status === 'changes_requested'
    ? run.status
    : hasBlockingFinding
      ? 'changes_requested'
      : run.reviewVerdict === 'clean' && findings.length === 0
        ? 'up_to_date'
        : 'commented';
  return setPackReviewRunTerminal(run.id, recoveredStatus, {
    exitCode: 0,
    githubReviewId: result.id,
    githubReviewUrl: result.url,
    githubReviewEvent: 'COMMENT',
    githubReviewReconciliation: result.reconciliation,
    deliveryOutcomes: {
      ...(run.deliveryOutcomes ?? {}),
      githubComment: {
        state: 'succeeded',
        recordedAtUtc: new Date().toISOString(),
        reason: 'comment_recovered',
        idempotencyKey: 'github-comment:' + run.id + ':' + run.targetSha,
      },
    },
  }, { projectId: options.projectId, storeRoot: options.storeRoot });
}

function writeCapture(path: string, payload: Record<string, unknown>): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(resolve(path), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

export function writeGithubReviewCapture(options: {
  repoSlug: string;
  prNumber: number;
  commitId: string;
  event: GithubReviewEvent;
  body: string;
  dismissedReviewIds: Array<number | string>;
  transport: GithubReviewTransport;
}): void {
  const capture = trim(process.env.PACK_REVIEW_GITHUB_REVIEW_CAPTURE_FILE);
  if (!capture) return;
  writeCapture(capture, {
    repoSlug: options.repoSlug,
    prNumber: options.prNumber,
    commitId: options.commitId,
    event: options.event,
    body: options.body,
    dismissedReviewIds: options.dismissedReviewIds,
    actions: options.transport.actions ?? [],
  });
}

export function createGithubReviewTransport(options: CreateGithubReviewTransportOptions): GithubReviewTransport {
  if (options.fixtureTransport) {
    if (process.env.OPK_VITEST_HARNESS !== '1') {
      throw new Error('fixture GitHub review transport is test-only');
    }
    return options.fixtureTransport;
  }

  if (process.env.OPK_VITEST_HARNESS === '1') {
    const actorLogin = trim(process.env.PACK_REVIEW_GITHUB_ACTOR_LOGIN) || 'fixture-pack-reviewer';
    const fixture = trim(process.env.PACK_REVIEW_GITHUB_REVIEWS_FIXTURE);
    const reviews = fixture
      ? normalizeGithubReviewSummaries(JSON.parse(fixture), 'GitHub review fixture')
      : [];
    const actions: GithubReviewCaptureAction[] = [];
    const fixtureReviewId = options.fixtureReviewId ?? 1;
    return {
      actions,
      async resolveActorLogin() {
        return actorLogin;
      },
      async listReviews() {
        return reviews.map((review) => ({ ...review }));
      },
      async postReview(input) {
        actions.push({ kind: 'post', event: input.event, body: input.body });
        const submittedAt = new Date(Date.now() + reviews.length).toISOString();
        const review: GithubReviewSummary = {
          id: fixtureReviewId,
          state: input.event === 'COMMENT' ? 'COMMENTED' : input.event === 'APPROVE' ? 'APPROVED' : 'CHANGES_REQUESTED',
          userLogin: actorLogin,
          submittedAt,
          body: input.body,
          commitId: input.commitId.toLowerCase(),
          url: `fixture://pull/${options.prNumber}/review/${fixtureReviewId}`,
        };
        reviews.push(review);
        return { id: review.id, url: review.url };
      },
      async dismissReview(reviewId) {
        const review = reviews.find((entry) => reviewIdKey(entry.id) === reviewIdKey(reviewId));
        if (!review) throw new Error(`fixture GitHub review ${reviewId} not found`);
        review.state = 'DISMISSED';
        actions.push({ kind: 'dismiss', reviewId, event: 'DISMISS' });
      },
    };
  }

  return {
    async resolveActorLogin() {
      const result = await runProcess({
        command: 'gh',
        args: ['api', 'user', '--jq', '.login'],
        cwd: options.repoRoot,
        inheritParentEnv: true,
        allowEmptyStdout: false,
        timeoutMs: 30_000,
      });
      const login = trim(await requireProcess(result, 'GitHub authenticated actor lookup'));
      if (!login) throw new Error('GitHub authenticated actor lookup returned no login');
      return login;
    },
    async listReviews() {
      const result = await runProcess({
        command: 'gh',
        args: ['api', '--paginate', '--slurp', `repos/${options.repoSlug}/pulls/${options.prNumber}/reviews`],
        cwd: options.repoRoot,
        inheritParentEnv: true,
        allowEmptyStdout: false,
        timeoutMs: 60_000,
      });
      const stdout = await requireProcess(result, 'GitHub PR review list');
      try {
        return normalizeGithubReviewSummaries(JSON.parse(stdout), 'GitHub PR review list');
      } catch (error) {
        throw new Error(`GitHub PR review list returned invalid JSON: ${describeError(error)}`);
      }
    },
    async postReview(input) {
      const request = `${JSON.stringify({ commit_id: input.commitId, event: input.event, body: input.body })}\n`;
      const result = await runProcess({
        command: 'gh',
        args: ['api', '--method', 'POST', `repos/${options.repoSlug}/pulls/${options.prNumber}/reviews`, '--input', '-'],
        input: request,
        cwd: options.repoRoot,
        inheritParentEnv: true,
        allowEmptyStdout: false,
        timeoutMs: 60_000,
      });
      if (!result.ok) {
        throw new GithubReviewPostError(
          classifyPostProcessFailure(result),
          processFailureMessage(result, 'GitHub PR review post'),
        );
      }
      const stdout = result.stdout.trim();
      let parsed: { id?: number | string; html_url?: string };
      try {
        parsed = JSON.parse(stdout) as { id?: number | string; html_url?: string };
      } catch (error) {
        throw new GithubReviewPostError(
          'ambiguous',
          `GitHub PR review post returned invalid JSON: ${describeError(error)}`,
          { cause: error },
        );
      }
      if (!parsed.id) {
        throw new GithubReviewPostError('ambiguous', 'GitHub PR review post returned no review id');
      }
      return { id: parsed.id, url: trim(parsed.html_url) };
    },
    async dismissReview(reviewId) {
      const request = `${JSON.stringify({
        message: 'Superseded by a confirmed non-blocking orchestrator-pack review.',
        event: 'DISMISS',
      })}\n`;
      const result = await runProcess({
        command: 'gh',
        args: [
          'api',
          '--method', 'PUT',
          `repos/${options.repoSlug}/pulls/${options.prNumber}/reviews/${reviewId}/dismissals`,
          '--input', '-',
        ],
        input: request,
        cwd: options.repoRoot,
        inheritParentEnv: true,
        allowEmptyStdout: true,
        timeoutMs: 60_000,
      });
      await requireProcess(result, `GitHub PR review ${reviewId} dismissal`);
    },
  };
}
