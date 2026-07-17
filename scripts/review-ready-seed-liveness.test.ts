import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runReviewReadySeedFixtureRunner } from './_review-ready-seed-fixture-test-helpers.js';
import { REVIEW_READY_SEED_LIVENESS_MATRIX } from './lib/review-ready-seed-liveness-matrix.mjs';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDir = path.join(repoRoot, 'scripts/fixtures/review-ready-seed-liveness');
const runnerScript = path.join(repoRoot, 'scripts/run-review-ready-seed-liveness-fixture.ps1');

describe.only('fast-tick verdict diagnostic', () => {
  it('returns stalled', () => {
    const row = REVIEW_READY_SEED_LIVENESS_MATRIX[0]!;
    const result = runReviewReadySeedFixtureRunner(runnerScript, fixtureDir, row.fixture);
    expect(result.detail).toContain('status=stalled');
  });
});
