import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { evaluateWakePayload } from '../docs/orchestrator-wake-filter.mjs';
import { planReconcileActions, unwrapReconcilePlanResult, type OpenPr } from '../docs/review-trigger-reconcile.mjs';
import {
  DEFERRED_WATCH_WINDOW_MS,
  INCIDENT_WAKE_TO_READINESS_DELAY_MS,
  READINESS_TO_RUN_DECISION_MAX_MS,
  SCOPED_DEFERRED_HEAD_WATCH_POLL_CLASS,
  createWatchEntry,
  detectReadinessTransition,
  evaluateBackstopOnlyZeroSignal,
  evaluateDeferredWatchEntry,
  evaluateHeadReviewTriggerDecision,
  evaluateReadyForReviewNotificationCapture,
  findForbiddenReviewReevalCommands,
  isDeferredNotReadySeedEligible,
  isWatchWindowNonConformant,
  mergeWatchState,
  planDeferredWatchTick,
  resolveMergedWatchStatus,
  revertTriggeredWatchOnAbort,
  seedWatchFromInProgressSignals,
  seedWatchFromWakeDefer,
  watchEntryKey,
  type ReevalWatchAction,
} from '../docs/review-trigger-reeval.mjs';
import { evaluateWakeReviewTrigger } from '../docs/review-wake-trigger.mjs';

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../tests/fixtures/review-trigger-reeval',
);
const captureDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../tests/external-output-references/captures/ao-webhook-notification',
);

type ReevalFixture = {
  description?: string;
  prNumber?: number;
  headSha?: string;
  sessionId?: string;
  nowMs?: number;
  readinessObservedMs?: number;
  openPrs?: Array<Record<string, unknown>>;
  reviewRuns?: Array<Record<string, unknown>>;
  sessions?: Array<Record<string, unknown>>;
  ciChecksByPr?: Record<string, Array<{ name: string; state: string }>>;
  requiredCheckNamesByPr?: Record<string, string[]>;
  requiredCheckLookupFailedByPr?: Record<string, boolean>;
  watchEntries?: Record<string, Record<string, unknown>>;
  snapshotErrorsByKey?: Record<string, boolean>;
  hadCompletionWake?: boolean;
  entryPaths?: string[];
  customWindowMs?: number;
  expect?: Record<string, unknown>;
};

function asOpenPrs(value: ReevalFixture['openPrs']): OpenPr[] | undefined {
  return value as unknown as OpenPr[] | undefined;
}

function loadFixture(name: string): ReevalFixture {
  return JSON.parse(readFileSync(path.join(fixturesDir, name), 'utf8')) as ReevalFixture;
}

function prKey(fixture: ReevalFixture) {
  return String(fixture.prNumber ?? fixture.openPrs?.[0]?.number ?? '');
}

function evaluateFixtureVerdict(fixture: ReevalFixture, entryPath = 'scoped_deferred_head_watch') {
  const key = prKey(fixture);
  return evaluateHeadReviewTriggerDecision({
    prNumber: Number(fixture.prNumber ?? fixture.openPrs?.[0]?.number),
    headSha: String(fixture.headSha ?? fixture.openPrs?.[0]?.headRefOid ?? ''),
    sessionId: fixture.sessionId,
    readinessObservedMs: fixture.readinessObservedMs ?? fixture.nowMs ?? Date.now(),
    nowMs: fixture.nowMs ?? Date.now(),
    openPrs: asOpenPrs(fixture.openPrs),
    reviewRuns: fixture.reviewRuns,
    sessions: fixture.sessions,
    ciChecks: fixture.ciChecksByPr?.[key],
    requiredCheckNames: fixture.requiredCheckNamesByPr?.[key],
    requiredCheckLookupFailed: fixture.requiredCheckLookupFailedByPr?.[key],
    entryPath,
  });
}

function planFixtureTick(fixture: ReevalFixture) {
  const nowMs = fixture.nowMs ?? Date.now();
  return planDeferredWatchTick({
    watchEntries: fixture.watchEntries ?? {},
    openPrs: asOpenPrs(fixture.openPrs),
    reviewRuns: fixture.reviewRuns,
    sessions: fixture.sessions,
    ciChecksByPr: fixture.ciChecksByPr,
    requiredCheckNamesByPr: fixture.requiredCheckNamesByPr,
    requiredCheckLookupFailedByPr: fixture.requiredCheckLookupFailedByPr,
    nowMs,
    snapshotErrorsByKey: fixture.snapshotErrorsByKey,
  });
}

