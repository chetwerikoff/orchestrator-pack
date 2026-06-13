/**
 * Source-agnostic worker message submit arbiter (Issue #232, extended by #293).
 * Vitest: scripts/worker-message-submit-reconcile.test.ts
 */
import {
  evaluateMechanicalTickInterval,
  readStdinJson,
  resolveBoundedInt,
  runStdinJsonCli,
} from './review-mechanical-cli.mjs';
import {
  findSessionById,
  sessionMatchesIdentifier,
  toArray,
} from './review-trigger-reconcile.mjs';
import {
  hasInterveningInputActivity,
  isSessionFloodActive,
} from './worker-input-draft-submit.mjs';
import {
  DELIVERY_PATH_PENDING_DRAFT,
  DELIVERY_PATH_SELF_SUBMITTED,
  DISPATCH_OUTCOME_DISPATCHED,
  DISPATCH_OUTCOME_SEND_FAILED,
  DISPATCH_OUTCOME_IN_FLIGHT,
  DISPATCH_OUTCOME_UNKNOWN,
  DRAFT_STATE_DRAFT_PRESENT,
  DRAFT_STATE_AUTO_SUBMITTED,
  findOverwrittenDeliveries,
  isDeliveryConsumed,
  isSessionAlive,
  isSessionStreaming,
  mergeDeliveryRecords,
  selectSurvivingDelivery,
} from './worker-message-dispatch-observe.mjs';

/** Default tick cadence: 30 seconds. */
export const DEFAULT_SUBMIT_RECONCILE_INTERVAL_MS = 30 * 1000;

/** Max submit attempts per delivery record. */
export const DEFAULT_MAX_SUBMIT_ATTEMPTS = 3;

/** Absolute delivery-anchored backstop (ms). */
export const DEFAULT_DELIVERY_BACKSTOP_MS = 30 * 60 * 1000;

/** Max pending age after first Enter dispatch absent fresh progress (ms). */
export const DEFAULT_POST_DISPATCH_LEASE_MS = 10 * 60 * 1000;

/** Active submit claim lease before a settled-observable retry may clear it (ms). */
export const DEFAULT_CLAIM_STALE_MS = 60 * 1000;

/** Idle-looking state must remain stable this long before retry is observable (ms). */
export const DEFAULT_OBSERVABILITY_SETTLE_MS = 15 * 1000;

export const SUBMIT_STATE_PENDING = 'pending';
export const SUBMIT_STATE_SUBMITTED = 'submitted';
export const SUBMIT_STATE_ESCALATED = 'escalated';
export const SUBMIT_STATE_NOOP = 'noop';

export const OPERATOR_ESCALATION_PREFIX =
  '[worker-message-submit-reconcile] ESCALATION:';

export const FAILED_DELIVERY_UNRESOLVED = 'unresolved';
export const FAILED_DELIVERY_RESOLVED = 'resolved';
export const FAILED_DELIVERY_AUDITED_CLOSED = 'audited_closed';

function trimString(value) {
  return String(value ?? '').trim();
}

function parseFlexibleTimestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : 0;
  }
  return 0;
}

function maxTimestamp(...values) {
  return values.reduce((max, value) => {
    const n = Number(value ?? 0);
    return Number.isFinite(n) && n > max ? n : max;
  }, 0);
}

/**
 * @param {object} [config]
 */
export function resolveSubmitReconcileConfig(config = {}) {
  return {
    intervalMs: resolveBoundedInt(
      config.intervalMs,
      DEFAULT_SUBMIT_RECONCILE_INTERVAL_MS,
      1000,
    ),
    maxSubmitAttempts: resolveBoundedInt(
      config.maxSubmitAttempts,
      DEFAULT_MAX_SUBMIT_ATTEMPTS,
      1,
    ),
    deliveryBackstopMs: resolveBoundedInt(
      config.deliveryBackstopMs ?? config.deliveryBudgetMs,
      DEFAULT_DELIVERY_BACKSTOP_MS,
      1000,
    ),
    postDispatchLeaseMs: resolveBoundedInt(
      config.postDispatchLeaseMs,
      DEFAULT_POST_DISPATCH_LEASE_MS,
      1000,
    ),
    claimStaleMs: resolveBoundedInt(
      config.claimStaleMs,
      DEFAULT_CLAIM_STALE_MS,
      1000,
    ),
    observabilitySettleMs: resolveBoundedInt(
      config.observabilitySettleMs,
      DEFAULT_OBSERVABILITY_SETTLE_MS,
      1000,
    ),
    busyDispatch: {
      markers: toArray(config?.busyDispatch?.markers),
      environment:
        config?.busyDispatch?.environment && typeof config.busyDispatch.environment === 'object'
          ? config.busyDispatch.environment
          : {},
    },
  };
}

function validatePositiveConfigField(name, value, max) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > max) {
    return { ok: false, reason: 'config_invalid', field: name };
  }
  return null;
}

/**
 * @param {Record<string, unknown>} [marker]
 */
export function validateBusyDispatchMarker(marker = {}) {
  const required = [
    'backendKey',
    'dispatchSignature',
    'runtimeFingerprint',
    'tmuxFingerprint',
    'smokedAt',
    'runId',
  ];
  for (const key of required) {
    if (!trimString(marker?.[key])) {
      return { ok: false, reason: 'busy_dispatch_marker_invalid', field: key };
    }
  }
  const requiredFlags = [
    'busy_enter_enqueued_observed',
    'consumed_after_flush_observed',
    'no_manual_enter',
  ];
  for (const key of requiredFlags) {
    if (marker?.[key] !== true) {
      return { ok: false, reason: 'busy_dispatch_marker_invalid', field: key };
    }
  }
  return { ok: true };
}

/**
 * @param {object} [config]
 */
export function validateSubmitReconcileConfig(config = {}) {
  const checks = [
    ['maxSubmitAttempts', config.maxSubmitAttempts, 25],
    ['deliveryBackstopMs', config.deliveryBackstopMs ?? config.deliveryBudgetMs, 24 * 60 * 60 * 1000],
    ['postDispatchLeaseMs', config.postDispatchLeaseMs, 24 * 60 * 60 * 1000],
    ['claimStaleMs', config.claimStaleMs, 24 * 60 * 60 * 1000],
    ['observabilitySettleMs', config.observabilitySettleMs, 5 * 60 * 1000],
  ];
  for (const [name, value, max] of checks) {
    const invalid = validatePositiveConfigField(name, value, max);
    if (invalid) {
      return invalid;
    }
  }

  for (const marker of toArray(config?.busyDispatch?.markers)) {
    const valid = validateBusyDispatchMarker(marker);
    if (!valid.ok) {
      return { ok: false, reason: valid.reason, field: valid.field };
    }
  }

  return { ok: true };
}

