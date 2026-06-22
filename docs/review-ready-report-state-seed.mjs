/**
 * State-derived review-start seed from accepted ready_for_review reports (Issue #391).
 * Vitest: scripts/review-ready-report-state-seed.test.ts
 */
import { readStdinJson, runStdinJsonCli } from './review-mechanical-cli.mjs';
import {
  handoffAdmissionKey,
  isTerminalHandoffAdmissionRecord,
  normalizeRepoSlugFromPrUrl,
  parsePrNumberFromPrUrl,
} from './review-handoff-wake-admission.mjs';
import { getReportState } from './review-finding-delivery-confirm.mjs';
import { hasReadyForReviewForHead } from './review-head-ready.mjs';
import {
  REPORT_STATE_SEED_START_REASON,
  createWatchEntry,
  mergeWatchState,
  reportStateWatchEntryKey,
  resolveStartReasonForWatchEntry,
  seedWatchFromReportStatePoll,
  watchEntryKey,
} from './review-trigger-reeval.mjs';
import {
  getReportTimestampMs,
  isHeadCovered,
  normalizeSha,
  resolveHeadCommittedAtMs,
  resolveHeadOwningWorkerSessionId,
  sessionMatchesPr,
  toArray,
} from './review-trigger-reconcile.mjs';

/** Poll classification for supervised report-state seed child. */
export const REPORT_STATE_POLL_CLASS = 'report_state_poll';

/** Upper bound from accepted report observation to review-start claim (ms). */
export const REPORT_STATE_SEED_TO_START_MAX_MS = 30_000;

/** Default per-tick scan capacity — deferred heads revisit on later ticks. */
export const DEFAULT_REPORT_STATE_POLL_TICK_CAPACITY = 20;

const READY_FOR_REVIEW_STATE = 'ready_for_review';

/**
 * @param {object} input
 * @param {string} [input.supervisedProject]
 * @param {string} input.repoSlug
 * @param {number} input.prNumber
 * @param {string} input.headSha
 * @param {string} [input.reportState]
 */
export function reportStateSeedDedupeKey(input) {
  return [
    String(input.supervisedProject ?? '').trim().toLowerCase(),
    String(input.repoSlug ?? '').trim().toLowerCase(),
    String(Number(input.prNumber)),
    normalizeSha(String(input.headSha ?? '')),
    String(input.reportState ?? READY_FOR_REVIEW_STATE).trim().toLowerCase(),
  ].join('|');
}

/**
 * @param {string} dedupeKey
 */
export function parseReportStateSeedDedupeKey(dedupeKey) {
  const parts = String(dedupeKey ?? '').split('|');
  if (parts.length < 5) {
    return null;
  }
  return {
    supervisedProject: parts[0],
    repoSlug: parts[1],
    prNumber: Number(parts[2]),
    headSha: parts[3],
    reportState: parts[4],
  };
}

/**
 * @param {object | null | undefined} entry
 * @param {number} nowMs
 */
export function resolveReportStateWatchEntryStatus(entry, nowMs) {
  if (!entry || typeof entry !== 'object') {
    return 'missing';
  }
  let status = String(entry.status ?? 'watching');
  const expiresMs = Number(entry.windowExpiresMs ?? 0);
  if (status === 'watching' && expiresMs > 0 && nowMs >= expiresMs) {
    return 'expired';
  }
  return status;
}

/**
 * @param {string} dedupeKey
 * @param {Record<string, object>} [watchEntries]
 * @param {number} [nowMs]
 */
export function isPersistedReportStateSeedBlocking(dedupeKey, watchEntries = {}, nowMs = Date.now()) {
  const parsed = parseReportStateSeedDedupeKey(dedupeKey);
  if (!parsed?.repoSlug || !parsed.prNumber || !parsed.headSha) {
    return false;
  }

  const watchKey = reportStateWatchEntryKey(parsed.repoSlug, parsed.prNumber, parsed.headSha);
  const entry = watchEntries[watchKey];
  if (!entry || entry.seedSource !== 'report_state_poll') {
    return false;
  }

  const status = resolveReportStateWatchEntryStatus(entry, nowMs);
  return status === 'watching' || status === 'triggered';
}

