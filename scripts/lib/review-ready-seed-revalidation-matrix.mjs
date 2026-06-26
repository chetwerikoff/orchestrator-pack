/**
 * Pre-side-effect revalidation matrix for review-ready-report-state-seed (Issue #475).
 */
export const REVIEW_READY_SEED_REVALIDATION_MATRIX = [
  { expected: 'fresh-candidate-starts', fixture: 'fresh-candidate-starts.json' },
  { expected: 'stale-head-rejected', fixture: 'stale-head-rejected.json' },
  { expected: 'readiness-revalidated', fixture: 'readiness-revalidated.json' },
  { expected: 'duplicate-prevented', fixture: 'duplicate-prevented.json' },
  { expected: 'boundary-race-blocked', fixture: 'boundary-race-blocked.json' },
];

export const REVIEW_READY_SEED_REVALIDATION_EXPECTED =
  REVIEW_READY_SEED_REVALIDATION_MATRIX.map((row) => row.expected);