/**
 * @param {Record<string, unknown>} tracking
 * @param {string} deliveryId
 */
export function getDeliveryTracking(tracking, deliveryId) {
  const id = trimString(deliveryId);
  return tracking?.deliveries?.[id] ?? {};
}

/**
 * @param {Record<string, unknown>} record
 */
export function clearSubmitClaimFields(record = {}) {
  const next = { ...record };
  delete next.claimed;
  delete next.claimKey;
  delete next.provisionalClaimKey;
  delete next.provisionalClaimSinceMs;
  return next;
}

/**
 * @param {Record<string, unknown>} record
 * @param {number} nowMs
 * @param {object} [config]
 */
export function isActiveSubmitClaim(record, nowMs, config = {}) {
  const hasClaim = Boolean(record?.claimed || record?.provisionalClaimKey);
  if (!hasClaim) {
    return false;
  }

  const claimSinceMs = Number(
    record?.lastSubmitAtMs ?? record?.provisionalClaimSinceMs ?? 0,
  );
  if (claimSinceMs <= 0) {
    return Boolean(record?.claimed);
  }

  const claimStaleMs = resolveBoundedInt(
    config.claimStaleMs,
    DEFAULT_CLAIM_STALE_MS,
    1000,
  );
  return nowMs - claimSinceMs < claimStaleMs;
}

/**
 * @param {Record<string, unknown>} record
 * @param {number} nowMs
 * @param {object} [config]
 */
export function shouldClearStaleSubmitClaim(record, nowMs, config = {}) {
  const hasClaim = Boolean(record?.claimed || record?.provisionalClaimKey);
  if (!hasClaim) {
    return false;
  }

  const claimSinceMs = Number(
    record?.lastSubmitAtMs ?? record?.provisionalClaimSinceMs ?? 0,
  );
  if (claimSinceMs <= 0) {
    return false;
  }

  const claimStaleMs = resolveBoundedInt(
    config.claimStaleMs,
    DEFAULT_CLAIM_STALE_MS,
    1000,
  );
  return nowMs - claimSinceMs >= claimStaleMs;
}

/**
 * @param {object} input
 */
export function resolveBusyDispatchCapability({ delivery, session, config }) {
  if (typeof delivery?.busyDispatchAllowed === 'boolean') {
    return {
      allowed: Boolean(delivery.busyDispatchAllowed),
      backendKey: trimString(session?.backendKey ?? delivery?.backendKey),
      reason: delivery.busyDispatchAllowed ? 'fixture_override' : 'fixture_disabled',
      marker: null,
    };
  }

  const cfg = resolveSubmitReconcileConfig(config);
  const environment =
    cfg.busyDispatch.environment && typeof cfg.busyDispatch.environment === 'object'
      ? cfg.busyDispatch.environment
      : {};
  const backendKey = trimString(
    session?.backendKey ?? delivery?.backendKey ?? environment.backendKey,
  );
  const dispatchSignature = trimString(
    session?.dispatchSignature ??
      delivery?.dispatchSignature ??
      environment.dispatchSignature,
  );
  const runtimeFingerprint = trimString(
    session?.runtimeFingerprint ??
      delivery?.runtimeFingerprint ??
      environment.runtimeFingerprint,
  );
  const tmuxFingerprint = trimString(
    session?.tmuxFingerprint ??
      delivery?.tmuxFingerprint ??
      environment.tmuxFingerprint,
  );

  if (!backendKey || !dispatchSignature || !runtimeFingerprint || !tmuxFingerprint) {
    return {
      allowed: false,
      backendKey,
      reason: 'busy_dispatch_environment_unknown',
      marker: null,
    };
  }

  for (const marker of cfg.busyDispatch.markers) {
    const valid = validateBusyDispatchMarker(marker);
    if (!valid.ok) {
      continue;
    }
    if (
      trimString(marker.backendKey) === backendKey &&
      trimString(marker.dispatchSignature) === dispatchSignature &&
      trimString(marker.runtimeFingerprint) === runtimeFingerprint &&
      trimString(marker.tmuxFingerprint) === tmuxFingerprint
    ) {
      return { allowed: true, backendKey, reason: 'busy_dispatch_marker_match', marker };
    }
  }

  return {
    allowed: false,
    backendKey,
    reason: 'busy_dispatch_marker_missing_or_stale',
    marker: null,
  };
}

/**
 * @param {Record<string, unknown>} [session]
 * @param {string} [deliverySessionId]
 */
export function collectSessionIdentifiers(session, deliverySessionId = '') {
  /** @type {Set<string>} */
  const ids = new Set();
  const push = (value) => {
    const trimmed = trimString(value);
    if (trimmed) {
      ids.add(trimmed);
    }
  };
  push(deliverySessionId);
  push(session?.name);
  push(session?.sessionId);
  push(session?.id);
  return [...ids];
}

/**
 * @param {Record<string, unknown>} delivery
 * @param {Record<string, unknown>} [record]
 */
export function getDeliveryInputAnchorMs(delivery, record = {}) {
  const deliveryMs = Number(delivery?.deliveredAtMs ?? 0);
  if (deliveryMs > 0) {
    return deliveryMs;
  }
  return Number(record?.deliveredAtMs ?? record?.firstObservedAtMs ?? 0);
}

/**
 * @param {Array<Record<string, unknown>>} events
 * @param {Record<string, unknown>} session
 * @param {Record<string, unknown>} delivery
 * @param {number} anchorMs
 */
export function hasInterveningInputActivityForDelivery(
  events,
  session,
  delivery,
  anchorMs,
) {
  const deliverySessionId = trimString(delivery?.sessionId);
  for (const identifier of collectSessionIdentifiers(session, deliverySessionId)) {
    if (hasInterveningInputActivity(events, identifier, anchorMs)) {
      return true;
    }
  }
  return false;
}

function normalizeDraftIdentity(delivery, record = {}) {
  return trimString(
    delivery?.draftIdentity ?? record?.draftIdentity ?? delivery?.deliveryId,
  );
}

