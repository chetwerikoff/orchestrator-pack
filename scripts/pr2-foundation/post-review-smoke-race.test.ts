// @vitest-ci-lane light
// @vitest-pre-topology-seconds 60

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Issue #2250 no retired scheduler smoke races', () => {
  it('has no scheduler-owned detached start, observation, retry, or reconciliation paths', () => {
    const scheduler = readFileSync(path.resolve('scripts/pr2-foundation/scheduler.ts'), 'utf8');
    expect(scheduler).not.toContain('startDetachedSmokeAttempt');
    expect(scheduler).not.toContain('observeDetachedSmokeAttempt');
    expect(scheduler).not.toContain('reconcilePostReviewSmoke');
    expect(scheduler).not.toContain('postReviewSmoke');
  });

  it('retains shared required current-head CI before starting pack review', () => {
    const scheduler = readFileSync(path.resolve('scripts/pr2-foundation/scheduler.ts'), 'utf8');
    const tick = scheduler.slice(scheduler.indexOf('export async function runSchedulerTick('));
    expect(tick).toContain('boundary.resolveRequiredCi');
    expect(tick).toContain('await boundary.readChecks(candidate)');
    expect(tick).toContain('evaluateHeadReadyForReview({');
    expect(tick).toContain('requiredCi');
    expect(tick).toContain('if (!decision.eligible)');
    expect(tick).toContain('await boundary.start(candidate, freshHead)');
    expect(scheduler).toContain('baseRefName');
  });
});
