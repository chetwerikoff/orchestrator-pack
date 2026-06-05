/**
 * Event-driven first `ao review run` on completion wakes (Issue #207).
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
} from './review-head-ready.mjs';
import {
  buildReviewRunArgv,
  findSessionById,
  hasFailedOrCancelledOnHead,
  IN_FLIGHT_REVIEW_STATUSES,
  isHeadCovered,
  isLiveWorkerSession,
  isRunCoveringHead,
  normalizeSha,
  resolveHeadOwningWorkerSessionId,
  toArray,
} from './review-trigger-reconcile.mjs';

/** Completion-time AO wake that may carry merge intent (approved-and-green → merge.ready). */
export const COMPLETION_MERGE_INTENT_WAKE_KINDS = new Set(['merge.ready']);

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
  if (!isCompletionMergeIntentWake(wakeKind)) {
    return {
      triggerReviewRun: false,
      reason: 'not_completion_wake',
      route: 'none',
      processingMs,
      withinLatencyBound,
    };
  }

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
  const headSha = resolveCurrentPrHeadSha(openPrs, prNumber);
  if (!headSha) {
    return {
      triggerReviewRun: false,
      reason: 'head_unresolved',
      route: 'none',
      processingMs,
      withinLatencyBound,
    };
  }

  const reviewRuns = toArray(input.reviewRuns);
  const sessions = toArray(input.sessions);
  const failedRun = findFailedOrCancelledRunOnHead(reviewRuns, prNumber, headSha);
  if (failedRun) {
    return {
      triggerReviewRun: false,
      reason: 'failed_or_cancelled_on_head',
      route: 'empty_review_trap',
      terminationReason: String(failedRun.terminationReason ?? ''),
      processingMs,
      withinLatencyBound,
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

  const decision = evaluateHeadReadyForReview({
    reviewRuns,
    prNumber,
    headSha,
    session,
    ciChecks: toArray(input.ciChecks),
    requiredCheckNames: toArray(input.requiredCheckNames),
    requiredCheckLookupFailed: Boolean(input.requiredCheckLookupFailed),
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

  return {
    triggerReviewRun: true,
    reason: 'head_ready_for_review',
    route: 'start_review',
    planned: {
      prNumber,
      headSha: normalizeSha(headSha),
      sessionId,
    },
    processingMs,
    withinLatencyBound,
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
  const needsTriage = reviewRuns.some((run) => {
    const status = String(run?.status ?? '').toLowerCase();
    return (
      Number(run?.prNumber) === prNumber &&
      normalizeSha(run?.targetSha) === headSha &&
      status === 'needs_triage'
    );
  });

  if (inFlight) {
    return {
      mergeable: false,
      reason: 'review_in_flight_revalidate',
      forwardWake: true,
      covered,
    };
  }

  if (needsTriage) {
    return {
      mergeable: false,
      reason: 'needs_triage_revalidate',
      forwardWake: true,
      covered,
    };
  }

  const waitingUpdate = reviewRuns.some((run) => {
    const status = String(run?.status ?? '').toLowerCase();
    return (
      Number(run?.prNumber) === prNumber &&
      normalizeSha(run?.targetSha) === headSha &&
      status === 'waiting_update'
    );
  });

  if (waitingUpdate) {
    return {
      mergeable: false,
      reason: 'waiting_update_revalidate',
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

  // Covered-terminal clean (etc.) is mergeable even when reviewDecision is still
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
  return preRunHeadReadyRecheck(input.planned, input.fresh);
}

/**
 * @param {string[]} commandLines
 */
export function findForbiddenReviewWakeCommands(commandLines) {
  return findForbiddenCommandPatterns(commandLines, MECHANICAL_FORBIDDEN_REVIEW_MECHANICAL);
}

export { buildReviewRunArgv };

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