function evaluateDraftFreshness(delivery, record = {}) {
  const draftState = trimString(delivery?.draftState);
  if (draftState !== DRAFT_STATE_DRAFT_PRESENT) {
    return {
      ok: false,
      reason:
        draftState === 'unknown' || !draftState
          ? 'draft_state_unknown'
          : 'draft_absent_or_changed',
      terminal: draftState === 'consumed' || draftState === 'changed' || draftState === 'absent',
      draftIdentity: normalizeDraftIdentity(delivery, record),
    };
  }

  const explicit = trimString(delivery?.draftIdentityStatus ?? delivery?.draftFreshness);
  if (explicit === 'foreign' || explicit === 'shape_identical_foreign') {
    return {
      ok: false,
      reason: 'shape_identical_foreign',
      terminal: true,
      draftIdentity: normalizeDraftIdentity(delivery, record),
    };
  }
  if (explicit === 'changed' || explicit === 'stale' || explicit === 'intervening_input') {
    return {
      ok: false,
      reason: 'draft_absent_or_changed',
      terminal: true,
      draftIdentity: normalizeDraftIdentity(delivery, record),
    };
  }
  if (
    delivery?.draftIdentityUnprovable === true ||
    explicit === 'unprovable' ||
    explicit === 'shape_only'
  ) {
    return {
      ok: false,
      reason: 'draft_identity_unprovable',
      terminal: false,
      draftIdentity: normalizeDraftIdentity(delivery, record),
    };
  }

  const tracked = trimString(record?.draftIdentity);
  const current = normalizeDraftIdentity(delivery, record);
  if (tracked && current && tracked !== current) {
    return {
      ok: false,
      reason: 'draft_identity_changed',
      terminal: true,
      draftIdentity: current,
    };
  }

  if (!current) {
    return {
      ok: false,
      reason: 'draft_identity_unprovable',
      terminal: false,
      draftIdentity: '',
    };
  }

  return { ok: true, reason: 'draft_fresh', draftIdentity: current, terminal: false };
}

function getSessionIdleAnchorMs(session = {}, record = {}) {
  return maxTimestamp(
    parseFlexibleTimestampMs(session?.idleSinceMs),
    parseFlexibleTimestampMs(session?.idleSince),
    parseFlexibleTimestampMs(session?.activityChangedAtMs),
    parseFlexibleTimestampMs(session?.activityChangedAt),
    Number(record?.lastProgressAtMs ?? 0),
    Number(record?.lastSubmitAtMs ?? 0),
  );
}

function getSessionProgressAnchorMs(session = {}, record = {}) {
  const reportTs = toArray(session?.reports).reduce((max, report) => {
    return maxTimestamp(
      max,
      parseFlexibleTimestampMs(report?.reportedAt),
      parseFlexibleTimestampMs(report?.timestamp),
      Number(report?.tsEpoch ?? 0),
    );
  }, 0);
  return maxTimestamp(
    reportTs,
    parseFlexibleTimestampMs(session?.updatedAt),
    parseFlexibleTimestampMs(session?.lastProgressAt),
    parseFlexibleTimestampMs(session?.lastProgressAtMs),
    parseFlexibleTimestampMs(session?.activityChangedAt),
    parseFlexibleTimestampMs(session?.activityChangedAtMs),
    parseFlexibleTimestampMs(session?.progressAt),
    parseFlexibleTimestampMs(session?.progressAtMs),
    Number(record?.lastProgressAtMs ?? 0),
    Number(record?.lastSubmitAtMs ?? 0),
  );
}

export function evaluateDispatchObservability({ session, delivery, record, nowMs, config }) {
  const explicit = trimString(
    delivery?.observability ?? session?.submitObservability ?? session?.observability,
  ).toLowerCase();
  const settleMs = resolveSubmitReconcileConfig(config).observabilitySettleMs;
  const drainSettled = !(
    delivery?.drainSettled === false ||
    session?.drainSettled === false ||
    explicit === 'idle_but_not_drained'
  );

  if (explicit === 'indeterminate') {
    return {
      observable: false,
      settled: false,
      reason: 'observability_indeterminate',
      progressAtMs: getSessionProgressAnchorMs(session, record),
    };
  }

  if (explicit === 'settled') {
    return {
      observable: true,
      settled: true,
      reason: 'settled_observable',
      progressAtMs: getSessionProgressAnchorMs(session, record),
    };
  }

  if (explicit === 'pending') {
    return {
      observable: false,
      settled: false,
      reason: 'dispatch_outcome_pending',
      progressAtMs: getSessionProgressAnchorMs(session, record),
    };
  }

  if (!session) {
    return {
      observable: false,
      settled: false,
      reason: 'session_not_found',
      progressAtMs: Number(record?.lastProgressAtMs ?? 0),
    };
  }

  if (isSessionStreaming(session)) {
    return {
      observable: false,
      settled: false,
      reason: 'dispatch_outcome_pending',
      progressAtMs: getSessionProgressAnchorMs(session, record),
    };
  }

  if (!drainSettled) {
    return {
      observable: true,
      settled: false,
      reason: 'observable_not_settled',
      progressAtMs: getSessionProgressAnchorMs(session, record),
    };
  }

  const idleAnchorMs = getSessionIdleAnchorMs(session, record);
  if (!idleAnchorMs || nowMs - idleAnchorMs < settleMs) {
    return {
      observable: true,
      settled: false,
      reason: 'observable_not_settled',
      progressAtMs: getSessionProgressAnchorMs(session, record),
    };
  }

  return {
    observable: true,
    settled: true,
    reason: 'settled_observable',
    progressAtMs: getSessionProgressAnchorMs(session, record),
  };
}

function buildFailedDeliveryRecord({ delivery, record, nowMs, reason }) {
  const reviewRunId = trimString(delivery?.reviewRunId ?? delivery?.sourceKey);
  return {
    deliveryId: trimString(delivery?.deliveryId ?? record?.deliveryId),
    sessionId: trimString(delivery?.sessionId ?? record?.sessionId),
    prNumber: Number(delivery?.prNumber ?? record?.prNumber ?? 0),
    headSha: trimString(delivery?.headSha ?? record?.headSha),
    reviewRunId,
    reason,
    unresolvedState: FAILED_DELIVERY_UNRESOLVED,
    firstFailedAtMs: Number(record?.firstFailedAtMs ?? nowMs),
    lastFailedAtMs: nowMs,
    deliverySequence: Number(delivery?.deliverySequence ?? record?.deliverySequence ?? 0),
    source: trimString(delivery?.source ?? record?.source),
    lifecycleState: trimString(record?.lifecycleState) || 'active',
  };
}

function classifyFailureTerminalReason(reason) {
  const hardFailures = new Set([
    'send_failed',
    'dispatch_unknown',
    'dispatch_not_dispatched',
    'worker_dead_or_gone',
    'draft_absent_or_changed',
    'shape_identical_foreign',
    'draft_identity_changed',
    'lost_delivery_overwritten',
    'delivery_backstop_exhausted',
    'still_live_but_unconsumed',
    'post_dispatch_lease_exhausted',
    'submit_attempts_exhausted',
    'draft_state_unknown',
    'draft_state_unknown',
    'dispatch_unknown',
  ]);
  return hardFailures.has(reason) ? reason : 'delivery_backstop_exhausted';
}

