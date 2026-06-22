/**
 * Deferred-head review re-evaluation (Issue #235).
 * Vitest: scripts/review-trigger-reeval.test.ts
 */
import {
  findForbiddenCommandPatterns,
  MECHANICAL_FORBIDDEN_REVIEW_MECHANICAL,
  readStdinJson,
  runStdinJsonCli,
} from './review-mechanical-cli.mjs';
import {
  buildNoStartDecisionRecord,
  hasReadyForReviewForHead,
  preRunHeadReadyRecheck,
  resolveCurrentPrHeadSha,
} from './review-head-ready.mjs';
import { getReportState } from './review-finding-delivery-confirm.mjs';
import {
  buildReviewRunArgv,
  findSessionById,
  getCiChecksForPr,
  getRequiredCheckLookupFailedForPr,
  getRequiredCheckNamesForPr,
  IN_FLIGHT_REVIEW_STATUSES,
  isHeadCovered,
  isLiveWorkerSession,
  isRunCoveringHead,
  normalizeSha,
  resolveHeadCommittedAtMs,
  resolveHeadOwningWorkerSessionId,
  toArray,
} from './review-trigger-reconcile.mjs';
import { evaluateWakeReviewTrigger } from './review-wake-trigger.mjs';

/** Captured incident wake→readiness delay (PR #234/opk-27 ~77 s). */
export const INCIDENT_WAKE_TO_READINESS_DELAY_MS = 77_000;

/** Per-head scoped watch window — must exceed incident delay with margin (5 min). */
export const DEFERRED_WATCH_WINDOW_MS = 300_000;

/** Upper bound for re-eval processing from observed readiness to run decision (ms). */
export const READINESS_TO_RUN_DECISION_MAX_MS = 5_000;

/** Explicit poll classification — scoped deferred-head watch, not full-PR reconcile. */
export const SCOPED_DEFERRED_HEAD_WATCH_POLL_CLASS = 'scoped_deferred_head_watch';

/** Start reason when report-state poll seeds a scoped watch (Issue #391). */
export const REPORT_STATE_SEED_START_REASON = 'report_state_seed';

/** Report states indicating worker progress toward review (Issue #235 crit 14). */
export const IN_PROGRESS_REPORT_STATES = new Set([
  'working',
  'fixing_ci',
  'started',
  'addressing_reviews',
  'pr_created',
  'completed',
]);

export const MECHANICAL_FORBIDDEN_REVIEW_REEVAL = [
  ...MECHANICAL_FORBIDDEN_REVIEW_MECHANICAL,
  /\bgh\s+pr\s+merge\b/i,
];

/**
 * @param {number} prNumber
 * @param {string} headSha
 */
export function watchEntryKey(prNumber, headSha) {
  return `${Number(prNumber)}:${normalizeSha(headSha)}`;
}

/**
 * @param {object | null | undefined} entry
 */
export function resolveStartReasonForWatchEntry(entry) {
  const seedSource = String(entry?.seedSource ?? '').trim();
  if (seedSource === 'report_state_poll') {
    return REPORT_STATE_SEED_START_REASON;
  }
  return 'deferred_head_watch';
}

/**
 * @param {string | null | undefined} deferReason
 * @param {{ primary?: string, failedComponents?: string[], branch?: string } | null | undefined} deferRecord
 */
export function isDeferredNotReadySeedEligible(deferReason, deferRecord) {
  const reason = String(deferReason ?? '').trim();
  if (reason !== 'uncovered_not_ready') {
    return false;
  }

  const record = deferRecord ?? {};
  const primary = String(record.primary ?? '').trim();
  const components = toArray(record.failedComponents).map((value) => String(value ?? '').trim());

  if (primary === 'no_ready_for_review' || components.includes('no_ready_for_review')) {
    return true;
  }

  if (primary === 'stale_report_binding' && components.includes('no_ready_for_review')) {
    return true;
  }

  return false;
}

/**
 * @param {string | null | undefined} deferReason
 * @param {{ primary?: string, failedComponents?: string[], branch?: string } | null | undefined} deferRecord
 */
