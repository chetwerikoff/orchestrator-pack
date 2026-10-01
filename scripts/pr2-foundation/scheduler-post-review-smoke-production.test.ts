// @vitest-ci-lane light
// @vitest-pre-topology-seconds 60

import { describe, expect, it } from 'vitest';
import { productionSchedulerBoundary, SCHEDULER_RUN_TICK_PHASE_INVENTORY } from './scheduler.ts';

describe('Issue #2250 production scheduler has no smoke-start authority', () => {
  it('builds production boundary without any post-review smoke start-or-observe member', () => {
    const boundary = productionSchedulerBoundary({
      repoRoot: process.cwd(),
      projectId: 'orchestrator-pack',
      env: process.env,
    });
    expect(Object.hasOwn(boundary, 'reconcilePostReviewSmoke')).toBe(false);
    expect(SCHEDULER_RUN_TICK_PHASE_INVENTORY.some((row) =>
      row.phase === 'detached-post-review-smoke-start-or-observe')).toBe(false);
  });
});