function resolveDeliveryTerminalEscalation({ delivery, record, nowMs, reason, diagnosis }) {
  const failedReason = classifyFailureTerminalReason(reason);
  return {
    terminalState: SUBMIT_STATE_ESCALATED,
    escalatedAtMs: nowMs,
    escalationReason: failedReason,
    firstFailedAtMs: Number(record?.firstFailedAtMs ?? nowMs),
    failedDelivery: buildFailedDeliveryRecord({ delivery, record, nowMs, reason: failedReason }),
    diagnosis,
  };
}

function recordConsumptionResolution({ record, nowMs }) {
  const next = {
    ...clearSubmitClaimFields(record),
    terminalState: SUBMIT_STATE_SUBMITTED,
    consumedAtMs: nowMs,
    escalationResolvedAtMs: nowMs,
    failedDeliveryResolvedAtMs: nowMs,
  };
  delete next.escalationReason;
  return next;
}

/**
 * @param {object} input
 */
export function applySubmitOutcomes(tracking, outcomes, nowMs) {
  const nextDeliveries = { ...(tracking?.deliveries ?? {}) };
  const nextFailedDeliveries = { ...(tracking?.failedDeliveries ?? {}) };
  const audit = [...toArray(tracking?.audit)];

  for (const item of toArray(outcomes)) {
    const deliveryId = trimString(item?.deliveryId);
    const outcome = trimString(item?.outcome);
    const claimKey = trimString(item?.claimKey);
    if (!deliveryId || !outcome) {
      continue;
    }

    const prior = nextDeliveries[deliveryId] ?? {};
    if (outcome === 'confirmed') {
      const cleared = clearSubmitClaimFields(prior);
      nextDeliveries[deliveryId] = {
        ...cleared,
        deliveryId,
        claimed: true,
        claimKey: claimKey || trimString(prior.provisionalClaimKey),
        lastSubmitAtMs: nowMs,
        firstDispatchAtMs: Number(prior.firstDispatchAtMs ?? nowMs),
        submitAttempts: Number(prior.submitAttempts ?? 0) + 1,
      };
      audit.push({
        deliveryId,
        action: 'confirm_claim',
        reason: 'submit_succeeded',
      });
      continue;
    }

    if (outcome === 'released') {
      nextDeliveries[deliveryId] = clearSubmitClaimFields(prior);
      audit.push({
        deliveryId,
        action: 'release_claim',
        reason: trimString(item?.reason) || 'submit_failed',
      });
    }
  }

  return {
    ...tracking,
    deliveries: nextDeliveries,
    failedDeliveries: nextFailedDeliveries,
    audit: audit.slice(-200),
  };
}

function buildBackstopEscalation(deliveryId, sessionId, reason, diagnosis) {
  return {
    action: 'escalate',
    reason,
    deliveryId,
    sessionId,
    diagnosis,
  };
}

function buildConsumptionAction(deliveryId, sessionId, reason = 'consumed') {
  return {
    action: 'mark_consumed',
    reason,
    deliveryId,
    sessionId,
  };
}

function isDeliveryBackstopExpired(firstObservedAtMs, nowMs, config) {
  const { deliveryBackstopMs } = resolveSubmitReconcileConfig(config);
  return firstObservedAtMs > 0 && nowMs - firstObservedAtMs >= deliveryBackstopMs;
}

function isPostDispatchLeaseExpired(record, progressAtMs, nowMs, config) {
  const { postDispatchLeaseMs } = resolveSubmitReconcileConfig(config);
  const firstDispatchAtMs = Number(record?.firstDispatchAtMs ?? record?.lastSubmitAtMs ?? 0);
  if (firstDispatchAtMs <= 0) {
    return false;
  }
  const leaseAnchor = maxTimestamp(firstDispatchAtMs, progressAtMs);
  return leaseAnchor > 0 && nowMs - leaseAnchor >= postDispatchLeaseMs;
}

/**
 * @param {object} input
 */
