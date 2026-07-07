import type { ReviewsBoardDocument } from './review-types.js';

const BOARD_JSON_PATH = '/api/reviews';

export async function fetchBoardDocument(projectId?: string | null): Promise<ReviewsBoardDocument> {
  const params = new URLSearchParams();
  if (projectId && projectId !== 'all') {
    params.set('projectId', projectId);
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : '';
  const response = await fetch(`${BOARD_JSON_PATH}${suffix}`, {
    headers: { accept: 'application/json' },
    cache: 'no-store',
  });

  const body = (await response.json()) as ReviewsBoardDocument;
  if (!response.ok && !body.dashboardLoadError) {
    throw new Error(`Board fetch failed (${response.status})`);
  }
  return body;
}
