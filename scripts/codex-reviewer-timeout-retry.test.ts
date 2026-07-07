import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { evaluateTimeoutRetryEligibility } from '../docs/codex-reviewer-timeout-retry.mjs';
import * as timeoutRetryCompat from '../docs/codex-reviewer-timeout-retry.mjs';
import * as reviewerFailureEvidenceMarkers from '../docs/reviewer-failure-evidence-markers.mjs';
import {
  countSameHeadFailuresByClass,
  extractReviewerFailureClass,
  REPEATED_TIMEOUT_ESCALATION_REASON,
  resolveTimeoutRetryMax,
  TIMEOUT_NO_VERDICT_FAILURE_CLASS,
} from '../docs/reviewer-failure-evidence-markers.mjs';
import {
  evaluateOrchestratorTurnGate,
  evaluateScenarioMatrixCell,
} from '../docs/orchestrator-claimed-review-run.mjs';
import { buildFailedCancelledObserved } from '../docs/review-head-ready.mjs';
import {
  evaluateWakeReviewTrigger,
  type AoSession,
  type OpenPr,
  type ReviewRun,
} from '../docs/review-wake-trigger.mjs';

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'codex-reviewer-timeout-retry',
);

type WakeFixture = {
  wakeKind?: string;
  sessionId?: string;
  prNumber?: number;
  headRefOid?: string;
  headCommittedAt?: string;
  reportedAt?: string;
  openPrs?: OpenPr[];
  reviewRuns?: ReviewRun[];
  sessions?: AoSession[];
  ciChecksByPr?: Record<string, Array<{ name: string; state: string }>>;
};

type WakeCommonFixture = {
  wakeKind: string;
  sessionId: string;
  prNumber: number;
  headRefOid: string;
  ciChecksByPr: Record<string, Array<{ name: string; state: string }>>;
};

type WakeScenarioFixture = WakeFixture & {
  description?: string;
  expect?: Record<string, unknown>;
};

const wakeCommonFixture = JSON.parse(
  readFileSync(path.join(fixturesDir, 'timeout-wake-common.json'), 'utf8'),
) as WakeCommonFixture;

function loadWakeFixture(name: string): WakeFixture {
  const scenario = JSON.parse(
    readFileSync(path.join(fixturesDir, name), 'utf8'),
  ) as WakeScenarioFixture;
  const headCommittedAt = scenario.headCommittedAt ?? '2026-06-20T00:00:00.000Z';
  const reportedAt = scenario.reportedAt ?? headCommittedAt;
  return {
    wakeKind: wakeCommonFixture.wakeKind,
    sessionId: wakeCommonFixture.sessionId,
    prNumber: wakeCommonFixture.prNumber,
    openPrs: [
      {
        number: wakeCommonFixture.prNumber,
        headRefOid: wakeCommonFixture.headRefOid,
        headCommittedAt,
      },
    ],
    reviewRuns: scenario.reviewRuns,
    sessions: [
      {
        name: wakeCommonFixture.sessionId,
        role: 'worker',
        prNumber: wakeCommonFixture.prNumber,
        status: 'working',
        reports: [{ reportState: 'ready_for_review', reportedAt }],
      },
    ],
    ciChecksByPr: wakeCommonFixture.ciChecksByPr,
  };
}

function evaluateWakeFixture(fixture: WakeFixture) {
  const prKey = String(fixture.prNumber);
  return evaluateWakeReviewTrigger({
    wakeKind: fixture.wakeKind,
    sessionId: fixture.sessionId,
    prNumber: fixture.prNumber,
    openPrs: fixture.openPrs,
    reviewRuns: fixture.reviewRuns,
    sessions: fixture.sessions,
    ciChecks: fixture.ciChecksByPr?.[prKey],
  });
}

function loadFixture(name: string) {
  return JSON.parse(readFileSync(path.join(fixturesDir, name), 'utf8'));
}

function buildTimeoutRun(overrides: Record<string, unknown> = {}) {
  return { ...loadFixture('timeout-run.json'), ...overrides };
}

