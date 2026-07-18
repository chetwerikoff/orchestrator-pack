/**
 * Shared session↔PR binding boundary for AO 0.10.2 bulk-list rows.
 * Issue #857 retires displayName/prNumber predicates and resolves from prs[]/branch.
 */

import { normalizeSha } from './review-reconcile-primitives.mjs';

/** @typedef {{ number?: number, headRefOid?: string, headRefName?: string, head?: string, state?: string, repoSlug?: string, repository?: string }} OpenPr */
/** @typedef {{ name?: string, sessionId?: string, id?: string, role?: string, issue?: string | number | null, issueId?: string | number | null, issueNumber?: number | null, branch?: string, headBranch?: string, headRefName?: string, ownedHeadSha?: string, headRefOid?: string, status?: string, repoSlug?: string, prs?: unknown[] }} AoSession */
/** @typedef {'issue_correlation' | 'none'} SessionPrBindingSource */

export const DEFER_NO_ISSUE_BINDING = 'no_issue_binding';
export const DEFER_AMBIGUOUS_ISSUE_PR_BINDING = 'ambiguous_issue_pr_binding';
export const DEFER_AMBIGUOUS_PR_SESSION_BINDING = 'ambiguous_pr_session_binding';
export const DEFER_AMBIGUOUS_SESSION_PRS = 'ambiguous_session_prs';

