// @vitest-ci-lane light
// @vitest-pre-topology-seconds 120
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_EFFECTIVE_BUDGET_MS,
  buildReviewerBudgetSpawnEnv,
  createReviewerBudgetLedger,
  resolveReviewerBudgetDecision,
  resolveSoftDeadlineMs,
  resolveTestBudgetMs,
} from '../plugins/ao-codex-pr-reviewer/lib/reviewer_budget.ts';
import { startPackReview } from './pack-review-runner.ts';

const roots: string[] = [];

afterEach(() => {
  delete process.env.AO_CODEX_REVIEW_EFFECTIVE_BUDGET_MS;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

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

  it('rejects invalid budget and preempting timeout before runner store or claim effects', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'pack-review-budget-preflight-'));
    roots.push(parent);
    const storeRoot = join(parent, 'store-not-created');
    process.env.AO_CODEX_REVIEW_EFFECTIVE_BUDGET_MS = '6e5';
    await expect(startPackReview({ storeRoot })).rejects.toThrow(/reviewer_budget_invalid/);
    expect(existsSync(storeRoot)).toBe(false);

    delete process.env.AO_CODEX_REVIEW_EFFECTIVE_BUDGET_MS;
    await expect(startPackReview({ storeRoot, timeoutSeconds: '899' })).rejects.toThrow(
      /below required 900/,
    );
    expect(existsSync(storeRoot)).toBe(false);
  });

  it('propagates one ledger into child timeout telemetry without recomputation', () => {
    const ledger = createReviewerBudgetLedger({
      AO_CODEX_REVIEW_EFFECTIVE_BUDGET_MS: '2400000',
    }, 1_000);
    expect(buildReviewerBudgetSpawnEnv(ledger, {})).toMatchObject({
      AO_REVIEW_EFFECTIVE_BUDGET_MS: '2400000',
      AO_REVIEW_SOFT_DEADLINE_MS: '2040000',
      AO_REVIEW_TEST_BUDGET_MS: '120000',
      AO_REVIEW_HARD_DEADLINE_MS: '2401000',
      AO_REVIEW_BUDGET_STARTED_MS: '1000',
      AO_REVIEW_RUNNER_TIMEOUT_REQUIRED_MS: '2700000',
      AO_REVIEW_RUNNER_TIMEOUT_SECONDS: '2700',
      AO_REVIEW_RUNNER_TIMEOUT_MS: '2700000',
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
