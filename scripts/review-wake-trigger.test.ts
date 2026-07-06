import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isCompletionMergeIntentWake } from '../docs/orchestrator-wake-filter.mjs';
import { planReconcileActions, unwrapReconcilePlanResult } from '../docs/review-trigger-reconcile.mjs';
import {
  WAKE_TO_RUN_DECISION_MAX_MS,
  amendMergeWakeMessage,
  buildReviewRunArgv,
  evaluateMergeIntentAfterReviewTrigger,
  evaluateWakePreRunRecheck,
  evaluateWakeReviewTrigger,
  findForbiddenReviewWakeCommands,
  isCompletionMergeIntentWake as isCompletionWakeFromTrigger,
} from '../docs/review-wake-trigger.mjs';

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../tests/fixtures/review-wake-trigger',
);

type WakeFixture = {
  wakeKind?: string;
  sessionId?: string;
  prNumber?: number;
  openPrs?: Array<{ number: number; headRefOid: string }>;
  reviewRuns?: Array<Record<string, unknown>>;
  sessions?: Array<Record<string, unknown>>;
  ciChecksByPr?: Record<string, Array<{ name: string; state: string }>>;
  requiredCheckNamesByPr?: Record<string, string[]>;
  requiredCheckLookupFailedByPr?: Record<string, boolean>;
  expect?: Record<string, unknown>;
  planned?: { prNumber: number; headSha: string; sessionId: string };
  fresh?: Record<string, unknown>;
};

function loadFixture(name: string): WakeFixture {
  return JSON.parse(readFileSync(path.join(fixturesDir, name), 'utf8')) as WakeFixture;
}

function evaluateFixture(fixture: WakeFixture, nowMs = Date.now()) {
  const prKey = String(fixture.prNumber);
  return evaluateWakeReviewTrigger({
    wakeKind: fixture.wakeKind,
    sessionId: fixture.sessionId,
    prNumber: fixture.prNumber,
    wakeReceivedMs: nowMs,
    nowMs,
    openPrs: fixture.openPrs,
    reviewRuns: fixture.reviewRuns,
    sessions: fixture.sessions,
    ciChecks: fixture.ciChecksByPr?.[prKey],
    requiredCheckNames: fixture.requiredCheckNamesByPr?.[prKey],
    requiredCheckLookupFailed: fixture.requiredCheckLookupFailedByPr?.[prKey],
  });
}

describe('completion wake classification', () => {
  it('treats merge.ready as completion merge-intent wake', () => {
    expect(isCompletionMergeIntentWake('merge.ready')).toBe(true);
    expect(isCompletionWakeFromTrigger('merge.ready')).toBe(true);
    expect(isCompletionMergeIntentWake('ready_for_review')).toBe(false);
    expect(isCompletionMergeIntentWake('heartbeat.reconcile')).toBe(false);
  });
});

