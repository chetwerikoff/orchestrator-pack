import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BOARD_STATUSES,
  FORBIDDEN_FALSE_EQUIVALENCE_FIELDS,
  REVIEW_BOARD_RUN_FIELD_NAMES,
  REVIEW_PRODUCER_API_PATHS,
  deriveWorkerPrUrl,
  fanOutReviewBoardRuns,
  mapEngineToBoardStatus,
  mapPrReviewToBoardRun,
  mapSessionRowWorkerContext,
  type ReviewBoardRun,
} from '../scripts/lib/review-producer-contract.js';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const capturesDir = path.join(
  repoRoot,
  'tests/external-output-references/captures/ao-0-10-daemon',
);
const mappingModulePath = path.join(repoRoot, 'scripts/lib/review-producer-contract.ts');

function loadJson(fileName: string) {
  return JSON.parse(readFileSync(path.join(capturesDir, fileName), 'utf8')) as Record<
    string,
    unknown
  >;
}

const engineBoardFixtures: Array<{
  label: string;
  input: Parameters<typeof mapEngineToBoardStatus>[0];
  expected: (typeof BOARD_STATUSES)[number];
}> = [
  {
    label: 'needs_review without latestRun → queued',
    input: { prReviewStatus: 'needs_review', latestRun: null },
    expected: 'queued',
  },
  {
    label: 'running → reviewing',
    input: {
      prReviewStatus: 'running',
      latestRun: { status: 'running', targetSha: 'abc123' },
      headSha: 'abc123',
    },
    expected: 'reviewing',
  },
  {
    label: 'changes_requested + deliveredAt → triage',
    input: {
      prReviewStatus: 'changes_requested',
      latestRun: {
        status: 'completed',
        verdict: 'changes_requested',
        deliveredAt: '2026-07-06T08:15:00.000Z',
        targetSha: 'def456',
      },
      headSha: 'def456',
    },
    expected: 'triage',
  },
  {
    label: 'changes_requested without delivery → waiting',
    input: {
      prReviewStatus: 'changes_requested',
      latestRun: {
        status: 'completed',
        verdict: 'changes_requested',
        deliveredAt: null,
        targetSha: 'fedcba',
      },
      headSha: 'fedcba',
    },
    expected: 'waiting',
  },
  {
    label: 'up_to_date → clean',
    input: {
      prReviewStatus: 'up_to_date',
      latestRun: { status: 'completed', verdict: 'approved', targetSha: '012345' },
      headSha: '012345',
    },
    expected: 'clean',
  },
  {
    label: 'latestRun.status failed → failed',
    input: {
      prReviewStatus: 'changes_requested',
      latestRun: { status: 'failed', targetSha: 'aaa111' },
      headSha: 'aaa111',
    },
    expected: 'failed',
  },
  {
    label: 'ineligible → outdated',
    input: {
      prReviewStatus: 'ineligible',
      latestRun: { status: 'completed', targetSha: 'bbb222' },
      headSha: 'bbb222',
    },
    expected: 'outdated',
  },
];

