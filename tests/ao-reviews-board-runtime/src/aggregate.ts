import {
  fanOutReviewBoardRuns,
  mapProjectName,
  toProjectRows,
  toSessionRows,
  type ReviewBoardRun,
  type SessionRow,
} from '../../../scripts/lib/review-producer-contract.js';
import { DAEMON_API_PATHS, type DaemonClient } from './daemon-client.js';
import {
  classifyDashboardLoadError,
  toSidebarSession,
  type AggregateReviewsBoardOptions,
  type ReviewsBoardDocument,
  type SidebarSession,
} from './types.js';

function isAllProjects(projectId: string | null | undefined): boolean {
  const value = String(projectId ?? '').trim();
  return !value || value.toLowerCase() === 'all';
}

function filterSessionsByProject(
  sessions: SessionRow[],
  projectId: string | null | undefined,
): SessionRow[] {
  if (isAllProjects(projectId)) return sessions;
  const wanted = String(projectId).trim();
  return sessions.filter((session) => String(session.projectId ?? '').trim() === wanted);
}

function filterRunsByProject(runs: ReviewBoardRun[], projectId: string | null | undefined): ReviewBoardRun[] {
  if (isAllProjects(projectId)) return runs;
  const wanted = String(projectId).trim();
  return runs.filter((run) => String(run.projectId ?? '').trim() === wanted);
}

function buildSidebar(sessions: SessionRow[]): {
  sidebarSessions: SidebarSession[];
  orchestrators: SidebarSession[];
  workerOptions: SidebarSession[];
} {
  const sidebarSessions = sessions
    .map((session) => toSidebarSession(session))
    .filter((row): row is SidebarSession => row != null);
  const orchestrators = sidebarSessions.filter((row) => row.kind === 'orchestrator');
  const workerOptions = sidebarSessions.filter((row) => row.kind === 'worker');
  return { sidebarSessions, orchestrators, workerOptions };
}

export async function aggregateReviewsBoard(
  client: DaemonClient,
  options: AggregateReviewsBoardOptions = {},
): Promise<ReviewsBoardDocument> {
  const empty: ReviewsBoardDocument = {
    runs: [],
    sidebarSessions: [],
    orchestrators: [],
    workerOptions: [],
    projects: [],
    projectName: null,
    dashboardLoadError: null,
  };

  let sessionsPayload: unknown;
  let projectsPayload: unknown;

  try {
    sessionsPayload = await client.fetchJson(DAEMON_API_PATHS.sessions);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...empty,
      dashboardLoadError: classifyDashboardLoadError('sessions-fetch-failed', message),
    };
  }

  try {
    projectsPayload = await client.fetchJson(DAEMON_API_PATHS.projects);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...empty,
      dashboardLoadError: classifyDashboardLoadError('projects-fetch-failed', message),
    };
  }

  const allSessions = toSessionRows(sessionsPayload);
  const projects = toProjectRows(projectsPayload);
  const scopedSessions = filterSessionsByProject(allSessions, options.projectId);
  const reviewsBySessionId: Record<string, unknown> = {};

  for (const session of scopedSessions) {
    const sessionId = String(session.id ?? '').trim();
    if (!sessionId) continue;
    try {
      reviewsBySessionId[sessionId] = await client.fetchJson(
        DAEMON_API_PATHS.sessionReviews(sessionId),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ...empty,
        sidebarSessions: buildSidebar(scopedSessions).sidebarSessions,
        orchestrators: buildSidebar(scopedSessions).orchestrators,
        workerOptions: buildSidebar(scopedSessions).workerOptions,
        projects,
        projectName: isAllProjects(options.projectId)
          ? null
          : mapProjectName(options.projectId, projects),
        dashboardLoadError: classifyDashboardLoadError(
          'session-reviews-fetch-failed',
          `${sessionId}:${message}`,
        ),
      };
    }
  }

  const runs = filterRunsByProject(
    fanOutReviewBoardRuns({
      sessionsPayload: { sessions: scopedSessions },
      projectsPayload: { projects },
      reviewsBySessionId,
    }),
    options.projectId,
  );

  const sidebar = buildSidebar(scopedSessions);
  const projectName = isAllProjects(options.projectId)
    ? null
    : mapProjectName(options.projectId, projects);

  return {
    runs,
    sidebarSessions: sidebar.sidebarSessions,
    orchestrators: sidebar.orchestrators,
    workerOptions: sidebar.workerOptions,
    projects,
    projectName,
    dashboardLoadError: null,
  };
}