describe('evaluateWakeReviewTrigger', () => {
  it('Issue #207 (1): event-causal trigger on completion wake for ready head', () => {
    const fixture = loadFixture('green-wake-triggers.json');
    const now = 1_700_000_000_000;
    const result = evaluateFixture(fixture, now);
    expect(result.triggerReviewRun).toBe(true);
    expect(result.withinLatencyBound).toBe(true);
    expect(result.processingMs).toBeLessThanOrEqual(WAKE_TO_RUN_DECISION_MAX_MS);
    expect(result.planned).toMatchObject({
      prNumber: 204,
      headSha: 'cafe204',
      sessionId: 'opk-11',
    });
  });

  it('Issue #207 (1): non-completion wake does not trigger', () => {
    const fixture = loadFixture('green-wake-triggers.json');
    const result = evaluateWakeReviewTrigger({
      wakeKind: 'ci.failing',
      sessionId: 'opk-11',
      prNumber: 204,
      openPrs: fixture.openPrs,
      reviewRuns: [],
      sessions: fixture.sessions,
      ciChecks: fixture.ciChecksByPr?.['204'],
    });
    expect(result.triggerReviewRun).toBe(false);
    expect(result.reason).toBe('not_event_wake');
  });

  it('Issue #207 (2): pending CI eligible when wake arrives', () => {
    const fixture = loadFixture('pending-ci-on-wake.json');
    expect(evaluateFixture(fixture).triggerReviewRun).toBe(true);
  });

  it('Issue #207 (2): red CI defers', () => {
    const fixture = loadFixture('red-ci-defer.json');
    const result = evaluateFixture(fixture);
    expect(result.triggerReviewRun).toBe(false);
    expect(result.reason).toBe('ci_red_defer');
  });

  it('Issue #207 (2): missing required checks route to degraded CI', () => {
    const fixture = loadFixture('missing-ci-degraded.json');
    const result = evaluateFixture(fixture);
    expect(result.triggerReviewRun).toBe(false);
    expect(result.route).toBe('degraded_ci_retry');
  });

  it('Issue #207 (3): covered head skips trigger', () => {
    const fixture = loadFixture('covered-head-skip.json');
    const result = evaluateFixture(fixture);
    expect(result.triggerReviewRun).toBe(false);
    expect(result.reason).toBe('head_covered');
  });

  it('Issue #207 (4): failed run precedence routes to EMPTY REVIEW TRAP', () => {
    const fixture = loadFixture('failed-precedence.json');
    const result = evaluateFixture(fixture);
    expect(result.triggerReviewRun).toBe(false);
    expect(result.route).toBe('empty_review_trap');
    expect(result.failureDetail).toContain('reviewer command exited');
  });

  it('review trigger failure reason annotates merge wake as non-mergeable', () => {
    const amended = amendMergeWakeMessage('wake merge.ready session=opk-1 pr=#1', {
      mergeable: false,
      reason: 'review_trigger_failed',
    });
    expect(amended).toContain('mergeable=false');
    expect(amended).toContain('review_trigger_failed');
  });

  it('empty-review trap annotates merge intent as non-mergeable', () => {
    const fixture = loadFixture('failed-precedence.json');
    const mergeEval = evaluateMergeIntentAfterReviewTrigger({
      prNumber: fixture.prNumber!,
      headSha: 'fail214',
      reviewRuns: fixture.reviewRuns!,
    });
    expect(mergeEval.mergeable).toBe(false);
    expect(mergeEval.reason).toBe('no_covered_terminal_run');
    const amended = amendMergeWakeMessage(
      'wake merge.ready session=opk-fail pr=#214',
      mergeEval,
    );
    expect(amended).toContain('mergeable=false');
    expect(amended).toContain('no_covered_terminal_run');
  });

  it('Issue #207 (8): incident 2026-06-05 would fast-trigger instead of heartbeat', () => {
    const fixture = loadFixture('incident-2026-06-05.json');
    const result = evaluateFixture(fixture);
    expect(result.triggerReviewRun).toBe(true);
    expect(fixture.expect?.beatsHeartbeatBackstop).toBe(true);
  });
});

describe('evaluateWakePreRunRecheck', () => {
  it('Issue #207 (5): aborts when head advances before run', () => {
    const fixture = loadFixture('head-advanced-abort.json');
    const result = evaluateWakePreRunRecheck({
      planned: fixture.planned!,
      fresh: fixture.fresh!,
    });
    expect(result.emitReviewRun).toBe(false);
    expect(result.reason).toBe('pre_run_recheck_head_advanced');
  });

  it('pre-run abort merge intent uses fresh head and defers merge', () => {
    const fixture = loadFixture('head-advanced-abort.json');
    const mergeEval = evaluateMergeIntentAfterReviewTrigger({
      prNumber: fixture.planned!.prNumber,
      headSha: 'new216',
      reviewRuns: [],
    });
    expect(mergeEval.mergeable).toBe(false);
    expect(mergeEval.reason).toBe('no_covered_terminal_run');
  });
});

