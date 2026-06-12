/**
 * Source-agnostic worker message submit arbiter (Issue #232).
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

/** Budget window per delivery before escalation (ms). */
export const DEFAULT_DELIVERY_BUDGET_MS = 5 * 60 * 1000;

/** Active submit claim lease before retry (ms). */
export const DEFAULT_CLAIM_STALE_MS = 60 * 1000;

export const SUBMIT_STATE_PENDING = 'pending';
export const SUBMIT_STATE_SUBMITTED = 'submitted';
export const SUBMIT_STATE_ESCALATED = 'escalated';
export const SUBMIT_STATE_NOOP = 'noop';

export const OPERATOR_ESCALATION_PREFIX =
  '[worker-message-submit-reconcile] ESCALATION:';

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
    deliveryBudgetMs: resolveBoundedInt(
      config.deliveryBudgetMs,
      DEFAULT_DELIVERY_BUDGET_MS,
      1000,
    ),
  };
}


/**
 * @param {object} [config]
 */
export function validateSubmitReconcileConfig(config = {}) {
  const checks = [
    ['maxSubmitAttempts', config.maxSubmitAttempts, 25],
    ['deliveryBudgetMs', config.deliveryBudgetMs, 24 * 60 * 60 * 1000],
  ];
  for (const [name, value, max] of checks) {
    if (value === undefined || value === null || value === '') continue;
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0 || n > max) {
      return { ok: false, reason: 'config_invalid', field: name };
    }
  }
  return { ok: true };
}

/**
 * @param {Record<string, unknown>} tracking
 * @param {string} deliveryId
 */