describe('review-trigger-reeval constants and helpers', () => {
  it('documents incident delay and conformant watch window', () => {
    expect(INCIDENT_WAKE_TO_READINESS_DELAY_MS).toBe(77_000);
    expect(DEFERRED_WATCH_WINDOW_MS).toBe(300_000);
    expect(DEFERRED_WATCH_WINDOW_MS).toBeGreaterThan(INCIDENT_WAKE_TO_READINESS_DELAY_MS);
    expect(isWatchWindowNonConformant(30_000)).toBe(true);
    expect(isWatchWindowNonConformant(DEFERRED_WATCH_WINDOW_MS)).toBe(false);
    expect(SCOPED_DEFERRED_HEAD_WATCH_POLL_CLASS).toBe('scoped_deferred_head_watch');
  });

  it('watchEntryKey normalizes sha', () => {
    expect(watchEntryKey(235, 'ABC235')).toBe('235:abc235');
  });

  it('isDeferredNotReadySeedEligible accepts no_ready_for_review only', () => {
    expect(isDeferredNotReadySeedEligible('uncovered_not_ready', { primary: 'no_ready_for_review' })).toBe(true);
    expect(isDeferredNotReadySeedEligible('ci_red_defer', { primary: 'ci_red' })).toBe(false);
    expect(isDeferredNotReadySeedEligible('head_covered', { primary: 'head_covered' })).toBe(false);
  });

  it('createWatchEntry stamps poll class and window', () => {
    const entry = createWatchEntry({
      prNumber: 235,
      headSha: 'abc',
      sessionId: 'opk-28',
      nowMs: 1_000,
      seedSource: 'wake_defer',
    });
    expect(entry.pollClass).toBe(SCOPED_DEFERRED_HEAD_WATCH_POLL_CLASS);
    expect(entry.windowExpiresMs - entry.seedMs).toBe(DEFERRED_WATCH_WINDOW_MS);
  });
});

