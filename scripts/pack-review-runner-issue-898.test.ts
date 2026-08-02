// @vitest-ci-lane light
// @vitest-pre-topology-seconds 120
import { describe, expect, it } from 'vitest';
import {
  MAX_EFFECTIVE_BUDGET_MS,
  createReviewerBudgetLedger,
  resolveReviewerBudgetDecision,
  resolveSoftDeadlineMs,
  resolveTestBudgetMs,
} from '../plugins/ao-codex-pr-reviewer/lib/reviewer_budget.ts';

describe('Issue #898 effective reviewer budget contract', () => {
  it('keeps 600000 default and applies 2400000 live override with ceil-to-second runner deadline', () => {
    expect(resolveReviewerBudgetDecision({})).toEqual({
      effectiveBudgetMs: 600000,
      effectiveBudgetSource: 'default',
      maxEffectiveBudgetMs: MAX_EFFECTIVE_BUDGET_MS,
      runnerTimeoutRequiredMs: 900000,
      runnerTimeoutSeconds: 900,
      runnerTimeoutMs: 900000,
      runnerTimeoutSource: 'derived',
      runnerOverheadMs: 300000,
    });
    expect(resolveReviewerBudgetDecision({
      AO_CODEX_REVIEW_EFFECTIVE_BUDGET_MS: '2400000',
    })).toMatchObject({
      effectiveBudgetMs: 2400000,
      effectiveBudgetSource: 'env',
      runnerTimeoutRequiredMs: 2700000,
      runnerTimeoutSeconds: 2700,
      runnerTimeoutMs: 2700000,
    });
    expect(resolveReviewerBudgetDecision({
      AO_CODEX_REVIEW_EFFECTIVE_BUDGET_MS: '600001',
    })).toMatchObject({
      runnerTimeoutRequiredMs: 900001,
      runnerTimeoutSeconds: 901,
      runnerTimeoutMs: 901000,
    });
  });

  it('accepts the exact maximum and rejects noncanonical, unsafe, overflowing, or preempting input', () => {
    expect(resolveReviewerBudgetDecision({
      AO_CODEX_REVIEW_EFFECTIVE_BUDGET_MS: String(MAX_EFFECTIVE_BUDGET_MS),
    })).toMatchObject({
      runnerTimeoutRequiredMs: 2147483000,
      runnerTimeoutSeconds: 2147483,
      runnerTimeoutMs: 2147483000,
    });
    for (const value of [
      String(MAX_EFFECTIVE_BUDGET_MS + 1),
      '0', '-1', '+1', ' 600000', '600000 ', '6e5', '600000.0', '9007199254740992',
    ]) {
      expect(() => resolveReviewerBudgetDecision({
        AO_CODEX_REVIEW_EFFECTIVE_BUDGET_MS: value,
      })).toThrow(/reviewer_budget_invalid/);
    }
    expect(() => resolveReviewerBudgetDecision({}, 899)).toThrow(/below required 900/);
    expect(resolveReviewerBudgetDecision({}, 901)).toMatchObject({
      runnerTimeoutSeconds: 901,
      runnerTimeoutMs: 901000,
      runnerTimeoutSource: 'explicit',
    });
  });

  it('preserves sibling env fallback behavior and emits complete telemetry', () => {
    const fallback = createReviewerBudgetLedger({});
    const live = createReviewerBudgetLedger({ AO_CODEX_REVIEW_EFFECTIVE_BUDGET_MS: '2400000' });
    expect(resolveSoftDeadlineMs(fallback.effectiveBudgetMs)).toBe(510000);
    expect(resolveSoftDeadlineMs(live.effectiveBudgetMs)).toBe(2040000);
    expect(resolveTestBudgetMs(fallback.effectiveBudgetMs)).toBe(120000);
    expect(resolveTestBudgetMs(live.effectiveBudgetMs)).toBe(120000);
    expect(live).toMatchObject({
      effectiveBudgetSource: 'env',
      maxEffectiveBudgetMs: MAX_EFFECTIVE_BUDGET_MS,
      runnerTimeoutRequiredMs: 2700000,
      runnerTimeoutSeconds: 2700,
      runnerTimeoutMs: 2700000,
      runnerTimeoutSource: 'derived',
      runnerOverheadMs: 300000,
    });
    expect(resolveSoftDeadlineMs(600000, { AO_CODEX_REVIEW_SOFT_DEADLINE_MS: 'not-a-number' })).toBe(510000);
    expect(resolveTestBudgetMs(600000, { AO_CODEX_REVIEW_TEST_BUDGET_MS: 'not-a-number' })).toBe(120000);
  });
});