export function isDeferredReevalWatchSeedEligible(deferReason, deferRecord) {
  const reason = String(deferReason ?? '').trim();
  if (reason === 'ci_red_defer') {
    const primary = String(deferRecord?.primary ?? '').trim();
    return primary === 'ci_red' || primary === '';
  }
  return isDeferredNotReadySeedEligible(deferReason, deferRecord);
}

/**
 * @param {object} input
 * @param {number} input.prNumber
 * @param {string} input.headSha
 * @param {string} input.sessionId
 * @param {number} input.nowMs
 * @param {'wake_defer' | 'in_progress' | 'recovery' | 'report_state_poll'} input.seedSource
 * @param {string} [input.deferReason]
 * @param {string} [input.deferPrimary]
 * @param {number} [input.windowMs]
 */
export function createWatchEntry(input) {
  const nowMs = Number(input.nowMs ?? Date.now());
  const windowMs = Number(input.windowMs ?? DEFERRED_WATCH_WINDOW_MS);
  const headSha = normalizeSha(String(input.headSha ?? ''));
  return {
    prNumber: Number(input.prNumber),
    headSha,
    sessionId: String(input.sessionId ?? '').trim(),
    seedMs: nowMs,
    windowExpiresMs: nowMs + windowMs,
    seedSource: String(input.seedSource ?? 'wake_defer'),
    deferReason: String(input.deferReason ?? 'uncovered_not_ready'),
    deferPrimary: String(input.deferPrimary ?? 'no_ready_for_review'),
    pollClass: SCOPED_DEFERRED_HEAD_WATCH_POLL_CLASS,
    lastObservedReadyMs: null,
    lastEvaluatedMs: nowMs,
    status: 'watching',
  };
}

/**
 * @param {number | undefined} windowMs
 */
export function isWatchWindowNonConformant(windowMs = DEFERRED_WATCH_WINDOW_MS) {
  return Number(windowMs) < INCIDENT_WAKE_TO_READINESS_DELAY_MS;
}

/**
 * @param {Record<string, object>} entries
 * @param {number} nowMs
 */
export function pruneExpiredWatchEntries(entries, nowMs = Date.now()) {
  const pruned = {};
  for (const [key, entry] of Object.entries(entries ?? {})) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const expiresMs = Number(entry.windowExpiresMs ?? 0);
    if (expiresMs > 0 && nowMs >= expiresMs && entry.status === 'watching') {
      pruned[key] = { ...entry, status: 'expired' };
      continue;
    }
    if (entry.status !== 'expired' && entry.status !== 'discarded') {
      pruned[key] = entry;
    }
  }
  return pruned;
}

const TERMINAL_WATCH_STATUSES = new Set(['triggered', 'discarded', 'expired']);

/**
 * @param {string | undefined} priorStatus
 * @param {string | undefined} incomingStatus
 */
export function resolveMergedWatchStatus(priorStatus, incomingStatus) {
  const prior = String(priorStatus ?? '').trim() || 'watching';
  const incoming = String(incomingStatus ?? '').trim() || 'watching';
  if (TERMINAL_WATCH_STATUSES.has(incoming)) {
    return incoming;
  }
  if (TERMINAL_WATCH_STATUSES.has(prior)) {
    return prior;
  }
  return 'watching';
}

/**
 * @param {Record<string, object>} existing
 * @param {Record<string, object>} incoming
 * @param {number} [nowMs]
 */
export function mergeWatchState(existing, incoming, nowMs = Date.now()) {
  const merged = { ...(existing ?? {}) };
  for (const [key, entry] of Object.entries(incoming ?? {})) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const prior = merged[key];
    if (!prior) {
      merged[key] = entry;
      continue;
    }
    merged[key] = {
      ...prior,
      ...entry,
      seedMs: Math.min(Number(prior.seedMs ?? nowMs), Number(entry.seedMs ?? nowMs)),
      windowExpiresMs: Math.max(
        Number(prior.windowExpiresMs ?? 0),
        Number(entry.windowExpiresMs ?? 0),
      ),
      lastObservedReadyMs:
        entry.lastObservedReadyMs ?? prior.lastObservedReadyMs ?? null,
      status: resolveMergedWatchStatus(prior.status, entry.status),
    };
  }
  return pruneExpiredWatchEntries(merged, nowMs);
}