export function evaluateSubmitDecision({
  delivery,
  session,
  tracking,
  aoEvents,
  floodActiveSessions,
  nowMs,
  config,
}) {
  const deliveryId = trimString(delivery?.deliveryId);
  const sessionId = trimString(delivery?.sessionId);
  const deliveryPath = trimString(delivery?.deliveryPath);
  const dispatchOutcome = trimString(
    delivery?.dispatchOutcome ?? DISPATCH_OUTCOME_DISPATCHED,
  );
  const draftState = trimString(
    delivery?.draftState ??
      (deliveryPath === DELIVERY_PATH_SELF_SUBMITTED
        ? DRAFT_STATE_AUTO_SUBMITTED
        : DRAFT_STATE_DRAFT_PRESENT),
  );
  const deliveryTimestampMs = Number(delivery?.deliveredAtMs ?? 0);
  const { maxSubmitAttempts } = resolveSubmitReconcileConfig(config);

  const record = getDeliveryTracking(tracking, deliveryId);
  const observationAnchorMs =
    deliveryTimestampMs > 0
      ? deliveryTimestampMs
      : Number(record.firstObservedAtMs ?? 0);

  if (!deliveryId || !sessionId || !observationAnchorMs) {
    return { action: 'noop', reason: 'missing_delivery_metadata', deliveryId };
  }

  if (delivery?.corruptObservation) {
    return buildBackstopEscalation(
      deliveryId,
      sessionId,
      trimString(delivery.corruptionReason) || 'corrupt_dispatch_journal',
      `${OPERATOR_ESCALATION_PREFIX} dispatch journal/state is corrupt or untrusted; quarantined=${deliveryId}. Failing closed.`,
    );
  }

  const terminalState = trimString(record.terminalState);

  const submitAttempts = Number(record.submitAttempts ?? 0);
  const firstObservedAtMs = Number(record.firstObservedAtMs ?? observationAnchorMs);
  const deliveryBackstopExpired = isDeliveryBackstopExpired(firstObservedAtMs, nowMs, config);

  if (dispatchOutcome === DISPATCH_OUTCOME_IN_FLIGHT) {
    if (deliveryBackstopExpired) {
      return buildBackstopEscalation(
        deliveryId,
        sessionId,
        'dispatch_unknown',
        `${OPERATOR_ESCALATION_PREFIX} delivery ${deliveryId} remained externally ambiguous until the delivery-anchored backstop; refusing duplicate Enter.`,
      );
    }
    return { action: 'noop', reason: 'dispatch_in_flight', deliveryId, sessionId };
  }

  if (dispatchOutcome === DISPATCH_OUTCOME_SEND_FAILED) {
    return buildBackstopEscalation(
      deliveryId,
      sessionId,
      'send_failed',
      `${OPERATOR_ESCALATION_PREFIX} delivery ${deliveryId} failed before/at ao send; never pressing Enter. Source must resend.`,
    );
  }

  if (dispatchOutcome !== DISPATCH_OUTCOME_DISPATCHED) {
    return buildBackstopEscalation(
      deliveryId,
      sessionId,
      dispatchOutcome === DISPATCH_OUTCOME_UNKNOWN ? 'dispatch_unknown' : 'dispatch_not_dispatched',
      `${OPERATOR_ESCALATION_PREFIX} delivery ${deliveryId} dispatch outcome is ambiguous (${dispatchOutcome}); never replaying payload or blind-Enter. Source must resend if needed.`,
    );
  }

  if (session && isDeliveryConsumed(session, delivery, observationAnchorMs)) {
    if (terminalState === SUBMIT_STATE_ESCALATED) {
      return buildConsumptionAction(deliveryId, sessionId, 'late_consumed_after_terminal');
    }
    if (terminalState === SUBMIT_STATE_SUBMITTED) {
      return { action: 'noop', reason: 'terminal_state', deliveryId, terminalState };
    }
    return buildConsumptionAction(deliveryId, sessionId, 'consumed');
  }

  if (terminalState === SUBMIT_STATE_ESCALATED || terminalState === SUBMIT_STATE_SUBMITTED) {
    return { action: 'noop', reason: 'terminal_state', deliveryId, terminalState };
  }

  if (!session || !sessionMatchesIdentifier(session, sessionId)) {
    if (deliveryBackstopExpired) {
      return buildBackstopEscalation(
        deliveryId,
        sessionId,
        'worker_dead_or_gone',
        `${OPERATOR_ESCALATION_PREFIX} delivery ${deliveryId} could not be matched back to a live worker session before the delivery backstop.`,
      );
    }
    return { action: 'noop', reason: !session ? 'session_not_found' : 'session_id_mismatch', deliveryId, sessionId };
  }

  if (!isSessionAlive(session)) {
    return buildBackstopEscalation(
      deliveryId,
      sessionId,
      'worker_dead_or_gone',
      `${OPERATOR_ESCALATION_PREFIX} delivery ${deliveryId} belongs to a non-live worker session; no Enter will be dispatched.`,
    );
  }

  if (isSessionFloodActive(floodActiveSessions ?? {}, sessionId)) {
    return { action: 'defer', reason: 'flood_active', deliveryId, sessionId, defer: true };
  }

  if (deliveryPath === DELIVERY_PATH_SELF_SUBMITTED || draftState === DRAFT_STATE_AUTO_SUBMITTED) {
    if (deliveryBackstopExpired) {
      return buildBackstopEscalation(
        deliveryId,
        sessionId,
        'delivery_backstop_exhausted',
        `${OPERATOR_ESCALATION_PREFIX} delivery ${deliveryId} was auto-submitted but never observably consumed before the delivery backstop.`,
      );
    }
    return { action: 'noop', reason: 'tracking_auto_submitted', deliveryId, sessionId };
  }

  if (deliveryPath !== DELIVERY_PATH_PENDING_DRAFT) {
    if (deliveryBackstopExpired) {
      return buildBackstopEscalation(
        deliveryId,
        sessionId,
        'delivery_backstop_exhausted',
        `${OPERATOR_ESCALATION_PREFIX} delivery ${deliveryId} never exposed a dispatchable pending draft before the delivery backstop.`,
      );
    }
    return { action: 'noop', reason: 'unknown_delivery_path', deliveryId, sessionId };
  }

  const draftFreshness = evaluateDraftFreshness(
    { ...delivery, draftState },
    record,
  );
  if (!draftFreshness.ok) {
    if (draftFreshness.reason === 'draft_identity_unprovable' && !deliveryBackstopExpired) {
      return { action: 'noop', reason: draftFreshness.reason, deliveryId, sessionId };
    }
    if (!draftFreshness.terminal && !deliveryBackstopExpired) {
      return { action: 'noop', reason: draftFreshness.reason, deliveryId, sessionId };
    }
    return buildBackstopEscalation(
      deliveryId,
      sessionId,
      draftFreshness.reason,
      `${OPERATOR_ESCALATION_PREFIX} delivery ${deliveryId} no longer has a provably fresh authoritative draft (${draftFreshness.reason}); refusing blind Enter.`,
    );
  }

  const inputAnchorMs = getDeliveryInputAnchorMs(delivery, record);
  if (
    hasInterveningInputActivityForDelivery(
      toArray(aoEvents),
      session ?? {},
      delivery,
      inputAnchorMs,
    )
  ) {
    if (deliveryBackstopExpired) {
      return buildBackstopEscalation(
        deliveryId,
        sessionId,
        'draft_absent_or_changed',
        `${OPERATOR_ESCALATION_PREFIX} delivery ${deliveryId} was superseded by later input before confirmed consumption.`,
      );
    }
    return { action: 'noop', reason: 'stale_input', deliveryId, sessionId };
  }

  const busyDispatch = resolveBusyDispatchCapability({ delivery, session, config });
  const isBusy = isSessionStreaming(session);
  const priorDispatchExists = submitAttempts > 0 || Number(record.lastSubmitAtMs ?? 0) > 0;

  if (!priorDispatchExists) {
    if (isBusy && !busyDispatch.allowed) {
      if (deliveryBackstopExpired) {
        return buildBackstopEscalation(
          deliveryId,
          sessionId,
          'delivery_backstop_exhausted',
          `${OPERATOR_ESCALATION_PREFIX} delivery ${deliveryId} never reached a smoke-permitted dispatch point before the delivery backstop.`,
        );
      }
      return { action: 'noop', reason: 'streaming', deliveryId, sessionId };
    }

    if (isActiveSubmitClaim(record, nowMs, config)) {
      return { action: 'noop', reason: 'claim_held', deliveryId, sessionId };
    }

    return {
      action: 'submit',
      reason: isBusy ? 'pending_draft_busy_dispatch' : 'pending_draft_idle_dispatch',
      deliveryId,
      sessionId,
      attempt: submitAttempts + 1,
      maxSubmitAttempts,
      draftIdentity: draftFreshness.draftIdentity,
      busyDispatchAllowed: busyDispatch.allowed,
      busyDispatchReason: busyDispatch.reason,
    };
  }

  const legacyWaitingInput =
    String(session?.activity ?? '').trim().toLowerCase() === 'waiting_input' &&
    submitAttempts > 0 &&
    Number(record.lastSubmitAtMs ?? 0) <= 0;
  if (legacyWaitingInput) {
    if (submitAttempts >= maxSubmitAttempts) {
      return buildBackstopEscalation(
        deliveryId,
        sessionId,
        'submit_attempts_exhausted',
        `${OPERATOR_ESCALATION_PREFIX} delivery ${deliveryId} exhausted legacy tracked submit attempts (${submitAttempts}/${maxSubmitAttempts}) while message remains unconsumed.`,
      );
    }
    if (!deliveryBackstopExpired) {
      return { action: 'noop', reason: 'next_prompt_possible', deliveryId, sessionId };
    }
    return {
      action: 'submit',
      reason: 'pending_draft_retry_after_observable_non_consumption',
      deliveryId,
      sessionId,
      attempt: submitAttempts + 1,
      maxSubmitAttempts,
      draftIdentity: draftFreshness.draftIdentity,
      busyDispatchAllowed: busyDispatch.allowed,
      busyDispatchReason: busyDispatch.reason,
    };
  }

  const observability = evaluateDispatchObservability({
    session,
    delivery,
    record,
    nowMs,
    config,
  });

  if (isActiveSubmitClaim(record, nowMs, config) && (!observability.observable || !observability.settled)) {
    return { action: 'noop', reason: 'claim_held', deliveryId, sessionId };
  }

  if (isPostDispatchLeaseExpired(record, observability.progressAtMs, nowMs, config)) {
    return buildBackstopEscalation(
      deliveryId,
      sessionId,
      'post_dispatch_lease_exhausted',
      `${OPERATOR_ESCALATION_PREFIX} delivery ${deliveryId} stayed pending after Enter without a settled outcome or fresh progress before the post-dispatch lease expired.`,
    );
  }

  if (deliveryBackstopExpired) {
    return buildBackstopEscalation(
      deliveryId,
      sessionId,
      'still_live_but_unconsumed',
      `${OPERATOR_ESCALATION_PREFIX} delivery ${deliveryId} remained live but unconsumed until the delivery-anchored ceiling; no further Enter will be sent.`,
    );
  }

  if (!observability.observable || !observability.settled) {
    return {
      action: 'noop',
      reason: observability.reason,
      deliveryId,
      sessionId,
    };
  }

  if (submitAttempts >= maxSubmitAttempts) {
    return buildBackstopEscalation(
      deliveryId,
      sessionId,
      'submit_attempts_exhausted',
      `${OPERATOR_ESCALATION_PREFIX} delivery ${deliveryId} exhausted consumption-verified Enter attempts (${submitAttempts}/${maxSubmitAttempts}) while remaining unconsumed.`,
    );
  }

  return {
    action: 'submit',
    reason: 'pending_draft_retry_after_observable_non_consumption',
    deliveryId,
    sessionId,
    attempt: submitAttempts + 1,
    maxSubmitAttempts,
    draftIdentity: draftFreshness.draftIdentity,
    busyDispatchAllowed: busyDispatch.allowed,
    busyDispatchReason: busyDispatch.reason,
  };
}

