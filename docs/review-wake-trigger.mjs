/**
 * Event-driven review trigger on completion wakes (Issue #207, #625).
 * Vitest: scripts/review-wake-trigger.test.ts
 */
import {
  findForbiddenCommandPatterns,
  MECHANICAL_FORBIDDEN_REVIEW_MECHANICAL,
  readStdinJson,
  runStdinJsonCli,
} from './review-mechanical-cli.mjs';
import {
  evaluateHeadReadyForReview,
  preRunHeadReadyRecheck,
  resolveCurrentPrHeadSha,
  buildFailedCancelledObserved,
} from './review-head-ready.mjs';
import { resolveFailedRunRetryEligibility } from './autonomous-review-retry.mjs';
import {
  evaluateHandoffPreClaimRecheck,
  formatHandoffWakeAuditLine,
  HANDOFF_RECEIPT_TO_RUN_MAX_MS,
  HANDOFF_WAKE_KIND,
} from './review-handoff-wake-admission.mjs';
import {
  isDeliveredChangesRequested,
  isUndeliveredChangesRequested,
  resolveFailureDetail,
} from './review-producer-contract.mjs';
import { nonEmptyString } from './orchestrator-wake-filter.mjs';
import {
  buildReviewRunArgv,
  buildReviewTriggerPath,
  findSessionById,
  hasFailedOrCancelledOnHead,
  IN_FLIGHT_REVIEW_STATUSES,
  isHeadCovered,
  isLiveWorkerSession,
  isRunCoveringHead,
  normalizeSha,
  resolveHeadCommittedAtMs,
  resolveHeadOwningWorkerSessionId,
  toArray,
} from './review-trigger-reconcile.mjs';
import { evaluateWorkerIterationCycleForPr } from './worker-iteration-cycle.mjs';
import { evaluateReviewCycleCapGate } from './review-cycle-cap.mjs';

/** Completion-time AO wake that may carry merge intent (approved-and-green → merge.ready). */
export const COMPLETION_MERGE_INTENT_WAKE_KINDS = new Set(['merge.ready']);

/** Hand-off semantic wakes that may start the first review run (Issue #381). */
export const HANDOFF_REVIEW_TRIGGER_WAKE_KINDS = new Set([HANDOFF_WAKE_KIND]);

/** Event-driven review trigger wakes (completion + hand-off). */
export const EVENT_REVIEW_TRIGGER_WAKE_KINDS = new Set([
  ...COMPLETION_MERGE_INTENT_WAKE_KINDS,
  ...HANDOFF_REVIEW_TRIGGER_WAKE_KINDS,
]);

/**
 * Upper bound for listener-local processing from wake receipt to run decision (ms).
 * Excludes external AO/GitHub command latency and retry backoff.
 */
export const WAKE_TO_RUN_DECISION_MAX_MS = 5_000;

/**
 * @param {string | null | undefined} wakeKind
 */
export function isCompletionMergeIntentWake(wakeKind) {
  return COMPLETION_MERGE_INTENT_WAKE_KINDS.has(String(wakeKind ?? '').trim());
}

/**
 * @param {string | null | undefined} wakeKind
 */
export function isHandoffReviewTriggerWake(wakeKind) {
  return HANDOFF_REVIEW_TRIGGER_WAKE_KINDS.has(String(wakeKind ?? '').trim());
}

/**
 * @param {string | null | undefined} wakeKind
 */
export function isEventReviewTriggerWake(wakeKind) {
  return EVENT_REVIEW_TRIGGER_WAKE_KINDS.has(String(wakeKind ?? '').trim());
}

/**
 * @param {import('./review-trigger-reconcile.mjs').ReviewRun[]} reviewRuns
 * @param {number} prNumber
 * @param {string} headSha
 */
export function findFailedOrCancelledRunOnHead(reviewRuns, prNumber, headSha) {
  const head = normalizeSha(headSha);
  return (
    toArray(reviewRuns).find((run) => {
      const status = String(run?.status ?? '').toLowerCase();
      return (
        Number(run?.prNumber) === prNumber &&
        normalizeSha(run?.targetSha) === head &&
        (status === 'failed' || status === 'cancelled')
      );
    }) ?? null
  );
}

/**
 * @param {object} input
 * @param {string} input.wakeKind
 * @param {string} input.sessionId
 * @param {number | undefined} input.prNumber
 * @param {number} [input.wakeReceivedMs]
 * @param {number} [input.nowMs]
 * @param {import('./review-trigger-reconcile.mjs').OpenPr[]} [input.openPrs]
 * @param {import('./review-trigger-reconcile.mjs').ReviewRun[]} [input.reviewRuns]
 * @param {import('./review-trigger-reconcile.mjs').AoSession[]} [input.sessions]
 * @param {Array<{ name?: string, state?: string, conclusion?: string, status?: string }>} [input.ciChecks]
 * @param {string[]} [input.requiredCheckNames]
 * @param {boolean} [input.requiredCheckLookupFailed]
 */