/**
 * @param {import('./review-trigger-reconcile.mjs').AoSession | null | undefined} session
 * @param {string} headSha
 * @param {{ headCommittedAtMs?: number }} [options]
 */
export function hasInProgressReportForHead(session, headSha, options = {}) {
  if (!session) {
    return false;
  }
  for (const report of toArray(session?.reports)) {
    const state = getReportState(report);
    if (!IN_PROGRESS_REPORT_STATES.has(state)) {
      continue;
    }
    const stored = normalizeSha(
      String(
        report?.headRefOid ??
          report?.head_ref_oid ??
          report?.forHeadSha ??
          report?.for_head_sha ??
          '',
      ),
    );
    const target = normalizeSha(headSha);
    if (stored && stored !== target) {
      continue;
    }
    if (hasReadyForReviewForHead(session, headSha, options)) {
      continue;
    }
    return true;
  }
  return false;
}

/**
 * @param {object} input
 * @param {number} input.prNumber
 * @param {string} input.headSha
 * @param {import('./review-trigger-reconcile.mjs').AoSession | null} [input.session]
 * @param {boolean} [input.hadCompletionWake]
 */
export function evaluateBackstopOnlyZeroSignal(input) {
  const session = input.session ?? null;
  const headSha = normalizeSha(String(input.headSha ?? ''));
  const headCommittedAtMs = Number(input.headCommittedAtMs);
  const bindingOptions = Number.isFinite(headCommittedAtMs)
    ? { headCommittedAtMs }
    : {};

  const inProgress = hasInProgressReportForHead(session, headSha, bindingOptions);
  const hadWake = Boolean(input.hadCompletionWake);

  if (!hadWake && !inProgress) {
    return {
      backstopOnly: true,
      reason: 'zero_signal_backstop_only',
      route: 'backstop',
    };
  }

  return {
    backstopOnly: false,
    reason: inProgress ? 'in_progress_observable' : 'completion_wake_observable',
    route: 'scoped_watch',
  };
}

/**
 * @param {object} input
 * @param {import('./review-trigger-reconcile.mjs').AoSession | null} input.session
 * @param {string} input.headSha
 * @param {number | null | undefined} input.priorReadyMs
 * @param {{ headCommittedAtMs?: number }} [input.bindingOptions]
 * @param {number} [input.nowMs]
 */
export function detectReadinessTransition(input) {
  const session = input.session ?? null;
  const headSha = normalizeSha(String(input.headSha ?? ''));
  const bindingOptions = input.bindingOptions ?? {};
  const nowMs = Number(input.nowMs ?? Date.now());
  const readyNow = hasReadyForReviewForHead(session, headSha, bindingOptions);
  const priorReadyMs =
    input.priorReadyMs == null ? null : Number(input.priorReadyMs);

  if (!readyNow) {
    return {
      transitioned: false,
      readyNow: false,
      readinessObservedMs: priorReadyMs,
    };
  }

  if (priorReadyMs == null || priorReadyMs <= 0) {
    return {
      transitioned: true,
      readyNow: true,
      readinessObservedMs: nowMs,
    };
  }

  return {
    transitioned: false,
    readyNow: true,
    readinessObservedMs: priorReadyMs,
  };
}

/**
 * Unified idempotent head review trigger verdict (Issue #235 / #195 / #189).
 *
 * @param {object} input
 * @param {number} input.prNumber
 * @param {string} input.headSha
 * @param {string} [input.sessionId]
 * @param {number} [input.readinessObservedMs]
 * @param {number} [input.nowMs]
 * @param {boolean} [input.snapshotError]
 * @param {import('./review-trigger-reconcile.mjs').OpenPr[]} [input.openPrs]
 * @param {import('./review-trigger-reconcile.mjs').ReviewRun[]} [input.reviewRuns]
 * @param {import('./review-trigger-reconcile.mjs').AoSession[]} [input.sessions]
 * @param {Array<{ name?: string, state?: string, conclusion?: string, status?: string }>} [input.ciChecks]
 * @param {string[]} [input.requiredCheckNames]
 * @param {boolean} [input.requiredCheckLookupFailed]
 * @param {string} [input.entryPath]
 */
