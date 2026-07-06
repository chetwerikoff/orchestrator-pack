/**
 * REMOVED on AO 0.10 — auto-delivery supersedes first-send reconcile (Issues #202, #210, #625).
 * Exports retained for import stability; planReviewSendActions returns empty actions.
 * Vitest: scripts/review-send-reconcile.test.ts
 */
import {
  evaluateMechanicalTickInterval,
  findForbiddenCommandPatterns,
  MECHANICAL_FORBIDDEN_SPAWN_CLAIM_KILL,
  readStdinJson,
  runStdinJsonCli,
} from './review-mechanical-cli.mjs';
import { getReviewRunId } from './review-finding-delivery-confirm.mjs';
import { shouldOrchestratorActOnRun } from './review-orchestrator-loop.mjs';
import { isRuntimeAlive } from './review-ready-stuck-guard.mjs';
import { resolveCurrentPrHeadSha } from './review-head-ready.mjs';
import {
  findSessionById,
  getSessionIdentifier,
  isLiveWorkerSession,
  normalizeSha,
  sessionOwnsRunHead,
  toArray,
} from './review-trigger-reconcile.mjs';
import { isUndeliveredChangesRequested } from './review-producer-contract.mjs';

/** REMOVED: first-send reconcile retired on AO 0.10 auto-delivery. */
export const REVIEW_SEND_RECONCILE_REMOVED = true;
export const REVIEW_SEND_RECONCILE_REMOVED_REASON = 'ao_0_10_auto_delivery';

/** Default tick cadence: 2 minutes (legacy constant; reconcile path is REMOVED). */
export const DEFAULT_REVIEW_SEND_INTERVAL_MS = 2 * 60 * 1000;

/** Undelivered changes_requested was eligible for legacy first-send. */
export const FIRST_SEND_RUN_STATUS = 'changes_requested';

/** Terminal / ineligible run statuses (fail-closed, AO 0.10). */
export const INELIGIBLE_FIRST_SEND_STATUSES = new Set([
  'failed',
  'cancelled',
  'outdated',
  'up_to_date',
  'queued',
  'preparing',
  'running',
  'reviewing',
  'needs_review',
]);

/** Shell fragments forbidden on this path (PR #97 split-brain). */
export const FORBIDDEN_LIFECYCLE_PATTERNS = [
  ...MECHANICAL_FORBIDDEN_SPAWN_CLAIM_KILL,
  /\bclaim-pr\b/i,
  /\bao\s+send\b/i,
  /\bao\s+report\b/i,
  new RegExp('ao\\s+review\\s+run', 'i'),
];

/** @typedef {{ id?: string, reviewerSessionId?: string, prNumber?: number, targetSha?: string, status?: string, prReviewStatus?: string, openFindingCount?: number, deliveredFindingCount?: number, deliveredAt?: string | null, linkedSessionId?: string }} ReviewRun */
/** @typedef {{ number?: number, headRefOid?: string }} OpenPr */
/** @typedef {{ name?: string, sessionId?: string, id?: string, role?: string, prNumber?: number | null, pr?: string | null, ownedHeadSha?: string, headRefOid?: string, status?: string, runtime?: string }} AoSession */
/** @typedef {{ runId?: string, targetSha?: string, sessionId?: string, sentAtMs?: number }} SentDeliveryRecord */
/** @typedef {{ sent?: Record<string, SentDeliveryRecord>, lastTickMs?: number }} ReviewSendTrackingState */
/** @typedef {{ type: 'send', runId: string, prNumber: number, targetSha: string, sessionId: string, dedupeKey: string } | { type: 'skip', runId?: string, prNumber?: number, targetSha?: string, reason: string }} ReviewSendAction */

/**
 * @param {string} runId
 * @param {string} targetSha
 */
export function buildDedupeKey(runId, targetSha) {
  return `${String(runId).trim()}:${normalizeSha(targetSha)}`;
}

/**
 * @param {ReviewRun} run
 */