export function evaluateWakeReviewTrigger(input) {
  const nowMs = Number(input.nowMs ?? Date.now());
  const wakeReceivedMs = Number(input.wakeReceivedMs ?? nowMs);
  const processingMs = Math.max(0, nowMs - wakeReceivedMs);
  const withinLatencyBound = processingMs <= WAKE_TO_RUN_DECISION_MAX_MS;

  const wakeKind = String(input.wakeKind ?? '');
  const isHandoffWake = isHandoffReviewTriggerWake(wakeKind);
  if (!isEventReviewTriggerWake(wakeKind)) {
    return {
      triggerReviewRun: false,
      reason: 'not_event_wake',
      route: 'none',
      processingMs,
      withinLatencyBound,
    };
  }
  const receiptToRunBoundMs = isHandoffWake
    ? Number(input.receiptToRunBoundMs ?? HANDOFF_RECEIPT_TO_RUN_MAX_MS)
    : WAKE_TO_RUN_DECISION_MAX_MS;
  const withinReceiptBound = processingMs <= receiptToRunBoundMs;

  const prNumber = Number(input.prNumber);
  if (!prNumber) {
    return {
      triggerReviewRun: false,
      reason: 'missing_pr_number',
      route: 'none',
      processingMs,
      withinLatencyBound,
    };
  }

  const openPrs = toArray(input.openPrs);
  const currentHeadSha = resolveCurrentPrHeadSha(openPrs, prNumber);
  if (!currentHeadSha) {
    return {
      triggerReviewRun: false,
      reason: 'head_unresolved',
      route: 'none',
      processingMs,
      withinLatencyBound,
    };
  }

  const normalizedCurrentHeadSha = normalizeSha(currentHeadSha);
  let headSha = normalizedCurrentHeadSha;
  if (isHandoffWake) {
    const admittedHeadSha = normalizeSha(String(input.admittedHeadSha ?? ''));
    if (!admittedHeadSha) {
      return {
        triggerReviewRun: false,
        reason: 'missing_admitted_head',
        route: 'none',
        processingMs,
        withinLatencyBound: withinReceiptBound,
        withinReceiptBound,
      };
    }
    if (admittedHeadSha !== normalizedCurrentHeadSha) {
      return {
        triggerReviewRun: false,
        reason: 'handoff_head_advanced',
        route: 'none',
        processingMs,
        withinLatencyBound: withinReceiptBound,
        withinReceiptBound,
      };
    }
    const admittedBaseRef = nonEmptyString(input.admittedBaseRef);
    if (!admittedBaseRef) {
      return {
        triggerReviewRun: false,
        reason: 'missing_admitted_base_ref',
        route: 'none',
        processingMs,
        withinLatencyBound: withinReceiptBound,
        withinReceiptBound,
      };
    }
    headSha = admittedHeadSha;
  }

  const reviewRuns = toArray(input.reviewRuns);
  const sessions = toArray(input.sessions);
  const failedRun = findFailedOrCancelledRunOnHead(reviewRuns, prNumber, headSha);
  const retryState = failedRun
    ? resolveFailedRunRetryEligibility(failedRun, reviewRuns, prNumber, headSha)
    : { retryEligible: true, escalationReason: null, failureClass: null };
  const failedRetryEligible =
    failedRun != null &&
    !isHeadCovered(reviewRuns, prNumber, headSha) &&
    retryState.retryEligible !== false;

  if (failedRun && !failedRetryEligible) {
    const observed = buildFailedCancelledObserved(failedRun, prNumber, headSha, reviewRuns);
    return {
      triggerReviewRun: false,
      reason:
        retryState.escalationReason != null
          ? 'retry_bound_exhausted'
          : 'failed_or_cancelled_on_head',
      route: 'empty_review_trap',
      failureDetail: resolveFailureDetail(failedRun) || String(failedRun?.body ?? ''),
      escalationReason: retryState.escalationReason ?? observed.escalationReason,
      observed,
      processingMs,
      withinLatencyBound: isHandoffWake ? withinReceiptBound : withinLatencyBound,
      withinReceiptBound,
    };
  }

  const resolvedSessionId = resolveHeadOwningWorkerSessionId(
    sessions,
    prNumber,
    headSha,
    openPrs,
  );
  let sessionId = resolvedSessionId;
  if (!sessionId) {
    const fallbackId = String(input.sessionId ?? '').trim();
    const fallbackSession = fallbackId ? findSessionById(sessions, fallbackId) : null;
    if (fallbackSession && isLiveWorkerSession(fallbackSession)) {
      sessionId = fallbackId;
    }
  }
  const session = sessionId ? findSessionById(sessions, sessionId) : null;

  if (!sessionId || !session) {
    return {
      triggerReviewRun: false,
      reason: 'no_worker_session',
      route: 'none',
      processingMs,
      withinLatencyBound,
    };
  }

  if (!isLiveWorkerSession(session)) {
    return {
      triggerReviewRun: false,
      reason: 'non_live_worker_session',
      route: 'none',
      processingMs,
      withinLatencyBound,
    };
  }

  const capGate = evaluateReviewCycleCapGate({
    prNumber,
    currentHeadSha: normalizeSha(headSha),
    openPrs,
    reviewRuns,
    capState: input.capCycleState ?? {},
    issueBody: input.issueBody,
    mergedPrNumbers: input.mergedPrNumbers,
    producer: isHandoffWake ? 'wake-handoff' : 'wake-completion',
    nowMs,
  });
  if (!capGate.allowStart) {
    return {
      triggerReviewRun: false,
      reason: capGate.reason,
      route: 'none',
      processingMs,
      withinLatencyBound: isHandoffWake ? withinReceiptBound : withinLatencyBound,
      withinReceiptBound,
      capCycleState: capGate.capState,
      mergeEligible: capGate.mergeEligible,
      atCapRecord: capGate.atCapRecord ?? undefined,
    };
  }

  const decision = evaluateHeadReadyForReview({
    reviewRuns,
    prNumber,
    headSha,
    session,
    ciChecks: toArray(input.ciChecks),
    requiredCheckNames: toArray(input.requiredCheckNames),
    requiredCheckLookupFailed: Boolean(input.requiredCheckLookupFailed),
    headCommittedAtMs: resolveHeadCommittedAtMs(openPrs, prNumber),
    allowFailedRetry: failedRetryEligible,
  });

  if (!decision.eligible) {
    return {
      triggerReviewRun: false,
      reason: decision.reason,
      route: decision.route ?? 'none',
      processingMs,
      withinLatencyBound,
    };
  }


  if (isHandoffWake && input.cycleState != null) {
    const cycleEval = evaluateWorkerIterationCycleForPr({
      cycleState: input.cycleState ?? {},
      repoRoot: input.repoRoot ?? '',
      prNumber,
      headSha: normalizeSha(headSha),
      ownerSessionId: sessionId,
      reviewRuns,
      session,
      nowMs,
      headCommittedAtMs: resolveHeadCommittedAtMs(openPrs, prNumber),
      handoffAccepted: true,
      handoffReportedAtMs: wakeReceivedMs,
    });
    if (!cycleEval.reviewGate.allow) {
      return {
        triggerReviewRun: false,
        reason: cycleEval.reviewGate.deferReason ?? 'already_reviewed_this_cycle',
        route: 'none',
        processingMs,
        withinLatencyBound: isHandoffWake ? withinReceiptBound : withinLatencyBound,
        withinReceiptBound,
        cycleBlocked: true,
      };
    }
  }
  if (isHandoffWake && !withinReceiptBound) {
    return {
      triggerReviewRun: false,
      reason: 'handoff_receipt_bound_exceeded',
      route: 'none',
      processingMs,
      withinLatencyBound: withinReceiptBound,
      withinReceiptBound,
    };
  }
  const planned = {
    prNumber,
    headSha: normalizeSha(headSha),
    sessionId,
    startReason: isHandoffWake ? 'handoff_wake' : 'completion_wake',
    admittedBaseRef: input.admittedBaseRef,
  };
  const auditLine = isHandoffWake
    ? formatHandoffWakeAuditLine({
        outcome: 'readiness_start',
        reason: 'head_ready_for_review',
        wakeKind,
        sessionId,
        prNumber,
      })
    : undefined;
  return {
    triggerReviewRun: true,
    reason: 'head_ready_for_review',
    route: 'start_review',
    planned,
    processingMs,
    withinLatencyBound: isHandoffWake ? withinReceiptBound : withinLatencyBound,
    withinReceiptBound,
    wakeKind,
    auditLine,
    capCycleState: capGate.capState,
    mergeEligible: capGate.mergeEligible,
  };
}

