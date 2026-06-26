import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  CLASSIFIER_INPUT_KEYS,
  classifyReviewStartAttempt,
  classifyReviewStartAttemptSeries,
} from '../docs/review-start-repeat-classifier.mjs';
import { repoRoot } from './_test-pwsh-helpers.js';

const fixturesDir = path.join(repoRoot, 'tests/fixtures/review-start-repeat-classifier');

function loadSeries(name: string) {
  return JSON.parse(readFileSync(path.join(fixturesDir, `${name}.json`), 'utf8')).attempts as Array<
    Record<string, unknown>
  >;
}

describe('review-start repeat classifier (Issue #480)', () => {
  it('emits required classifier keys on every row', () => {
    const rows = classifyReviewStartAttemptSeries(loadSeries('same-cycle-repeat'));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      for (const key of CLASSIFIER_INPUT_KEYS) {
        expect(row).toHaveProperty(key);
      }
      expect(row).toHaveProperty('classification');
    }
  });

  it('classifies same PR/head/cycle repeat as regression', () => {
    const rows = classifyReviewStartAttemptSeries(loadSeries('same-cycle-repeat'));
    const last = rows[rows.length - 1]!;
    expect(last.classification).toBe('same_cycle_repeat_regression');
  });

  it('classifies covered in-flight head as suppressed', () => {
    const row = classifyReviewStartAttempt(loadSeries('covered-in-flight')[0]!);
    expect(row.classification).toBe('covered_in_flight_suppressed');
  });

  it('classifies claim loser without new start', () => {
    const row = classifyReviewStartAttempt(loadSeries('claim-loser')[0]!);
    expect(row.classification).toBe('claim_loser');
  });

  it('classifies new head within cycle as distinct_new_head', () => {
    const rows = classifyReviewStartAttemptSeries(loadSeries('distinct-new-head'));
    const last = rows[rows.length - 1]!;
    expect(last.classification).toBe('distinct_new_head');
  });

  it('classifies new worker cycle as distinct_new_cycle', () => {
    const rows = classifyReviewStartAttemptSeries(loadSeries('distinct-new-cycle'));
    const last = rows[rows.length - 1]!;
    expect(last.classification).toBe('distinct_new_cycle');
  });
});
