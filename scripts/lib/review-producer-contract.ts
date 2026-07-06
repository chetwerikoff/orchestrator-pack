/**
 * AO 0.10 review pipeline producer data contract (Issue #626).
 * Maps daemon HTTP fan-out (/sessions, /projects, per-session /reviews) to #214 board fields.
 */

export const REVIEW_PRODUCER_API_PATHS = [
  '/api/v1/sessions',
  '/api/v1/projects',
  '/api/v1/sessions/{sessionId}/reviews',
] as const;

/** 0.9 pseudo-fields that must never be emitted on producer rows. */
export const FORBIDDEN_FALSE_EQUIVALENCE_FIELDS = [
  'needs_triage',
  'sentFindingCount',
  'terminationReason',
] as const;

export const BOARD_STATUSES = [
  'queued',
  'reviewing',
  'triage',
  'waiting',
  'clean',
  'failed',
  'outdated',
] as const;

export type BoardStatus = (typeof BOARD_STATUSES)[number];

export type PrReviewStatus =
  | 'needs_review'
  | 'running'
  | 'up_to_date'
  | 'changes_requested'
  | 'ineligible';

export interface ReviewRunState {
  id?: string | null;
  batchId?: string | null;
  verdict?: string | null;
  body?: string | null;
  githubReviewId?: number | string | null;
  deliveredAt?: string | null;
  status?: string | null;
  targetSha?: string | null;
}

export interface PrReviewState {
  prUrl?: string | null;
  targetSha?: string | null;
  headSha?: string | null;
  status?: PrReviewStatus | string | null;
  latestRun?: ReviewRunState | null;
}

export interface SessionReviewsPayload {
  reviewerHandleId?: string | null;
  reviews?: PrReviewState[] | null;
}

export interface SessionRow {
  id?: string | null;
  projectId?: string | null;
  branch?: string | null;
  status?: string | null;
  activity?: unknown;
  prs?: string[] | null;
  terminalHandleId?: string | null;
  isTerminated?: boolean | null;
}

export interface ProjectRow {
  id?: string | null;
  name?: string | null;
}

export interface WorkerContext {
  projectName: string | null;
  workerBranch: string | null;
  workerPrUrl: string | null;
  workerStatus: string | null;
  workerActivity: unknown;
  workerHasRuntime: boolean;
}

export interface ReviewBoardRun {
  id: string | null;
  sessionId: string;
  projectId: string | null;
  prUrl: string | null;
  targetSha: string | null;
  prReviewStatus: string | null;
  latestRunStatus: string | null;
  verdict: string | null;
  body: string | null;
  githubReviewId: number | string | null;
  deliveredAt: string | null;
  batchId: string | null;
  projectName: string | null;
  workerBranch: string | null;
  workerPrUrl: string | null;
  workerStatus: string | null;
  workerActivity: unknown;
  workerHasRuntime: boolean;
  status: BoardStatus;
}

export interface EngineBoardMappingInput {
  prReviewStatus?: string | null;
  latestRun?: ReviewRunState | null;
  headSha?: string | null;
  targetSha?: string | null;
}

function normalizeSha(value: unknown): string {
  const sha = String(value ?? '').trim().toLowerCase();
  if (!sha) return '';
  return sha.length > 12 ? sha.slice(0, 12) : sha;
}

function hasDeliveredAt(latestRun: ReviewRunState | null | undefined): boolean {
  const deliveredAt = latestRun?.deliveredAt;
  return deliveredAt != null && String(deliveredAt).trim() !== '';
}

function headMovedVsRun(
  headSha: string | null | undefined,
  latestRun: ReviewRunState | null | undefined,
  targetSha: string | null | undefined,
): boolean {
  const head = normalizeSha(headSha);
  const runTarget = normalizeSha(latestRun?.targetSha ?? targetSha);
  return Boolean(head && runTarget && head !== runTarget);
}

/**
 * Producer-owned 0.10 engine → v0.9.2 board column mapping (#626 / #214).
 * Precedence: failed → outdated → reviewing → triage/waiting → queued → clean.
 */
export function mapEngineToBoardStatus(input: EngineBoardMappingInput): BoardStatus {
  const prReviewStatus = String(input.prReviewStatus ?? '').toLowerCase();
  const latestRun = input.latestRun ?? null;
  const latestRunStatus = String(latestRun?.status ?? '').toLowerCase();
  const verdict = String(latestRun?.verdict ?? '').toLowerCase();

  if (latestRunStatus === 'failed') {
    return 'failed';
  }

  if (prReviewStatus === 'ineligible' || headMovedVsRun(input.headSha, latestRun, input.targetSha)) {
    return 'outdated';
  }

  if (prReviewStatus === 'running') {
    return 'reviewing';
  }

  if (prReviewStatus === 'changes_requested') {
    return hasDeliveredAt(latestRun) ? 'triage' : 'waiting';
  }

  if (prReviewStatus === 'needs_review' && !latestRun) {
    return 'queued';
  }

  if (prReviewStatus === 'up_to_date' || verdict === 'approved') {
    return 'clean';
  }

  return 'queued';
}