export function getDeliveryTracking(tracking, deliveryId) {
  const id = String(deliveryId ?? '').trim();
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
export function applySubmitOutcomes(tracking, outcomes, nowMs) {
  const nextDeliveries = { ...(tracking?.deliveries ?? {}) };
  const audit = [...toArray(tracking?.audit)];

  for (const item of toArray(outcomes)) {
    const deliveryId = String(item?.deliveryId ?? '').trim();
    const outcome = String(item?.outcome ?? '').trim();
    const claimKey = String(item?.claimKey ?? '').trim();
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
        claimKey: claimKey || String(prior.provisionalClaimKey ?? ''),
        lastSubmitAtMs: nowMs,
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
        reason: String(item?.reason ?? 'submit_failed'),
      });
    }
  }

  return {
    ...tracking,
    deliveries: nextDeliveries,
    audit: audit.slice(-200),
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
    const trimmed = String(value ?? '').trim();
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
  const deliverySessionId = String(delivery?.sessionId ?? '').trim();
  for (const identifier of collectSessionIdentifiers(session, deliverySessionId)) {
    if (hasInterveningInputActivity(events, identifier, anchorMs)) {
      return true;
    }
  }
  return false;
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
  const deliveryId = String(delivery?.deliveryId ?? '').trim();
  const sessionId = String(delivery?.sessionId ?? '').trim();
  const deliveryPath = String(delivery?.deliveryPath ?? '').trim();
  const dispatchOutcome = String(delivery?.dispatchOutcome ?? DISPATCH_OUTCOME_DISPATCHED).trim();
  const draftState = String(delivery?.draftState ?? (deliveryPath === DELIVERY_PATH_SELF_SUBMITTED ? DRAFT_STATE_AUTO_SUBMITTED : DRAFT_STATE_DRAFT_PRESENT)).trim();
  const deliveryTimestampMs = Number(delivery?.deliveredAtMs ?? 0);
  const { maxSubmitAttempts, deliveryBudgetMs } = resolveSubmitReconcileConfig(config);

  const record = getDeliveryTracking(tracking, deliveryId);
  const observationAnchorMs =
    deliveryTimestampMs > 0
      ? deliveryTimestampMs
      : Number(record.firstObservedAtMs ?? 0);

  if (!deliveryId || !sessionId || !observationAnchorMs) {
    return { action: 'noop', reason: 'missing_delivery_metadata', deliveryId };
  }

  const terminalState = String(record.terminalState ?? '').trim();
  if (terminalState === SUBMIT_STATE_ESCALATED || terminalState === SUBMIT_STATE_SUBMITTED) {
    return { action: 'noop', reason: 'terminal_state', deliveryId, terminalState };
  }

  if (delivery?.corruptObservation) {
    return {
      action: 'escalate',
      reason: String(delivery.corruptionReason ?? 'corrupt_dispatch_journal'),
      deliveryId,
      sessionId,
      diagnosis: `${OPERATOR_ESCALATION_PREFIX} dispatch journal/state is corrupt or untrusted; quarantined=${String(delivery?.deliveryId ?? '')}. Failing closed.`,
    };
  }

  const submitAttempts = Number(record.submitAttempts ?? 0);
  const firstObservedAtMs = Number(record.firstObservedAtMs ?? observationAnchorMs);
  const budgetDeadline = firstObservedAtMs + deliveryBudgetMs;

  if (dispatchOutcome === DISPATCH_OUTCOME_IN_FLIGHT) {
    if (nowMs >= budgetDeadline) {
      return {
        action: 'escalate',
        reason: 'dispatch_unknown',
        deliveryId,
        sessionId,
        diagnosis: `${OPERATOR_ESCALATION_PREFIX} delivery ${deliveryId} remained in-flight past the finite dispatch budget; treating outcome as ambiguous. Source must resend if needed.`,
      };
    }
    return { action: 'noop', reason: 'dispatch_in_flight', deliveryId, sessionId };
  }

  if (dispatchOutcome === DISPATCH_OUTCOME_SEND_FAILED) {
    return {
      action: 'escalate',
      reason: 'send_failed',
      deliveryId,
      sessionId,
      diagnosis: `${OPERATOR_ESCALATION_PREFIX} delivery ${deliveryId} failed before/at ao send; never pressing Enter. Source must resend.`,
    };
  }

  if (dispatchOutcome !== DISPATCH_OUTCOME_DISPATCHED) {
    return {
      action: 'escalate',
      reason: dispatchOutcome === DISPATCH_OUTCOME_UNKNOWN ? 'dispatch_unknown' : 'dispatch_not_dispatched',
      deliveryId,
      sessionId,
      diagnosis: `${OPERATOR_ESCALATION_PREFIX} delivery ${deliveryId} dispatch outcome is ambiguous (${dispatchOutcome}); never replaying payload or blind-Enter. Source must resend if needed.`,
    };
  }

  if (!session) {
    return { action: 'noop', reason: 'session_not_found', deliveryId, sessionId };
  }

  if (!isSessionAlive(session)) {
    return { action: 'noop', reason: 'session_not_alive', deliveryId, sessionId };
  }

  if (!sessionMatchesIdentifier(session, sessionId)) {
    return { action: 'noop', reason: 'session_id_mismatch', deliveryId, sessionId };
  }

  if (isSessionFloodActive(floodActiveSessions ?? {}, sessionId)) {
    return { action: 'defer', reason: 'flood_active', deliveryId, sessionId, defer: true };
  }

  if (isDeliveryConsumed(session, delivery, observationAnchorMs)) {
    return {
      action: 'mark_consumed',
      reason: 'consumed',
      deliveryId,
      sessionId,
    };
  }

  if (deliveryPath === DELIVERY_PATH_SELF_SUBMITTED || draftState === DRAFT_STATE_AUTO_SUBMITTED) {
    if (nowMs >= budgetDeadline) {
      return {
        action: 'escalate',
        reason: 'self_submitted_unconsumed_budget_exhausted',
        deliveryId,
        sessionId,
        diagnosis: `${OPERATOR_ESCALATION_PREFIX} delivery ${deliveryId} was auto-submitted/short but not consumed within the finite budget; no Enter will be pressed.`,
      };
    }
    return { action: 'noop', reason: 'tracking_auto_submitted', deliveryId, sessionId };
  }

  if (deliveryPath !== DELIVERY_PATH_PENDING_DRAFT) {
    return { action: 'noop', reason: 'unknown_delivery_path', deliveryId };
  }

  if (draftState !== DRAFT_STATE_DRAFT_PRESENT) {
    if (nowMs >= budgetDeadline) {
      return {
        action: 'escalate',
        reason: 'draft_state_unknown',
        deliveryId,
        sessionId,
        diagnosis: `${OPERATOR_ESCALATION_PREFIX} delivery ${deliveryId} has no authoritative draft-present signal (${draftState || 'missing'}); refusing blind Enter and escalating.`,
      };
    }
    return { action: 'noop', reason: 'draft_state_not_enter_eligible', deliveryId, sessionId };
  }

  if (isSessionStreaming(session)) {
    return { action: 'noop', reason: 'streaming', deliveryId, sessionId };
  }

  const activity = String(session?.activity ?? '').trim().toLowerCase();
  if (
    activity === 'waiting_input' &&
    submitAttempts > 0 &&
    submitAttempts < maxSubmitAttempts &&
    nowMs < budgetDeadline
  ) {
    return { action: 'noop', reason: 'next_prompt_possible', deliveryId, sessionId };
  }

  if (submitAttempts >= maxSubmitAttempts) {
    if (nowMs >= budgetDeadline) {
      return {
        action: 'escalate',
        reason: 'submit_attempts_exhausted',
        deliveryId,
        sessionId,
        diagnosis: `${OPERATOR_ESCALATION_PREFIX} delivery ${deliveryId} submit attempts exhausted (${submitAttempts}/${maxSubmitAttempts}) while message remains unconsumed. Inspect worker terminal and resend if needed.`,
      };
    }
    return { action: 'noop', reason: 'awaiting_budget', deliveryId, sessionId };
  }

  if (nowMs >= budgetDeadline && submitAttempts === 0) {
    return {
      action: 'escalate',
      reason: 'ambiguous_budget_exhausted',
      deliveryId,
      sessionId,
      diagnosis: `${OPERATOR_ESCALATION_PREFIX} delivery ${deliveryId} never reached a submit attempt within budget (observation stayed ambiguous). Inspect AO session state and worker terminal.`,
    };
  }

  if (isActiveSubmitClaim(record, nowMs, config)) {
    return { action: 'noop', reason: 'claim_held', deliveryId, sessionId };
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
    return { action: 'noop', reason: 'stale_input', deliveryId, sessionId };
  }

  return {
    action: 'submit',
    reason: 'pending_draft_unconsumed',
    deliveryId,
    sessionId,
    attempt: submitAttempts + 1,
    maxSubmitAttempts,
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
        diagnosis: `${OPERATOR_ESCALATION_PREFIX} invalid worker-message submit config field ${configCheck.field}; refusing to track unbounded deliveries.`,
      }],
      tracking: tracking ?? { deliveries: {}, audit: [] },
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
  /** @type {Array<Record<string, unknown>>} */
  const audit = [];

  const sessionIds = new Set(deliveries.map((d) => String(d.sessionId)));
  const paneCompetingBySession = new Map();
  for (const d of deliveries) {
    const sid = String(d.sessionId ?? '');
    if (!sid) continue;
    const outcome = String(d.dispatchOutcome ?? DISPATCH_OUTCOME_DISPATCHED);
    const couldHavePaneDraft =
      outcome === DISPATCH_OUTCOME_DISPATCHED || outcome === DISPATCH_OUTCOME_IN_FLIGHT;
    if (!couldHavePaneDraft || String(d.deliveryPath) !== DELIVERY_PATH_PENDING_DRAFT) {
      continue;
    }
    const arr = paneCompetingBySession.get(sid) ?? [];
    arr.push(d);
    paneCompetingBySession.set(sid, arr);
  }

  for (const sessionId of sessionIds) {
    const session = findSessionById(sessionList, sessionId);
    const terminalDispatchFailures = deliveries.filter((d) => {
      if (String(d.sessionId ?? '') !== sessionId) return false;
      const outcome = String(d.dispatchOutcome ?? DISPATCH_OUTCOME_DISPATCHED);
      return outcome !== DISPATCH_OUTCOME_DISPATCHED;
    });
    for (const failed of terminalDispatchFailures) {
      const failedId = String(failed.deliveryId ?? '');
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
        nextDeliveries[failedId] = {
          ...nextDeliveries[failedId],
          terminalState: SUBMIT_STATE_ESCALATED,
          escalatedAtMs: nowMs,
          escalationReason: decision.reason,
        };
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
      const lostId = String(lost.deliveryId);
      const existing = nextDeliveries[lostId] ?? {};
      if (
        existing.terminalState === SUBMIT_STATE_ESCALATED ||
        existing.terminalState === SUBMIT_STATE_SUBMITTED
      ) {
        continue;
      }
      if ((paneCompetingBySession.get(sessionId) ?? []).length > 1) { lost.ambiguousSessionInflight = true; }
      if (isDeliveryConsumed(session, lost, Number(lost.deliveredAtMs ?? 0))) {
        nextDeliveries[lostId] = {
          ...existing,
          deliveryId: lostId,
          terminalState: SUBMIT_STATE_SUBMITTED,
          consumedAtMs: nowMs,
        };
        actions.push({
          type: 'mark_consumed',
          deliveryId: lostId,
          sessionId,
          reason: 'consumed',
        });
        audit.push({ deliveryId: lostId, action: 'mark_consumed', reason: 'consumed' });
        continue;
      }
      nextDeliveries[lostId] = {
        ...existing,
        deliveryId: lostId,
        terminalState: SUBMIT_STATE_ESCALATED,
        escalatedAtMs: nowMs,
        escalationReason: 'lost_delivery_overwritten',
      };
      const diagnosis = `${OPERATOR_ESCALATION_PREFIX} delivery ${lostId} was overwritten by a later send to ${sessionId}; content lost. Operator must resend if still needed.`;
      actions.push({
        type: 'escalate',
        deliveryId: lostId,
        sessionId,
        reason: 'lost_delivery_overwritten',
        diagnosis,
      });
      audit.push({ deliveryId: lostId, action: 'escalate', reason: 'lost_delivery_overwritten' });
    }

    let surviving = selectSurvivingDelivery(deliveries, sessionId);
    if (!surviving) {
      const latestForSession = deliveries
        .filter((d) => String(d.sessionId ?? '') === sessionId)
        .sort((a, b) => Number(b.deliveredAtMs ?? 0) - Number(a.deliveredAtMs ?? 0))[0];
      if (latestForSession && (latestForSession.corruptObservation || String(latestForSession.deliveryPath) === DELIVERY_PATH_SELF_SUBMITTED || String(latestForSession.draftState ?? '') === DRAFT_STATE_AUTO_SUBMITTED)) {
        surviving = latestForSession;
      }
    }
    if (surviving && (paneCompetingBySession.get(sessionId) ?? []).length > 1) {
      surviving.ambiguousSessionInflight = true;
    }
    if (!surviving) {
      continue;
    }

    const deliveryId = String(surviving.deliveryId);
    const prior = nextDeliveries[deliveryId] ?? {};
    if (!prior.firstObservedAtMs) {
      nextDeliveries[deliveryId] = {
        ...prior,
        deliveryId,
        sessionId,
        firstObservedAtMs: Number(surviving.deliveredAtMs) > 0 ? Number(surviving.deliveredAtMs) : nowMs,
        deliveredAtMs: Number(surviving.deliveredAtMs),
      };
    }

    const decision = evaluateSubmitDecision({
      delivery: surviving,
      session,
      tracking: { deliveries: nextDeliveries },
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
        if (shouldClearStaleSubmitClaim(record, nowMs, config)) {
          record = clearSubmitClaimFields(record);
          nextDeliveries[deliveryId] = record;
          audit.push({
            deliveryId,
            action: 'release_claim',
            reason: 'stale_claim',
          });
        }
        nextDeliveries[deliveryId] = {
          ...nextDeliveries[deliveryId],
          provisionalClaimKey: `${deliveryId}:${decision.attempt}`,
          provisionalClaimSinceMs: nowMs,
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
        nextDeliveries[deliveryId] = {
          ...nextDeliveries[deliveryId],
          terminalState: SUBMIT_STATE_SUBMITTED,
          consumedAtMs: nowMs,
        };
        actions.push({ type: 'mark_consumed', deliveryId, sessionId, reason: decision.reason });
        break;
      }
      case 'escalate': {
        nextDeliveries[deliveryId] = {
          ...nextDeliveries[deliveryId],
          terminalState: SUBMIT_STATE_ESCALATED,
          escalatedAtMs: nowMs,
          escalationReason: decision.reason,
        };
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
  }

  return {
    actions,
    tracking: {
      deliveries: nextDeliveries,
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
        payload.tracking ?? { deliveries: {}, audit: [] },
        payload.outcomes ?? [],
        Number(payload.nowMs ?? Date.now()),
      ),
    };
  },
});