export function evaluateHeadReviewTriggerDecision(input) {
  const nowMs = Number(input.nowMs ?? Date.now());
  const readinessObservedMs = Number(input.readinessObservedMs ?? nowMs);
  const processingMs = Math.max(0, nowMs - readinessObservedMs);
  const withinLatencyBound = processingMs <= READINESS_TO_RUN_DECISION_MAX_MS;
  const entryPath = String(input.entryPath ?? 'state_derived');

  if (input.snapshotError) {
    return {
      triggerReviewRun: false,
      reason: 'snapshot_unknown',
      route: 'retain_watch',
      entryPath,
      processingMs,
      withinLatencyBound,
      retainWatch: true,
    };
  }

  const prNumber = Number(input.prNumber);
  const plannedHead = normalizeSha(String(input.headSha ?? ''));
  const currentHead = normalizeSha(resolveCurrentPrHeadSha(toArray(input.openPrs), prNumber));

  if (!prNumber || !plannedHead) {
    return {
      triggerReviewRun: false,
      reason: 'head_unresolved',
      route: 'none',
      entryPath,
      processingMs,
      withinLatencyBound,
    };
  }

  if (currentHead && plannedHead !== currentHead) {
    return {
      triggerReviewRun: false,
      reason: 'stale_deferred_head_discarded',
      route: 'discard_watch',
      entryPath,
      processingMs,
      withinLatencyBound,
      currentHeadSha: currentHead,
    };
  }

  const wakeEval = evaluateWakeReviewTrigger({
    wakeKind: 'merge.ready',
    sessionId: String(input.sessionId ?? ''),
    prNumber,
    wakeReceivedMs: readinessObservedMs,
    nowMs,
    openPrs: input.openPrs,
    reviewRuns: input.reviewRuns,
    sessions: input.sessions,
    ciChecks: input.ciChecks,
    requiredCheckNames: input.requiredCheckNames,
    requiredCheckLookupFailed: input.requiredCheckLookupFailed,
  });

  const retainWatch =
    wakeEval.route === 'degraded_ci_retry' ||
    wakeEval.reason === 'uncovered_not_ready' ||
    wakeEval.reason === 'ci_red_defer';

  return {
    ...wakeEval,
    entryPath,
    processingMs,
    withinLatencyBound,
    ...(retainWatch ? { retainWatch: true } : {}),
  };
}

/**
 * @param {object} input
 * @param {object} input.entry
 * @param {number} input.nowMs
 * @param {import('./review-trigger-reconcile.mjs').OpenPr[]} input.openPrs
 * @param {import('./review-trigger-reconcile.mjs').ReviewRun[]} input.reviewRuns
 * @param {import('./review-trigger-reconcile.mjs').AoSession[]} input.sessions
 * @param {Record<string, Array<{ name?: string, state?: string, conclusion?: string, status?: string }>> | Array<{ prNumber?: number, checks?: unknown[] }>} [input.ciChecksByPr]
 * @param {Record<string, string[]> | Array<{ prNumber?: number, requiredCheckNames?: string[] }>} [input.requiredCheckNamesByPr]
 * @param {Record<string, boolean> | Array<{ prNumber?: number, failed?: boolean }>} [input.requiredCheckLookupFailedByPr]
 * @param {boolean} [input.snapshotError]
 * @param {string} [input.entryPath]
 */
