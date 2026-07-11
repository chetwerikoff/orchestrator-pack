/**
 * Shared session↔PR binding boundary for AO 0.10.2 list rows (Issue #699).
 * Vitest: scripts/session-pr-binding-resolver.test.ts
 */
import { toArray, normalizeSha } from './review-reconcile-primitives.mjs';
import { isAoWorkerIterationBranch } from './dead-worker-reconciler.mjs';

/** @typedef {{ number?: number, headRefOid?: string, headRefName?: string, head?: string, state?: string }} OpenPr */
/** @typedef {{ name?: string, sessionId?: string, id?: string, role?: string, prNumber?: number | null, pr?: string | null, issue?: string | number | null, issueId?: string | number | null, issueNumber?: number | null, displayName?: string, branch?: string, headBranch?: string, headRefName?: string, ownedHeadSha?: string, headRefOid?: string, status?: string }} AoSession */
/** @typedef {'explicit_pr' | 'display_name' | 'issue_correlation' | 'none'} SessionPrBindingSource */

export const DEFER_NO_ISSUE_BINDING = 'no_issue_binding';
export const DEFER_AMBIGUOUS_ISSUE_PR_BINDING = 'ambiguous_issue_pr_binding';
export const DEFER_AMBIGUOUS_PR_SESSION_BINDING = 'ambiguous_pr_session_binding';

/**
 * @typedef {{
 *   bound: boolean,
 *   prNumber: number | null,
 *   source: SessionPrBindingSource,
 *   enriched: boolean,
 *   deferReason?: string,
 * }} SessionPrBinding
 */

/**
 * @typedef {{
 *   sessionId: string | null,
 *   reason: string,
 *   failClosed: boolean,
 *   deferReason?: string,
 * }} PrSessionBindingResolution
 */