describe('review producer contract (Issue #626)', () => {
  it.each(engineBoardFixtures)('maps engine signal: $label', ({ input, expected }) => {
    expect(mapEngineToBoardStatus(input)).toBe(expected);
  });

  it('red-then-green: changes_requested+deliveredAt must map to triage not waiting', () => {
    const input = {
      prReviewStatus: 'changes_requested',
      latestRun: {
        status: 'completed',
        verdict: 'changes_requested',
        deliveredAt: '2026-07-06T08:15:00.000Z',
        targetSha: 'def456abc7890',
      },
      headSha: 'def456abc7890',
    };
    expect(mapEngineToBoardStatus(input)).toBe('triage');
    expect(mapEngineToBoardStatus(input)).not.toBe('waiting');
  });

  it('maps head drift to outdated', () => {
    expect(
      mapEngineToBoardStatus({
        prReviewStatus: 'up_to_date',
        latestRun: { status: 'completed', targetSha: 'aaa111111111' },
        headSha: 'bbb222222222',
      }),
    ).toBe('outdated');
  });

  it('detects drift on full SHA even when 12-char prefixes match', () => {
    const sharedPrefix = 'abc123def456';
    const headSha = `${sharedPrefix}7890abcdef1234567890abcdef12`;
    const targetSha = `${sharedPrefix}7890abcdef1234567890abcdef99`;
    expect(headSha.slice(0, 12)).toBe(targetSha.slice(0, 12));
    expect(
      mapEngineToBoardStatus({
        prReviewStatus: 'changes_requested',
        latestRun: {
          status: 'completed',
          verdict: 'changes_requested',
          deliveredAt: '2026-07-06T08:15:00.000Z',
          targetSha,
        },
        headSha,
      }),
    ).toBe('outdated');
  });

  it('binds session worker-context fields from sessions-list capture', () => {
    const sessionsPayload = loadJson('sessions-list.raw.json');
    const projectsPayload = loadJson('projects-list.raw.json');
    const reviewsPayload = loadJson('per-session-reviews-populated.raw.json');
    const session = (sessionsPayload.sessions as Array<Record<string, unknown>>)[0];

    const worker = mapSessionRowWorkerContext(session, 'orchestrator-pack');
    expect(worker).toMatchObject({
      projectName: 'orchestrator-pack',
      workerBranch: 'issue-626-review-producer-contract',
      workerStatus: 'working',
      workerPrUrl: 'https://github.com/chetwerikoff/orchestrator-pack/pull/626',
      workerHasRuntime: true,
    });
    expect(deriveWorkerPrUrl([])).toBeNull();
    expect(
      deriveWorkerPrUrl([
        'https://github.com/chetwerikoff/orchestrator-pack/pull/1',
        'https://github.com/chetwerikoff/orchestrator-pack/pull/2',
      ]),
    ).toBeNull();

    const runs = fanOutReviewBoardRuns({
      sessionsPayload,
      projectsPayload,
      reviewsBySessionId: {
        'orchestrator-pack-7': reviewsPayload,
      },
    });
    expect(runs.length).toBeGreaterThanOrEqual(4);
    expect(runs.map((run: ReviewBoardRun) => run.status).sort()).toEqual(
      expect.arrayContaining(['reviewing', 'triage', 'waiting', 'clean', 'queued']),
    );
  });

  it('maps populated per-session reviews capture rows without false-equivalence fields', () => {
    const reviewsPayload = loadJson('per-session-reviews-populated.raw.json');
    const session = {
      id: 'orchestrator-pack-7',
      projectId: 'orchestrator-pack',
      branch: 'issue-626-review-producer-contract',
      status: 'working',
      terminalHandleId: 'term-1',
      prs: ['https://github.com/chetwerikoff/orchestrator-pack/pull/626'],
    };
    const runs = (reviewsPayload.reviews as Array<Record<string, unknown>>).map((review) =>
      mapPrReviewToBoardRun({ session, review, projectName: 'orchestrator-pack' }),
    );

    for (const run of runs) {
      for (const forbidden of FORBIDDEN_FALSE_EQUIVALENCE_FIELDS) {
        expect(Object.prototype.hasOwnProperty.call(run, forbidden)).toBe(false);
      }
      for (const field of REVIEW_BOARD_RUN_FIELD_NAMES) {
        expect(Object.prototype.hasOwnProperty.call(run, field)).toBe(true);
      }
    }

    const byPr = Object.fromEntries(runs.map((run) => [run.prUrl, run.status]));
    expect(byPr['https://github.com/chetwerikoff/orchestrator-pack/pull/626']).toBe('reviewing');
    expect(byPr['https://github.com/chetwerikoff/orchestrator-pack/pull/625']).toBe('triage');
    expect(byPr['https://github.com/chetwerikoff/orchestrator-pack/pull/624']).toBe('waiting');
    expect(byPr['https://github.com/chetwerikoff/orchestrator-pack/pull/623']).toBe('clean');
    expect(byPr['https://github.com/chetwerikoff/orchestrator-pack/pull/622']).toBe('queued');
  });

  it('static guard: mapping module does not emit forbidden false-equivalence field names', () => {
    const source = readFileSync(mappingModulePath, 'utf8');
    for (const field of FORBIDDEN_FALSE_EQUIVALENCE_FIELDS) {
      expect(source).not.toMatch(new RegExp(`['\"]${field}['\"]\\s*:`));
    }
    expect(source).toContain('FORBIDDEN_FALSE_EQUIVALENCE_FIELDS');
  });

  it('static guard: producer path is API-only (no ao.db reads)', () => {
    const source = readFileSync(mappingModulePath, 'utf8');
    expect(source).not.toMatch(/ao\.db/i);
    for (const apiPath of REVIEW_PRODUCER_API_PATHS) {
      expect(source).toContain(apiPath);
    }
  });

  it('schema requires every contracted row field with explicit nullability', () => {
    const schemaPath = path.join(repoRoot, 'docs/ao-0-10-review-producer-contract.schema.json');
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as {
      required?: string[];
      properties?: Record<string, { type?: unknown }>;
    };
    expect([...(schema.required ?? [])].sort()).toEqual([...REVIEW_BOARD_RUN_FIELD_NAMES].sort());
    for (const field of REVIEW_BOARD_RUN_FIELD_NAMES) {
      expect(schema.properties?.[field]).toBeDefined();
    }
    const nullableFields = REVIEW_BOARD_RUN_FIELD_NAMES.filter(
      (field) => field !== 'sessionId' && field !== 'status' && field !== 'workerHasRuntime',
    );
    for (const field of nullableFields) {
      const type = schema.properties?.[field]?.type;
      expect(type).toBeDefined();
      if (Array.isArray(type)) {
        expect(type).toContain('null');
      }
    }
  });
});

import './ao-reviews-board.test.ts';
