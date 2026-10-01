// @vitest-ci-lane light
// @vitest-pre-topology-seconds 60

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Issue #2250 retire scheduler post-review smoke reconciliation', () => {
  it('has no active scheduler reconciliation function, phase, or production call site', () => {
    const scheduler = readFileSync(path.resolve('scripts/pr2-foundation/scheduler.ts'), 'utf8');
    expect(scheduler).not.toContain('reconcilePostReviewSmoke');
    expect(scheduler).not.toContain('createProductionPostReviewSmokeReconciler');
    expect(scheduler).not.toContain('detached-post-review-smoke-start-or-observe');
    expect(scheduler).toContain('evaluateHeadReadyForReview({');
  });

  it('keeps required post-review smoke in the same manager without a scheduler starter', () => {
    const skill = readFileSync(path.resolve('.cursor/skills/execute-issue-with-gpt/SKILL.md'), 'utf8');
    expect(skill).toContain('execute:smoke');
    expect(skill).toContain('temporary detached Git worktree');
    expect(skill).not.toContain('independent-smoke');
    expect(skill).not.toContain('scheduler post-review smoke');
  });
});
