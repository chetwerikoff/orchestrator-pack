import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  REVIEW_READY_SEED_LIVENESS_EXPECTED,
  REVIEW_READY_SEED_LIVENESS_MATRIX,
} from './lib/review-ready-seed-liveness-matrix.mjs';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDir = path.join(repoRoot, 'scripts/fixtures/review-ready-seed-liveness');
const runnerScript = path.join(repoRoot, 'scripts/run-review-ready-seed-liveness-fixture.ps1');
const generatorScript = path.join(
  repoRoot,
  'scripts/generate-review-ready-seed-grown-state-fixture.mjs',
);

function runFixture(fixtureName: string): { expected: string; ok: boolean; detail: string } {
  const stdout = execFileSync(
    'pwsh',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', runnerScript, '-FixturePath', path.join(fixtureDir, fixtureName)],
    { cwd: repoRoot, encoding: 'utf8', timeout: 120_000 },
  ).trim();
  return JSON.parse(stdout) as { expected: string; ok: boolean; detail: string };
}

beforeAll(() => {
  execFileSync('node', [generatorScript], { cwd: repoRoot, encoding: 'utf8', timeout: 120_000 });
  const grownDir = path.join(
    repoRoot,
    'tests/external-output-references/generated/review-ready-seed-liveness',
  );
  for (const name of ['grown-status-sessions.json', 'grown-review-list.json']) {
    const full = path.join(grownDir, name);
    if (!existsSync(full)) {
      throw new Error(`missing generated grown-state fixture: ${full}`);
    }
    const bytes = Buffer.byteLength(readFileSync(full, 'utf8'), 'utf8');
    expect(bytes).toBeGreaterThan(500_000);
  }
});

describe('review-ready-seed-liveness matrix coverage (Issue #473)', () => {
  it('maps every expected label to a named fixture', () => {
    const fixtureNames = new Set(
      REVIEW_READY_SEED_LIVENESS_MATRIX.map((row) => row.fixture),
    );
    expect(fixtureNames.size).toBe(REVIEW_READY_SEED_LIVENESS_EXPECTED.length);
    for (const row of REVIEW_READY_SEED_LIVENESS_MATRIX) {
      expect(existsSync(path.join(fixtureDir, row.fixture))).toBe(true);
      const fixture = JSON.parse(readFileSync(path.join(fixtureDir, row.fixture), 'utf8')) as {
        expected: string;
      };
      expect(fixture.expected).toBe(row.expected);
    }
  });
});

describe('review-ready-seed-liveness (Issue #473)', () => {
  for (const row of REVIEW_READY_SEED_LIVENESS_MATRIX) {
    it(`expected: ${row.expected}`, () => {
      const result = runFixture(row.fixture);
      expect(result.expected).toBe(row.expected);
      expect(result.ok, result.detail).toBe(true);
      console.log(
        JSON.stringify({
          producer: 'orchestrator-pack',
          datum: 'review-ready-seed-liveness',
          expected: row.expected,
        }),
      );
    });
  }
});
