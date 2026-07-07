import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReviewBoardView } from './ao-reviews-board-runtime/ui/src/ReviewDashboard.js';
import {
  groupRunsByColumn,
  REVIEW_BOARD_COLUMNS,
  REVIEW_COLUMN_LABELS,
  type ReviewsBoardDocument,
} from './ao-reviews-board-runtime/ui/src/review-types.js';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const uiRoot = path.join(repoRoot, 'tests/ao-reviews-board-runtime/ui');
const fixturePath = path.join(repoRoot, 'tests/fixtures/reviews-board-seven-columns.json');

function listUiSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      files.push(...listUiSourceFiles(fullPath));
      continue;
    }
    if (/\.(ts|tsx|js|jsx|css|html)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

describe('AO Reviews board UI fork (Issue #628)', () => {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as ReviewsBoardDocument;

  it('renders seven column headers and one card per column from fixture board JSON', () => {
    const grouped = groupRunsByColumn(fixture.runs);
    for (const column of REVIEW_BOARD_COLUMNS) {
      expect(grouped[column]).toHaveLength(1);
    }

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
      expect(html).toContain(REVIEW_COLUMN_LABELS[column]);
      expect(html).toContain(`data-review-column="${column}"`);
    }

    for (const run of fixture.runs) {
      expect(html).toContain(run.sessionId);
    }
  });

  it('groups runs by producer-mapped status, not upstream 0.9 enums', () => {
    const grouped = groupRunsByColumn(fixture.runs);
    expect(Object.keys(grouped).sort()).toEqual([...REVIEW_BOARD_COLUMNS].sort());
    expect(grouped.reviewing[0]?.prReviewStatus).toBe('running');
    expect(grouped.triage[0]?.deliveredAt).toBeTruthy();
  });

  it('forbidden data-source guard: UI sources avoid removed 0.9 data paths', () => {
    const forbidden = [
      /@aoagents\/ao-core/,
      /createCodeReviewStore/,
      /getReviewPageData/,
      /server-only/,
      /window\.ao/,
      /ao\.db/i,
      /~\/\.agent-orchestrator/,
      /packages\/web\/src\/app\/api\/reviews/,
      /getReviewBoardColumn/,
    ];
    const sources = listUiSourceFiles(uiRoot);
    expect(sources.length).toBeGreaterThan(0);
    for (const file of sources) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of forbidden) {
        expect(text, `${path.relative(repoRoot, file)} must not match ${pattern}`).not.toMatch(
          pattern,
        );
      }
    }
  });

  it('documents Apache-2.0 / upstream attribution under ui tree', () => {
    const notice = readFileSync(path.join(uiRoot, 'NOTICE'), 'utf8');
    expect(notice).toMatch(/ComposioHQ\/agent-orchestrator/);
    expect(notice).toMatch(/v0\.9\.2/);
  });
});
