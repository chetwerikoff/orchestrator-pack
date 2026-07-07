import type { ProjectRow, ReviewBoardRun, SessionRow } from '../../../scripts/lib/review-producer-contract.js';

/** Board JSON read interface consumed by the UI fork (#215). */
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

export interface ReviewsBoardDocument {
  runs: ReviewBoardRun[];
  sidebarSessions: SidebarSession[];
  orchestrators: SidebarSession[];
  workerOptions: SidebarSession[];
  projects: ProjectRow[];
  projectName: string | null;
  dashboardLoadError: string | null;
}

export interface AggregateReviewsBoardOptions {
  /** `all` or omitted = no project filter. */
  projectId?: string | null;
}

export type DashboardLoadErrorCode =
  | 'daemon-unreachable'
  | 'sessions-fetch-failed'
  | 'projects-fetch-failed'
  | 'session-reviews-fetch-failed';

export function classifyDashboardLoadError(code: DashboardLoadErrorCode, detail?: string): string {
  const base = `dashboard-load:${code}`;
  const trimmed = String(detail ?? '').trim();
  return trimmed ? `${base}:${trimmed}` : base;
}

export function toSidebarSession(session: SessionRow): SidebarSession | null {
  const id = String(session.id ?? '').trim();
  if (!id) return null;
  return {
    id,
    projectId: session.projectId != null ? String(session.projectId) : null,
    kind: (session as { kind?: string | null }).kind != null
      ? String((session as { kind?: string | null }).kind)
      : null,
    branch: session.branch != null ? String(session.branch) : null,
    status: session.status != null ? String(session.status) : null,
    isTerminated: Boolean(session.isTerminated),
    harness:
      (session as { harness?: string | null }).harness != null
        ? String((session as { harness?: string | null }).harness)
        : null,
    terminalHandleId:
      session.terminalHandleId != null ? String(session.terminalHandleId) : null,
  };
}

export const FORBIDDEN_DAEMON_AGGREGATION_PATHS = [
  '/api/v1/reviews',
  '/api/v1/reviews/list',
  '/api/v1/dashboard/reviews',
] as const;