describe('same-head timeout retry escalation (AC#4)', () => {
  it('re-exports reviewer-failure-evidence marker symbols for backward compatibility', () => {
    expect(timeoutRetryCompat.TIMEOUT_NO_VERDICT_FAILURE_CLASS).toBe(
      reviewerFailureEvidenceMarkers.TIMEOUT_NO_VERDICT_FAILURE_CLASS,
    );
    expect(timeoutRetryCompat.REPEATED_TIMEOUT_ESCALATION_REASON).toBe(
      reviewerFailureEvidenceMarkers.REPEATED_TIMEOUT_ESCALATION_REASON,
    );
    expect(timeoutRetryCompat.REVIEWER_EVIDENCE_PREFIX).toBe(
      reviewerFailureEvidenceMarkers.REVIEWER_EVIDENCE_PREFIX,
    );
    expect(timeoutRetryCompat.DEFAULT_TIMEOUT_RETRY_MAX).toBe(
      reviewerFailureEvidenceMarkers.DEFAULT_TIMEOUT_RETRY_MAX,
    );
    expect(timeoutRetryCompat.resolveTimeoutRetryMax).toBe(
      reviewerFailureEvidenceMarkers.resolveTimeoutRetryMax,
    );
    expect(timeoutRetryCompat.extractReviewerEvidenceFromText).toBe(
      reviewerFailureEvidenceMarkers.extractReviewerEvidenceFromText,
    );
    expect(timeoutRetryCompat.extractReviewerFailureClass).toBe(
      reviewerFailureEvidenceMarkers.extractReviewerFailureClass,
    );
    expect(timeoutRetryCompat.countSameHeadFailuresByClass).toBe(
      reviewerFailureEvidenceMarkers.countSameHeadFailuresByClass,
    );
  });

  it('extracts timeout_no_verdict from reviewer-evidence marker', () => {
    const terminationReason = [
      'reviewer-evidence:{"reviewer":{"effectiveBudgetMs":600000,"failureClass":"timeout_no_verdict"}}',
      'reviewer timeout before verdict (effectiveBudgetMs=600000, softDeadlineMs=510000)',
    ].join('\n');
    expect(extractReviewerFailureClass({ body: terminationReason, status: 'failed' })).toBe(
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
        body: 'reviewer produced empty output',
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


  it('allows wake start after first timeout_no_verdict failure', () => {
    const fixture = loadWakeFixture('timeout-first-wake-retry.json');
    const result = evaluateWakeFixture(fixture);
    expect(result.triggerReviewRun).toBe(true);
    expect(result.route).toBe('start_review');
  });

  it('escalates repeated timeout_no_verdict at wake start', () => {
    const fixture = loadWakeFixture('timeout-repeated-wake-trap.json');
    const result = evaluateWakeFixture(fixture);
    expect(result.triggerReviewRun).toBe(false);
    expect(result.reason).toBe('retry_bound_exhausted');
    expect(result.route).toBe('empty_review_trap');
    expect(result.escalationReason).toBe(REPEATED_TIMEOUT_ESCALATION_REASON);
  });

  it('does not allow wake retry for non-timeout failures without explicit retryEligible', () => {
    const result = evaluateWakeReviewTrigger({
      wakeKind: 'merge.ready',
      sessionId: 'opk-fail',
      prNumber: 214,
      openPrs: [
        {
          number: 214,
          headRefOid: 'fail214',
          headCommittedAt: '2026-06-05T12:00:00.000Z',
        },
      ],
      reviewRuns: [
        {
          id: 'run-failed',
          prNumber: 214,
          targetSha: 'fail214',
          status: 'failed',
          findingCount: 0,
          body: 'reviewer command exited 1',
        },
      ],
      sessions: [
        {
          name: 'opk-fail',
          role: 'worker',
          prNumber: 214,
          reports: [{ reportState: 'ready_for_review', reportedAt: '2026-06-05T12:00:00.000Z' }],
        },
      ],
      ciChecks: [{ name: 'Verify orchestrator-pack structure', state: 'SUCCESS' }],
    });
    expect(result.triggerReviewRun).toBe(false);
    expect(result.route).toBe('empty_review_trap');
    expect(result.failureDetail).toContain('reviewer command exited');
  });

  it('counts only matching failure class on same head', () => {
    const runs = [
      {
        id: 'empty-fail',
        prNumber: 461,
        targetSha: 'abc46100000000000000000000000000000000000',
        status: 'failed',
        body: 'reviewer produced empty output',
        createdAt: '2026-06-20T00:00:00.000Z',
      },
      {
        id: 'timeout-fail',
        prNumber: 461,
        targetSha: 'abc46100000000000000000000000000000000000',
        status: 'failed',
        body:
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
