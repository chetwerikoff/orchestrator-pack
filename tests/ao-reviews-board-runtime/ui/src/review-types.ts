/**
 * Derived from ComposioHQ/agent-orchestrator v0.9.2 packages/web/src/lib/review-types.ts
 * Column labels and board column order preserved; data shapes adapted for #627 read contract.
 */

export type ReviewBoardColumn =
  | 'queued'
  | 'reviewing'
  | 'triage'
  | 'waiting'
  | 'clean'
  | 'failed'
  | 'outdated';

/** Row from GET /api/reviews — matches scripts/lib/review-producer-contract ReviewBoardRun. */
export interface BoardReviewRun {
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
  status: ReviewBoardColumn;
}

export interface SidebarSession {
  id: string;
  projectId: string | null;
  kind: string | null;
  branch: string | null;
  status: string | null;
  isTerminated: boolean;
  harness: string | null;
  terminalHandleId: string | null;
}

export interface ProjectOption {
  id: string;
  name?: string | null;
}

export interface ReviewsBoardDocument {
  runs: BoardReviewRun[];
  sidebarSessions: SidebarSession[];
  orchestrators: SidebarSession[];
  workerOptions: SidebarSession[];
  projects: ProjectOption[];
  projectName: string | null;
  dashboardLoadError: string | null;
}

export const REVIEW_BOARD_COLUMNS: ReviewBoardColumn[] = [
  'queued',
  'reviewing',
  'triage',
  'waiting',
  'clean',
  'failed',
  'outdated',
];

export const REVIEW_COLUMN_LABELS: Record<ReviewBoardColumn, string> = {
  queued: 'Queued',
  reviewing: 'Reviewing',
  triage: 'Triage',
  waiting: 'Waiting',
  clean: 'Clean',
  failed: 'Failed',
  outdated: 'Outdated',
};

export const COLUMN_HINTS: Record<ReviewBoardColumn, string> = {
  queued: 'Review work requested but not executing yet.',
  reviewing: 'A reviewer is reading a snapshot.',
  triage: 'Findings need a human decision.',
  waiting: 'Feedback is with the coding worker.',
  clean: 'No open AO findings remain.',
  failed: 'Reviewer runs that need retry or inspection.',
  outdated: 'Runs superseded by newer worker commits.',
};

/** Assign runs to columns using producer-mapped `status` (#626), not 0.9 run enums. */
export function groupRunsByColumn(
  runs: BoardReviewRun[],
): Record<ReviewBoardColumn, BoardReviewRun[]> {
  const columns = Object.fromEntries(
    REVIEW_BOARD_COLUMNS.map((column) => [column, [] as BoardReviewRun[]]),
  ) as Record<ReviewBoardColumn, BoardReviewRun[]>;

  for (const run of runs) {
    const column = REVIEW_BOARD_COLUMNS.includes(run.status) ? run.status : 'queued';
    columns[column].push(run);
  }
  return columns;
}

export function parsePrNumber(prUrl: string | null): number | null {
  if (!prUrl) return null;
  const match = /\/pull\/(\d+)/.exec(prUrl);
  return match ? Number(match[1]) : null;
}

export function formatStatus(value: string | null | undefined): string {
  return String(value ?? 'unknown').replaceAll('_', ' ');
}

export function formatRelativeTime(value: string | null | undefined): string {
  if (!value) return 'unknown';
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return value;
  const diffMs = Date.now() - timestamp;
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
}

export function runCardKey(run: BoardReviewRun): string {
  return run.id ?? `${run.sessionId}:${run.prUrl ?? 'no-pr'}`;
}

export function workerAvailabilityLabel(run: BoardReviewRun): string {
  if (!run.workerHasRuntime) return 'no runtime';
  if (run.workerStatus === 'exited') return 'exited';
  return run.workerStatus ?? 'worker';
}
