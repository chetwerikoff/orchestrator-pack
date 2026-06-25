import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  countSameHeadFailuresByClass,
  evaluateTimeoutRetryEligibility,
  extractReviewerFailureClass,
  REPEATED_TIMEOUT_ESCALATION_REASON,
  resolveTimeoutRetryMax,
  TIMEOUT_NO_VERDICT_FAILURE_CLASS,
} from '../docs/codex-reviewer-timeout-retry.mjs';
import {
  evaluateOrchestratorTurnGate,
  evaluateScenarioMatrixCell,
} from '../docs/orchestrator-claimed-review-run.mjs';
import { buildFailedCancelledObserved } from '../docs/review-head-ready.mjs';

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'codex-reviewer-timeout-retry',
);

function loadFixture(name: string) {
  return JSON.parse(readFileSync(path.join(fixturesDir, name), 'utf8'));
}

function buildTimeoutRun(overrides: Record<string, unknown> = {}) {
  return { ...loadFixture('timeout-run.json'), ...overrides };
}

describe('same-head timeout retry escalation (AC#4)', () => {
  it('extracts timeout_no_verdict from reviewer-evidence marker', () => {
    const terminationReason = [
      'reviewer-evidence:{"reviewer":{"effectiveBudgetMs":600000,"failureClass":"timeout_no_verdict"}}',
      'reviewer timeout before verdict (effectiveBudgetMs=600000, softDeadlineMs=510000)',
    ].join('\n');
    expect(extractReviewerFailureClass({ terminationReason, status: 'failed' })).toBe(
      TIMEOUT_NO_VERDICT_FAILURE_CLASS,
    );
  });

  it('honors zero as a valid timeout retry limit', () => {
    expect(resolveTimeoutRetryMax({ AO_CODEX_REVIEW_TIMEOUT_RETRY_MAX: '0' })).toBe(0);
    const runs = [buildTimeoutRun()];
    const state = evaluateTimeoutRetryEligibility(runs, runs[0].prNumber, runs[0].targetSha, {
      maxRetries: resolveTimeoutRetryMax({ AO_CODEX_REVIEW_TIMEOUT_RETRY_MAX: '0' }),
    });
    expect(state.retryEligible).toBe(false);
    expect(state.escalationReason).toBe(REPEATED_TIMEOUT_ESCALATION_REASON);
  });

  it('allows one retry after first timeout_no_verdict failure', () => {
    const scenario = loadFixture('timeout-repeated-scenario.json');
    const runs = [buildTimeoutRun()];
    const state = evaluateTimeoutRetryEligibility(
      runs,
      scenario.prNumber,
      scenario.headSha,
      { maxRetries: 1 },
    );
    expect(state.retryEligible).toBe(true);
    expect(state.escalationReason).toBeNull();
    expect(state.timeoutFailureCount).toBe(1);
  });

  it('escalates repeated timeout_no_verdict failures at review-start layer', () => {
    const scenario = loadFixture('timeout-repeated-scenario.json');
    const runs = [
      buildTimeoutRun(),
      buildTimeoutRun({
        id: scenario.repeatRunId,
        createdAt: '2026-06-20T01:00:00.000Z',
      }),
    ];
    const state = evaluateTimeoutRetryEligibility(
      runs,
      scenario.prNumber,
      scenario.headSha,
      { maxRetries: 1 },
    );
    expect(state.retryEligible).toBe(false);
    expect(state.escalationReason).toBe(REPEATED_TIMEOUT_ESCALATION_REASON);
    expect(state.timeoutFailureCount).toBe(2);

    const observed = buildFailedCancelledObserved(
      runs[1],
      scenario.prNumber,
      scenario.headSha,
      runs,
    );
    expect(observed.retryEligible).toBe(false);
    expect(observed.escalationReason).toBe(REPEATED_TIMEOUT_ESCALATION_REASON);
    expect(observed.failureClass).toBe(TIMEOUT_NO_VERDICT_FAILURE_CLASS);

    const gate = evaluateScenarioMatrixCell({
      claimWindow: 'free',
      reviewRuns: runs,
      prNumber: scenario.prNumber,
      headSha: scenario.headSha,
    });
    expect(gate.launch).toBe(false);
    expect(gate.reason).toBe('retry_bound_exhausted');
    expect(gate.coverage.escalationReason).toBe(REPEATED_TIMEOUT_ESCALATION_REASON);
  });

  it('does not label non-timeout retry exhaustion as repeated_timeout_no_verdict', () => {
    const runs = [
      {
        id: 'empty-fail',
        prNumber: 461,
        targetSha: 'abc46100000000000000000000000000000000000',
        status: 'failed',
        findingCount: 0,
        terminationReason: 'reviewer produced empty output',
        retryEligible: false,
        retryCount: 1,
        createdAt: '2026-06-20T00:00:00.000Z',
      },
    ];
    const gate = evaluateOrchestratorTurnGate({
      prNumber: 461,
      sessionId: 'opk-22',
      openPrs: [
        {
          number: 461,
          headRefOid: 'abc46100000000000000000000000000000000000',
          headCommittedAt: '2026-06-20T00:00:00.000Z',
        },
      ],
      reviewRuns: runs,
      sessions: [
        {
          name: 'opk-22',
          sessionId: 'opk-22',
          role: 'worker',
          prNumber: 461,
          status: 'ready_for_review',
          reports: [{ reportState: 'ready_for_review', reportedAt: '2026-06-20T00:00:00.000Z' }],
        },
      ],
      ciChecks: [{ name: 'Verify orchestrator-pack structure', state: 'SUCCESS' }],
      requiredCheckNames: ['Verify orchestrator-pack structure'],
      claimWindow: 'free',
      provenanceAutonomous: true,
    });
    expect(gate.launch).toBe(false);
    expect(gate.reason).toBe('retry_bound_exhausted');
    expect(gate.escalationReason).toBeUndefined();
  });

  it('counts only matching failure class on same head', () => {
    const runs = [
      {
        id: 'empty-fail',
        prNumber: 461,
        targetSha: 'abc46100000000000000000000000000000000000',
        status: 'failed',
        terminationReason: 'reviewer produced empty output',
        createdAt: '2026-06-20T00:00:00.000Z',
      },
      {
        id: 'timeout-fail',
        prNumber: 461,
        targetSha: 'abc46100000000000000000000000000000000000',
        status: 'failed',
        terminationReason:
          'reviewer-evidence:{"reviewer":{"effectiveBudgetMs":600000,"failureClass":"timeout_no_verdict"}}',
        createdAt: '2026-06-20T01:00:00.000Z',
      },
    ];
    expect(
      countSameHeadFailuresByClass(
        runs,
        461,
        'abc46100000000000000000000000000000000000',
        TIMEOUT_NO_VERDICT_FAILURE_CLASS,
      ),
    ).toBe(1);
  });
});
