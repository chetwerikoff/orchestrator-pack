import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ACTIONABLE_REVIEW_STATUSES,
  classifyBulkSendRun,
  diagnoseBulkSendBlock,
  normalizeReviewRuns,
} from '../docs/review-bulk-send-diagnose.mjs';

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/review-bulk-send-diagnose',
);

type FixturePayload = {
  description?: string;
  runs: Record<string, unknown>[];
  expect?: {
    flaggedRuns?: number;
    kinds?: string[];
  };
};

function loadFixture(name: string): FixturePayload {
  const raw = readFileSync(path.join(fixturesDir, name), 'utf8');
  return JSON.parse(raw) as FixturePayload;
}

function diagnoseFromFixture(name: string) {
  const fixture = loadFixture(name);
  return diagnoseBulkSendBlock({ runs: fixture.runs });
}

describe('normalizeReviewRuns', () => {
  it('accepts array or wrapped payloads', () => {
    const run = { id: 'r1', status: 'clean' };
    expect(normalizeReviewRuns([run])).toEqual([run]);
    expect(normalizeReviewRuns({ runs: [run] })).toEqual([run]);
    expect(normalizeReviewRuns({ data: [run] })).toEqual([run]);
  });
});

describe('classifyBulkSendRun', () => {
  it('flags actionable runs with open findings', () => {
    const result = classifyBulkSendRun({
      id: 'r1',
      status: 'changes_requested',
      openFindingCount: 2,
      sentFindingCount: 0,
      findingCount: 2,
    });
    expect(result.flagged).toBe(true);
    expect(result.signals.map((s) => s.kind)).toContain('multi_open_awaiting_dispatch');
  });

  it('does not flag clean runs', () => {
    const result = classifyBulkSendRun({
      id: 'r2',
      status: 'clean',
      openFindingCount: 0,
      sentFindingCount: 0,
      findingCount: 0,
    });
    expect(result.flagged).toBe(false);
  });
});

describe('diagnoseBulkSendBlock fixtures', () => {
  it('flags changes_requested multi-open bulk-send trap', () => {
    const fixture = loadFixture('needs-triage-multi-open.json');
    const result = diagnoseFromFixture('needs-triage-multi-open.json');
    expect(result.summary.flaggedRuns).toBe(fixture.expect?.flaggedRuns);
    const kinds = result.flaggedRuns.flatMap((r) => r.signals.map((s) => s.kind));
    for (const kind of fixture.expect?.kinds ?? []) {
      expect(kinds).toContain(kind);
    }
    expect(result.gate0.capabilities.selectiveSend).toBe(false);
  });

  it('flags stuck open after partial send', () => {
    const fixture = loadFixture('stuck-open-partial-send.json');
    const result = diagnoseFromFixture('stuck-open-partial-send.json');
    expect(result.summary.flaggedRuns).toBe(fixture.expect?.flaggedRuns);
    const kinds = result.flaggedRuns.flatMap((r) => r.signals.map((s) => s.kind));
    for (const kind of fixture.expect?.kinds ?? []) {
      expect(kinds).toContain(kind);
    }
  });

  it('passes clean runs without flags', () => {
    const fixture = loadFixture('clean-no-open.json');
    const result = diagnoseFromFixture('clean-no-open.json');
    expect(result.summary.flaggedRuns).toBe(fixture.expect?.flaggedRuns);
  });
});

describe('ACTIONABLE_REVIEW_STATUSES', () => {
  it('includes changes_requested for AO 0.10', () => {
    expect(ACTIONABLE_REVIEW_STATUSES).toContain('changes_requested');
  });
});