/**
 * Merge-intent ordering: re-read coverage after the fast review trigger path.
 *
 * @param {object} input
 * @param {number} input.prNumber
 * @param {string} input.headSha
 * @param {import('./review-trigger-reconcile.mjs').ReviewRun[]} input.reviewRuns
 * @param {string} [input.reviewDecision]
 */
export function evaluateMergeIntentAfterReviewTrigger(input) {
  const prNumber = Number(input.prNumber);
  const headSha = normalizeSha(String(input.headSha ?? ''));
  const reviewRuns = toArray(input.reviewRuns);
  const reviewDecision = String(input.reviewDecision ?? 'none').trim().toLowerCase();

  const covered = isHeadCovered(reviewRuns, prNumber, headSha);
  const inFlight = reviewRuns.some((run) => {
    const status = String(run?.status ?? '').toLowerCase();
    return (
      Number(run?.prNumber) === prNumber &&
      normalizeSha(run?.targetSha) === headSha &&
      IN_FLIGHT_REVIEW_STATUSES.has(status)
    );
  });
  const undeliveredChangesRequested = reviewRuns.some(
    (run) =>
      Number(run?.prNumber) === prNumber &&
      normalizeSha(run?.targetSha) === headSha &&
      isUndeliveredChangesRequested(run),
  );

  if (inFlight) {
    return {
      mergeable: false,
      reason: 'review_in_flight_revalidate',
      forwardWake: true,
      covered,
    };
  }

  if (undeliveredChangesRequested) {
    return {
      mergeable: false,
      reason: 'undelivered_changes_requested_revalidate',
      forwardWake: true,
      covered,
    };
  }

  const deliveredChangesRequested = reviewRuns.some(
    (run) =>
      Number(run?.prNumber) === prNumber &&
      normalizeSha(run?.targetSha) === headSha &&
      isDeliveredChangesRequested(run),
  );

  if (deliveredChangesRequested) {
    return {
      mergeable: false,
      reason: 'delivered_changes_requested_revalidate',
      forwardWake: true,
      covered,
    };
  }

  if (!covered && (reviewDecision === 'none' || reviewDecision === '')) {
    return {
      mergeable: false,
      reason: 'no_covered_terminal_run',
      forwardWake: true,
      covered,
    };
  }

  const terminalCovered = reviewRuns.some(
    (run) =>
      Number(run?.prNumber) === prNumber &&
      normalizeSha(run?.targetSha) === headSha &&
      isRunCoveringHead(run) &&
      !IN_FLIGHT_REVIEW_STATUSES.has(String(run?.status ?? '').toLowerCase()),
  );

  // Covered-terminal up_to_date (etc.) is mergeable even when reviewDecision is still
  // none — only the empty-review trap (no covered run + reviewDecision none) defers.
  return {
    mergeable: terminalCovered,
    reason: terminalCovered ? 'covered_terminal_run' : 'awaiting_review_coverage',
    forwardWake: true,
    covered,
  };
}