export function evaluateDeferredWatchEntry(input) {
  const entry = input.entry ?? {};
  const prNumber = Number(entry.prNumber);
  const headSha = normalizeSha(String(entry.headSha ?? ''));
  const nowMs = Number(input.nowMs ?? Date.now());
  const openPrs = toArray(input.openPrs);
  const sessions = toArray(input.sessions);
  const prKey = String(prNumber);
  const headCommittedAtMs = resolveHeadCommittedAtMs(openPrs, prNumber);
  const bindingOptions = { headCommittedAtMs };
  const sessionId =
    String(entry.sessionId ?? '').trim() ||
    resolveHeadOwningWorkerSessionId(sessions, prNumber, headSha, openPrs);
  const session = sessionId ? findSessionById(sessions, sessionId) : null;

  const readiness = detectReadinessTransition({
    session,
    headSha,
    priorReadyMs: entry.lastObservedReadyMs,
    bindingOptions,
    nowMs,
  });

  const ciChecks = getCiChecksForPr(input.ciChecksByPr, prNumber);
  const requiredCheckNames = getRequiredCheckNamesForPr(input.requiredCheckNamesByPr, prNumber);
  const requiredCheckLookupFailed = getRequiredCheckLookupFailedForPr(
    input.requiredCheckLookupFailedByPr,
    prNumber,
  );

  const verdict = evaluateHeadReviewTriggerDecision({
    prNumber,
    headSha,
    sessionId,
    readinessObservedMs: readiness.transitioned
      ? readiness.readinessObservedMs
      : readiness.readyNow
        ? readiness.readinessObservedMs
        : nowMs,
    nowMs,
    snapshotError: Boolean(input.snapshotError),
    openPrs,
    reviewRuns: toArray(input.reviewRuns),
    sessions,
    ciChecks,
    requiredCheckNames,
    requiredCheckLookupFailed,
    entryPath:
      String(entry.seedSource ?? '') === 'report_state_poll'
        ? 'report_state_seed'
        : String(input.entryPath ?? 'scoped_deferred_head_watch'),
  });

  const expiresMs = Number(entry.windowExpiresMs ?? 0);
  const expired = expiresMs > 0 && nowMs >= expiresMs;

  let nextEntry = {
    ...entry,
    sessionId: sessionId || entry.sessionId,
    lastEvaluatedMs: nowMs,
    lastObservedReadyMs: readiness.readyNow
      ? readiness.readinessObservedMs
      : entry.lastObservedReadyMs,
  };

  if (verdict.route === 'discard_watch') {
    nextEntry = { ...nextEntry, status: 'discarded' };
  } else if (expired && !verdict.triggerReviewRun) {
    nextEntry = { ...nextEntry, status: 'expired' };
  } else if (verdict.retainWatch || verdict.route === 'retain_watch') {
    nextEntry = { ...nextEntry, status: 'watching' };
  }

  return {
    ...verdict,
    readiness,
    expired,
    nextEntry,
    watchKey: watchEntryKey(prNumber, headSha),
  };
}

/**
 * @param {object} input
 * @param {Record<string, object>} [input.watchEntries]
 * @param {import('./review-trigger-reconcile.mjs').OpenPr[]} [input.openPrs]
 * @param {import('./review-trigger-reconcile.mjs').ReviewRun[]} [input.reviewRuns]
 * @param {import('./review-trigger-reconcile.mjs').AoSession[]} [input.sessions]
 * @param {number} [input.nowMs]
 * @param {Record<string, boolean>} [input.snapshotErrorsByKey]
 */