describe('Issue #235 acceptance criteria', () => {
  it('(1) closes ordering race: deferred wake then readiness triggers run without backstop', () => {
    const fixture = loadFixture('wake-before-ready-then-ready.json');
    const plan = planFixtureTick(fixture);
    const starts = plan.actions.filter((a: ReevalWatchAction) => a.type === 'start_review');
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ prNumber: 235, headSha: 'abc235' });
    expect(plan.pollClass).toBe(SCOPED_DEFERRED_HEAD_WATCH_POLL_CLASS);
  });

  it('(2) seconds-scale bound is falsifiable', () => {
    const fixture = loadFixture('seconds-scale-bound.json');
    const verdict = evaluateFixtureVerdict(fixture);
    expect(verdict.triggerReviewRun).toBe(true);
    expect(verdict.processingMs).toBeLessThanOrEqual(READINESS_TO_RUN_DECISION_MAX_MS);
    expect(verdict.withinLatencyBound).toBe(true);
  });

  it('(3) capture-backed AO ready_for_review notification at info priority is promoted (Issue #381)', () => {
    const capture = JSON.parse(
      readFileSync(path.join(captureDir, 'ready_for_review.raw.json'), 'utf8'),
    );
    const evalCapture = evaluateReadyForReviewNotificationCapture(capture);
    expect(evalCapture.emitsNotification).toBe(true);
    expect(evalCapture.priority).toBe('info');

    const admissionContext = {
      supervisedProjectId: 'orchestrator-pack',
      supervisedRepoSlug: 'chetwerikoff/orchestrator-pack',
      openPrs: [{ number: 234, headRefOid: 'handoff234', baseRefName: 'main' }],
    };
    const wake = evaluateWakePayload(capture, admissionContext);
    expect(wake.ok).toBe(true);
    if (wake.ok) {
      expect(wake.wakeKind).toBe('ready_for_review');
      expect(wake.handoffAdmission?.promotedFromInfoPriority).toBe(true);
    }

    const actionCapture = JSON.parse(
      readFileSync(path.join(captureDir, 'ready_for_review.action-priority.raw.json'), 'utf8'),
    );
    const actionWake = evaluateWakePayload(actionCapture, admissionContext);
    expect(actionWake.ok).toBe(true);
  });

  it('(4a) head churn: deferred SHA still head and ready → run', () => {
    const fixture = loadFixture('head-churn-still-head-ready.json');
    expect(evaluateFixtureVerdict(fixture).triggerReviewRun).toBe(true);
  });

  it('(4b) head churn: advanced past deferred SHA → discard', () => {
    const fixture = loadFixture('head-churn-advanced-past.json');
    const verdict = evaluateFixtureVerdict(fixture);
    expect(verdict.triggerReviewRun).toBe(false);
    expect(verdict.reason).toBe('stale_deferred_head_discarded');
  });

  it('(4c) head churn: new head not ready → defer, retain watch', () => {
    const fixture = loadFixture('head-churn-new-head-not-ready.json');
    const verdict = evaluateFixtureVerdict(fixture);
    expect(verdict.triggerReviewRun).toBe(false);
    expect(verdict.reason).toBe('uncovered_not_ready');
    expect(verdict.retainWatch).toBe(true);
  });

  it('(4) red CI and degraded CI defer paths', () => {
    const red = evaluateFixtureVerdict(loadFixture('red-ci-defer.json'));
    expect(red.triggerReviewRun).toBe(false);
    expect(red.reason).toBe('ci_red_defer');

    const degraded = evaluateFixtureVerdict(loadFixture('missing-ci-degraded.json'));
    expect(degraded.triggerReviewRun).toBe(false);
    expect(degraded.route).toBe('degraded_ci_retry');
  });

  it('(5) dedupe: covered head produces no new run', () => {
    const fixture = loadFixture('dedupe-covered.json');
    expect(evaluateFixtureVerdict(fixture).triggerReviewRun).toBe(false);
    expect(evaluateFixtureVerdict(fixture).reason).toBe('head_covered');
  });

  it('(5) concurrent observers: in-flight on correct head is benign no-op', () => {
    const fixture = loadFixture('concurrent-observers-benign.json');
    const verdict = evaluateFixtureVerdict(fixture);
    expect(verdict.triggerReviewRun).toBe(false);
    expect(verdict.reason).toBe('head_covered');
  });

  it('(6) failed/cancelled precedence routes to empty review trap', () => {
    const fixture = loadFixture('failed-cancelled-precedence.json');
    const plan = planFixtureTick(fixture);
    expect(plan.actions.some((a: ReevalWatchAction) => a.type === 'empty_review_trap')).toBe(true);
    expect(plan.actions.some((a: ReevalWatchAction) => a.type === 'start_review')).toBe(false);
  });

  it('(7) bounded never-ready hands to backstop without duplicate runs', () => {
    const fixture = loadFixture('bounded-never-ready.json');
    const plan = planFixtureTick(fixture);
    expect(plan.actions.filter((a: ReevalWatchAction) => a.type === 'start_review')).toHaveLength(0);
    expect(plan.actions.some((a: ReevalWatchAction) => a.type === 'hand_to_backstop')).toBe(true);
  });

  it('(8) review-run-only scope: forbidden lifecycle commands', () => {
    const violations = findForbiddenReviewReevalCommands([
      'ao spawn worker',
      'ao review run opk-1 --execute --command codex',
      'ao send opk-1 ping',
      'gh pr merge 1',
    ]);
    expect(violations.length).toBeGreaterThan(0);
    expect(findForbiddenReviewReevalCommands(['gh pr merge 1'])).toHaveLength(1);
    expect(
      findForbiddenReviewReevalCommands([
        'ao review run opk-1 --execute --command codex',
      ]),
    ).toHaveLength(0);
  });

  it('(9) restart-durable watch survives and triggers on readiness', () => {
    const fixture = loadFixture('restart-durable-defer-before-ready.json');
    const plan = planFixtureTick(fixture);
    expect(plan.actions.filter((a: ReevalWatchAction) => a.type === 'start_review')).toHaveLength(1);
  });

  it('(11b) readiness during downtime: recovery re-read triggers run', () => {
    const fixture = loadFixture('readiness-during-downtime.json');
    const plan = planFixtureTick(fixture);
    expect(plan.actions.filter((a: ReevalWatchAction) => a.type === 'start_review')).toHaveLength(1);
  });

  it('(12) delayed readiness >=77s within window still triggers', () => {
    const fixture = loadFixture('delayed-readiness-77s.json');
    const seedMs = Number(fixture.watchEntries?.['235:late235']?.seedMs);
    const nowMs = Number(fixture.nowMs);
    expect(nowMs - seedMs).toBeGreaterThanOrEqual(INCIDENT_WAKE_TO_READINESS_DELAY_MS);
    const plan = planFixtureTick(fixture);
    expect(plan.actions.filter((a: ReevalWatchAction) => a.type === 'start_review')).toHaveLength(1);
  });

  it('(12) non-conformant short window hands to backstop', () => {
    const fixture = loadFixture('non-conformant-short-window.json');
    expect(isWatchWindowNonConformant(fixture.customWindowMs)).toBe(true);
    const plan = planFixtureTick(fixture);
    expect(plan.actions.some((a: ReevalWatchAction) => a.type === 'hand_to_backstop')).toBe(true);
  });

  it('(13) idempotent verdict across entry paths', () => {
    const fixture = loadFixture('idempotent-verdict.json');
    const paths = fixture.entryPaths ?? ['scoped_deferred_head_watch'];
    const verdicts = paths.map((entryPath) => evaluateFixtureVerdict(fixture, entryPath));
    for (const verdict of verdicts) {
      expect(verdict.triggerReviewRun).toBe(true);
      expect(verdict.reason).toBe('head_ready_for_review');
    }
    const covered = evaluateHeadReviewTriggerDecision({
      prNumber: 235,
      headSha: 'idem235',
      sessionId: 'opk-28',
      nowMs: fixture.nowMs,
      openPrs: asOpenPrs(fixture.openPrs),
      reviewRuns: [{ prNumber: 235, targetSha: 'idem235', status: 'clean' }],
      sessions: fixture.sessions,
      ciChecks: fixture.ciChecksByPr?.['235'],
      entryPath: 'reapply',
    });
    expect(covered.triggerReviewRun).toBe(false);
    expect(covered.reason).toBe('head_covered');
  });

  it('(14) dropped wake with in-progress seed converges seconds-scale', () => {
    const fixture = loadFixture('dropped-wake-in-progress-seed.json');
    const seed = seedWatchFromInProgressSignals({
      openPrs: asOpenPrs(fixture.openPrs),
      reviewRuns: fixture.reviewRuns,
      sessions: fixture.sessions,
      existingWatches: fixture.watchEntries,
      nowMs: fixture.nowMs,
    });
    expect(seed.seededKeys.length).toBeGreaterThan(0);
    const readySessions = [
      {
        ...fixture.sessions![0],
        reports: [
          ...(fixture.sessions![0].reports as Array<Record<string, unknown>>),
          { reportState: 'ready_for_review', reportedAt: '2026-06-05T14:16:40.000Z' },
        ],
      },
    ];
    const plan = planDeferredWatchTick({
      watchEntries: seed.watchEntries,
      openPrs: asOpenPrs(fixture.openPrs),
      reviewRuns: fixture.reviewRuns,
      sessions: readySessions,
      ciChecksByPr: fixture.ciChecksByPr,
      nowMs: Number(fixture.nowMs) + 2_000,
    });
    expect(plan.actions.filter((a: ReevalWatchAction) => a.type === 'start_review')).toHaveLength(1);
  });

  it('reverts triggered watch when pre-run abort retains watch', () => {
    const fixture = loadFixture('dropped-wake-in-progress-seed.json');
    const seed = seedWatchFromInProgressSignals({
      openPrs: asOpenPrs(fixture.openPrs),
      reviewRuns: fixture.reviewRuns,
      sessions: fixture.sessions,
      existingWatches: fixture.watchEntries,
      nowMs: fixture.nowMs,
    });
    const key = watchEntryKey(235, 'prog235');
    const triggered = {
      ...seed.watchEntries,
      [key]: { ...seed.watchEntries[key], status: 'triggered' },
    };
    const reverted = revertTriggeredWatchOnAbort(triggered, key, Number(fixture.nowMs) + 1_000);
    expect(reverted[key].status).toBe('watching');
    expect(reverted[key].lastEvaluatedMs).toBe(Number(fixture.nowMs) + 1_000);
  });

  it('retains watch across ticks after pre-run abort revert', () => {
    const fixture = loadFixture('dropped-wake-in-progress-seed.json');
    const readySessions = [
      {
        ...fixture.sessions![0],
        reports: [
          ...(fixture.sessions![0].reports as Array<Record<string, unknown>>),
          { reportState: 'ready_for_review', reportedAt: '2026-06-05T14:16:40.000Z' },
        ],
      },
    ];
    const seed = seedWatchFromInProgressSignals({
      openPrs: asOpenPrs(fixture.openPrs),
      reviewRuns: fixture.reviewRuns,
      sessions: fixture.sessions,
      existingWatches: fixture.watchEntries,
      nowMs: fixture.nowMs,
    });
    const firstPlan = planDeferredWatchTick({
      watchEntries: seed.watchEntries,
      openPrs: asOpenPrs(fixture.openPrs),
      reviewRuns: fixture.reviewRuns,
      sessions: readySessions,
      ciChecksByPr: fixture.ciChecksByPr,
      nowMs: Number(fixture.nowMs) + 2_000,
    });
    const key = watchEntryKey(235, 'prog235');
    expect(firstPlan.watchEntries[key].status).toBe('triggered');
    const restored = revertTriggeredWatchOnAbort(
      firstPlan.watchEntries,
      key,
      Number(fixture.nowMs) + 3_000,
    );
    const secondPlan = planDeferredWatchTick({
      watchEntries: restored,
      openPrs: asOpenPrs(fixture.openPrs),
      reviewRuns: fixture.reviewRuns,
      sessions: readySessions,
      ciChecksByPr: fixture.ciChecksByPr,
      nowMs: Number(fixture.nowMs) + 4_000,
    });
    expect(secondPlan.actions.filter((a: ReevalWatchAction) => a.type === 'start_review')).toHaveLength(1);
  });

  it('(14) genuinely zero-signal head is backstop-only', () => {
    const fixture = loadFixture('zero-signal-backstop-only.json');
    const session = fixture.sessions?.[0] ?? null;
    const signal = evaluateBackstopOnlyZeroSignal({
      prNumber: Number(fixture.prNumber ?? fixture.openPrs?.[0]?.number),
      headSha: String(fixture.headSha ?? fixture.openPrs?.[0]?.headRefOid ?? ''),
      session,
      hadCompletionWake: fixture.hadCompletionWake,
    });
    expect(signal.backstopOnly).toBe(true);
    expect(signal.reason).toBe('zero_signal_backstop_only');
    const seed = seedWatchFromInProgressSignals({
      openPrs: asOpenPrs(fixture.openPrs),
      reviewRuns: fixture.reviewRuns,
      sessions: fixture.sessions,
      existingWatches: {},
    });
    expect(seed.seededKeys).toHaveLength(0);
  });

  it('(15a) transient read error retains watch as unknown', () => {
    const fixture = loadFixture('transient-read-error-15a.json');
    const plan = planFixtureTick(fixture);
    expect(plan.actions.some((a: ReevalWatchAction) => a.type === 'retain_watch' && a.reason === 'snapshot_unknown')).toBe(true);
    expect(plan.actions.some((a: ReevalWatchAction) => a.type === 'start_review')).toBe(false);
  });

  it('(15b2) ambiguous timeout re-read sees in-flight — no duplicate retry', () => {
    const fixture = loadFixture('run-ambiguous-timeout-15b2.json');
    const plan = planFixtureTick(fixture);
    expect(plan.actions.filter((a: ReevalWatchAction) => a.type === 'start_review')).toHaveLength(0);
  });

  it('(15c) window exhausted hands to backstop', () => {
    const fixture = loadFixture('window-exhausted-backstop-15c.json');
    const plan = planFixtureTick(fixture);
    const handoff = plan.actions.find((a: ReevalWatchAction) => a.type === 'hand_to_backstop');
    expect(handoff?.reason).toBe('watch_window_expired');
  });
});