export function resolveSentFindingCount(run) {
  const raw = run?.deliveredFindingCount ?? run?.sentFindingCount;
  if (raw === null || raw === undefined) {
    return { ok: false, reason: 'delivered_finding_count_missing' };
  }
  const count = Number(raw);
  if (!Number.isFinite(count) || count < 0) {
    return { ok: false, reason: 'delivered_finding_count_ambiguous' };
  }
  return { ok: true, count };
}

/** @deprecated Use resolveSentFindingCount — retained for import stability (#625). */
export const resolveDeliveredFindingCount = resolveSentFindingCount;

/**
 * @param {ReviewRun} run
 */
export function resolveOpenFindingCount(run) {
  const raw = run?.openFindingCount;
  if (raw === null || raw === undefined) {
    return { ok: false, reason: 'open_finding_count_missing' };
  }
  const count = Number(raw);
  if (!Number.isFinite(count) || count < 0) {
    return { ok: false, reason: 'open_finding_count_ambiguous' };
  }
  return { ok: true, count };
}

/**
 * @param {ReviewRun} run
 */
export function isNeedsTriageNeverSentRun(run) {
  if (!isUndeliveredChangesRequested(run)) {
    return false;
  }
  const sent = resolveSentFindingCount(run);
  if (!sent.ok || sent.count !== 0) {
    return false;
  }
  const open = resolveOpenFindingCount(run);
  if (!open.ok || open.count <= 0) {
    return false;
  }
  return true;
}

/**
 * PR numbers referenced on runs/sessions but absent from gh open PR list are merged/closed.
 *
 * @param {ReviewRun[]} reviewRuns
 * @param {AoSession[]} sessions
 * @param {OpenPr[]} openPrs
 * @param {number[] | Set<number>} [explicitMerged]
 */
export function buildMergedPrNumberSet(reviewRuns, sessions, openPrs, explicitMerged = []) {
  const open = new Set(
    toArray(openPrs)
      .map((pr) => Number(pr?.number))
      .filter((n) => n > 0),
  );
  /** @type {Set<number>} */
  const merged = new Set(toArray(explicitMerged).map((n) => Number(n)).filter((n) => n > 0));

  for (const run of toArray(reviewRuns)) {
    const pr = Number(run?.prNumber);
    if (pr > 0 && !open.has(pr)) {
      merged.add(pr);
    }
  }
  for (const session of toArray(sessions)) {
    const pr = Number(session?.prNumber);
    if (pr > 0 && !open.has(pr)) {
      merged.add(pr);
    }
  }
  return merged;
}

/**
 * @param {ReviewRun[]} runs
 * @param {ReviewRun} target
 */
export function countAmbiguousNeedsTriagePeers(runs, target) {
  const prNumber = Number(target?.prNumber);
  const head = normalizeSha(target?.targetSha);
  if (!prNumber || !head) {
    return 0;
  }

  return toArray(runs).filter((run) => {
    if (!isNeedsTriageNeverSentRun(run)) {
      return false;
    }
    if (Number(run?.prNumber) !== prNumber) {
      return false;
    }
    return normalizeSha(run?.targetSha) === head;
  }).length;
}

/**
 * @param {ReviewRun} run
 * @param {AoSession[]} sessions
 * @param {OpenPr[]} openPrs
 * @param {Set<number>} mergedPrNumbers
 */