/**
 * @param {object} input
 * @param {string} input.repoSlug
 * @param {number} input.prNumber
 */
export function pollBindingStateKey(input) {
  return `${String(input.repoSlug ?? '').trim().toLowerCase()}|${Number(input.prNumber)}`;
}

/**
 * @param {Record<string, unknown>} report
 */
export function isAcceptedReadyForReviewReport(report) {
  if (!report || report.accepted !== true) {
    return false;
  }
  return getReportState(report) === READY_FOR_REVIEW_STATE;
}

/**
 * @param {import('./review-trigger-reconcile.mjs').AoSession} session
 */
export function resolveSessionRepoSlug(session, fallbackRepoSlug = '') {
  const prUrl = String(session?.pr ?? session?.prUrl ?? '').trim();
  return normalizeRepoSlugFromPrUrl(prUrl) ?? String(fallbackRepoSlug ?? '').trim().toLowerCase();
}

/**
 * @param {import('./review-trigger-reconcile.mjs').AoSession} session
 */
export function resolveSessionPrNumber(session) {
  const direct = Number(session?.prNumber);
  if (Number.isFinite(direct) && direct > 0) {
    return direct;
  }
  return parsePrNumberFromPrUrl(String(session?.pr ?? session?.prUrl ?? ''));
}

/**
 * @param {import('./review-trigger-reconcile.mjs').AoSession} session
 */
export function resolveSessionProjectId(session) {
  return String(session?.project ?? session?.projectId ?? '').trim();
}

/**
 * @param {import('./review-trigger-reconcile.mjs').AoSession} session
 * @param {string} [supervisedProject]
 */
export function sessionMatchesSupervisedProject(session, supervisedProject = '') {
  const supervised = String(supervisedProject ?? '').trim();
  if (!supervised) {
    return true;
  }
  const projectId = resolveSessionProjectId(session);
  if (!projectId) {
    return true;
  }
  return projectId === supervised;
}

/**
 * @param {Record<string, unknown>} report
 * @param {string} sessionId
 * @param {number} prNumber
 */
export function reportEventIdentity(report, sessionId, prNumber) {
  const ts = getReportTimestampMs(report);
  return `${String(sessionId ?? '')}|${Number(prNumber)}|${ts}|${getReportState(report)}`;
}

/**
 * Poll binding invariant: report binds to current head only when emitted not earlier than
 * when the poller first observed the current tip.
 *
 * @param {object} input
 * @param {Record<string, unknown>} input.report
 * @param {string} input.currentHeadSha
 * @param {number} input.tipFirstObservedMs
 * @param {string} [input.boundReportEventId]
 * @param {string} input.reportEventId
 */
export function evaluatePollReportBinding(input) {
  const currentHeadSha = normalizeSha(String(input.currentHeadSha ?? ''));
  const tipFirstObservedMs = Number(input.tipFirstObservedMs ?? 0);
  const reportMs = getReportTimestampMs(input.report);
  const reportEventId = String(input.reportEventId ?? '').trim();
  const boundReportEventId = String(input.boundReportEventId ?? '').trim();

  if (!currentHeadSha || !reportMs || tipFirstObservedMs <= 0) {
    return { binds: false, reason: 'incomplete_binding_inputs' };
  }

  if (reportMs < tipFirstObservedMs) {
    return { binds: false, reason: 'report_predates_observed_tip' };
  }

  if (boundReportEventId && boundReportEventId === reportEventId) {
    return { binds: true, reason: 'already_bound_report_event' };
  }

  if (boundReportEventId && boundReportEventId !== reportEventId) {
    return { binds: false, reason: 'stale_bound_report_event' };
  }

  return { binds: true, reason: 'fresh_report_on_observed_tip' };
}