function ensureTrackingSeed(prior, surviving, nowMs, busyDispatch, draftIdentity) {
  return {
    ...prior,
    deliveryId: trimString(surviving?.deliveryId ?? prior?.deliveryId),
    sessionId: trimString(surviving?.sessionId ?? prior?.sessionId),
    firstObservedAtMs:
      Number(prior?.firstObservedAtMs ?? 0) ||
      (Number(surviving?.deliveredAtMs) > 0 ? Number(surviving.deliveredAtMs) : nowMs),
    deliveredAtMs: Number(prior?.deliveredAtMs ?? surviving?.deliveredAtMs ?? 0),
    draftIdentity: trimString(prior?.draftIdentity) || trimString(draftIdentity),
    busyDispatchAllowed:
      typeof prior?.busyDispatchAllowed === 'boolean'
        ? Boolean(prior.busyDispatchAllowed)
        : Boolean(busyDispatch.allowed),
    busyDispatchReason:
      trimString(prior?.busyDispatchReason) || trimString(busyDispatch.reason),
    prNumber: Number(prior?.prNumber ?? surviving?.prNumber ?? 0),
    headSha: trimString(prior?.headSha ?? surviving?.headSha),
    reviewRunId: trimString(prior?.reviewRunId ?? surviving?.sourceKey),
  };
}

function updateFailedDeliveryState(nextFailedDeliveries, deliveryRecord) {
  const failed = deliveryRecord?.failedDelivery;
  if (!failed?.deliveryId) {
    return;
  }
  nextFailedDeliveries[failed.deliveryId] = failed;
}

function resolveFailedDeliveryState(nextFailedDeliveries, deliveryId, nowMs, resolution = 'consumed') {
  const key = trimString(deliveryId);
  if (!key || !nextFailedDeliveries[key]) {
    return;
  }
  nextFailedDeliveries[key] = {
    ...nextFailedDeliveries[key],
    unresolvedState: FAILED_DELIVERY_RESOLVED,
    resolvedAtMs: nowMs,
    resolution,
  };
}

/**
 * @param {object} input
 */
export function getFailedDeliveryStatus(input) {
  const tracking = input?.tracking ?? { failedDeliveries: {} };
  const scopePrNumber = Number(input?.prNumber ?? 0);
  const scopeReviewRunId = trimString(input?.reviewRunId);
  const scopeHeadSha = trimString(input?.headSha);
  const unresolved = [];
  let failClosed = false;
  const hasScope = scopePrNumber > 0 || Boolean(scopeReviewRunId) || Boolean(scopeHeadSha);

  for (const record of Object.values(tracking.failedDeliveries ?? {})) {
    if (!record || typeof record !== 'object') {
      continue;
    }
    if (trimString(record.unresolvedState) !== FAILED_DELIVERY_UNRESOLVED) {
      continue;
    }
    const recordPr = Number(record.prNumber ?? 0);
    const recordRunId = trimString(record.reviewRunId);
    const recordHeadSha = trimString(record.headSha);
    const scopeChecks = [];
    if (scopeReviewRunId) {
      scopeChecks.push(Boolean(recordRunId) && scopeReviewRunId === recordRunId);
    }
    if (scopePrNumber > 0) {
      scopeChecks.push(recordPr === scopePrNumber);
    }
    if (scopeHeadSha) {
      scopeChecks.push(Boolean(recordHeadSha) && scopeHeadSha === recordHeadSha);
    }
    const scopedMatch = scopeChecks.length > 0 && scopeChecks.every(Boolean);
    if (!hasScope || scopedMatch) {
      unresolved.push(record);
      continue;
    }
    if (hasScope && !recordPr && !recordRunId && !recordHeadSha) {
      failClosed = true;
    }
  }

  return {
    ok: !failClosed && unresolved.length === 0,
    failClosed,
    unresolved,
  };
}

/**
 * @param {object} input
 */