export function planDeferredWatchTick(input) {
  const nowMs = Number(input.nowMs ?? Date.now());
  const rawEntries = input.watchEntries ?? {};
  /** @type {Array<object>} */
  const actions = [];
  /** @type {Record<string, object>} */
  const nextEntries = {};

  for (const [key, entry] of Object.entries(rawEntries)) {
    if (!entry || entry.status === 'discarded' || entry.status === 'triggered') {
      if (entry) {
        nextEntries[key] = entry;
      }
      continue;
    }

    const expiresMs = Number(entry.windowExpiresMs ?? 0);
    const windowExpired =
      entry.status !== 'expired' && expiresMs > 0 && nowMs >= expiresMs;

    if (windowExpired && entry.status === 'watching') {
      actions.push({
        type: 'hand_to_backstop',
        prNumber: Number(entry.prNumber),
        headSha: normalizeSha(String(entry.headSha ?? '')),
        reason: 'watch_window_expired',
        watchKey: key,
      });
      nextEntries[key] = { ...entry, status: 'expired', lastEvaluatedMs: nowMs };
      continue;
    }

    if (entry.status === 'expired') {
      nextEntries[key] = entry;
      continue;
    }

    const evaluation = evaluateDeferredWatchEntry({
      entry,
      nowMs,
      openPrs: toArray(input.openPrs),
      reviewRuns: toArray(input.reviewRuns),
      sessions: toArray(input.sessions),
      ciChecksByPr: input.ciChecksByPr,
      requiredCheckNamesByPr: input.requiredCheckNamesByPr,
      requiredCheckLookupFailedByPr: input.requiredCheckLookupFailedByPr,
      snapshotError: Boolean(input.snapshotErrorsByKey?.[key]),
      entryPath: 'scoped_deferred_head_watch',
    });

    nextEntries[key] = evaluation.nextEntry;

    if (evaluation.triggerReviewRun && evaluation.planned) {
      actions.push({
        type: 'start_review',
        prNumber: evaluation.planned.prNumber,
        headSha: evaluation.planned.headSha,
        sessionId: evaluation.planned.sessionId,
        startReason: resolveStartReasonForWatchEntry(entry),
        watchKey: key,
        processingMs: evaluation.processingMs,
        withinLatencyBound: evaluation.withinLatencyBound,
      });
      nextEntries[key] = { ...evaluation.nextEntry, status: 'triggered' };
      continue;
    }

    if (evaluation.route === 'empty_review_trap') {
      actions.push({
        type: 'empty_review_trap',
        prNumber: Number(entry.prNumber),
        headSha: normalizeSha(String(entry.headSha ?? '')),
        terminationReason: evaluation.terminationReason,
        watchKey: key,
      });
      nextEntries[key] = { ...evaluation.nextEntry, status: 'discarded' };
      continue;
    }

    if (evaluation.route === 'escalate_operator') {
      actions.push({
        type: 'escalate_degraded_ci',
        prNumber: Number(entry.prNumber),
        headSha: normalizeSha(String(entry.headSha ?? '')),
        reason: evaluation.reason,
        watchKey: key,
      });
      continue;
    }

    if (evaluation.expired) {
      actions.push({
        type: 'hand_to_backstop',
        prNumber: Number(entry.prNumber),
        headSha: normalizeSha(String(entry.headSha ?? '')),
        reason: 'watch_window_expired',
        watchKey: key,
      });
      continue;
    }

    if (evaluation.retainWatch || evaluation.route === 'retain_watch') {
      actions.push({
        type: 'retain_watch',
        prNumber: Number(entry.prNumber),
        headSha: normalizeSha(String(entry.headSha ?? '')),
        reason: evaluation.reason,
        watchKey: key,
      });
      continue;
    }

    actions.push({
      type: 'skip',
      prNumber: Number(entry.prNumber),
      headSha: normalizeSha(String(entry.headSha ?? '')),
      reason: evaluation.reason,
      record: evaluation.record,
      watchKey: key,
    });
  }

  return {
    actions,
    watchEntries: nextEntries,
    pollClass: SCOPED_DEFERRED_HEAD_WATCH_POLL_CLASS,
  };
}

/**
 * Restore a watch entry optimistically marked `triggered` by planTick when the
 * side-effecting run aborts before starting (pre-run re-check, fence busy, etc.).
 *
 * @param {Record<string, object>} entries
 * @param {string} watchKey
 * @param {number} [nowMs]
 */
export function revertTriggeredWatchOnAbort(entries, watchKey, nowMs = Date.now()) {
  const key = String(watchKey ?? '').trim();
  if (!key || !entries?.[key]) {
    return entries ?? {};
  }
  const entry = entries[key];
  if (entry.status !== 'triggered') {
    return entries;
  }
  return {
    ...entries,
    [key]: {
      ...entry,
      status: 'watching',
      lastEvaluatedMs: nowMs,
    },
  };
}

