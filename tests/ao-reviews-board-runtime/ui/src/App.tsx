import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchBoardDocument } from './board-client.js';
import { ReviewDashboard } from './ReviewDashboard.js';
import type { ReviewsBoardDocument } from './review-types.js';

const POLL_INTERVAL_MS = 5_000;

function readProjectIdFromLocation(): string | null {
  const params = new URLSearchParams(window.location.search);
  const projectId = params.get('projectId');
  return projectId && projectId !== 'all' ? projectId : null;
}

function writeProjectIdToLocation(projectId: string | null): void {
  const url = new URL(window.location.href);
  if (projectId) {
    url.searchParams.set('projectId', projectId);
  } else {
    url.searchParams.delete('projectId');
  }
  window.history.replaceState({}, '', url);
}

const EMPTY_BOARD: ReviewsBoardDocument = {
  runs: [],
  sidebarSessions: [],
  orchestrators: [],
  workerOptions: [],
  projects: [],
  projectName: null,
  dashboardLoadError: null,
};

export function App() {
  const [projectId, setProjectId] = useState<string | null>(() => readProjectIdFromLocation());
  const [board, setBoard] = useState<ReviewsBoardDocument>(EMPTY_BOARD);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const loadBoard = useCallback(async () => {
    try {
      const document = await fetchBoardDocument(projectId);
      setBoard(document);
      setFetchError(document.dashboardLoadError);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load board data';
      setFetchError(message);
      setBoard(EMPTY_BOARD);
    }
  }, [projectId]);

  useEffect(() => {
    void loadBoard();
    const timer = window.setInterval(() => void loadBoard(), POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [loadBoard]);

  const handleProjectChange = (nextProjectId: string | null) => {
    setProjectId(nextProjectId);
    writeProjectIdToLocation(nextProjectId);
  };

  const projectName = useMemo(() => {
    if (!projectId) return board.projectName ?? 'All projects';
    const match = board.projects.find((project) => project.id === projectId);
    return match?.name ?? projectId;
  }, [board.projectName, board.projects, projectId]);

  return (
    <ReviewDashboard
      runs={board.runs}
      sidebarSessions={board.sidebarSessions}
      projects={board.projects}
      projectId={projectId}
      projectName={projectName}
      dashboardLoadError={fetchError}
      onProjectChange={handleProjectChange}
    />
  );
}