export function planWorkerMessageSubmitActions(input) {
  const {
    aoEvents,
    dispatchJournal,
    reviewRuns,
    reactionMessages,
    sessions,
    tracking,
    floodActiveSessions,
    nowMs,
    config,
  } = input;

  const configCheck = validateSubmitReconcileConfig(config ?? {});
  if (!configCheck.ok) {
    return {
      actions: [{
        type: 'escalate',
        deliveryId: 'config-invalid',
        sessionId: 'operator',
        reason: 'config_invalid',
        diagnosis: `${OPERATOR_ESCALATION_PREFIX} invalid worker-message submit config field ${configCheck.field}; refusing to track unbounded or untrusted deliveries.`,
      }],
      tracking: tracking ?? { deliveries: {}, failedDeliveries: {}, audit: [] },
      deliveryCount: 0,
    };
  }

  const deliveries = mergeDeliveryRecords({
    aoEvents,
    dispatchJournal,
    reviewRuns,
    reactionMessages,
    nowMs,
  });

  const sessionList = toArray(sessions);
  /** @type {Array<Record<string, unknown>>} */
  const actions = [];
  /** @type {Record<string, Record<string, unknown>>} */
  const nextDeliveries = { ...(tracking?.deliveries ?? {}) };
  const nextFailedDeliveries = { ...(tracking?.failedDeliveries ?? {}) };
  /** @type {Array<Record<string, unknown>>} */
  const audit = [];

  const sessionIds = new Set(deliveries.map((d) => trimString(d.sessionId)).filter(Boolean));
  const paneCompetingBySession = new Map();
  for (const d of deliveries) {
    const sid = trimString(d.sessionId);
    if (!sid) continue;
    const outcome = trimString(d.dispatchOutcome ?? DISPATCH_OUTCOME_DISPATCHED);
    const couldHavePaneDraft =
      outcome === DISPATCH_OUTCOME_DISPATCHED || outcome === DISPATCH_OUTCOME_IN_FLIGHT;
    if (!couldHavePaneDraft || trimString(d.deliveryPath) !== DELIVERY_PATH_PENDING_DRAFT) {
      continue;
    }
    const arr = paneCompetingBySession.get(sid) ?? [];
    arr.push(d);
    paneCompetingBySession.set(sid, arr);
  }

  for (const sessionId of sessionIds) {
    const session = findSessionById(sessionList, sessionId);
    const terminalDispatchFailures = deliveries.filter((d) => {
      if (trimString(d.sessionId) !== sessionId) return false;
      const outcome = trimString(d.dispatchOutcome ?? DISPATCH_OUTCOME_DISPATCHED);
      return outcome !== DISPATCH_OUTCOME_DISPATCHED;
    });
    for (const failed of terminalDispatchFailures) {
      const failedId = trimString(failed.deliveryId);
      if (!failedId) continue;
      const existing = nextDeliveries[failedId] ?? {};
      if (
        existing.terminalState === SUBMIT_STATE_ESCALATED ||
        existing.terminalState === SUBMIT_STATE_SUBMITTED
      ) {
        continue;
      }
      if (!existing.firstObservedAtMs) {
        nextDeliveries[failedId] = {
          ...existing,
          deliveryId: failedId,
          sessionId,
          firstObservedAtMs: Number(failed.deliveredAtMs) > 0 ? Number(failed.deliveredAtMs) : nowMs,
          deliveredAtMs: Number(failed.deliveredAtMs),
        };
      }
      const decision = evaluateSubmitDecision({
        delivery: failed,
        session,
        tracking: { deliveries: nextDeliveries },
        aoEvents,
        floodActiveSessions,
        nowMs,
        config,
      });
      audit.push({ deliveryId: failedId, action: decision.action, reason: decision.reason });
      if (decision.action === 'escalate') {
        const escalation = resolveDeliveryTerminalEscalation({
          delivery: failed,
          record: nextDeliveries[failedId],
          nowMs,
          reason: decision.reason,
          diagnosis: decision.diagnosis,
        });
        nextDeliveries[failedId] = {
          ...nextDeliveries[failedId],
          terminalState: escalation.terminalState,
          escalatedAtMs: escalation.escalatedAtMs,
          escalationReason: escalation.escalationReason,
          failedDelivery: escalation.failedDelivery,
        };
        updateFailedDeliveryState(nextFailedDeliveries, escalation);
        actions.push({
          type: 'escalate',
          deliveryId: failedId,
          sessionId,
          reason: decision.reason,
          diagnosis: decision.diagnosis,
        });
      }
    }

    const overwritten = findOverwrittenDeliveries(deliveries, sessionId);
    for (const lost of overwritten) {
      const lostId = trimString(lost.deliveryId);
      const existing = nextDeliveries[lostId] ?? {};
      if (
        existing.terminalState === SUBMIT_STATE_ESCALATED ||
        existing.terminalState === SUBMIT_STATE_SUBMITTED
      ) {
        continue;
      }
      if ((paneCompetingBySession.get(sessionId) ?? []).length > 1) {
        lost.ambiguousSessionInflight = true;
      }
      if (session && isDeliveryConsumed(session, lost, Number(lost.deliveredAtMs ?? 0))) {
        nextDeliveries[lostId] = recordConsumptionResolution({ record: existing, nowMs });
        resolveFailedDeliveryState(nextFailedDeliveries, lostId, nowMs, 'consumed');
        actions.push({
          type: 'mark_consumed',
          deliveryId: lostId,
          sessionId,
          reason: 'consumed',
        });
        audit.push({ deliveryId: lostId, action: 'mark_consumed', reason: 'consumed' });
        continue;
      }
      const escalation = resolveDeliveryTerminalEscalation({
        delivery: lost,
        record: existing,
        nowMs,
        reason: 'lost_delivery_overwritten',
        diagnosis: `${OPERATOR_ESCALATION_PREFIX} delivery ${lostId} was overwritten by a later send to ${sessionId}; content lost. Operator must resend if still needed.`,
      });
      nextDeliveries[lostId] = {
        ...existing,
        terminalState: escalation.terminalState,
        escalatedAtMs: escalation.escalatedAtMs,
        escalationReason: escalation.escalationReason,
        failedDelivery: escalation.failedDelivery,
      };
      updateFailedDeliveryState(nextFailedDeliveries, escalation);
      actions.push({
        type: 'escalate',
        deliveryId: lostId,
        sessionId,
        reason: 'lost_delivery_overwritten',
        diagnosis: escalation.diagnosis,
      });
      audit.push({ deliveryId: lostId, action: 'escalate', reason: 'lost_delivery_overwritten' });
    }

    let surviving = selectSurvivingDelivery(deliveries, sessionId);
    if (!surviving) {
      const latestForSession = deliveries
        .filter((d) => trimString(d.sessionId) === sessionId)
        .sort((a, b) => Number(b.deliveredAtMs ?? 0) - Number(a.deliveredAtMs ?? 0))[0];
      if (
        latestForSession &&
        (latestForSession.corruptObservation ||
          trimString(latestForSession.deliveryPath) === DELIVERY_PATH_SELF_SUBMITTED ||
          trimString(latestForSession.draftState ?? '') === DRAFT_STATE_AUTO_SUBMITTED)
      ) {
        surviving = latestForSession;
      }
    }
    if (surviving && (paneCompetingBySession.get(sessionId) ?? []).length > 1) {
      surviving.ambiguousSessionInflight = true;
    }
    if (!surviving) {
      continue;
    }

    const deliveryId = trimString(surviving.deliveryId);
    const survivingTerminalState = trimString(nextDeliveries[deliveryId]?.terminalState);
    if (
      surviving.corruptObservation &&
      (survivingTerminalState === SUBMIT_STATE_ESCALATED ||
        survivingTerminalState === SUBMIT_STATE_SUBMITTED)
    ) {
      continue;
    }
    if (survivingTerminalState === SUBMIT_STATE_SUBMITTED) {
      continue;
    }
    const activeCompetingInFlight = (paneCompetingBySession.get(sessionId) ?? []).some((candidate) => {
      const candidateId = trimString(candidate.deliveryId);
      if (!candidateId || candidateId === deliveryId) return false;
      if (trimString(candidate.dispatchOutcome ?? '') !== DISPATCH_OUTCOME_IN_FLIGHT) return false;
      const candidateRecord = nextDeliveries[candidateId] ?? {};
      const terminalState = trimString(candidateRecord.terminalState);
      return terminalState !== SUBMIT_STATE_ESCALATED && terminalState !== SUBMIT_STATE_SUBMITTED;
    });
    if (activeCompetingInFlight) {
      audit.push({
        deliveryId,
        action: 'noop',
        reason: 'competing_dispatch_in_flight',
      });
      continue;
    }

    const prior = nextDeliveries[deliveryId] ?? {};
    const busyDispatch = resolveBusyDispatchCapability({ delivery: surviving, session, config });
    const draftFreshness = evaluateDraftFreshness(surviving, prior);
    nextDeliveries[deliveryId] = ensureTrackingSeed(
      prior,
      surviving,
      nowMs,
      busyDispatch,
      draftFreshness.draftIdentity,
    );

    const decision = evaluateSubmitDecision({
      delivery: surviving,
      session,
      tracking: { deliveries: nextDeliveries, failedDeliveries: nextFailedDeliveries },
      aoEvents,
      floodActiveSessions,
      nowMs,
      config,
    });

    audit.push({
      deliveryId,
      action: decision.action,
      reason: decision.reason,
    });

    switch (decision.action) {
      case 'submit': {
        let record = nextDeliveries[deliveryId] ?? {};
        if (
          decision.reason === 'pending_draft_retry_after_observable_non_consumption' ||
          shouldClearStaleSubmitClaim(record, nowMs, config)
        ) {
          record = clearSubmitClaimFields(record);
          nextDeliveries[deliveryId] = record;
          audit.push({
            deliveryId,
            action: 'release_claim',
            reason:
              decision.reason === 'pending_draft_retry_after_observable_non_consumption'
                ? 'observable_retry'
                : 'stale_claim',
          });
        }
        nextDeliveries[deliveryId] = {
          ...nextDeliveries[deliveryId],
          draftIdentity: trimString(decision.draftIdentity ?? nextDeliveries[deliveryId]?.draftIdentity),
          provisionalClaimKey: `${deliveryId}:${decision.attempt}`,
          provisionalClaimSinceMs: nowMs,
          busyDispatchAllowed: Boolean(decision.busyDispatchAllowed ?? nextDeliveries[deliveryId]?.busyDispatchAllowed),
          busyDispatchReason: trimString(decision.busyDispatchReason ?? nextDeliveries[deliveryId]?.busyDispatchReason),
        };
        actions.push({
          type: 'submit',
          deliveryId,
          sessionId,
          attempt: decision.attempt,
          maxSubmitAttempts: decision.maxSubmitAttempts,
          claimKey: `${deliveryId}:${decision.attempt}`,
        });
        break;
      }
      case 'mark_consumed': {
        nextDeliveries[deliveryId] = recordConsumptionResolution({
          record: nextDeliveries[deliveryId],
          nowMs,
        });
        resolveFailedDeliveryState(nextFailedDeliveries, deliveryId, nowMs, decision.reason);
        actions.push({ type: 'mark_consumed', deliveryId, sessionId, reason: decision.reason });
        break;
      }
      case 'escalate': {
        const escalation = resolveDeliveryTerminalEscalation({
          delivery: surviving,
          record: nextDeliveries[deliveryId],
          nowMs,
          reason: decision.reason,
          diagnosis: decision.diagnosis,
        });
        nextDeliveries[deliveryId] = {
          ...nextDeliveries[deliveryId],
          terminalState: escalation.terminalState,
          escalatedAtMs: escalation.escalatedAtMs,
          escalationReason: escalation.escalationReason,
          failedDelivery: escalation.failedDelivery,
        };
        updateFailedDeliveryState(nextFailedDeliveries, escalation);
        actions.push({
          type: 'escalate',
          deliveryId,
          sessionId,
          reason: decision.reason,
          diagnosis: decision.diagnosis,
        });
        break;
      }
      case 'defer': {
        actions.push({
          type: 'defer',
          deliveryId,
          sessionId,
          reason: decision.reason,
        });
        break;
      }
      default: {
        actions.push({
          type: 'noop',
          deliveryId,
          sessionId,
          reason: decision.reason,
        });
      }
    }

    if (session) {
      nextDeliveries[deliveryId] = {
        ...nextDeliveries[deliveryId],
        lastProgressAtMs: getSessionProgressAnchorMs(session, nextDeliveries[deliveryId]),
      };
    }
  }

  return {
    actions,
    tracking: {
      deliveries: nextDeliveries,
      failedDeliveries: nextFailedDeliveries,
      lastTickMs: nowMs,
      audit: [...toArray(tracking?.audit), ...audit].slice(-200),
    },
    deliveryCount: deliveries.length,
  };
}

/**
 * @param {object} input
 */
export function evaluateConcurrentSubmitClaim(input) {
  const { existingClaim, newClaimKey } = input;
  if (!existingClaim) {
    return { ok: true, reason: 'no_prior_claim' };
  }
  if (existingClaim === newClaimKey) {
    return { ok: false, reason: 'duplicate_claim' };
  }
  return { ok: false, reason: 'claim_held' };
}

runStdinJsonCli('worker-message-submit-reconcile.mjs', {
  plan() {
    const payload = readStdinJson();
    return planWorkerMessageSubmitActions(payload);
  },
  interval() {
    const payload = readStdinJson();
    return evaluateMechanicalTickInterval(payload);
  },
  outcome() {
    const payload = readStdinJson();
    return {
      tracking: applySubmitOutcomes(
        payload.tracking ?? { deliveries: {}, failedDeliveries: {}, audit: [] },
        payload.outcomes ?? [],
        Number(payload.nowMs ?? Date.now()),
      ),
    };
  },
  status() {
    const payload = readStdinJson();
    return getFailedDeliveryStatus(payload);
  },
});
