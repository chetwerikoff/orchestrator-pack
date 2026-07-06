import { describe, expect, it } from 'vitest';
import {
  BOARD_COLUMN_STATUSES,
  deriveDeliveredFindingCount,
  flattenSessionReviewsToNormalizedRuns,
  isDeliveredChangesRequested,
  isUndeliveredChangesRequested,
  mapEngineStateToBoardStatus,
  resolveFailureDetail,
} from '../docs/review-producer-contract.mjs';

describe('review-producer-contract', () => {
  it('maps all seven board columns from engine signals', () => {
    const cases = [
      { prReviewStatus: 'needs_review', latestRun: null, want: 'queued' },
      { prReviewStatus: 'running', latestRun: { status: 'running' }, want: 'reviewing' },
      {
        prReviewStatus: 'changes_requested',
        latestRun: { status: 'completed', deliveredAt: '2026-07-06T00:00:00.000Z', findingCount: 2 },
        want: 'triage',
      },
      {
        prReviewStatus: 'changes_requested',
        latestRun: { status: 'completed', findingCount: 2 },
        want: 'waiting',
      },
      { prReviewStatus: 'up_to_date', latestRun: { status: 'completed', verdict: 'approved' }, want: 'clean' },
      { prReviewStatus: 'running', latestRun: { status: 'failed', body: 'timeout' }, want: 'failed' },
      { prReviewStatus: 'ineligible', latestRun: { status: 'completed' }, want: 'outdated' },
    ];
    for (const row of cases) {
      expect(
        mapEngineStateToBoardStatus({
          prReviewStatus: row.prReviewStatus,
          latestRun: row.latestRun,
        }),
      ).toBe(row.want);
    }
    expect(BOARD_COLUMN_STATUSES).toHaveLength(7);
  });

  it('flatten produces 0.10 fields without false-equivalence names', () => {
    const payload = {
      reviews: [
        {
          prNumber: 42,
          headSha: 'abc123def4567890abcdef1234567890abcdef12',
          status: 'changes_requested',
          latestRun: {
            id: 'rr-1',
            status: 'completed',
            targetSha: 'abc123def4567890abcdef1234567890abcdef12',
            deliveredAt: '2026-07-06T01:00:00.000Z',
            findingCount: 3,
            verdict: 'changes_requested',
          },
        },
      ],
    };
    const runs = flattenSessionReviewsToNormalizedRuns(payload, 'opk-1');
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run.prReviewStatus).toBe('changes_requested');
    expect(run.deliveredFindingCount).toBe(3);
    expect(isDeliveredChangesRequested(run)).toBe(true);
    expect(isUndeliveredChangesRequested(run)).toBe(false);
    expect(JSON.stringify(run)).not.toMatch(/needs_triage|sentFindingCount|terminationReason/);
  });

  it('resolveFailureDetail reads latestRun.body on failed runs', () => {
    expect(resolveFailureDetail({ status: 'failed', body: 'codex timeout' })).toBe('codex timeout');
    expect(resolveFailureDetail({ status: 'completed', body: 'ignored' })).toBe('');
  });

  it('deriveDeliveredFindingCount is zero without deliveredAt', () => {
    expect(deriveDeliveredFindingCount({ findingCount: 2 }, 'changes_requested')).toBe(0);
  });
});