/**
 * @param {object} input
 * @param {import('./review-trigger-reconcile.mjs').OpenPr[]} input.openPrs
 * @param {import('./review-trigger-reconcile.mjs').ReviewRun[]} input.reviewRuns
 * @param {import('./review-trigger-reconcile.mjs').AoSession[]} input.sessions
 * @param {Record<string, object>} [input.existingWatches]
 * @param {number} [input.nowMs]
 */
export function seedWatchFromInProgressSignals(input) {
  const nowMs = Number(input.nowMs ?? Date.now());
  const openPrs = toArray(input.openPrs);
  const reviewRuns = toArray(input.reviewRuns);
  const sessions = toArray(input.sessions);
  /** @type {Record<string, object>} */
  const seeded = {};

  for (const pr of openPrs) {
    const prNumber = Number(pr?.number);
    const headSha = normalizeSha(String(pr?.headRefOid ?? ''));
    if (!prNumber || !headSha) {
      continue;
    }

    if (isHeadCovered(reviewRuns, prNumber, headSha)) {
      continue;
    }

    const sessionId = resolveHeadOwningWorkerSessionId(sessions, prNumber, headSha, openPrs);
    const session = sessionId ? findSessionById(sessions, sessionId) : null;
    if (!session || !isLiveWorkerSession(session)) {
      continue;
    }

    const headCommittedAtMs = resolveHeadCommittedAtMs(openPrs, prNumber);
    const bindingOptions = { headCommittedAtMs };
    const zeroSignal = evaluateBackstopOnlyZeroSignal({
      prNumber,
      headSha,
      session,
      hadCompletionWake: false,
      headCommittedAtMs,
    });
    if (zeroSignal.backstopOnly) {
      continue;
    }

    if (
      !hasInProgressReportForHead(session, headSha, bindingOptions) &&
      !hasReadyForReviewForHead(session, headSha, bindingOptions)
    ) {
      continue;
    }

    if (hasReadyForReviewForHead(session, headSha, bindingOptions)) {
      continue;
    }

    const key = watchEntryKey(prNumber, headSha);
    seeded[key] = createWatchEntry({
      prNumber,
      headSha,
      sessionId,
      nowMs,
      seedSource: 'in_progress',
      deferReason: 'uncovered_not_ready',
      deferPrimary: 'no_ready_for_review',
    });
  }

  return {
    watchEntries: mergeWatchState(input.existingWatches ?? {}, seeded, nowMs),
    seededKeys: Object.keys(seeded),
  };
}

/**
 * @param {object} input
 * @param {number} input.prNumber
 * @param {string} input.headSha
 * @param {string} input.sessionId
 * @param {string} input.deferReason
 * @param {{ primary?: string } | null | undefined} [input.deferRecord]
 * @param {Record<string, object>} [input.existingWatches]
 * @param {number} [input.nowMs]
 * @param {number} [input.windowMs]
 */

/**
 * @param {object} input
 * @param {Array<{ prNumber: number, headSha: string, sessionId?: string, dedupeKey?: string }>} [input.candidates]
 * @param {Record<string, object>} [input.existingWatches]
 * @param {number} [input.nowMs]
 */
export function seedWatchFromReportStatePoll(input) {
  const nowMs = Number(input.nowMs ?? Date.now());
  /** @type {Record<string, object>} */
  const seeded = {};
  const seededKeys = [];

  for (const candidate of toArray(input.candidates)) {
    const prNumber = Number(candidate?.prNumber);
    const headSha = normalizeSha(String(candidate?.headSha ?? ''));
    if (!prNumber || !headSha) {
      continue;
    }
    const key = watchEntryKey(prNumber, headSha);
    seeded[key] = createWatchEntry({
      prNumber,
      headSha,
      sessionId: String(candidate?.sessionId ?? ''),
      nowMs,
      seedSource: 'report_state_poll',
      deferReason: 'uncovered_not_ready',
      deferPrimary: 'no_ready_for_review',
    });
    seededKeys.push(String(candidate?.dedupeKey ?? key));
  }

  return {
    watchEntries: mergeWatchState(input.existingWatches ?? {}, seeded, nowMs),
    seededKeys,
  };
}