/**
 * @param {string} wakeMessage
 * @param {{ mergeable?: boolean, reason?: string }} mergeEval
 */
export function amendMergeWakeMessage(wakeMessage, mergeEval) {
  const base = String(wakeMessage ?? '').trim();
  if (mergeEval?.mergeable !== false) {
    return base;
  }
  const reason = String(mergeEval?.reason ?? 'revalidate').trim();
  return `${base} mergeable=false reason=${reason}`;
}

/**
 * @param {object} input
 * @param {{ prNumber: number, headSha: string, sessionId: string }} input.planned
 * @param {object} input.fresh
 */
export function evaluateWakePreRunRecheck(input) {
  const planned = input.planned ?? {};
  const fresh = input.fresh ?? {};
  const base = preRunHeadReadyRecheck(planned, fresh);
  if (!base.emitReviewRun) {
    return base;
  }
  if (planned.startReason === 'handoff_wake' || isHandoffReviewTriggerWake(input.wakeKind)) {
    const handoff = evaluateHandoffPreClaimRecheck({ planned, fresh });
    if (!handoff.emitReviewRun) {
      return {
        ...base,
        emitReviewRun: false,
        reason: handoff.reason,
        auditLine: formatHandoffWakeAuditLine(handoff.audit),
      };
    }
  }
  return base;
}

/**
 * @param {string[]} commandLines
 */
/** Wake fast path must never merge — extends review mechanical guard. */
export const MECHANICAL_FORBIDDEN_REVIEW_WAKE = [
  ...MECHANICAL_FORBIDDEN_REVIEW_MECHANICAL,
  /\bgh\s+pr\s+merge\b/i,
];

export function findForbiddenReviewWakeCommands(commandLines) {
  return findForbiddenCommandPatterns(commandLines, MECHANICAL_FORBIDDEN_REVIEW_WAKE);
}

export { buildReviewRunArgv, buildReviewTriggerPath };

runStdinJsonCli('review-wake-trigger.mjs', {
  evaluate: () => evaluateWakeReviewTrigger(readStdinJson()),
  preRunRecheck: () => {
    const payload = readStdinJson();
    return evaluateWakePreRunRecheck(payload);
  },
  mergeIntent: () => evaluateMergeIntentAfterReviewTrigger(readStdinJson()),
  forbidden: () => {
    const payload = readStdinJson();
    return findForbiddenReviewWakeCommands(toArray(payload.commands));
  },
});