/**
 * @param {object} input
 * @param {Record<string, object>} [input.bindingByKey]
 * @param {string} input.repoSlug
 * @param {number} input.prNumber
 * @param {string} input.currentHeadSha
 * @param {number} input.nowMs
 * @param {Record<string, unknown> | null} [input.latestAcceptedReport]
 * @param {string} [input.sessionId]
 * @param {string} [input.reportEventId]
 */
/**
 * Anchor first tip observation to head commit / pre-existing report time so a poller
 * restart does not treat an already-accepted ready_for_review as predating the tip.
 *
 * @param {object} input
 * @param {number} input.nowMs
 * @param {number} [input.headCommittedAtMs]
 * @param {Record<string, unknown> | null} [input.anchorReport]
 */
export function resolveInitialTipFirstObservedMs(input) {
  const nowMs = Number(input.nowMs ?? Date.now());
  let tipMs = nowMs;
  const headCommittedAtMs = Number(input.headCommittedAtMs ?? 0);
  if (Number.isFinite(headCommittedAtMs) && headCommittedAtMs > 0) {
    tipMs = Math.min(tipMs, headCommittedAtMs);
  }
  const report = input.anchorReport ?? null;
  if (isAcceptedReadyForReviewReport(report)) {
    const reportMs = getReportTimestampMs(report);
    if (reportMs > 0) {
      tipMs = Math.min(tipMs, reportMs);
    }
  }
  return tipMs;
}

export function updatePollBindingStateEntry(input) {
  const key = pollBindingStateKey({ repoSlug: input.repoSlug, prNumber: input.prNumber });
  const bindingByKey = { ...(input.bindingByKey ?? {}) };
  const prior = bindingByKey[key] ?? {};
  const currentHeadSha = normalizeSha(String(input.currentHeadSha ?? ''));
  const priorHeadSha = normalizeSha(String(prior.currentHeadSha ?? ''));
  const nowMs = Number(input.nowMs ?? Date.now());

  if (!currentHeadSha) {
    return { bindingByKey, entry: prior, changed: false, reason: 'missing_head' };
  }

  let entry = { ...prior };
  let changed = false;

  if (!priorHeadSha || priorHeadSha !== currentHeadSha) {
    const anchorReport = !priorHeadSha ? (input.latestAcceptedReport ?? null) : null;
    entry = {
      repoSlug: input.repoSlug,
      prNumber: Number(input.prNumber),
      currentHeadSha,
      tipFirstObservedMs: resolveInitialTipFirstObservedMs({
        nowMs,
        headCommittedAtMs: input.headCommittedAtMs,
        anchorReport,
      }),
      boundReportEventId: '',
      boundHeadSha: '',
      updatedAtMs: nowMs,
    };
    changed = true;
  }

  const report = input.latestAcceptedReport ?? null;
  if (!report) {
    if (changed) {
      bindingByKey[key] = entry;
    }
    return {
      bindingByKey,
      entry,
      changed,
      reason: changed ? 'tip_observed_no_report' : 'no_report',
      binds: false,
    };
  }

  const reportEventId =
    String(input.reportEventId ?? '').trim() ||
    reportEventIdentity(report, String(input.sessionId ?? ''), Number(input.prNumber));
  const binding = evaluatePollReportBinding({
    report,
    currentHeadSha,
    tipFirstObservedMs: Number(entry.tipFirstObservedMs ?? nowMs),
    boundReportEventId: String(entry.boundReportEventId ?? ''),
    reportEventId,
  });

  if (binding.binds) {
    const nextEntry = {
      ...entry,
      boundReportEventId: reportEventId,
      boundHeadSha: currentHeadSha,
      boundReportTimestampMs: getReportTimestampMs(report),
      updatedAtMs: nowMs,
    };
    if (
      nextEntry.boundReportEventId !== entry.boundReportEventId ||
      nextEntry.boundHeadSha !== entry.boundHeadSha
    ) {
      changed = true;
    }
    bindingByKey[key] = nextEntry;
    return { bindingByKey, entry: nextEntry, changed, reason: binding.reason, binds: true };
  }

  if (changed) {
    bindingByKey[key] = entry;
  }
  return { bindingByKey, entry, changed, reason: binding.reason, binds: false };
}