describe('scenario matrix cells', () => {
  it('wake after ready (#207 no-regression)', () => {
    const greenWake = JSON.parse(
      readFileSync(
        path.join(path.dirname(fileURLToPath(import.meta.url)), '../tests/fixtures/review-wake-trigger/green-wake-triggers.json'),
        'utf8',
      ),
    );
    const result = evaluateWakeReviewTrigger({
      wakeKind: 'merge.ready',
      sessionId: greenWake.sessionId,
      prNumber: greenWake.prNumber,
      openPrs: greenWake.openPrs,
      reviewRuns: greenWake.reviewRuns,
      sessions: greenWake.sessions,
      ciChecks: greenWake.ciChecksByPr?.['204'],
    });
    expect(result.triggerReviewRun).toBe(true);
  });

  it('CI flip green→red after defer re-reads level truth', () => {
    const fixture = loadFixture('ci-flip-green-red.json');
    expect(evaluateFixtureVerdict(fixture).reason).toBe('ci_red_defer');
  });

  it('head advances after run started: new head may run; old run not covering new SHA', () => {
    const fixture = loadFixture('head-advances-after-run-started.json');
    expect(evaluateFixtureVerdict(fixture).triggerReviewRun).toBe(true);
    const oldRun = fixture.reviewRuns?.find((r) => r.targetSha === 'old235');
    expect(oldRun?.status).toBe('running');
  });

  it('seedWatchFromWakeDefer records deferred-not-ready wake', () => {
    const seeded = seedWatchFromWakeDefer({
      prNumber: 235,
      headSha: 'wake235',
      sessionId: 'opk-28',
      deferReason: 'uncovered_not_ready',
      deferRecord: { primary: 'no_ready_for_review' },
      nowMs: 1_700_000_000_000,
    });
    expect(seeded.seeded).toBe(true);
    expect(seeded.watchKey).toBe('235:wake235');
  });

  it('detectReadinessTransition fires on first ready observation', () => {
    const fixture = loadFixture('wake-before-ready-then-ready.json');
    const session = fixture.sessions?.[0];
    const transition = detectReadinessTransition({
      session,
      headSha: 'abc235',
      priorReadyMs: null,
      bindingOptions: { headCommittedAtMs: Date.parse('2026-06-05T14:16:00.000Z') },
      nowMs: fixture.nowMs,
    });
    expect(transition.transitioned).toBe(true);
    expect(transition.readyNow).toBe(true);
  });

  it('mergeWatchState is idempotent for same key', () => {
    const entry = createWatchEntry({
      prNumber: 235,
      headSha: 'x',
      sessionId: 'opk-28',
      nowMs: 100,
    });
    const merged = mergeWatchState({ '235:x': entry }, { '235:x': entry }, 200);
    expect(Object.keys(merged)).toEqual(['235:x']);
  });

  it('mergeWatchState preserves terminal incoming statuses over prior watching', () => {
    const key = '235:term235';
    const watching = {
      ...createWatchEntry({
        prNumber: 235,
        headSha: 'term235',
        sessionId: 'opk-28',
        nowMs: 100,
      }),
      status: 'watching',
    };
    const mergedTriggered = mergeWatchState(
      { [key]: watching },
      { [key]: { ...watching, status: 'triggered', lastEvaluatedMs: 200 } },
      200,
    );
    expect(mergedTriggered[key].status).toBe('triggered');
    expect(resolveMergedWatchStatus('watching', 'discarded')).toBe('discarded');
    expect(resolveMergedWatchStatus('watching', 'expired')).toBe('expired');
  });

  it('mergeWatchState keeps prior terminal status when concurrent seed is watching', () => {
    const key = '235:term235';
    const triggered = {
      ...createWatchEntry({
        prNumber: 235,
        headSha: 'term235',
        sessionId: 'opk-28',
        nowMs: 100,
      }),
      status: 'triggered',
    };
    const merged = mergeWatchState(
      { [key]: triggered },
      { [key]: { ...triggered, status: 'watching', lastEvaluatedMs: 200 } },
      200,
    );
    expect(merged[key].status).toBe('triggered');
    expect(resolveMergedWatchStatus('triggered', 'watching')).toBe('triggered');
  });

  it('reconcile observer agrees with re-eval verdict on same state', () => {
    const fixture = loadFixture('wake-before-ready-then-ready.json');
    const reeval = evaluateFixtureVerdict(fixture);
    const reconcile = unwrapReconcilePlanResult(planReconcileActions({
      openPrs: (fixture.openPrs ?? []) as unknown as OpenPr[],
      reviewRuns: fixture.reviewRuns ?? [],
      sessions: fixture.sessions ?? [],
      ciChecksByPr: fixture.ciChecksByPr,
    })).actions;
    const reconcileStart = reconcile.find((a: { type: string }) => a.type === 'start_review');
    expect(reeval.triggerReviewRun).toBe(Boolean(reconcileStart));
  });

  it('evaluateDeferredWatchEntry returns nextEntry with updated observation', () => {
    const fixture = loadFixture('wake-before-ready-then-ready.json');
    const entry = fixture.watchEntries?.['235:abc235'];
    const evaluation = evaluateDeferredWatchEntry({
      entry,
      nowMs: fixture.nowMs,
      openPrs: fixture.openPrs ?? [],
      reviewRuns: fixture.reviewRuns ?? [],
      sessions: fixture.sessions ?? [],
      ciChecksByPr: fixture.ciChecksByPr,
    });
    expect(evaluation.triggerReviewRun).toBe(true);
    expect(evaluation.nextEntry?.lastObservedReadyMs).not.toBeNull();
  });
});
