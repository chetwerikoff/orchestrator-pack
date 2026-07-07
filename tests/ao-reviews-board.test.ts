import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BOARD_STATUSES,
  mapEngineToBoardStatus,
  REVIEW_BOARD_RUN_FIELD_NAMES,
} from '../scripts/lib/review-producer-contract.js';
import { aggregateReviewsBoard } from './ao-reviews-board-runtime/src/aggregate.js';
import {
  createCaptureReplayDaemonClient,
  DAEMON_API_PATHS,
} from './ao-reviews-board-runtime/src/daemon-client.js';
import { createReviewsBoardServer } from './ao-reviews-board-runtime/src/server.js';
import { FORBIDDEN_DAEMON_AGGREGATION_PATHS } from './ao-reviews-board-runtime/src/types.js';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const capturesDir = path.join(
  repoRoot,
  'tests/external-output-references/captures/ao-0-10-daemon',
);
const toolRoot = path.join(repoRoot, 'tests/ao-reviews-board-runtime');

function loadJson(fileName: string) {
  return JSON.parse(readFileSync(path.join(capturesDir, fileName), 'utf8')) as Record<
    string,
    unknown
  >;
}

function listSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(fullPath));
      continue;
    }
    if (/\.(ts|mjs|js)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

describe('AO Reviews board runtime (Issue #627)', () => {
  it('aggregates empty per-session reviews into valid board JSON from daemon captures', async () => {
    const sessionsPayload = loadJson('sessions-list.raw.json');
    const projectsPayload = loadJson('projects-list.raw.json');
    const emptyReviews = loadJson('per-session-reviews-empty.raw.json');
    const client = createCaptureReplayDaemonClient({
      sessions: sessionsPayload,
      projects: projectsPayload,
      reviewsBySessionId: {
        'orchestrator-pack-7': emptyReviews,
        'orchestrator-pack-8': emptyReviews,
      },
    });

    const board = await aggregateReviewsBoard(client);
    expect(board.dashboardLoadError).toBeNull();
    expect(board.runs).toEqual([]);
    expect(board.sidebarSessions.length).toBe(2);
    expect(board.projects.length).toBeGreaterThan(0);
    expect(board.workerOptions.length).toBe(2);
  });

  it('merges populated per-session reviews and derives board columns via #626 mapping', async () => {
    const sessionsPayload = loadJson('sessions-list.raw.json');
    const projectsPayload = loadJson('projects-list.raw.json');
    const populatedReviews = loadJson('per-session-reviews-populated.raw.json');
    const client = createCaptureReplayDaemonClient({
      sessions: sessionsPayload,
      projects: projectsPayload,
      reviewsBySessionId: {
        'orchestrator-pack-7': populatedReviews,
        'orchestrator-pack-8': loadJson('per-session-reviews-empty.raw.json'),
      },
    });

    const board = await aggregateReviewsBoard(client, { projectId: 'orchestrator-pack' });
    expect(board.dashboardLoadError).toBeNull();
    expect(board.runs.length).toBeGreaterThanOrEqual(5);
    const byPr = Object.fromEntries(
      board.runs.map((run) => [run.prUrl, run.status]),
    );
    expect(byPr['https://github.com/chetwerikoff/orchestrator-pack/pull/626']).toBe('reviewing');
    expect(byPr['https://github.com/chetwerikoff/orchestrator-pack/pull/625']).toBe('triage');
    expect(byPr['https://github.com/chetwerikoff/orchestrator-pack/pull/624']).toBe('waiting');
    expect(byPr['https://github.com/chetwerikoff/orchestrator-pack/pull/623']).toBe('clean');
    expect(byPr['https://github.com/chetwerikoff/orchestrator-pack/pull/622']).toBe('queued');
    expect(board.projectName).toBe('orchestrator-pack');
  });

  it('project filter excludes runs from other projects', async () => {
    const sessionsPayload = {
      sessions: [
        ...(loadJson('sessions-list.raw.json').sessions as Array<Record<string, unknown>>),
        {
          id: 'other-project-1',
          projectId: 'other-project',
          kind: 'worker',
          branch: 'foreign',
          status: 'working',
          prs: ['https://github.com/chetwerikoff/orchestrator-pack/pull/999'],
          terminalHandleId: '',
          isTerminated: false,
        },
      ],
    };
    const projectsPayload = {
      projects: [
        ...(loadJson('projects-list.raw.json').projects as Array<Record<string, unknown>>),
        { id: 'other-project', name: 'other-project' },
      ],
    };
    const foreignReview = {
      reviewerHandleId: 'review-foreign',
      reviews: [
        {
          prUrl: 'https://github.com/chetwerikoff/orchestrator-pack/pull/999',
          status: 'running',
          latestRun: { id: 'rr-999', status: 'running', targetSha: 'abc' },
        },
      ],
    };
    const client = createCaptureReplayDaemonClient({
      sessions: sessionsPayload,
      projects: projectsPayload,
      reviewsBySessionId: {
        'orchestrator-pack-7': loadJson('per-session-reviews-populated.raw.json'),
        'orchestrator-pack-8': loadJson('per-session-reviews-empty.raw.json'),
        'other-project-1': foreignReview,
      },
    });

    const board = await aggregateReviewsBoard(client, { projectId: 'orchestrator-pack' });
    expect(board.runs.every((run) => run.projectId === 'orchestrator-pack')).toBe(true);
    expect(board.runs.some((run) => run.prUrl?.includes('/pull/999'))).toBe(false);
  });

  it('uses per-session fan-out only (no cross-session reviews list route)', async () => {
    const client = createCaptureReplayDaemonClient({
      sessions: loadJson('sessions-list.raw.json'),
      projects: loadJson('projects-list.raw.json'),
      reviewsBySessionId: {
        'orchestrator-pack-7': loadJson('per-session-reviews-empty.raw.json'),
        'orchestrator-pack-8': loadJson('per-session-reviews-empty.raw.json'),
      },
    });

    await aggregateReviewsBoard(client);
    const urls = client.getRequestLog();
    expect(urls.some((url) => url.includes('/api/v1/sessions/orchestrator-pack-7/reviews'))).toBe(
      true,
    );
    for (const forbidden of FORBIDDEN_DAEMON_AGGREGATION_PATHS) {
      expect(urls.some((url) => url.includes(forbidden))).toBe(false);
    }
    expect(urls.some((url) => /\/api\/v1\/reviews(?:\/|$)/.test(url))).toBe(false);
  });

  it('rejects forbidden cross-session daemon paths at client boundary', async () => {
    const client = createCaptureReplayDaemonClient({
      sessions: {},
      projects: {},
      reviewsBySessionId: {},
    });
    await expect(client.fetchJson('/api/v1/reviews')).rejects.toThrow(/forbidden cross-session/);
    await expect(client.fetchJson('/api/v1/reviews/list')).rejects.toThrow(/forbidden cross-session/);
  });

  it('fail-loud: surfaces dashboardLoadError when sessions fetch fails', async () => {
    const client = {
      async fetchJson(path: string) {
        if (path === DAEMON_API_PATHS.sessions) {
          throw new Error('ECONNREFUSED');
        }
        return {};
      },
      getRequestLog() {
        return [];
      },
    };
    const board = await aggregateReviewsBoard(client);
    expect(board.dashboardLoadError).toMatch(/sessions-fetch-failed/);
    expect(board.runs).toEqual([]);
  });

  it('HTTP server returns 503 when aggregation fails', async () => {
    const client = {
      async fetchJson() {
        throw new Error('daemon down');
      },
      getRequestLog() {
        return [];
      },
    };
    const server = createReviewsBoardServer({ client });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('server bind failed');
    }
    const response = await fetch(`http://127.0.0.1:${address.port}/api/reviews`);
    expect(response.status).toBe(503);
    const body = (await response.json()) as { dashboardLoadError: string | null };
    expect(body.dashboardLoadError).toMatch(/sessions-fetch-failed|projects-fetch-failed/);
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });

  it('maps all seven board columns via producer mapping table', () => {
    const cases: Array<{ input: Parameters<typeof mapEngineToBoardStatus>[0]; want: string }> = [
      { input: { prReviewStatus: 'needs_review', latestRun: null }, want: 'queued' },
      { input: { prReviewStatus: 'running', latestRun: { status: 'running' } }, want: 'reviewing' },
      {
        input: {
          prReviewStatus: 'changes_requested',
          latestRun: { status: 'completed', deliveredAt: '2026-07-06T00:00:00.000Z' },
        },
        want: 'triage',
      },
      {
        input: { prReviewStatus: 'changes_requested', latestRun: { status: 'completed' } },
        want: 'waiting',
      },
      {
        input: {
          prReviewStatus: 'up_to_date',
          latestRun: { status: 'completed', verdict: 'approved' },
        },
        want: 'clean',
      },
      { input: { prReviewStatus: 'running', latestRun: { status: 'failed' } }, want: 'failed' },
      { input: { prReviewStatus: 'ineligible', latestRun: { status: 'completed' } }, want: 'outdated' },
    ];
    for (const row of cases) {
      expect(mapEngineToBoardStatus(row.input)).toBe(row.want);
    }
    expect(BOARD_STATUSES).toHaveLength(7);
  });

  it('upgrade-safety: tool sources do not import AO desktop internals or ao.db', () => {
    const forbidden = [
      /\/usr\/lib\/agent-orchestrator/,
      /app\.asar/,
      /ao\.db/i,
      /~\/\.agent-orchestrator/,
      /code-reviews\//,
      /@composio\/agent-orchestrator/,
    ];
    const sources = listSourceFiles(toolRoot);
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

  it('board schema lists contracted run fields', () => {
    const schema = JSON.parse(
      readFileSync(path.join(repoRoot, 'docs/ao-0-10-review-producer-contract.schema.json'), 'utf8'),
    ) as { required?: string[] };
    expect([...(schema.required ?? [])].sort()).toEqual([...REVIEW_BOARD_RUN_FIELD_NAMES].sort());
  });
});