export function evaluateFirstSendCandidate(run, sessions, openPrs, mergedPrNumbers) {
  const runId = getReviewRunId(run);
  if (!runId) {
    return { eligible: false, reason: 'missing_run_id' };
  }

  const status = String(run?.prReviewStatus ?? run?.status ?? '').toLowerCase();
  if (!isUndeliveredChangesRequested(run)) {
    return { eligible: false, reason: `status_${status || 'missing'}` };
  }

  if (INELIGIBLE_FIRST_SEND_STATUSES.has(status)) {
    return { eligible: false, reason: `ineligible_status_${status}` };
  }

  const sent = resolveSentFindingCount(run);
  if (!sent.ok) {
    return { eligible: false, reason: sent.reason };
  }
  if (sent.count > 0) {
    return { eligible: false, reason: 'already_sent' };
  }

  const open = resolveOpenFindingCount(run);
  if (!open.ok) {
    return { eligible: false, reason: open.reason };
  }
  if (open.count <= 0) {
    return { eligible: false, reason: 'no_open_findings' };
  }

  const act = shouldOrchestratorActOnRun(run, sessions, mergedPrNumbers);
  if (!act.act) {
    return {
      eligible: false,
      reason: act.reason ?? act.action ?? 'orchestrator_inaction',
    };
  }

  const prNumber = Number(run?.prNumber) || Number(act.prNumber);
  if (!prNumber) {
    return { eligible: false, reason: 'unresolved_pr_number' };
  }

  const targetSha = normalizeSha(run?.targetSha);
  const currentHead = normalizeSha(resolveCurrentPrHeadSha(openPrs, prNumber));
  if (!targetSha || !currentHead) {
    return { eligible: false, reason: 'missing_head_sha' };
  }
  if (targetSha !== currentHead) {
    return { eligible: false, reason: 'stale_head' };
  }

  const linkedId = String(run?.linkedSessionId ?? '').trim();
  if (!linkedId) {
    return { eligible: false, reason: 'missing_linked_session' };
  }

  const session = findSessionById(sessions, linkedId);
  if (!session) {
    return { eligible: false, reason: 'linked_session_missing' };
  }
  if (!isLiveWorkerSession(session)) {
    return { eligible: false, reason: 'linked_session_not_live' };
  }
  if (!isRuntimeAlive(session)) {
    return { eligible: false, reason: 'linked_session_runtime_not_alive' };
  }
  if (!sessionOwnsRunHead(session, prNumber, targetSha, openPrs)) {
    return { eligible: false, reason: 'linked_session_not_head_owner' };
  }

  return {
    eligible: true,
    reason: 'ok',
    runId,
    prNumber,
    targetSha,
    sessionId: getSessionIdentifier(session) ?? linkedId,
  };
}

/**
 * @param {object} input
 * @param {ReviewRun[]} input.reviewRuns
 * @param {AoSession[]} input.sessions
 * @param {OpenPr[]} input.openPrs
 * @param {number[] | Set<number>} [input.mergedPrNumbers]
 * @param {ReviewSendTrackingState} [input.tracking]
 */
export function planReviewSendActions({
  reviewRuns,
  sessions,
  openPrs,
  mergedPrNumbers: explicitMerged,
  tracking = {},
}) {
  const runList = toArray(reviewRuns);
  const sessionList = toArray(sessions);
  const openPrList = toArray(openPrs);
  const merged = buildMergedPrNumberSet(runList, sessionList, openPrList, explicitMerged);
  return {
    actions: [],
    mergedPrNumbers: [...merged],
    removed: true,
    reason: REVIEW_SEND_RECONCILE_REMOVED_REASON,
  };
}

/**
 * @param {ReviewRun | undefined} run
 * @param {string} expectedRunId
 * @param {string} expectedTargetSha
 */
export function verifyRunSentStateAfterSend(run, expectedRunId, expectedTargetSha) {
  const runId = getReviewRunId(run);
  if (!runId || runId !== expectedRunId) {
    return { ok: false, reason: 'run_missing_after_send' };
  }
  if (isUndeliveredChangesRequested(run)) {
    return { ok: false, reason: 'still_undelivered_changes_requested_after_send' };
  }
  const sent = resolveSentFindingCount(run);
  if (!sent.ok) {
    return { ok: false, reason: sent.reason };
  }
  if (sent.count <= 0) {
    return { ok: false, reason: 'sent_finding_count_not_positive' };
  }
  if (normalizeSha(run?.targetSha) !== normalizeSha(expectedTargetSha)) {
    return { ok: false, reason: 'target_sha_changed_after_send' };
  }
  return { ok: true, reason: 'ok' };
}

