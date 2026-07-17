import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { runReviewReadySeedFixtureRunner } from './_review-ready-seed-fixture-test-helpers.js';
import {
  REVIEW_READY_SEED_LIVENESS_EXPECTED,
  REVIEW_READY_SEED_LIVENESS_MATRIX,
} from './lib/review-ready-seed-liveness-matrix.mjs';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDir = path.join(repoRoot, 'scripts/fixtures/review-ready-seed-liveness');
const runnerScript = path.join(repoRoot, 'scripts/run-review-ready-seed-liveness-fixture.ps1');
const generatorScript = path.join(repoRoot, 'scripts/generate-review-ready-seed-grown-state-fixture.mjs');

function runFixture(fixtureName: string): { expected: string; ok: boolean; detail: string } {
  return runReviewReadySeedFixtureRunner(runnerScript, fixtureDir, fixtureName);
}

beforeAll(() => {
  execFileSync('node', [generatorScript], { cwd: repoRoot, encoding: 'utf8', timeout: 120_000 });
  const grownDir = path.join(repoRoot, 'tests/external-output-references/generated/review-ready-seed-liveness');
  for (const name of ['grown-status-sessions.json', 'grown-review-list.json']) {
    const full = path.join(grownDir, name);
    if (!existsSync(full)) throw new Error(`missing generated grown-state fixture: ${full}`);
    expect(Buffer.byteLength(readFileSync(full, 'utf8'), 'utf8')).toBeGreaterThan(500_000);
  }
}, 120_000);

describe('review-ready-seed-liveness matrix coverage (Issue #473)', () => {
  it('maps every expected label to a named fixture', () => {
    const fixtureNames = new Set(REVIEW_READY_SEED_LIVENESS_MATRIX.map((row) => row.fixture));
    expect(fixtureNames.size).toBe(REVIEW_READY_SEED_LIVENESS_EXPECTED.length);
  });
});

describe.only('review-ready-seed-liveness first quarter diagnostic', () => {
  for (const row of REVIEW_READY_SEED_LIVENESS_MATRIX.slice(0, 4)) {
    it(`expected: ${row.expected}`, () => {
      const result = runFixture(row.fixture);
      expect(result.expected).toBe(row.expected);
      expect(result.ok, result.detail).toBe(true);
    });
  }
});