function numberOrZero(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeString(value) {
  return String(value ?? '').trim();
}

/**
 * @param {AoSession | null | undefined} session
 */
export function getSessionIssueNumber(session) {
  const issue = numberOrZero(session?.issueNumber ?? session?.issue ?? session?.issueId);
  return issue > 0 ? issue : 0;
}

/**
 * @param {AoSession | null | undefined} session
 */
export function getExplicitSessionPrNumber(session) {
  const pr = numberOrZero(session?.prNumber);
  if (pr > 0) {
    return pr;
  }
  const prField = normalizeString(session?.pr);
  if (!prField) {
    return 0;
  }
  const bare = prField.startsWith('#') ? prField.slice(1) : prField;
  const parsed = numberOrZero(bare);
  return parsed > 0 ? parsed : 0;
}

function getSessionIdentifier(session) {
  return normalizeString(session?.sessionId ?? session?.id ?? session?.name) || null;
}

/**
 * @param {unknown} payload ao session get JSON ({ session: ... } or bare session row)
 */
export function sessionDetailFromSessionGetPayload(payload) {
  const session = payload && typeof payload === 'object' && payload.session ? payload.session : payload;
  const displayName = normalizeString(session?.displayName);
  return displayName ? { displayName } : null;
}

/**
 * @param {AoSession | null | undefined} session
 */
export function shouldEnrichSessionDetailFromGet(session) {
  if (getExplicitSessionPrNumber(session) > 0) {
    return false;
  }
  const rowDisplay = normalizeString(session?.displayName);
  if (rowDisplay && /^\d+$/.test(rowDisplay)) {
    return false;
  }
  const role = normalizeString(session?.role).toLowerCase();
  if (role && role !== 'worker' && role !== 'coding') {
    return false;
  }
  return Boolean(getSessionIdentifier(session));
}

/**
 * @param {AoSession[]} sessions
 * @param {Record<string, unknown>} [sessionGetsById]
 */
export function buildSessionDetailsById(sessions, sessionGetsById = {}) {
  /** @type {Record<string, { displayName?: string }>} */
  const details = {};
  for (const session of toArray(sessions)) {
    const sessionId = getSessionIdentifier(session);
    if (!sessionId) {
      continue;
    }
    const rowDisplay = normalizeString(session?.displayName);
    const rowDetail = rowDisplay ? { displayName: rowDisplay } : null;
    const getDetail = sessionGetsById[sessionId]
      ? sessionDetailFromSessionGetPayload(sessionGetsById[sessionId])
      : null;
    const merged = getDetail ?? rowDetail;
    if (merged) {
      details[sessionId] = merged;
    }
  }
  return details;
}

function getSessionBranch(session) {
  return normalizeString(session?.branch ?? session?.headBranch ?? session?.headRefName);
}

/**
 * @param {number} issueNumber
 */
export function issueLinkedWorkerBranchLiterals(issueNumber) {
  const issue = numberOrZero(issueNumber);
  if (issue <= 0) {
    return [];
  }
  return [`feat/${issue}`, `feat/issue-${issue}`, `opk-${issue}`];
}

/**
 * @param {string} headRefName
 * @param {number} issueNumber
 * @param {AoSession | null | undefined} [session]
 */
export function headRefCorrelatesToIssue(headRefName, issueNumber, session = null) {
  const head = normalizeString(headRefName);
  const issue = numberOrZero(issueNumber);
  if (!head || issue <= 0) {
    return false;
  }

  for (const literal of issueLinkedWorkerBranchLiterals(issue)) {
    if (head === literal) {
      return true;
    }
  }

  const issuePrefix = `issue-${issue}`;
  if (
    head === issuePrefix ||
    head.startsWith(`${issuePrefix}-`) ||
    new RegExp(`(?:^|/)${issuePrefix}(?:-|$)`).test(head)
  ) {
    return true;
  }

  const sessionBranch = getSessionBranch(session);
  if (sessionBranch && sessionBranch === head && isAoWorkerIterationBranch(sessionBranch)) {
    return true;
  }

  return false;
}

/**
 * @param {number} issueNumber
 * @param {OpenPr[]} openPrs
 * @param {AoSession | null | undefined} [session]
 * @param {{ headSha?: string }} [options]
 */
export function listIssueCorrelatedOpenPrs(issueNumber, openPrs = [], session = null, options = {}) {
  const issue = numberOrZero(issueNumber);
  if (issue <= 0) {
    return [];
  }
  const targetHead = normalizeSha(options.headSha);
  return toArray(openPrs).filter((pr) => {
    const headName = normalizeString(pr?.headRefName ?? pr?.head);
    if (!headRefCorrelatesToIssue(headName, issue, session)) {
      return false;
    }
    if (!targetHead) {
      return true;
    }
    const prHead = normalizeSha(pr?.headRefOid);
    return Boolean(prHead && prHead === targetHead);
  });
}

/**
 * Numeric displayName is enriched evidence only when available head/issue signals corroborate.
 *
 * @param {AoSession | null | undefined} session
 * @param {OpenPr} pr
 * @param {{ headSha?: string }} [options]
 */
function numericDisplayNameCorroboratesPr(session, pr, options = {}) {
  const issueNumber = getSessionIssueNumber(session);
  const headSha = normalizeSha(options.headSha);
  let hasSignal = false;
  let corroborated = true;

  if (headSha) {
    hasSignal = true;
    const prHead = normalizeSha(pr?.headRefOid);
    if (!prHead || prHead !== headSha) {
      corroborated = false;
    }
  }

  if (issueNumber > 0) {
    hasSignal = true;
    const headName = normalizeString(pr?.headRefName ?? pr?.head);
    if (!headRefCorrelatesToIssue(headName, issueNumber, session)) {
      corroborated = false;
    }
  }

  return hasSignal && corroborated;
}

/**
 * @param {AoSession | null | undefined} session
 * @param {OpenPr[]} [openPrs]
 * @param {{ headSha?: string, sessionDetail?: { displayName?: string } | null }} [options]
 * @returns {SessionPrBinding}
 */
export function resolveSessionPrBinding(session, openPrs = [], options = {}) {
  const prList = toArray(openPrs);
  const explicitPr = getExplicitSessionPrNumber(session);
  if (explicitPr > 0) {
    return {
      bound: true,
      prNumber: explicitPr,
      source: 'explicit_pr',
      enriched: false,
    };
  }

  const displayName = normalizeString(options.sessionDetail?.displayName ?? session?.displayName);
  if (displayName && /^\d+$/.test(displayName)) {
    const displayPr = numberOrZero(displayName);
    const displayPrRow = prList.find((pr) => numberOrZero(pr?.number) === displayPr);
    if (
      displayPr > 0 &&
      displayPrRow &&
      numericDisplayNameCorroboratesPr(session, displayPrRow, options)
    ) {
      return {
        bound: true,
        prNumber: displayPr,
        source: 'display_name',
        enriched: true,
      };
    }
  }

  const issueNumber = getSessionIssueNumber(session);
  if (issueNumber <= 0) {
    return {
      bound: false,
      prNumber: null,
      source: 'none',
      enriched: false,
      deferReason: DEFER_NO_ISSUE_BINDING,
    };
  }

  const issueScoped = listIssueCorrelatedOpenPrs(issueNumber, prList, session);
  if (issueScoped.length > 1) {
    return {
      bound: false,
      prNumber: null,
      source: 'none',
      enriched: false,
      deferReason: DEFER_AMBIGUOUS_ISSUE_PR_BINDING,
    };
  }
  const matches = options.headSha
    ? listIssueCorrelatedOpenPrs(issueNumber, prList, session, {
        headSha: options.headSha,
      })
    : issueScoped;
  if (matches.length === 1) {
    const prNumber = numberOrZero(matches[0]?.number);
    if (prNumber > 0) {
      return {
        bound: true,
        prNumber,
        source: 'issue_correlation',
        enriched: true,
      };
    }
  }

  return {
    bound: false,
    prNumber: null,
    source: 'none',
    enriched: false,
    deferReason: DEFER_NO_ISSUE_BINDING,
  };
}

/**
 * @param {SessionPrBinding} binding
 */
export function isEnrichedPrBinding(binding) {
  return Boolean(binding?.enriched);
}

/**
 * @param {AoSession | null | undefined} session
 * @param {number} prNumber
 * @param {OpenPr[]} [openPrs]
 * @param {{ headSha?: string, sessionDetail?: { displayName?: string } | null }} [options]
 */
export function sessionMatchesPrBound(session, prNumber, openPrs = [], options = {}) {
  const binding = resolveSessionPrBinding(session, openPrs, options);
  return binding.bound && numberOrZero(binding.prNumber) === numberOrZero(prNumber);
}

/**
 * @param {AoSession[]} sessions
 * @param {number} prNumber
 * @param {OpenPr[]} [openPrs]
 * @param {{
 *   headSha?: string,
 *   requireLive?: boolean,
 *   sessionDetailsById?: Record<string, { displayName?: string }>,
 *   isLive?: (session: AoSession) => boolean,
 *   getSessionId?: (session: AoSession) => string | null,
 * }} [options]
 * @returns {PrSessionBindingResolution}
 */
export function resolvePrOwningWorkerSessionBinding(
  sessions,
  prNumber,
  openPrs = [],
  options = {},
) {
  const targetPr = numberOrZero(prNumber);
  if (targetPr <= 0) {
    return { sessionId: null, reason: 'missing_pr_number', failClosed: false };
  }

  const isLive = options.isLive ?? (() => true);
  const getSessionId =
    options.getSessionId ??
    ((session) => normalizeString(session?.sessionId ?? session?.id ?? session?.name) || null);
  const sessionDetailsById = options.sessionDetailsById ?? {};

  /** @type {Array<{ session: AoSession, binding: SessionPrBinding, sessionId: string }>} */
  const matches = [];
  let sawIssueAmbiguityDefer = false;
  for (const session of toArray(sessions)) {
    const role = normalizeString(session?.role).toLowerCase();
    if (role !== 'worker' && role !== 'coding') {
      continue;
    }
    const sessionId = getSessionId(session);
    if (!sessionId) {
      continue;
    }
    const binding = resolveSessionPrBinding(session, openPrs, {
      headSha: options.headSha,
      sessionDetail: sessionDetailsById[sessionId] ?? null,
    });
    if (binding.deferReason === DEFER_AMBIGUOUS_ISSUE_PR_BINDING) {
      sawIssueAmbiguityDefer = true;
    }
    if (!binding.bound || numberOrZero(binding.prNumber) !== targetPr) {
      continue;
    }
    if (options.requireLive !== false && !isLive(session)) {
      continue;
    }
    matches.push({ session, binding, sessionId });
  }

  if (matches.length > 1) {
    return {
      sessionId: null,
      reason: 'ambiguous_pr_session_binding',
      failClosed: true,
      deferReason: DEFER_AMBIGUOUS_PR_SESSION_BINDING,
    };
  }
  if (matches.length === 1) {
    return {
      sessionId: matches[0].sessionId,
      reason: 'resolved',
      failClosed: false,
    };
  }

  if (matches.length === 0 && sawIssueAmbiguityDefer) {
    return {
      sessionId: null,
      reason: 'ambiguous_issue_pr_binding',
      failClosed: true,
      deferReason: DEFER_AMBIGUOUS_ISSUE_PR_BINDING,
    };
  }

  return { sessionId: null, reason: 'no_worker_session', failClosed: false };
}
