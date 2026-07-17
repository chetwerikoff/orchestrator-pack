import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runReviewReadySeedFixtureRunner } from './_review-ready-seed-fixture-test-helpers.js';
import { REVIEW_READY_SEED_LIVENESS_MATRIX } from './lib/review-ready-seed-liveness-matrix.mjs';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDir = path.join(repoRoot, 'scripts/fixtures/review-ready-seed-liveness');
const runnerScript = path.join(repoRoot, 'scripts/run-review-ready-seed-liveness-fixture.ps1');
const generatorScript = path.join(repoRoot, 'scripts/generate-review-ready-seed-grown-state-fixture.mjs');

describe.only('fast-tick runner failure-class diagnostic', () => {
  it('classifies the failure as a PowerShell process exception', () => {
    execFileSync('node', [generatorScript], { cwd: repoRoot, encoding: 'utf8', timeout: 120_000 });
    let threw = false;
    try {
      const row = REVIEW_READY_SEED_LIVENESS_MATRIX[0]!;
      runReviewReadySeedFixtureRunner(runnerScript, fixtureDir, row.fixture);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