/**
 * @param {object} input
 * @param {string} [input.supervisedProject]
 * @param {string} input.repoSlug
 * @param {number} input.prNumber
 * @param {string} input.headSha
 * @param {Record<string, unknown>} [input.handoffRecords]
 * @param {Set<string> | string[]} [input.terminalClaimKeys]
 */
export function hasTerminalHandoffOutcome(input) {
  const prNumber = Number(input.prNumber);
  const headSha = normalizeSha(String(input.headSha ?? ''));
  const repoSlug = String(input.repoSlug ?? '').trim().toLowerCase();
  const projectId = String(input.supervisedProject ?? '').trim();

  const handoffKey = handoffAdmissionKey({
    projectId,
    repoSlug,
    prNumber,
    headSha,
  });
  const handoffRecords = input.handoffRecords ?? {};
  const handoffRecord = handoffRecords[handoffKey];
  if (isTerminalHandoffAdmissionRecord(handoffRecord)) {
    return { terminal: true, reason: 'handoff_receipt' };
  }

  const claimKey = `${prNumber}:${headSha}`;
  const terminalClaims = new Set(toArray(input.terminalClaimKeys).map((value) => String(value)));
  if (terminalClaims.has(claimKey)) {
    return { terminal: true, reason: 'review_start_claim' };
  }

  return { terminal: false, reason: 'none' };
}

/**
 * @param {import('./review-trigger-reconcile.mjs').AoSession[]} sessions
 * @param {string} [fallbackRepoSlug]
 */

/**
 * Resolve an open PR row for a session repository + number pair.
 * Gh open-PR lists are supervised-repo scoped; foreign-repo sessions must not
 * inherit a colliding prNumber head from the local repository.
 *
 * @param {import('./review-trigger-reconcile.mjs').OpenPr[]} openPrs
 * @param {string} repoSlug
 * @param {number} prNumber
 * @param {string} [supervisedRepoSlug]
 */
export function resolveOpenPrForRepoAndNumber(openPrs, repoSlug, prNumber, supervisedRepoSlug = '') {
  const normalizedRepo = String(repoSlug ?? '').trim().toLowerCase();
  const supervised = String(supervisedRepoSlug ?? '').trim().toLowerCase();
  if (supervised && normalizedRepo !== supervised) {
    return null;
  }
  for (const pr of toArray(openPrs)) {
    if (Number(pr?.number) === Number(prNumber)) {
      return pr;
    }
  }
  return null;
}

export function collectStatusSessionsForPoll(sessions, supervisedProject = '') {
  return toArray(sessions).filter((session) => {
    if (!sessionMatchesSupervisedProject(session, supervisedProject)) {
      return false;
    }
    const prNumber = resolveSessionPrNumber(session);
    return Number.isFinite(prNumber) && prNumber > 0;
  });
}

/**
 * Find latest accepted ready_for_review report on a session (emission order).
 *
 * @param {import('./review-trigger-reconcile.mjs').AoSession} session
 */
export function findLatestAcceptedReadyForReviewReport(session) {
  for (const report of toArray(session?.reports)) {
    if (isAcceptedReadyForReviewReport(report)) {
      return report;
    }
  }
  return null;
}
/**
 * Latest accepted ready_for_review across every session row for one PR.
 *
 * @param {import('./review-trigger-reconcile.mjs').AoSession[]} sessions
 */
export function findLatestAcceptedReadyForReviewAcrossSessions(sessions) {
  for (const session of toArray(sessions)) {
    for (const report of toArray(session?.reports)) {
      if (isAcceptedReadyForReviewReport(report)) {
        return { report, session };
      }
    }
  }
  return { report: null, session: null };
}

