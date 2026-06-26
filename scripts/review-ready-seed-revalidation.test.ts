import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SEED_REVALIDATION_OUTCOMES,
  classifySeedSideEffectOutcome,
  evaluateSeedPreSideEffectRevalidation,
} from '../docs/review-ready-report-state-seed.mjs';
import { runReviewReadySeedFixtureRunner } from './_review-ready-seed-fixture-test-helpers.js';
import {
  REVIEW_READY_SEED_REVALIDATION_EXPECTED,
  REVIEW_READY_SEED_REVALIDATION_MATRIX,
} from './lib/review-ready-seed-revalidation-matrix.mjs';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDir = path.join(repoRoot, 'scripts/fixtures/review-ready-seed-revalidation');
const runnerScript = path.join(repoRoot, 'scripts/run-review-ready-seed-revalidation-fixture.ps1');
const seedFixturesDir = path.join(repoRoot, 'tests/fixtures/review-ready-report-state-seed');

type RevalidationFixture = {
  expected: string;
  headSha?: string;
  nowMs?: number;
  openPrs?: Array<Record<string, unknown>>;
  sessions?: Array<Record<string, unknown>>;
  reviewRuns?: Array<Record<string, unknown>>;
  ciChecksByPr?: Record<string, unknown[]>;
  requiredCheckNamesByPr?: Record<string, string[]>;
  requiredCheckLookupFailedByPr?: Record<string, boolean>;
  freshSnapshot?: Record<string, unknown>;
  expectOutcome?: string;
};

function runFixture(fixtureName: string): { expected: string; ok: boolean; detail: string } {
  return runReviewReadySeedFixtureRunner(runnerScript, fixtureDir, fixtureName);
}

function loadSeedFixture(name: string): RevalidationFixture {
  return JSON.parse(readFileSync(path.join(seedFixturesDir, name), 'utf8')) as RevalidationFixture;
}

describe('review-ready-seed-revalidation classifier (Issue #475)', () => {
  it('maps fresh recheck success to fresh-candidate-starts', () => {
    const fixture = loadSeedFixture('gate-b-ready-green.json');
    const headSha = String(fixture.headSha ?? fixture.openPrs?.[0]?.headRefOid ?? '');
    const result = evaluateSeedPreSideEffectRevalidation({
      planned: {
        prNumber: 380,
        headSha,
        sessionId: 'opk-165',
        startReason: 'report_state_seed',
      },
      fresh: {
        openPrs: fixture.openPrs,
        reviewRuns: fixture.reviewRuns,
        sessions: fixture.sessions,
        ciChecksByPr: fixture.ciChecksByPr,
        requiredCheckNamesByPr: fixture.requiredCheckNamesByPr,
        requiredCheckLookupFailedByPr: fixture.requiredCheckLookupFailedByPr,
        nowMs: fixture.nowMs,
      },
    });
    expect(result.outcome).toBe(SEED_REVALIDATION_OUTCOMES.FRESH);
    expect(result.emitReviewStart).toBe(true);
  });

  it('maps head_advanced recheck to stale-head', () => {
    const fixture = loadSeedFixture('gate-b-ready-green.json');
    const headSha = String(fixture.headSha ?? '');
    const result = evaluateSeedPreSideEffectRevalidation({
      planned: { prNumber: 380, headSha, sessionId: 'opk-165', startReason: 'report_state_seed' },
      fresh: {
        openPrs: [{ number: 380, headRefOid: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }],
        reviewRuns: [],
        sessions: fixture.sessions,
        ciChecksByPr: fixture.ciChecksByPr,
        requiredCheckNamesByPr: fixture.requiredCheckNamesByPr,
        requiredCheckLookupFailedByPr: fixture.requiredCheckLookupFailedByPr,
      },
    });
    expect(result.outcome).toBe(SEED_REVALIDATION_OUTCOMES.STALE_HEAD);
    expect(result.emitReviewStart).toBe(false);
  });

  it('maps covered claim loser to duplicate-prevented', () => {
    const classified = classifySeedSideEffectOutcome({
      triggered: false,
      sideEffectReason: 'covered_by_run',
    });
    expect(classified.outcome).toBe(SEED_REVALIDATION_OUTCOMES.DUPLICATE);
  });

  it('maps boundary claim loss to boundary-race-blocked', () => {
    const classified = classifySeedSideEffectOutcome({
      triggered: false,
      sideEffectReason: 'claimed',
      boundaryRace: true,
    });
    expect(classified.outcome).toBe(SEED_REVALIDATION_OUTCOMES.BOUNDARY_RACE);
  });
});

describe('review-ready-seed-revalidation matrix coverage (Issue #475)', () => {
  it('maps every expected label to a named fixture', () => {
    const fixtureNames = new Set(REVIEW_READY_SEED_REVALIDATION_MATRIX.map((row) => row.fixture));
    expect(fixtureNames.size).toBe(REVIEW_READY_SEED_REVALIDATION_EXPECTED.length);
    for (const row of REVIEW_READY_SEED_REVALIDATION_MATRIX) {
      expect(existsSync(path.join(fixtureDir, row.fixture))).toBe(true);
      const fixture = JSON.parse(readFileSync(path.join(fixtureDir, row.fixture), 'utf8')) as {
        expected: string;
      };
      expect(fixture.expected).toBe(row.expected);
    }
  });
});

describe('review-ready-seed-revalidation (Issue #475)', () => {
  for (const row of REVIEW_READY_SEED_REVALIDATION_MATRIX) {
    it(`expected: ${row.expected}`, () => {
      const result = runFixture(row.fixture);
      expect(result.expected).toBe(row.expected);
      expect(result.ok, result.detail).toBe(true);
      console.log(
        JSON.stringify({
          producer: 'orchestrator-pack',
          datum: 'review-ready-seed-revalidation',
          expected: row.expected,
        }),
      );
    });
  }
});