describe('evaluateMergeIntentAfterReviewTrigger', () => {
  it('covered-terminal clean is mergeable when reviewDecision is none', () => {
    const fixture = loadFixture('covered-head-skip.json');
    const mergeEval = evaluateMergeIntentAfterReviewTrigger({
      prNumber: fixture.prNumber!,
      headSha: 'cov213',
      reviewRuns: fixture.reviewRuns!,
    });
    expect(mergeEval.mergeable).toBe(true);
    expect(mergeEval.reason).toBe('covered_terminal_run');
    expect(amendMergeWakeMessage('wake merge.ready session=opk-covered pr=#213', mergeEval)).toBe(
      'wake merge.ready session=opk-covered pr=#213',
    );
  });

  it('waiting_update covered head is not mergeable', () => {
    const fixture = loadFixture('waiting-update-not-mergeable.json');
    const evalResult = evaluateFixture(fixture);
    expect(evalResult.triggerReviewRun).toBe(false);
    expect(evalResult.reason).toBe('head_covered');
    const mergeEval = evaluateMergeIntentAfterReviewTrigger({
      prNumber: fixture.prNumber!,
      headSha: 'wait216',
      reviewRuns: fixture.reviewRuns!,
    });
    expect(mergeEval.mergeable).toBe(false);
    expect(mergeEval.reason).toBe('waiting_update_revalidate');
    const amended = amendMergeWakeMessage(
      'wake merge.ready session=opk-wait pr=#216',
      mergeEval,
    );
    expect(amended).toContain('mergeable=false');
    expect(amended).toContain('waiting_update_revalidate');
  });

  it('webhook sessionId fallback rejects non-live workers', () => {
    const fixture = loadFixture('non-live-fallback-session.json');
    const result = evaluateFixture(fixture);
    expect(result.triggerReviewRun).toBe(false);
    expect(result.reason).toBe('no_worker_session');
  });

  it('side-effect fence busy treats in-flight review as non-mergeable', () => {
    const fixture = loadFixture('merge-intent-ordering.json');
    const headSha = evaluateFixture(fixture).planned!.headSha;
    const mergeEval = evaluateMergeIntentAfterReviewTrigger({
      prNumber: fixture.prNumber!,
      headSha,
      reviewRuns: [
        ...(fixture.reviewRuns ?? []),
        {
          prNumber: fixture.prNumber,
          targetSha: headSha,
          status: 'queued',
        },
      ],
    });
    expect(mergeEval.mergeable).toBe(false);
    expect(mergeEval.reason).toBe('review_in_flight_revalidate');
  });

  it('Issue #207 (6): merge intent defers while review is in flight', () => {
    const fixture = loadFixture('merge-intent-ordering.json');
    const evalResult = evaluateFixture(fixture);
    expect(evalResult.triggerReviewRun).toBe(true);
    const headSha = evalResult.planned!.headSha;
    const mergeEval = evaluateMergeIntentAfterReviewTrigger({
      prNumber: fixture.prNumber!,
      headSha,
      reviewRuns: [
        {
          prNumber: fixture.prNumber,
          targetSha: headSha,
          status: 'queued',
        },
      ],
    });
    expect(mergeEval.mergeable).toBe(false);
    expect(mergeEval.reason).toBe('review_in_flight_revalidate');
    const amended = amendMergeWakeMessage(
      'wake merge.ready session=opk-merge pr=#215',
      mergeEval,
    );
    expect(amended).toContain('mergeable=false');
    expect(amended).toContain('review_in_flight_revalidate');
  });
});

describe('findForbiddenReviewWakeCommands', () => {
  it('Issue #623: forbids legacy ao review run; allows ao-review shim', () => {
    expect(findForbiddenReviewWakeCommands(['ao-review run opk-11'])).toHaveLength(0);

    const violations = findForbiddenReviewWakeCommands([
      'ao review run opk-11 --execute --command ./scripts/run-pack-review.ps1',
      'ao spawn worker',
      'ao send opk-11 ping',
      'gh pr merge 1',
      'ao session kill opk-11',
      'ao review run x --claim-pr',
    ]);
    expect(violations.length).toBeGreaterThanOrEqual(6);
    expect(
      violations.some((entry) => entry.command.includes('gh pr merge')),
    ).toBe(true);
  });
});

describe('residual race benign-ness', () => {
  it('Issue #207 (5): concurrent observers produce at most redundant run for correct head', () => {
    const fixture = loadFixture('green-wake-triggers.json');
    const wake = evaluateFixture(fixture);
    const reconcile = unwrapReconcilePlanResult(planReconcileActions({
      openPrs: fixture.openPrs!,
      reviewRuns: fixture.reviewRuns!,
      sessions: fixture.sessions!,
      ciChecksByPr: fixture.ciChecksByPr,
    })).actions;
    expect(wake.triggerReviewRun).toBe(true);
    expect(reconcile.filter((a) => a.type === 'start_review')).toHaveLength(1);
    const wakeHead = wake.planned!.headSha;
    const reconcileHead = reconcile.find((a) => a.type === 'start_review')?.headSha;
    expect(reconcileHead).toBe(wakeHead);
  });
});

describe('buildReviewRunArgv', () => {
  it('binds trigger to ao-review shim for worker session', () => {
    expect(buildReviewRunArgv('opk-11', './scripts/run-pack-review.ps1')).toEqual([
      'ao-review',
      'run',
      'opk-11',
    ]);
  });
});

describe('latency bound', () => {
  it('fails fixtures that defer past WAKE_TO_RUN_DECISION_MAX_MS', () => {
    const fixture = loadFixture('green-wake-triggers.json');
    const wakeReceivedMs = 1_700_000_000_000;
    const late = evaluateWakeReviewTrigger({
      wakeKind: fixture.wakeKind,
      sessionId: fixture.sessionId,
      prNumber: fixture.prNumber,
      wakeReceivedMs,
      nowMs: wakeReceivedMs + WAKE_TO_RUN_DECISION_MAX_MS + 1,
      openPrs: fixture.openPrs,
      reviewRuns: fixture.reviewRuns,
      sessions: fixture.sessions,
      ciChecks: fixture.ciChecksByPr?.['204'],
    });
    expect(late.withinLatencyBound).toBe(false);
  });
});