/**
 * @param {object} input
 * @param {import('./review-trigger-reconcile.mjs').AoSession[]} [input.sessions]
 * @param {import('./review-trigger-reconcile.mjs').OpenPr[]} [input.openPrs]
 * @param {import('./review-trigger-reconcile.mjs').ReviewRun[]} [input.reviewRuns]
 * @param {Record<string, object>} [input.bindingByKey]
 * @param {Record<string, unknown>} [input.handoffRecords]
 * @param {Set<string> | string[]} [input.terminalClaimKeys]
 * @param {Set<string> | string[]} [input.existingSeedKeys]
 * @param {string} [input.supervisedProject]
 * @param {string} [input.fallbackRepoSlug]
 * @param {number} [input.nowMs]
 * @param {number} [input.tickCapacity]
 * @param {string[]} [input.deferredScanKeys]
 * @param {Record<string, object>} [input.watchEntries]
 */
export function planReportStatePollTick(input) {
  const nowMs = Number(input.nowMs ?? Date.now());
  const openPrs = toArray(input.openPrs);
  const reviewRuns = toArray(input.reviewRuns);
  const sessions = collectStatusSessionsForPoll(
    toArray(input.sessions),
    input.supervisedProject,
  );
  const tickCapacity = Number(input.tickCapacity ?? DEFAULT_REPORT_STATE_POLL_TICK_CAPACITY);
  const watchEntries = input.watchEntries ?? {};
  const releasedSeedKeys = [];
  const activeSeedKeys = new Set();
  for (const key of toArray(input.existingSeedKeys).map((value) => String(value))) {
    if (isPersistedReportStateSeedBlocking(key, watchEntries, nowMs)) {
      activeSeedKeys.add(key);
    } else if (key) {
      releasedSeedKeys.push(key);
    }
  }
  const existingSeedKeys = activeSeedKeys;
  const deferredPrior = toArray(input.deferredScanKeys).map((value) => String(value));

  /** @type {Record<string, object>} */
  let bindingByKey = { ...(input.bindingByKey ?? {}) };
  /** @type {Array<object>} */
  const candidates = [];
  /** @type {Array<object>} */
  const skips = [];
  /** @type {string[]} */
  const deferredScanKeys = [];
  /** @type {string[]} */
  const seededKeys = [];

  const supervisedRepoSlug = String(input.fallbackRepoSlug ?? '').trim().toLowerCase();

  /** @type {Map<string, { sessions: import('./review-trigger-reconcile.mjs').AoSession[], prNumber: number, repoSlug: string }>} */
  const headsByScanKey = new Map();

  for (const session of sessions) {
    const prNumber = resolveSessionPrNumber(session);
    const repoSlug =
      resolveSessionRepoSlug(session, input.fallbackRepoSlug) ||
      supervisedRepoSlug;
    const openPr = resolveOpenPrForRepoAndNumber(
      openPrs,
      repoSlug,
      prNumber,
      supervisedRepoSlug,
    );
    const headSha = normalizeSha(String(openPr?.headRefOid ?? ''));
    if (!headSha) {
      continue;
    }
    const scanKey = pollBindingStateKey({ repoSlug, prNumber });
    const existing = headsByScanKey.get(scanKey);
    if (existing) {
      existing.sessions.push(session);
    }
    else {
      headsByScanKey.set(scanKey, { sessions: [session], prNumber, repoSlug });
    }
  }

  const orderedScanKeys = [
    ...deferredPrior.filter((key) => headsByScanKey.has(key)),
    ...[...headsByScanKey.keys()].filter((key) => !deferredPrior.includes(key)),
  ];

  let processed = 0;
  for (const scanKey of orderedScanKeys) {
    const head = headsByScanKey.get(scanKey);
    if (!head) {
      continue;
    }
    if (processed >= tickCapacity) {
      deferredScanKeys.push(scanKey);
      continue;
    }
    processed += 1;

    const { sessions: prSessions, prNumber, repoSlug } = head;
    const openPr = resolveOpenPrForRepoAndNumber(
      openPrs,
      repoSlug,
      prNumber,
      supervisedRepoSlug,
    );
    const headSha = normalizeSha(String(openPr?.headRefOid ?? ''));
    const headCommittedAtMs = resolveHeadCommittedAtMs(openPr ? [openPr] : [], prNumber);
    const bindingOptions = Number.isFinite(headCommittedAtMs) ? { headCommittedAtMs } : {};
    const { report: latestReport, session: reportSession } =
      findLatestAcceptedReadyForReviewAcrossSessions(prSessions);
    const sessionId = String(
      reportSession?.name ?? reportSession?.sessionId ?? reportSession?.id ?? '',
    ).trim();

    const bindingUpdate = updatePollBindingStateEntry({
      bindingByKey,
      repoSlug,
      prNumber,
      currentHeadSha: headSha,
      nowMs,
      headCommittedAtMs,
      latestAcceptedReport: latestReport,
      sessionId,
      reportEventId: latestReport
        ? reportEventIdentity(latestReport, sessionId, prNumber)
        : '',
    });
    bindingByKey = bindingUpdate.bindingByKey;

    if (!latestReport) {
      skips.push({ scanKey, prNumber, headSha, reason: 'no_accepted_ready_report' });
      continue;
    }

    if (!bindingUpdate.binds || bindingUpdate.entry?.boundHeadSha !== headSha) {
      skips.push({
        scanKey,
        prNumber,
        headSha,
        reason: bindingUpdate.reason ?? 'poll_binding_failed',
      });
      continue;
    }

    if (isHeadCovered(reviewRuns, prNumber, headSha)) {
      skips.push({ scanKey, prNumber, headSha, reason: 'head_covered' });
      continue;
    }

    const terminal = hasTerminalHandoffOutcome({
      supervisedProject: input.supervisedProject,
      repoSlug,
      prNumber,
      headSha,
      handoffRecords: input.handoffRecords,
      terminalClaimKeys: input.terminalClaimKeys,
    });
    if (terminal.terminal) {
      skips.push({ scanKey, prNumber, headSha, reason: terminal.reason });
      continue;
    }

    if (!hasReadyForReviewForHead(reportSession, headSha, bindingOptions)) {
      skips.push({ scanKey, prNumber, headSha, reason: 'classifier_not_ready' });
      continue;
    }

    const dedupeKey = reportStateSeedDedupeKey({
      supervisedProject: input.supervisedProject,
      repoSlug,
      prNumber,
      headSha,
      reportState: READY_FOR_REVIEW_STATE,
    });
    if (existingSeedKeys.has(dedupeKey)) {
      skips.push({ scanKey, prNumber, headSha, reason: 'seed_deduped' });
      continue;
    }

    candidates.push({
      dedupeKey,
      repoSlug,
      prNumber,
      headSha,
      sessionId:
        sessionId ||
        resolveHeadOwningWorkerSessionId(sessions, prNumber, headSha, openPrs) ||
        '',
      reportTimestampMs: getReportTimestampMs(latestReport),
      scanKey,
    });
  }

  return {
    pollClass: REPORT_STATE_POLL_CLASS,
    bindingByKey,
    candidates,
    skips,
    deferredScanKeys,
    seededKeys,
    releasedSeedKeys,
    nowMs,
  };
}

export { REPORT_STATE_SEED_START_REASON, resolveStartReasonForWatchEntry, seedWatchFromReportStatePoll };

runStdinJsonCli('review-ready-report-state-seed.mjs', {
  planTick: () => planReportStatePollTick(readStdinJson()),
  seedFromCandidates: () => seedWatchFromReportStatePoll(readStdinJson()),
  updateBinding: () => updatePollBindingStateEntry(readStdinJson()),
  hasTerminalOutcome: () => hasTerminalHandoffOutcome(readStdinJson()),
});