/**
 * @param {object} planned
 * @param {string} planned.runId
 * @param {number} planned.prNumber
 * @param {string} planned.targetSha
 * @param {string} planned.sessionId
 * @param {object} fresh
 * @param {ReviewRun[]} fresh.reviewRuns
 * @param {AoSession[]} fresh.sessions
 * @param {OpenPr[]} fresh.openPrs
 * @param {number[] | Set<number>} [fresh.mergedPrNumbers]
 */
export function preSendRecheck(planned, fresh) {
  const { runId, prNumber, targetSha, sessionId } = planned;
  const runList = toArray(fresh.reviewRuns);
  const sessionList = toArray(fresh.sessions);
  const openPrList = toArray(fresh.openPrs);
  const merged = buildMergedPrNumberSet(
    runList,
    sessionList,
    openPrList,
    fresh.mergedPrNumbers,
  );

  const run = runList.find((row) => getReviewRunId(row) === runId);
  if (!run) {
    return { ok: false, reason: 'run_missing_at_send' };
  }

  const candidate = evaluateFirstSendCandidate(run, sessionList, openPrList, merged);
  if (!candidate.eligible) {
    return { ok: false, reason: `recheck_failed:${candidate.reason}` };
  }

  if (candidate.runId !== runId) {
    return { ok: false, reason: 'run_id_changed' };
  }
  if (candidate.prNumber !== prNumber) {
    return { ok: false, reason: 'pr_number_changed' };
  }
  if (normalizeSha(candidate.targetSha) !== normalizeSha(targetSha)) {
    return { ok: false, reason: 'head_advanced' };
  }
  if (candidate.sessionId !== sessionId) {
    return { ok: false, reason: 'session_id_changed' };
  }

  if (countAmbiguousNeedsTriagePeers(runList, run) > 1) {
    return { ok: false, reason: 'ambiguous_overlap_at_send' };
  }

  return { ok: true, reason: 'ok' };
}

/**
 * @param {ReviewSendTrackingState} tracking
 * @param {string} dedupeKey
 * @param {object} record
 * @param {string} record.runId
 * @param {string} record.targetSha
 * @param {string} record.sessionId
 * @param {number} record.sentAtMs
 */
export function recordSuccessfulSend(tracking, dedupeKey, record) {
  const sent = { ...(tracking.sent ?? {}) };
  sent[dedupeKey] = {
    runId: record.runId,
    targetSha: normalizeSha(record.targetSha),
    sessionId: record.sessionId,
    sentAtMs: record.sentAtMs,
  };
  return { ...tracking, sent };
}

/**
 * @param {object} input
 * @param {number} input.nowMs
 * @param {number | undefined} input.lastTickMs
 * @param {number} [input.intervalMs]
 */
export function evaluateReviewSendInterval({ nowMs, lastTickMs, intervalMs }) {
  return evaluateMechanicalTickInterval({
    nowMs,
    lastTickMs,
    intervalMs: Number(intervalMs) || DEFAULT_REVIEW_SEND_INTERVAL_MS,
    defaultIntervalMs: DEFAULT_REVIEW_SEND_INTERVAL_MS,
  });
}

/**
 * @param {string[]} commandLines
 */
export function findForbiddenReviewSendReconcileCommands(commandLines) {
  return findForbiddenCommandPatterns(commandLines, FORBIDDEN_LIFECYCLE_PATTERNS);
}

runStdinJsonCli('review-send-reconcile.mjs', {
  plan: () => {
    const payload = readStdinJson();
    return planReviewSendActions(payload);
  },
  interval: () => {
    const payload = readStdinJson();
    return evaluateReviewSendInterval({
      nowMs: Number(payload.nowMs) || Date.now(),
      lastTickMs: payload.lastTickMs,
      intervalMs: payload.intervalMs,
    });
  },
  recheck: () => {
    const payload = readStdinJson();
    return preSendRecheck(payload.planned, payload.fresh);
  },
  'verify-sent': () => {
    const payload = readStdinJson();
    const run = toArray(payload.reviewRuns).find(
      (row) => getReviewRunId(row) === payload.runId,
    );
    return verifyRunSentStateAfterSend(run, payload.runId, payload.targetSha);
  },
});