export function seedWatchFromWakeDefer(input) {
  const nowMs = Number(input.nowMs ?? Date.now());
  const deferRecord = input.deferRecord ?? {};
  if (!isDeferredReevalWatchSeedEligible(input.deferReason, deferRecord)) {
    return {
      seeded: false,
      reason: 'not_deferred_not_ready_seed',
      watchEntries: input.existingWatches ?? {},
    };
  }

  const entry = createWatchEntry({
    prNumber: input.prNumber,
    headSha: input.headSha,
    sessionId: input.sessionId,
    nowMs,
    seedSource: 'wake_defer',
    deferReason: String(input.deferReason ?? 'uncovered_not_ready'),
    deferPrimary: String(deferRecord.primary ?? 'no_ready_for_review'),
    windowMs: input.windowMs,
  });
  const key = watchEntryKey(entry.prNumber, entry.headSha);
  const watchEntries = mergeWatchState(input.existingWatches ?? {}, { [key]: entry }, nowMs);

  return {
    seeded: true,
    watchKey: key,
    watchEntries,
    entry,
  };
}

/**
 * AO 0.9.x ready_for_review webhook capture evaluation (Issue #235 crit 3).
 *
 * @param {object} body
 */
export function evaluateReadyForReviewNotificationCapture(body) {
  const event = body?.event;
  const priority = String(event?.priority ?? '').trim().toLowerCase();
  const semanticType = String(event?.data?.semanticType ?? event?.type ?? '').trim();
  const filteredByListener =
    priority === 'info' || priority === 'warning' || !semanticType.includes('ready_for_review');

  return {
    emitsNotification: Boolean(event),
    semanticType,
    priority,
    filteredByListener,
    requiresScopedDeferredHeadWatch: filteredByListener,
    designNote:
      'When AO emits ready_for_review at info priority, the wake listener drops it; scoped deferred-head watch re-evaluates from observed report state.',
  };
}

/**
 * @param {string[]} commandLines
 */
export function findForbiddenReviewReevalCommands(commandLines) {
  return findForbiddenCommandPatterns(commandLines, MECHANICAL_FORBIDDEN_REVIEW_REEVAL);
}

export { buildReviewRunArgv, buildNoStartDecisionRecord, preRunHeadReadyRecheck };

runStdinJsonCli('review-trigger-reeval.mjs', {
  planTick: () => planDeferredWatchTick(readStdinJson()),
  seedFromWakeDefer: () => seedWatchFromWakeDefer(readStdinJson()),
  seedFromInProgress: () => seedWatchFromInProgressSignals(readStdinJson()),
  seedFromReportStatePoll: () => seedWatchFromReportStatePoll(readStdinJson()),
  evaluateVerdict: () => evaluateHeadReviewTriggerDecision(readStdinJson()),
  preRunRecheck: () => {
    const payload = readStdinJson();
    return preRunHeadReadyRecheck(payload.planned, payload.fresh);
  },
  revertTriggeredWatchOnAbort: () => {
    const payload = readStdinJson();
    return {
      watchEntries: revertTriggeredWatchOnAbort(
        payload.watchEntries ?? {},
        payload.watchKey,
        payload.nowMs,
      ),
    };
  },
  mergeWatchState: () => {
    const payload = readStdinJson();
    return {
      watchEntries: mergeWatchState(
        payload.existingWatches ?? {},
        payload.incomingWatches ?? {},
        payload.nowMs,
      ),
    };
  },
  forbidden: () => {
    const payload = readStdinJson();
    return findForbiddenReviewReevalCommands(toArray(payload.commands));
  },
  evaluateNotificationCapture: () =>
    evaluateReadyForReviewNotificationCapture(readStdinJson()),
});