export function deriveWorkerPrUrl(prs: unknown): string | null {
  if (!Array.isArray(prs)) return null;
  const urls = prs.map((entry) => String(entry ?? '').trim()).filter(Boolean);
  return urls.length === 1 ? urls[0] : null;
}

export function mapSessionRowWorkerContext(
  session: SessionRow,
  projectName: string | null = null,
): WorkerContext {
  const terminalHandleId = String(session.terminalHandleId ?? '').trim();
  return {
    projectName,
    workerBranch: session.branch != null ? String(session.branch) : null,
    workerPrUrl: deriveWorkerPrUrl(session.prs),
    workerStatus: session.status != null ? String(session.status) : null,
    workerActivity: session.activity ?? null,
    workerHasRuntime: terminalHandleId !== '',
  };
}

export function mapProjectName(
  projectId: string | null | undefined,
  projects: ProjectRow[] | null | undefined,
): string | null {
  const id = String(projectId ?? '').trim();
  if (!id || !Array.isArray(projects)) return null;
  const match = projects.find((row) => String(row?.id ?? '').trim() === id);
  return match?.name != null ? String(match.name) : null;
}

export function toSessionRows(payload: unknown): SessionRow[] {
  if (Array.isArray(payload)) return payload as SessionRow[];
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    if (Array.isArray(record.sessions)) return record.sessions as SessionRow[];
    if (Array.isArray(record.data)) return record.data as SessionRow[];
  }
  return [];
}

export function toProjectRows(payload: unknown): ProjectRow[] {
  if (Array.isArray(payload)) return payload as ProjectRow[];
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    if (Array.isArray(record.projects)) return record.projects as ProjectRow[];
    if (Array.isArray(record.data)) return record.data as ProjectRow[];
  }
  return [];
}

export function mapPrReviewToBoardRun(input: {
  session: SessionRow;
  review: PrReviewState;
  projectName?: string | null;
}): ReviewBoardRun {
  const sessionId = String(input.session.id ?? '').trim();
  const latestRun = input.review.latestRun ?? null;
  const worker = mapSessionRowWorkerContext(input.session, input.projectName ?? null);
  const prUrl = input.review.prUrl != null ? String(input.review.prUrl) : null;
  const targetSha =
    input.review.targetSha != null
      ? String(input.review.targetSha)
      : latestRun?.targetSha != null
        ? String(latestRun.targetSha)
        : input.review.headSha != null
          ? String(input.review.headSha)
          : null;

  return {
    id: latestRun?.id != null ? String(latestRun.id) : null,
    sessionId,
    projectId: input.session.projectId != null ? String(input.session.projectId) : null,
    prUrl,
    targetSha,
    prReviewStatus: input.review.status != null ? String(input.review.status) : null,
    latestRunStatus: latestRun?.status != null ? String(latestRun.status) : null,
    verdict: latestRun?.verdict != null ? String(latestRun.verdict) : null,
    body: latestRun?.body != null ? String(latestRun.body) : null,
    githubReviewId: latestRun?.githubReviewId ?? null,
    deliveredAt: latestRun?.deliveredAt != null ? String(latestRun.deliveredAt) : null,
    batchId: latestRun?.batchId != null ? String(latestRun.batchId) : null,
    projectName: worker.projectName,
    workerBranch: worker.workerBranch,
    workerPrUrl: worker.workerPrUrl,
    workerStatus: worker.workerStatus,
    workerActivity: worker.workerActivity,
    workerHasRuntime: worker.workerHasRuntime,
    status: mapEngineToBoardStatus({
      prReviewStatus: input.review.status,
      latestRun,
      headSha: input.review.headSha ?? input.review.targetSha,
      targetSha,
    }),
  };
}

export function fanOutReviewBoardRuns(input: {
  sessionsPayload: unknown;
  projectsPayload?: unknown;
  reviewsBySessionId: Record<string, SessionReviewsPayload | unknown>;
}): ReviewBoardRun[] {
  const sessions = toSessionRows(input.sessionsPayload);
  const projects = toProjectRows(input.projectsPayload);
  /** @type {ReviewBoardRun[]} */
  const runs: ReviewBoardRun[] = [];

  for (const session of sessions) {
    const sessionId = String(session.id ?? '').trim();
    if (!sessionId) continue;
    const projectName = mapProjectName(session.projectId, projects);
    const reviewsPayload = input.reviewsBySessionId[sessionId];
    const reviews = Array.isArray((reviewsPayload as SessionReviewsPayload)?.reviews)
      ? ((reviewsPayload as SessionReviewsPayload).reviews as PrReviewState[])
      : [];

    for (const review of reviews) {
      runs.push(
        mapPrReviewToBoardRun({
          session,
          review,
          projectName,
        }),
      );
    }
  }

  return runs;
}

export const REVIEW_BOARD_RUN_FIELD_NAMES = [
  'id',
  'sessionId',
  'projectId',
  'prUrl',
  'targetSha',
  'prReviewStatus',
  'latestRunStatus',
  'verdict',
  'body',
  'githubReviewId',
  'deliveredAt',
  'batchId',
  'projectName',
  'workerBranch',
  'workerPrUrl',
  'workerStatus',
  'workerActivity',
  'workerHasRuntime',
  'status',
] as const;
