/**
 * Standalone render harness for ReviewBoardView (Issue #628 AC #2/#3).
 * Executed via `node --import tsx` from ao-reviews-board-ui.test.ts — not part of tsc include.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReviewBoardView } from './src/ReviewDashboard.tsx';
import {
  REVIEW_BOARD_COLUMNS,
  REVIEW_COLUMN_LABELS,
  type ReviewsBoardDocument,
} from './src/review-types.ts';

const uiRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(uiRoot, '../../..');
const fixturePath = path.join(repoRoot, 'tests/fixtures/reviews-board-seven-columns.json');

function main(): void {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as ReviewsBoardDocument;
  const html = renderToStaticMarkup(
    ReviewBoardView({
      runs: fixture.runs,
      sidebarSessions: fixture.sidebarSessions,
      projects: fixture.projects,
      projectId: 'orchestrator-pack',
      projectName: fixture.projectName,
      dashboardLoadError: null,
    }),
  );

  for (const column of REVIEW_BOARD_COLUMNS) {
    if (!html.includes(REVIEW_COLUMN_LABELS[column])) {
      throw new Error(`missing column header label: ${REVIEW_COLUMN_LABELS[column]}`);
    }
    if (!html.includes(`data-review-column="${column}"`)) {
      throw new Error(`missing column marker: ${column}`);
    }
  }

  for (const run of fixture.runs) {
    if (!html.includes(run.sessionId)) {
      throw new Error(`missing card session id: ${run.sessionId}`);
    }
  }

  process.stdout.write('PASS: seven-column-render\n');
}

main();