function numberOrZero(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeString(value) {
  return String(value ?? '').trim();
}

function normalizeRepoSlug(value) {
  return normalizeString(value).toLowerCase();
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

function getSessionIdentifier(session) {
  return normalizeString(session?.sessionId ?? session?.id ?? session?.name) || null;
}

function getSessionBranch(session) {
  return normalizeString(session?.branch ?? session?.headBranch ?? session?.headRefName);
}

function getOpenPrRepoSlug(pr, fallback = '') {
  return normalizeRepoSlug(pr?.repoSlug ?? pr?.repository ?? fallback);
}

function getSessionRepoSlug(session, fallback = '') {
  return normalizeRepoSlug(session?.repoSlug ?? fallback);
}

function repoScopeMatches(candidate, expected) {
  const candidateRepo = normalizeRepoSlug(candidate);
  const expectedRepo = normalizeRepoSlug(expected);
  return !expectedRepo || !candidateRepo || candidateRepo === expectedRepo;
}

function prIsTerminal(pr) {
  const state = normalizeString(pr?.state).toLowerCase();
  return state === 'closed' || state === 'merged' || pr?.merged === true || pr?.closed === true;
}

/**
 * Parse AO session prs[] entries. AO 0.10.2 emits full GitHub PR URLs.
 * A small set of structured forms is accepted for forward compatibility; bare
 * numbers are deliberately rejected so callers cannot accidentally revive the
 * retired numeric-row contract.
 */
export function parseSessionPrReference(value) {
  if (value && typeof value === 'object') {
    const nested = value.url ?? value.htmlUrl ?? value.html_url ?? value.prUrl ?? value.pullRequestUrl;
    if (nested) return parseSessionPrReference(nested);
    const repoSlug = normalizeRepoSlug(value.repoSlug ?? value.repository);
    const prNumber = numberOrZero(value.number ?? value.prNumber);
    return repoSlug && prNumber > 0 ? { repoSlug, prNumber } : null;
  }
  const text = normalizeString(value);
  if (!text) return null;
  const githubUrl = text.match(/^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/i);
  if (githubUrl) {
    return {
      repoSlug: normalizeRepoSlug(`${githubUrl[1]}/${githubUrl[2]}`),
      prNumber: numberOrZero(githubUrl[3]),
    };
  }
  const repoHash = text.match(/^([^/\s]+\/[^#\s]+)#(\d+)$/);
  if (repoHash) {
    return { repoSlug: normalizeRepoSlug(repoHash[1]), prNumber: numberOrZero(repoHash[2]) };
  }
  return null;
}

export function listSessionPrReferences(session, options = {}) {
  const expectedRepo = normalizeRepoSlug(options.repoSlug ?? session?.repoSlug);
  const seen = new Set();
  const refs = [];
  for (const raw of toArray(session?.prs)) {
    const parsed = parseSessionPrReference(raw);
    if (!parsed || parsed.prNumber <= 0 || !repoScopeMatches(parsed.repoSlug, expectedRepo)) continue;
    const key = `${parsed.repoSlug}|${parsed.prNumber}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(parsed);
  }
  return refs;
}

/** @param {AoSession | null | undefined} session */
export function getSessionIssueNumber(session) {
  const issue = numberOrZero(session?.issueNumber ?? session?.issue ?? session?.issueId);
  return issue > 0 ? issue : 0;
}

const LEGACY_PR_NUMBER_KEY = ['pr', 'Number'].join('');
const LEGACY_PR_KEY = 'pr';

function hasDaemonPrListField(session) {
  return Boolean(
    session &&
    typeof session === 'object' &&
    Object.prototype.hasOwnProperty.call(session, 'prs')
  );
}

function legacySessionField(session, key) {
  if (!session || typeof session !== 'object' || hasDaemonPrListField(session)) return undefined;
  return session[key];
}

/** Historical non-daemon compatibility; live AO rows always own prs. */
export function getExplicitSessionPrNumber(session) {
  const direct = numberOrZero(legacySessionField(session, LEGACY_PR_NUMBER_KEY));
  if (direct > 0) return direct;
  const raw = normalizeString(legacySessionField(session, LEGACY_PR_KEY));
  if (!raw) return 0;
  const parsed = numberOrZero(raw.startsWith('#') ? raw.slice(1) : raw);
  return parsed > 0 ? parsed : 0;
}

export function sessionDetailFromSessionGetPayload(_ignoredPayload) {
  return null;
}

export function shouldEnrichSessionDetailFromGet(_ignoredSession) {
  return false;
}

export function buildSessionDetailsById(_ignoredSessions, _ignoredSessionGetsById = {}) {
  return {};
}

export function issueLinkedWorkerBranchLiterals(issueNumber) {
  const issue = numberOrZero(issueNumber);
  if (issue <= 0) return [];
  return [`feat/${issue}`, `feat/issue-${issue}`, `opk-${issue}`];
}

function isAoWorkerIterationBranch(branch) {
  const value = normalizeString(branch);
  return /^(?:opk-|issue-|feat\/issue-|agent\/issue-)/i.test(value);
}

export function headRefCorrelatesToIssue(headRefName, issueNumber, session = null) {
  const head = normalizeString(headRefName);
  const issue = numberOrZero(issueNumber);
  if (!head || issue <= 0) return false;
  for (const literal of issueLinkedWorkerBranchLiterals(issue)) {
    if (head === literal) return true;
  }
  const issuePrefix = `issue-${issue}`;
  if (
    head === issuePrefix ||
    head.startsWith(`${issuePrefix}-`) ||
    new RegExp(`(?:^|/)${issuePrefix}(?:-|$)`).test(head)
  ) return true;
  const branch = getSessionBranch(session);
  return Boolean(branch && branch === head && isAoWorkerIterationBranch(branch));
}

export function listIssueCorrelatedOpenPrs(issueNumber, openPrs = [], session = null, options = {}) {
  const issue = numberOrZero(issueNumber);
  if (issue <= 0) return [];
  const expectedRepo = normalizeRepoSlug(options.repoSlug ?? session?.repoSlug);
  return toArray(openPrs).filter((pr) => {
    if (prIsTerminal(pr)) return false;
    if (!repoScopeMatches(getOpenPrRepoSlug(pr), expectedRepo)) return false;
    const headName = normalizeString(pr?.headRefName ?? pr?.head);
    return headRefCorrelatesToIssue(headName, issue, session);
  });
}

function listDirectBranchMatches(session, openPrs, options = {}) {
  const branch = getSessionBranch(session);
  if (!branch) return [];
  const expectedRepo = normalizeRepoSlug(options.repoSlug ?? session?.repoSlug);
  const targetHead = normalizeSha(options.headSha);
  return toArray(openPrs).filter((pr) => {
    if (prIsTerminal(pr)) return false;
    if (!repoScopeMatches(getOpenPrRepoSlug(pr), expectedRepo)) return false;
    if (normalizeString(pr?.headRefName ?? pr?.head) !== branch) return false;
    if (!targetHead) return true;
    const prHead = normalizeSha(pr?.headRefOid);
    return Boolean(prHead && prHead === targetHead);
  });
}

function unbound(deferReason, extra = {}) {
  return {
    bound: false,
    prNumber: null,
    source: 'none',
    enriched: false,
    deferReason,
    ...extra,
  };
}

/**
 * Resolve the live side of the #857 contract from a single already-fetched row.
 * Trust order on the live side: unambiguous prs[] > exact branch > issue heuristic.
 */
export function resolveSessionPrBinding(session, openPrs = [], options = {}) {
  const prList = toArray(openPrs);
  const expectedRepo = normalizeRepoSlug(options.repoSlug ?? session?.repoSlug);
  const refs = listSessionPrReferences(session, { repoSlug: expectedRepo });
  if (refs.length > 1) {
    return unbound(DEFER_AMBIGUOUS_SESSION_PRS, {
      liveSource: 'prs',
      diagnostic: 'multiple_session_pr_references',
      candidates: refs,
    });
  }
  if (refs.length === 1) {
    const ref = refs[0];
    const row = prList.find((pr) => (
      numberOrZero(pr?.number) === ref.prNumber &&
      repoScopeMatches(getOpenPrRepoSlug(pr, ref.repoSlug), ref.repoSlug) &&
      !prIsTerminal(pr)
    ));
    if (row || prList.length === 0 || options.openListAuthoritative !== true) {
      return {
        bound: true,
        prNumber: ref.prNumber,
        source: 'issue_correlation',
        bindingSource: 'live_prs',
        enriched: true,
        liveSource: 'prs',
        trustRank: 400,
        repoSlug: ref.repoSlug || expectedRepo,
      };
    }
  }

  // Compatibility for pack-owned synthetic rows only. AO daemon list rows always
  // own the `prs` field, including the explicit empty-array UNBOUND case.
  if (!hasDaemonPrListField(session)) {
    const syntheticPr = getExplicitSessionPrNumber(session);
    const requestedHead = normalizeSha(options.headSha);
    const syntheticRow = prList.find((pr) => (
      numberOrZero(pr?.number) === syntheticPr &&
      repoScopeMatches(getOpenPrRepoSlug(pr), expectedRepo) &&
      !prIsTerminal(pr)
    ));
    const openPrHead = normalizeSha(syntheticRow?.headRefOid);
    const sessionHead = normalizeSha(session?.ownedHeadSha ?? session?.headRefOid);
    const headCorroborated = !requestedHead || (
      openPrHead === requestedHead &&
      (!sessionHead || sessionHead === requestedHead)
    );
    if (
      syntheticPr > 0 &&
      syntheticRow &&
      headCorroborated
    ) {
      return {
        bound: true,
        prNumber: syntheticPr,
        source: 'issue_correlation',
        bindingSource: 'issue_correlation',
        enriched: false,
        liveSource: 'issue_correlation',
        trustRank: 300,
        repoSlug: getOpenPrRepoSlug(syntheticRow, expectedRepo),
      };
    }
  }

  const packReportPr = String(session?.reportSnapshotKind ?? '') === 'pack-worker-report-store'
    ? numberOrZero(session?.prNumber)
    : 0;
  const requestedHead = normalizeSha(options.headSha);
  const packReportCoversHead = !requestedHead || toArray(session?.reports).some((report) => (
    normalizeSha(report?.headSha ?? report?.headRefOid) === requestedHead
  ));
  if (packReportPr > 0 && packReportCoversHead) {
    return {
      bound: true,
      prNumber: packReportPr,
      source: 'issue_correlation',
      bindingSource: 'issue_correlation',
      enriched: false,
      liveSource: 'issue_correlation',
      trustRank: 250,
      repoSlug: expectedRepo,
    };
  }

  const branchMatches = listDirectBranchMatches(session, prList, options);
  if (branchMatches.length > 1) {
    return unbound(DEFER_AMBIGUOUS_ISSUE_PR_BINDING, {
      liveSource: 'branch',
      candidates: branchMatches.map((pr) => numberOrZero(pr?.number)).filter(Boolean),
    });
  }
  if (branchMatches.length === 1) {
    return {
      bound: true,
      prNumber: numberOrZero(branchMatches[0]?.number),
      source: 'issue_correlation',
      bindingSource: 'issue_correlation',
      enriched: true,
      liveSource: 'branch',
      trustRank: 200,
      repoSlug: getOpenPrRepoSlug(branchMatches[0], expectedRepo),
    };
  }

  const issueNumber = getSessionIssueNumber(session);
  if (issueNumber <= 0) return unbound(DEFER_NO_ISSUE_BINDING, { liveSource: 'none' });
  const issueScoped = listIssueCorrelatedOpenPrs(issueNumber, prList, session, {
    ...options,
    repoSlug: expectedRepo,
  });
  if (issueScoped.length > 1) {
    return unbound(DEFER_AMBIGUOUS_ISSUE_PR_BINDING, {
      liveSource: 'issue_correlation',
      candidates: issueScoped.map((pr) => numberOrZero(pr?.number)).filter(Boolean),
    });
  }
  if (issueScoped.length === 1) {
    const prNumber = numberOrZero(issueScoped[0]?.number);
    if (prNumber > 0) {
      return {
        bound: true,
        prNumber,
        source: 'issue_correlation',
        bindingSource: 'issue_correlation',
        enriched: true,
        liveSource: 'issue_correlation',
        trustRank: 200,
        repoSlug: getOpenPrRepoSlug(issueScoped[0], expectedRepo),
      };
    }
  }
  return unbound(DEFER_NO_ISSUE_BINDING, { liveSource: 'none' });
}

export function isEnrichedPrBinding(binding) {
  return Boolean(binding?.enriched);
}

export function sessionMatchesPrBound(session, prNumber, openPrs = [], options = {}) {
  const binding = resolveSessionPrBinding(session, openPrs, options);
  return binding.bound && numberOrZero(binding.prNumber) === numberOrZero(prNumber);
}

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
  const getSessionId = options.getSessionId ?? getSessionIdentifier;
  const sessionDetailsById = options.sessionDetailsById ?? {};
  const matches = [];
  const ambiguousSessions = [];
  for (const session of toArray(sessions)) {
    const role = normalizeString(session?.role ?? session?.kind).toLowerCase();
    if (role && role !== 'worker' && role !== 'coding') continue;
    const sessionId = getSessionId(session);
    if (!sessionId) continue;
    if (options.requireLive !== false && !isLive(session)) continue;
    const binding = resolveSessionPrBinding(session, openPrs, {
      headSha: options.headSha,
      repoSlug: options.repoSlug,
      openListAuthoritative: options.openListAuthoritative,
      sessionDetail: sessionDetailsById[sessionId] ?? null,
    });
    if (
      binding.deferReason === DEFER_AMBIGUOUS_ISSUE_PR_BINDING ||
      binding.deferReason === DEFER_AMBIGUOUS_SESSION_PRS
    ) {
      const candidates = toArray(binding.candidates).map((candidate) => numberOrZero(candidate?.prNumber ?? candidate));
      if (candidates.length === 0 || candidates.includes(targetPr)) ambiguousSessions.push(sessionId);
    }
    if (binding.bound && numberOrZero(binding.prNumber) === targetPr) {
      matches.push({ sessionId, binding });
    }
  }
  if (matches.length > 1) {
    return {
      sessionId: null,
      conflictingSessionIds: matches.map((row) => row.sessionId),
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
      source: matches[0].binding.bindingSource ?? matches[0].binding.liveSource ?? matches[0].binding.source,
    };
  }
  if (ambiguousSessions.length > 0) {
    return {
      sessionId: null,
      conflictingSessionIds: ambiguousSessions,
      reason: 'ambiguous_issue_pr_binding',
      failClosed: true,
      deferReason: DEFER_AMBIGUOUS_ISSUE_PR_BINDING,
    };
  }
  return { sessionId: null, reason: 'no_worker_session', failClosed: false };
}
