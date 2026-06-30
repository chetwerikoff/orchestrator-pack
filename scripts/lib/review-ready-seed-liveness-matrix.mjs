/**
 * Liveness matrix for review-ready-report-state-seed (Issue #473).
 * Every row must map to a named deterministic fixture.
 */
export const REVIEW_READY_SEED_LIVENESS_MATRIX = [
  { expected: 'fast-tick-ok', fixture: 'fast-tick-ok.json' },
  { expected: 'long-tick-not-stalled', fixture: 'long-tick-not-stalled.json' },
  { expected: 'refresh-github-detail-progress', fixture: 'refresh-github-detail-progress.json' },
  { expected: 'stale-poll-regression', fixture: 'stale-poll-regression.json' },
  { expected: 'hang-still-stalled', fixture: 'hang-still-stalled.json' },
  { expected: 'tick-error-classified', fixture: 'tick-error-classified.json' },
  { expected: 'progress-livelock-fails', fixture: 'progress-livelock-fails.json' },
  { expected: 'progress-identity', fixture: 'progress-identity.json' },
  { expected: 'dead-process-not-fresh', fixture: 'dead-process-not-fresh.json' },
  { expected: 'overlap-safe', fixture: 'overlap-safe.json' },
  { expected: 'side-effect-safe-long-scan', fixture: 'side-effect-safe-long-scan.json' },
  { expected: 'stale-lock-bounded', fixture: 'stale-lock-bounded.json' },
  { expected: 'atomic-progress-read', fixture: 'atomic-progress-read.json' },
  { expected: 'upgrade-safe-progress', fixture: 'upgrade-safe-progress.json' },
  { expected: 'legacy-poll-compat', fixture: 'legacy-poll-compat.json' },
  { expected: 'large-payload-progress', fixture: 'large-payload-progress.json' },
];

export const REVIEW_READY_SEED_LIVENESS_EXPECTED = REVIEW_READY_SEED_LIVENESS_MATRIX.map(
  (row) => row.expected,
);
