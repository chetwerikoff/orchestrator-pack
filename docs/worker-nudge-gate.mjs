/**
 * Shared per-(PR, worker-cycle, intent-class, worker-target) worker nudge gate (Issue #384).
 * Vitest: scripts/worker-nudge-gate.test.ts
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrapLegacyNudgedCycle, buildOwnerCycleKey, getOwnerCycleRecord } from './worker-iteration-cycle.mjs';
import {
  evaluateAutonomousGatePreflight,
  loadAutonomousCapabilitiesInventory,
  loadMergedAutonomousCapabilitiesInventory,
  validateCapabilityInventory,
} from './autonomous-gate-preflight.mjs';
import { readStdinJson, runStdinJsonCli } from './review-mechanical-cli.mjs';
import { evaluateCiFailureSuppressorDecision } from './ci-failure-notification.mjs';
import { resolveHeadOwningWorkerSessionId, sessionMatchesPr } from './review-trigger-reconcile.mjs';
import { resolvePrOwningWorkerSessionBinding } from './session-pr-binding-resolver.mjs';
import { isSessionAlive } from './worker-message-dispatch-observe.mjs';
export { validateCapabilityInventory };

export const WORKER_NUDGE_GATE_VERSION = 'worker-nudge-gate/v1';
export const ATOMIC_WORKER_NUDGE_CLAIM_CAPABILITY = 'worker-nudge-claim-atomic/v1';
export const ORCHESTRATOR_TURN_SURFACE = 'orchestrator-turn';
export const AUTONOMOUS_SURFACE_ENV = 'AO_AUTONOMOUS_ORCHESTRATOR_SURFACE';
export const JOURNALED_SEND_INTERNAL_ENV = 'AO_JOURNALED_SEND_INTERNAL';
export const JOURNALED_SEND_INTERNAL_CAPABILITY = 'journaled-worker-send-internal/v1';
export const OPERATOR_ESCALATION_PREFIX = '[worker-nudge-gate] ESCALATION:';
export const CLASSIFIER_VERSION = 'worker-nudge-intent/v1';

/** @type {readonly string[]} */
export const INTENT_CLASSES = Object.freeze([
  'review-findings',
  'findings-delivery',
  'review-findings-redelivery',
  'ci-green-handoff',
  'ci-failure',
  'liveness',
  'task-continuation',
  'unknown-worker-nudge',
]);

/** @type {readonly string[]} */
export const TERMINAL_CLAIM_PHASES = Object.freeze([
  'SENT',
  'FAILED_DEFINITIVE',
  'UNCERTAIN',
]);

/** @type {readonly string[]} */
export const ACTIVE_CLAIM_PHASES = Object.freeze(['CLAIMED', 'SEND_ATTEMPTED']);

const SHA40 = /^[0-9a-f]{40}$/i;
const DEFAULT_UNRESOLVED_ESCALATE_COUNT = 3;
const DEFAULT_UNRESOLVED_ESCALATE_MS = 15 * 60 * 1000;

/**
 * @param {unknown} value
 */
function toArray(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * @param {string | undefined | null} sha
 */
export function normalizeHeadSha(sha) {
  return String(sha ?? '')
    .trim()
    .toLowerCase();
}

const VALID_HEAD_SHA = /^[0-9a-f]{40}$/;

/**
 * @param {string} episodeKey
 */
function extractHeadShaFromEpisodeKey(episodeKey) {
  const key = String(episodeKey ?? '').trim();
  if (!key) {
    return '';
  }
  const headRed = key.match(/^head-red:([0-9a-f]{40}):stint-\d+$/i);
  if (headRed) {
    return headRed[1].toLowerCase();
  }
  const episodePrHead = key.match(/^(?:episode:)?(\d+):([0-9a-f]{40})$/i);
  if (episodePrHead) {
    return episodePrHead[2].toLowerCase();
  }
  if (VALID_HEAD_SHA.test(key)) {
    return key.toLowerCase();
  }
  return '';
}

/**
 * @param {object} input
 */
export function resolveCiFailureHeadShaFromGateInput(input) {
  const direct = normalizeHeadSha(input?.headSha ?? '');
  if (VALID_HEAD_SHA.test(direct)) {
    return direct;
  }
  const episodeKey = String(input?.episodeKey ?? input?.redPeriod ?? '').trim();
  const fromKey = extractHeadShaFromEpisodeKey(episodeKey);
  if (fromKey) {
    return fromKey;
  }
  const prNumber = Number(input?.prNumber ?? 0);
  const openPrs = toArray(input?.workerState?.openPrs);
  const pr = openPrs.find((row) => Number(row?.number) === prNumber);
  const fromPr = normalizeHeadSha(pr?.headRefOid ?? '');
  if (VALID_HEAD_SHA.test(fromPr)) {
    return fromPr;
  }
  return '';
}

/**
 * @param {string} storePath
 */
export function canonicalizeStorePath(storePath) {
  let normalized = String(storePath ?? '').trim();
  if (!normalized) {
    return '';
  }
  const wsl = normalized.match(/^\/mnt\/([a-z])\/(.*)$/i);
  if (wsl) {
    normalized = `${wsl[1].toUpperCase()}:/${wsl[2]}`;
  }
  normalized = normalized.replace(/\\/g, '/');
  if (/^[a-z]:\//i.test(normalized)) {
    normalized = normalized[0].toLowerCase() + normalized.slice(1);
  }
  return normalized.toLowerCase();
}

/**
 * @param {string} storePath
 */
export function canonicalStoreId(storePath) {
  const canonical = canonicalizeStorePath(storePath);
  if (!canonical) {
    return '';
  }
  return createHash('sha256').update(canonical).digest('hex').slice(0, 24);
}

/**
 * @param {string} message
 */
export function hashNudgeMessageContent(message) {
  const normalized = String(message ?? '').replace(/\r\n/g, '\n').trim();
  if (!normalized) {
    return '';
  }
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/**
 * @param {object} input
 */
export function inferResumeLineageFromOwnershipChange(input) {
  const existing = input.existingClaim ?? null;
  const ownerSessionId = String(input.ownerSessionId ?? '').trim();
  if (!existing || !ownerSessionId) {
    return { resumeLineage: false, reason: 'missing_context' };
  }
  const priorOwner = String(existing.ownerSessionId ?? '').trim();
  if (!priorOwner || priorOwner === ownerSessionId) {
    return { resumeLineage: false, reason: 'same_owner' };
  }
  const worktree = canonicalizeStorePath(String(input.worktree ?? ''));
  const priorWorktree = canonicalizeStorePath(String(existing.worktree ?? ''));
  if (!worktree || !priorWorktree || worktree !== priorWorktree) {
    return { resumeLineage: false, reason: 'worktree_changed' };
  }
  const meta = input.sessionMeta ?? {};
  const restoredAt = String(meta.restoredAt ?? meta.resumedAt ?? '').trim();
  const parentSessionId = String(meta.parentSessionId ?? meta.parent_session_id ?? '').trim();
  const resumedFrom = String(meta.resumedFromSessionId ?? meta.resumedFrom ?? '').trim();
  if (restoredAt || parentSessionId === priorOwner || resumedFrom === priorOwner) {
    return { resumeLineage: true, reason: 'same_worktree_resume_signal' };
  }
  return { resumeLineage: false, reason: 'replacement_without_resume_signal' };
}

/**
 * @param {object} terminal
 * @param {object} input
 */
function isMateriallyNewServedContent(terminal, input) {
  const incomingHash = hashNudgeMessageContent(input.message ?? '');
  const servedHash = String(
    terminal?.messageContentHash ?? terminal?.contentHash ?? '',
  ).trim();
  return Boolean(incomingHash && servedHash && incomingHash !== servedHash);
}

/**
 * @param {object} input
 */

/**
 * @param {Record<string, unknown> | null | undefined} session
 */
function getSessionIdentifier(session) {
  for (const key of ['name', 'sessionId', 'id']) {
    const value = String(session?.[key] ?? '').trim();
    if (value) {
      return value;
    }
  }
  return '';
}

/**
 * @param {Record<string, unknown> | null | undefined} session
 */

/**
 * @param {unknown} value
 */
export function normalizeIssueNumber(value) {
  const raw = String(value ?? '')
    .trim()
    .replace(/^#/, '');
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * @param {Record<string, unknown> | null | undefined} session
 * @param {number} issueNumber
 */
function sessionMatchesIssue(session, issueNumber) {
  return normalizeIssueNumber(session?.issue) === issueNumber;
}

/**
 * @param {Record<string, unknown> | null | undefined} session
 * @param {string} projectId
 */
function sessionMatchesProject(session, projectId) {
  const expected = String(projectId ?? '').trim();
  if (!expected) {
    return true;
  }
  const actual = String(session?.project ?? '').trim();
  return !actual || actual === expected;
}

function deriveTargetGeneration(session) {
  for (const key of ['targetGeneration', 'sessionGeneration', 'generation']) {
    const value = String(session?.[key] ?? '').trim();
    if (value) {
      return value;
    }
  }
  return getSessionIdentifier(session);
}

/**
 * @param {unknown[]} sessions
 * @param {number} prNumber
 * @param {string} headSha
 * @param {unknown[]} openPrs
 */
function resolvePrOwningWorkerSessionId(sessions, prNumber, headSha = '', openPrs = [], sessionDetailsById = {}) {
  if (headSha) {
    const owned = resolveHeadOwningWorkerSessionId(sessions, prNumber, headSha, openPrs);
    if (owned) {
      return { sessionId: owned };
    }
  }
  const prBinding = resolvePrOwningWorkerSessionBinding(sessions, prNumber, openPrs, {
    headSha: headSha || undefined,
    requireLive: true,
    isLive: isSessionAlive,
    getSessionId: getSessionIdentifier,
    sessionDetailsById,
  });
  if (prBinding.failClosed) {
    return {
      sessionId: null,
      deferReason: prBinding.deferReason ?? prBinding.reason ?? 'ambiguous_pr_session_binding',
    };
  }
  return { sessionId: prBinding.sessionId ?? null };
}

/**
 * @param {string} value
 */
export function isValidJournaledSendInternalCapability(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return false;
  const prefix = `${JOURNALED_SEND_INTERNAL_CAPABILITY}:`;
  if (!raw.startsWith(prefix)) return false;
  const nonce = raw.slice(prefix.length).trim();
  return nonce.length >= 8 && /^[A-Za-z0-9-]+$/.test(nonce);
}

/**
 * @param {object} input
 */
export function evaluateClaimStoreFailure(input) {
  const bounds = resolveUnresolvedEscalationBounds(input);
  const unresolvedCount = Number(input.unresolvedCount ?? 0) + 1;
  const nowMs = Number(input.nowMs ?? Date.now());
  const sinceMs = Number(input.unresolvedSinceMs ?? nowMs);
  const escalate =
    unresolvedCount >= bounds.count || sinceMs + bounds.ms <= nowMs;
  return {
    escalate,
    unresolvedCount,
    unresolvedSinceMs: sinceMs,
    reason: escalate ? 'unresolved_escalate' : 'unresolved_fail_closed',
    diagnosis: escalate
      ? `${OPERATOR_ESCALATION_PREFIX} claim store unreadable after ${unresolvedCount} consecutive failure(s) (${input.failureReason ?? 'storage_failure'}); worker nudges fail-closed until operator repairs claim storage.`
      : null,
  };
}

/**
 * @param {object} input
 */
export function syncPrOwnershipClaimRecord(input) {
  const prNumber = Number(input.prNumber);
  const ownerSessionId = String(input.ownerSessionId ?? '').trim();
  const worktree = canonicalizeStorePath(String(input.worktree ?? input.workspacePath ?? ''));
  const existing = input.existingClaim ?? null;
  const nowIso = new Date().toISOString();
  if (!prNumber || !ownerSessionId) {
    return { ok: false, reason: 'missing_owner' };
  }
  if (!existing || !existing.generation) {
    return {
      ok: true,
      changed: true,
      reason: 'initialized',
      record: {
        prNumber,
        ownerSessionId,
        generation: ownerSessionId,
        lineageId: ownerSessionId,
        worktree,
        claimedAtUtc: nowIso,
        updatedAtUtc: nowIso,
      },
    };
  }
  const priorOwner = String(existing.ownerSessionId ?? '').trim();
  const priorWorktree = canonicalizeStorePath(String(existing.worktree ?? ''));
  if (priorOwner === ownerSessionId) {
    return {
      ok: true,
      changed: false,
      reason: 'same_owner',
      record: {
        ...existing,
        ownerSessionId,
        worktree: worktree || priorWorktree,
        updatedAtUtc: nowIso,
      },
    };
  }
  const resumeLineage = Boolean(input.resumeLineage ?? input.resumeSameLineage);
  if (resumeLineage) {
    return {
      ok: true,
      changed: priorOwner !== ownerSessionId,
      reason: 'resume_same_lineage',
      record: {
        ...existing,
        ownerSessionId,
        worktree: worktree || priorWorktree,
        updatedAtUtc: nowIso,
      },
    };
  }
  return {
    ok: true,
    changed: true,
    reason: 'replacement_claim',
    record: {
      prNumber,
      ownerSessionId,
      generation: ownerSessionId,
      lineageId: ownerSessionId,
      worktree,
      claimedAtUtc: nowIso,
      updatedAtUtc: nowIso,
      replacedOwnerSessionId: priorOwner || null,
    },
  };
}

/**
 * @param {object} input
 */
/**
 * @param {object} input
 */
export function resolvePrOwnerSessionForNudge(input) {
  const prNumber = Number(input.prNumber);
  const sessionId = String(input.sessionId ?? '').trim();
  const headSha = normalizeHeadSha(input.headSha ?? '');
  const sessions = toArray(input.sessions);
  const openPrs = toArray(input.openPrs);

  const sessionDetailsById = input.sessionDetailsById ?? input.workerState?.sessionDetailsById ?? {};
  const ownership = resolvePrOwningWorkerSessionId(sessions, prNumber, headSha, openPrs, sessionDetailsById);
  const ownerSessionId = ownership.sessionId;
  if (!ownerSessionId) {
    return { ok: false, reason: ownership.deferReason ?? 'pr_owner_unresolved' };
  }
  if (sessionId && headSha && ownerSessionId !== sessionId) {
    return { ok: false, reason: 'head_owner_mismatch' };
  }
  if (sessionId && !headSha) {
    const sessionOk = sessions.some(
      (session) => getSessionIdentifier(session) === sessionId && sessionMatchesPr(session, prNumber, openPrs),
    );
    if (!sessionOk) {
      return { ok: false, reason: 'pr_session_mismatch' };
    }
    return { ok: true, ownerSessionId: sessionId };
  }
  return { ok: true, ownerSessionId };
}

export function resolveWorkerTargetFromPrClaim(input) {
  const prNumber = Number(input.prNumber);
  const sessionId = String(input.sessionId ?? '').trim();
  const sessions = toArray(input.sessions);
  const prClaims = toArray(input.prClaims);
  const headSha = normalizeHeadSha(input.headSha ?? '');
  if (!prNumber || !sessionId) {
    return { ok: false, reason: 'missing_pr_or_session', verifiable: false };
  }
  const claimRecord =
    prClaims.find((row) => Number(row?.prNumber) === prNumber) ?? input.claimRecord ?? null;
  const sessionDetailsById = input.sessionDetailsById ?? input.workerState?.sessionDetailsById ?? {};
  const ownership = resolvePrOwningWorkerSessionId(sessions, prNumber, headSha, input.openPrs, sessionDetailsById);
  const ownerSessionId =
    String(claimRecord?.ownerSessionId ?? '').trim() || ownership.sessionId;
  if (!ownerSessionId) {
    return {
      ok: false,
      reason: ownership.deferReason ?? 'pr_owner_unresolved',
      verifiable: false,
    };
  }
  if (!claimRecord?.generation) {
    return { ok: false, reason: 'pr_claim_unresolved', verifiable: false };
  }
  const targetGeneration = String(claimRecord.generation).trim();
  const targetId = String(
    claimRecord.logicalWorkerId ?? claimRecord.lineageId ?? targetGeneration,
  ).trim();
  if (!targetId || !targetGeneration) {
    return { ok: false, reason: 'pr_claim_unresolved', verifiable: false };
  }
  return {
    ok: true,
    verifiable: true,
    targetId,
    targetGeneration,
    workerTarget: `${targetId}:${targetGeneration}`,
    logicalWorkerId: targetId,
    sessionGeneration: targetGeneration,
    rawSessionId: sessionId,
    ownerSessionId,
    lineageId: String(claimRecord.lineageId ?? targetGeneration),
    targetResolutionSource: prClaims.length ? 'pr-claim-record' : 'ao-pr-ownership-claim',
  };
}


/**
 * @param {object} input
 */
export function syncIssueOwnershipClaimRecord(input) {
  const projectId = String(input.projectId ?? 'orchestrator-pack').trim();
  const issueNumber = normalizeIssueNumber(input.issueNumber);
  const ownerSessionId = String(input.ownerSessionId ?? '').trim();
  const existing = input.existingClaim ?? null;
  const nowIso = new Date().toISOString();
  const nowMs = Number(input.nowMs ?? Date.now());
  if (!projectId || !issueNumber || !ownerSessionId) {
    return { ok: false, reason: 'missing_owner' };
  }
  if (existing) {
    const priorOwner = String(existing.ownerSessionId ?? '').trim();
    if (priorOwner !== ownerSessionId) {
      return { ok: false, reason: 'issue_owner_mismatch' };
    }
    return {
      ok: true,
      changed: false,
      reason: 'same_owner',
      record: {
        ...existing,
        projectId,
        issueNumber,
        ownerSessionId,
        updatedAtUtc: nowIso,
      },
    };
  }
  const generation = createHash('sha256')
    .update(`${projectId}:${issueNumber}:${ownerSessionId}:${nowMs}`)
    .digest('hex')
    .slice(0, 12);
  return {
    ok: true,
    changed: true,
    reason: 'initialized',
    record: {
      projectId,
      issueNumber,
      ownerSessionId,
      generation,
      lineageId: generation,
      logicalWorkerId: ownerSessionId,
      claimedAtUtc: nowIso,
      updatedAtUtc: nowIso,
    },
  };
}

/**
 * @param {object} input
 */
export function resolveIssueOwnerSessionForNudge(input) {
  const issueNumber = normalizeIssueNumber(input.issueNumber);
  const sessionId = String(input.sessionId ?? '').trim();
  const projectId = String(input.projectId ?? 'orchestrator-pack').trim();
  const sessions = toArray(input.sessions);
  if (!issueNumber) {
    return { ok: false, reason: 'missing_issue' };
  }
  const candidates = sessions.filter((session) => {
    const role = String(session?.role ?? '').toLowerCase();
    if (role !== 'worker' && role !== 'coding') {
      return false;
    }
    if (!sessionMatchesIssue(session, issueNumber)) {
      return false;
    }
    if (!sessionMatchesProject(session, projectId)) {
      return false;
    }
    return isSessionAlive(session);
  });
  if (candidates.length === 0) {
    return { ok: false, reason: 'no_issue_owner' };
  }
  if (candidates.length > 1) {
    return { ok: false, reason: 'ambiguous_issue_owner' };
  }
  const ownerSessionId = getSessionIdentifier(candidates[0]);
  if (!ownerSessionId) {
    return { ok: false, reason: 'no_issue_owner' };
  }
  if (sessionId && sessionId !== ownerSessionId) {
    return { ok: false, reason: 'session_not_issue_owner' };
  }
  return { ok: true, ownerSessionId };
}

export function resolveWorkerTargetFromIssueClaim(input) {
  const issueNumber = normalizeIssueNumber(input.issueNumber);
  const sessionId = String(input.sessionId ?? '').trim();
  const projectId = String(input.projectId ?? 'orchestrator-pack').trim();
  const issueClaims = toArray(input.issueClaims);
  if (!issueNumber || !sessionId) {
    return { ok: false, reason: 'missing_issue_or_session', verifiable: false };
  }
  const claimRecord =
    issueClaims.find((row) => normalizeIssueNumber(row?.issueNumber) === issueNumber) ??
    input.claimRecord ??
    null;
  if (!claimRecord?.generation) {
    return { ok: false, reason: 'issue_claim_unresolved', verifiable: false };
  }
  const ownerSessionId = String(claimRecord.ownerSessionId ?? '').trim();
  if (!ownerSessionId) {
    return { ok: false, reason: 'issue_claim_unresolved', verifiable: false };
  }
  if (ownerSessionId !== sessionId) {
    return { ok: false, reason: 'session_not_issue_owner', verifiable: false };
  }
  const targetGeneration = String(claimRecord.generation).trim();
  const targetId = String(
    claimRecord.logicalWorkerId ?? claimRecord.lineageId ?? ownerSessionId,
  ).trim();
  if (!targetId || !targetGeneration) {
    return { ok: false, reason: 'issue_claim_unresolved', verifiable: false };
  }
  return {
    ok: true,
    verifiable: true,
    targetId,
    targetGeneration,
    workerTarget: `${targetId}:${targetGeneration}`,
    logicalWorkerId: targetId,
    sessionGeneration: targetGeneration,
    rawSessionId: sessionId,
    ownerSessionId,
    lineageId: String(claimRecord.lineageId ?? targetGeneration),
    targetResolutionSource: issueClaims.length ? 'issue-claim-record' : 'ao-issue-ownership-claim',
    projectId,
    issueNumber,
  };
}

export function buildWorkerTarget(input) {
  const targetId = String(input.targetId ?? input.sessionId ?? input.workerSessionId ?? '').trim();
  const targetGeneration = String(
    input.targetGeneration ?? input.workerGeneration ?? input.sessionGeneration ?? targetId,
  ).trim();
  if (!targetId) {
    return { workerTarget: '', targetId: '', targetGeneration: '', verifiable: false };
  }
  return {
    workerTarget: `${targetId}:${targetGeneration}`,
    targetId,
    targetGeneration,
    verifiable: Boolean(targetId && targetGeneration),
  };
}

/**
 * @param {object} input
 */
export function classifyIntent(input) {
  const hint = String(input.intentClass ?? input.intentHint ?? '').trim().toLowerCase();
  if (INTENT_CLASSES.includes(hint)) {
    return hint;
  }

  const source = String(input.source ?? '').trim().toLowerCase();
  const surface = String(input.surface ?? '').trim().toLowerCase();
  const message = String(input.message ?? '').trim().toLowerCase();

  if (
    source.includes('review-finding-delivery-confirm') ||
    surface.includes('review-finding-delivery-confirm')
  ) {
    return 'review-findings-redelivery';
  }
  if (source === 'review-send' || source.includes('review-send')) {
    return 'findings-delivery';
  }
  if (source.includes('ci-failure') || source.includes('ci-failed')) {
    return 'ci-failure';
  }
  if (
    source.includes('ci-green') ||
    source === 'pack-send' ||
    message.includes('continue-hand-off') ||
    message.includes('ready_for_review when ci green')
  ) {
    return 'ci-green-handoff';
  }
  if (
    surface === 'waiting_worker_review_response' ||
    surface === 'merge.ready' ||
    message.includes('review findings') ||
    message.includes('changes_requested') ||
    message.includes('addressing_reviews') ||
    message.includes('GET /reviews')
  ) {
    return 'review-findings';
  }
  if (message.includes('liveness') || source.includes('heartbeat') || source.includes('liveness')) {
    return 'liveness';
  }
  return 'unknown-worker-nudge';
}

/**
 * @param {string} intentClass
 * @param {object} input
 */
export function deriveCycleKey(intentClass, input) {
  const klass = String(intentClass ?? '').trim().toLowerCase();
  const prNumber = Number(input.prNumber ?? 0);
  const headSha = normalizeHeadSha(input.headSha ?? input.eventHeadSha ?? '');
  const target = buildWorkerTarget(input);

  switch (klass) {
    case 'review-findings':
    case 'findings-delivery': {
      const runId = String(input.reviewRunId ?? input.runId ?? '').trim();
      if (!runId) {
        return '';
      }
      return `run:${runId}`;
    }
    case 'review-findings-redelivery': {
      const runId = String(input.reviewRunId ?? input.runId ?? '').trim();
      const attempt = Number(input.redeliveryAttempt ?? input.attempt ?? 0);
      if (!runId || !Number.isFinite(attempt) || attempt < 1) {
        return '';
      }
      return `redelivery:${runId}:${attempt}`;
    }
    case 'ci-green-handoff': {
      const transitionId = String(input.transitionId ?? '').trim();
      if (transitionId) {
        return `transition:${transitionId}`;
      }
      if (headSha) {
        return `transition:${prNumber}:${headSha}`;
      }
      return '';
    }
    case 'ci-failure': {
      const episodeKey = String(input.episodeKey ?? input.redPeriod ?? '').trim();
      if (episodeKey) {
        return `episode:${episodeKey}`;
      }
      if (headSha) {
        return `episode:${prNumber}:${headSha}`;
      }
      return '';
    }
    case 'task-continuation': {
      const generation = String(
        input.targetGeneration ?? input.taskGeneration ?? input.generation ?? '',
      ).trim();
      if (!generation) {
        return '';
      }
      return `task-gen:${generation}`;
    }
    case 'liveness':
    case 'unknown-worker-nudge':
      if (!headSha || !target.workerTarget) {
        return '';
      }
      return `head:${headSha}:${target.targetGeneration}`;
    default:
      return '';
  }
}

/**
 * @param {object} input
 */

/**
 * @param {object} input
 */
export function buildIssueTupleKey(input) {
  const intentClass = classifyIntent(input);
  if (intentClass !== 'task-continuation') {
    return { ok: false, reason: 'not_issue_keyed_intent', intentClass };
  }
  const projectId = String(input.projectId ?? 'orchestrator-pack').trim();
  const issueNumber = normalizeIssueNumber(input.issueNumber);
  const cycleKey = deriveCycleKey(intentClass, input);
  const target = buildWorkerTarget(input);
  if (!projectId || !issueNumber || !cycleKey || !intentClass || !target.workerTarget) {
    return {
      ok: false,
      reason: 'tuple_incomplete',
      intentClass,
      cycleKey,
      workerTarget: target.workerTarget,
      issueNumber,
      projectId,
    };
  }
  return {
    ok: true,
    projectId,
    issueNumber,
    intentClass,
    cycleKey,
    workerTarget: target.workerTarget,
    targetId: target.targetId,
    targetGeneration: target.targetGeneration,
    targetVerifiable: target.verifiable,
    issueKeyed: true,
    tupleKey: `${projectId}|${issueNumber}|${cycleKey}|${intentClass}|${target.workerTarget}`,
  };
}

export function buildTupleKey(input) {
  const intentClass = classifyIntent(input);
  if (intentClass === 'task-continuation') {
    return buildIssueTupleKey(input);
  }
  const cycleKey = deriveCycleKey(intentClass, input);
  const target = buildWorkerTarget(input);
  const prNumber = Number(input.prNumber ?? 0);
  if (!prNumber || !cycleKey || !intentClass || !target.workerTarget) {
    return {
      ok: false,
      reason: 'tuple_incomplete',
      intentClass,
      cycleKey,
      workerTarget: target.workerTarget,
    };
  }
  return {
    ok: true,
    prNumber,
    intentClass,
    cycleKey,
    workerTarget: target.workerTarget,
    targetId: target.targetId,
    targetGeneration: target.targetGeneration,
    targetVerifiable: target.verifiable,
    tupleKey: `${prNumber}|${cycleKey}|${intentClass}|${target.workerTarget}`,
  };
}

/**
 * @param {object} record
 */
export function remapLegacy332Record(record) {
  const transitionId = String(record?.transitionId ?? record?.sourceKey ?? '').trim();
  const sessionId = String(record?.sessionId ?? '').trim();
  const sentAtMs = Number(record?.sentAtMs ?? 0);
  const verifiable = Boolean(sessionId && (record?.targetGeneration || record?.sessionGeneration));
  if (!verifiable) {
    return { suppresses: false, reason: 'legacy_unverifiable', verifiable: false };
  }
  const targetGeneration = String(record?.targetGeneration ?? record?.sessionGeneration ?? sessionId);
  const intentClass = String(record?.intentClass ?? 'review-findings');
  const cycleKey = transitionId
    ? `transition:${transitionId.replace(/^ci-green:/, '')}`
    : deriveCycleKey(intentClass, record);
  return {
    suppresses: Boolean(cycleKey && sessionId),
    reason: 'legacy_verifiable',
    verifiable: true,
    intentClass,
    cycleKey,
    workerTarget: `${sessionId}:${targetGeneration}`,
    sentAtMs,
  };
}

/**
 * @param {object} input
 */
export function buildAuditRecord(input) {
  const required = [
    'logicalWorkerId',
    'sessionGeneration',
    'rawSessionId',
    'targetResolutionSource',
    'surface',
    'cycleKey',
    'intentClass',
    'storeId',
    'decision',
    'reason',
    'claimPhase',
    'sendTarget',
  ];
  /** @type {Record<string, unknown>} */
  const out = {
    kind: 'worker-nudge-gate',
    gateVersion: WORKER_NUDGE_GATE_VERSION,
    classifierVersion: CLASSIFIER_VERSION,
    atUtc: new Date().toISOString(),
    ...input,
  };
  for (const key of required) {
    if (out[key] === undefined || out[key] === null || out[key] === '') {
      out.auditIncomplete = true;
      out.missingAuditField = key;
      break;
    }
  }
  const hasPr = out.prNumber !== undefined && out.prNumber !== null && out.prNumber !== '';
  const hasIssue = out.issueNumber !== undefined && out.issueNumber !== null && out.issueNumber !== '';
  if (!hasPr && !hasIssue) {
    out.auditIncomplete = true;
    out.missingAuditField = 'prNumber|issueNumber';
  }
  return out;
}

/**
 * @param {object} input
 */
function resolveUnresolvedEscalationBounds(input) {
  const count = Math.max(
    1,
    Number(input.unresolvedEscalateCount ?? process.env.AO_NUDGE_GATE_UNRESOLVED_ESCALATE_COUNT) ||
      DEFAULT_UNRESOLVED_ESCALATE_COUNT,
  );
  const ms = Math.max(
    1,
    Number(input.unresolvedEscalateMs ?? process.env.AO_NUDGE_GATE_UNRESOLVED_ESCALATE_MS) ||
      DEFAULT_UNRESOLVED_ESCALATE_MS,
  );
  const reportStaleMs = Math.max(1, Number(input.reportStaleMs ?? 30 * 60 * 1000));
  return {
    count,
    ms: Math.min(ms, reportStaleMs),
    reportStaleMs,
  };
}

/**
 * @param {object} input
 */

function buildCiFailureEpisodeFromGateInput(input) {
  const prNumber = Number(input.prNumber ?? 0);
  const headSha = resolveCiFailureHeadShaFromGateInput(input);
  const targetId = String(input.targetId ?? input.sessionId ?? '').trim();
  const targetGeneration = String(input.targetGeneration ?? targetId).trim();
  const episodeKey = String(input.episodeKey ?? input.redPeriod ?? '').trim();
  const redPeriod = episodeKey.startsWith('episode:')
    ? episodeKey.slice('episode:'.length)
    : (episodeKey || (headSha ? `${prNumber}:${headSha}` : ''));
  const repo = String(input.repo ?? 'chetwerikoff/orchestrator-pack').trim();
  return {
    repo,
    prNumber,
    headSha,
    redPeriod,
    targetId,
    targetGeneration,
  };
}

function evaluateCiFailureNudgeSuppressor(input, tuple) {
  if (!input?.workerState) {
    return {
      suppress: true,
      reason: 'ci_failure_worker_state_unreadable',
      failClosed: true,
    };
  }
  const suppressorInput = {
    ...input,
    targetId: tuple.targetId ?? input.targetId,
    targetGeneration: tuple.targetGeneration ?? input.targetGeneration,
  };
  const headSha = resolveCiFailureHeadShaFromGateInput(suppressorInput);
  if (!VALID_HEAD_SHA.test(headSha)) {
    return {
      suppress: true,
      reason: 'ci_failure_head_sha_unresolvable',
      failClosed: true,
    };
  }
  let episode;
  try {
    episode = buildCiFailureEpisodeFromGateInput({ ...suppressorInput, headSha });
  } catch (error) {
    return {
      suppress: true,
      reason: 'ci_failure_episode_unreadable',
      failClosed: true,
      diagnosis: error instanceof Error ? error.message : String(error),
    };
  }
  let decision;
  try {
    decision = evaluateCiFailureSuppressorDecision({
      episode,
      workerState: input.workerState,
      surface: input.surface ?? input.source ?? 'unknown',
      storeDir: input.ciFailureStoreDir ?? input.storeDir ?? null,
      nowMs: input.nowMs,
      config: input.ciFailureConfig ?? input.config,
      headShaFirst: input.headShaFirst,
      headShaSecond: input.headShaSecond,
      versionMarkerFirst: input.versionMarkerFirst,
      versionMarkerSecond: input.versionMarkerSecond,
    });
  } catch (error) {
    return {
      suppress: true,
      reason: 'ci_failure_suppressor_unreadable',
      failClosed: true,
      diagnosis: error instanceof Error ? error.message : String(error),
    };
  }
  if (decision.decision === 'SUPPRESS') {
    return {
      suppress: true,
      reason: decision.reason,
      audit: decision.audit,
      stintClass: decision.stintClass,
      postStaleLock: decision.postStaleLock ?? false,
    };
  }
  return {
    suppress: false,
    reason: decision.reason,
    audit: decision.audit,
    stintClass: decision.stintClass,
  };
}

export function evaluateNudgeGate(input) {
  let gateInput = input;
  if (classifyIntent(input) === 'ci-failure') {
    const resolvedHeadSha = resolveCiFailureHeadShaFromGateInput(input);
    if (VALID_HEAD_SHA.test(resolvedHeadSha)) {
      gateInput = { ...input, headSha: resolvedHeadSha };
    }
  }
  const tuple = buildTupleKey(gateInput);
  if (!tuple.ok) {
    return {
      allow: false,
      decision: 'SUPPRESS',
      reason: tuple.reason,
      failClosed: true,
      audit: buildAuditRecord({
        prNumber: input.prNumber ?? null,
        issueNumber: input.issueNumber ?? null,
        projectId: input.projectId ?? null,
        logicalWorkerId: input.targetId ?? input.sessionId ?? null,
        sessionGeneration: input.targetGeneration ?? null,
        rawSessionId: input.sessionId ?? null,
        targetResolutionSource: input.targetResolutionSource ?? 'unresolved',
        surface: input.surface ?? input.source ?? 'unknown',
        cycleKey: tuple.cycleKey ?? null,
        intentClass: tuple.intentClass ?? 'unknown-worker-nudge',
        storeId: canonicalStoreId(input.storePath ?? ''),
        decision: 'SUPPRESS',
        reason: tuple.reason,
        claimPhase: 'none',
        sendTarget: input.sessionId ?? null,
      }),
    };
  }

  const storeId = canonicalStoreId(input.storePath ?? '');
  const claims = toArray(input.claims);
  const terminal = claims.find((row) => {
    if (String(row?.tupleKey ?? '') !== tuple.tupleKey) {
      return false;
    }
    const phase = String(row?.phase ?? row?.state ?? '');
    return phase === 'SENT' || phase === 'UNCERTAIN';
  });
  if (terminal) {
    const phase = String(terminal.phase ?? terminal.state ?? 'SENT');
    if (phase === 'SENT' || phase === 'UNCERTAIN') {
      if (isMateriallyNewServedContent(terminal, input)) {
        return {
          allow: false,
          decision: 'SUPPRESS',
          reason: 'materially_new_content',
          escalate: true,
          priorPhase: phase,
          diagnosis: `${OPERATOR_ESCALATION_PREFIX} tuple ${tuple.tupleKey} was already ${phase} but incoming message content differs; tuple remains suppressed.`,
          tuple,
          audit: buildAuditRecord({
            ...tupleAuditFields(tuple, input),
            logicalWorkerId: tuple.targetId,
            sessionGeneration: tuple.targetGeneration,
            rawSessionId: input.sessionId ?? tuple.targetId,
            targetResolutionSource: input.targetResolutionSource ?? 'session',
            surface: input.surface ?? input.source ?? 'unknown',
            cycleKey: tuple.cycleKey,
            intentClass: tuple.intentClass,
            storeId,
            decision: 'SUPPRESS',
            reason: 'materially_new_content',
            claimPhase: phase,
            sendTarget: input.sessionId ?? tuple.targetId,
            messageContentHash: hashNudgeMessageContent(input.message ?? ''),
            priorMessageContentHash: String(
              terminal.messageContentHash ?? terminal.contentHash ?? '',
            ).trim(),
          }),
        };
      }
      return suppress('already_served', tuple, input, storeId, phase);
    }
  }

  const active = claims.find(
    (row) =>
      String(row?.tupleKey ?? '') === tuple.tupleKey &&
      ACTIVE_CLAIM_PHASES.includes(String(row?.phase ?? row?.state ?? '')),
  );
  if (active && String(input.holderProcessGuid ?? '') !== String(active.holder?.processGuid ?? active.processGuid ?? '')) {
    return suppress('claimed', tuple, input, storeId, String(active.phase ?? active.state ?? 'CLAIMED'));
  }

  for (const legacy of toArray(input.legacyRecords)) {
    const mapped = remapLegacy332Record(legacy);
    if (!mapped.suppresses) {
      continue;
    }
    if (
      mapped.intentClass === tuple.intentClass &&
      mapped.cycleKey === tuple.cycleKey &&
      mapped.workerTarget === tuple.workerTarget
    ) {
      return suppress('legacy_record', tuple, input, storeId, 'SENT');
    }
  }

  const cycleState = input.cycleState ?? {};
  const repoId = String(cycleState.repoId ?? input.repoId ?? 'orchestrator-pack');
  const owner = tuple.issueKeyed
    ? null
    : getOwnerCycleRecord(cycleState, repoId, tuple.prNumber, tuple.targetId);
  if (!tuple.issueKeyed && tuple.intentClass === 'ci-green-handoff' && owner?.nudgeArmed) {
    return suppress('already_nudged_this_cycle', tuple, input, storeId, 'SENT');
  }

  const legacyNudged = input.legacyNudged ?? {};
  const bootstrapped = tuple.issueKeyed
    ? cycleState
    : bootstrapLegacyNudgedCycle(cycleState, legacyNudged, tuple.prNumber, tuple.targetId);
  const bootOwner = tuple.issueKeyed
    ? null
    : getOwnerCycleRecord(bootstrapped, repoId, tuple.prNumber, tuple.targetId);
  if (!tuple.issueKeyed && tuple.intentClass === 'ci-green-handoff' && bootOwner?.nudgeArmed && !owner?.nudgeArmed) {
    return suppress('legacy_nudged_cycle', tuple, input, storeId, 'SENT');
  }

  if (tuple.intentClass === 'ci-failure') {
    const ciSuppressor = evaluateCiFailureNudgeSuppressor(gateInput, tuple);
    if (ciSuppressor.suppress) {
      return {
        allow: false,
        decision: 'SUPPRESS',
        reason: ciSuppressor.reason,
        failClosed: Boolean(ciSuppressor.failClosed),
        stintClass: ciSuppressor.stintClass,
        postStaleLock: ciSuppressor.postStaleLock ?? false,
        tuple,
        audit: buildAuditRecord({
          ...tupleAuditFields(tuple, input),
          logicalWorkerId: tuple.targetId,
          sessionGeneration: tuple.targetGeneration,
          rawSessionId: input.sessionId ?? tuple.targetId,
          targetResolutionSource: input.targetResolutionSource ?? 'session',
          surface: input.surface ?? input.source ?? 'unknown',
          cycleKey: tuple.cycleKey,
          intentClass: tuple.intentClass,
          storeId,
          decision: 'SUPPRESS',
          reason: ciSuppressor.reason,
          claimPhase: 'none',
          sendTarget: input.sessionId ?? tuple.targetId,
          ciFailureFixingStint: ciSuppressor.audit ?? null,
        }),
      };
    }
  }

  if (input.stateUnreadable) {
    const bounds = resolveUnresolvedEscalationBounds(input);
    const unresolvedCount = Number(input.unresolvedCount ?? 0) + 1;
    const escalate =
      unresolvedCount >= bounds.count ||
      Number(input.unresolvedSinceMs ?? 0) + bounds.ms <= Number(input.nowMs ?? Date.now());
    return {
      allow: false,
      decision: 'SUPPRESS',
      reason: escalate ? 'unresolved_escalate' : 'unresolved_fail_closed',
      failClosed: true,
      escalate,
      unresolvedCount,
      audit: buildAuditRecord({
        ...tupleAuditFields(tuple, input),
        logicalWorkerId: tuple.targetId,
        sessionGeneration: tuple.targetGeneration,
        rawSessionId: input.sessionId ?? tuple.targetId,
        targetResolutionSource: input.targetResolutionSource ?? 'session',
        surface: input.surface ?? input.source ?? 'unknown',
        cycleKey: tuple.cycleKey,
        intentClass: tuple.intentClass,
        storeId,
        decision: 'SUPPRESS',
        reason: escalate ? 'unresolved_escalate' : 'unresolved_fail_closed',
        claimPhase: 'none',
        sendTarget: input.sessionId ?? tuple.targetId,
      }),
    };
  }

  return {
    allow: true,
    decision: 'SEND',
    reason: 'gate_allow',
    tuple,
    audit: buildAuditRecord({
      ...tupleAuditFields(tuple, input),
      logicalWorkerId: tuple.targetId,
      sessionGeneration: tuple.targetGeneration,
      rawSessionId: input.sessionId ?? tuple.targetId,
      targetResolutionSource: input.targetResolutionSource ?? 'session',
      surface: input.surface ?? input.source ?? 'unknown',
      cycleKey: tuple.cycleKey,
      intentClass: tuple.intentClass,
      storeId,
      decision: 'SEND',
      reason: 'gate_allow',
      claimPhase: 'CLAIMED',
      sendTarget: input.sessionId ?? tuple.targetId,
    }),
  };
}

/**
 * @param {string} reason
 * @param {object} tuple
 * @param {object} input
 * @param {string} storeId
 * @param {string} claimPhase
 */
function tupleAuditFields(tuple, input) {
  if (tuple.issueKeyed) {
    return {
      projectId: tuple.projectId,
      issueNumber: tuple.issueNumber,
      prNumber: input.prNumber ?? null,
    };
  }
  return {
    prNumber: tuple.prNumber,
    issueNumber: input.issueNumber ?? null,
    projectId: input.projectId ?? null,
  };
}

function suppress(reason, tuple, input, storeId, claimPhase) {
  return {
    allow: false,
    decision: 'SUPPRESS',
    reason,
    tuple,
    audit: buildAuditRecord({
      ...tupleAuditFields(tuple, input),
      logicalWorkerId: tuple.targetId,
      sessionGeneration: tuple.targetGeneration,
      rawSessionId: input.sessionId ?? tuple.targetId,
      targetResolutionSource: input.targetResolutionSource ?? 'session',
      surface: input.surface ?? input.source ?? 'unknown',
      cycleKey: tuple.cycleKey,
      intentClass: tuple.intentClass,
      storeId,
      decision: 'SUPPRESS',
      reason,
      claimPhase,
      sendTarget: input.sessionId ?? tuple.targetId,
    }),
  };
}

/**
 * @param {object} input
 */
export function acquireClaim(input) {
  const gate = evaluateNudgeGate(input);
  if (!gate.allow) {
    return {
      acquired: false,
      reason: gate.reason,
      decision: gate.decision,
      audit: gate.audit,
    };
  }
  const tuple = gate.tuple ?? buildTupleKey(input);
  const claimId = String(input.claimId ?? createHash('sha256').update(`${tuple.tupleKey}:${Date.now()}`).digest('hex').slice(0, 16));
  const leaseMs = Math.max(1, Number(input.claimLeaseMs ?? 120_000));
  const nowMs = Number(input.nowMs ?? Date.now());
  return {
    acquired: true,
    reason: 'acquired',
    claimId,
    phase: 'CLAIMED',
    tuple,
    claimLeaseExpiresAtMs: nowMs + leaseMs,
    audit: gate.audit,
  };
}

/**
 * @param {object} input
 */
export function finalizeClaim(input) {
  const phase = String(input.phase ?? input.outcome ?? '').trim().toUpperCase();
  if (!['SENT', 'FAILED_DEFINITIVE', 'UNCERTAIN', 'SEND_ATTEMPTED'].includes(phase)) {
    return { ok: false, reason: 'invalid_finalize_phase', phase };
  }
  if (phase === 'FAILED_DEFINITIVE') {
    return { ok: true, phase, retryable: true, reason: 'failed_definitive' };
  }
  if (phase === 'UNCERTAIN') {
    return { ok: true, phase, retryable: false, escalate: true, reason: 'uncertain_delivery' };
  }
  if (phase === 'SEND_ATTEMPTED') {
    return { ok: true, phase, retryable: false, reason: 'send_attempted' };
  }
  return { ok: true, phase: 'SENT', retryable: false, reason: 'sent' };
}

/**
 * @param {string} commandLine
 */
export function containsRawWorkerSendInvocation(commandLine) {
  return /\bao\s+send\b/i.test(String(commandLine ?? ''));
}

/**
 * @param {string} commandLine
 */
export function isGatedWorkerNudgeParentCommandLine(commandLine) {
  const line = String(commandLine ?? '');
  return /invoke-gated-worker-nudge\.ps1/i.test(line) || /journaled-worker-send\.ps1/i.test(line);
}

/**
 * @param {object} input
 */
export function evaluateBoundary(input) {
  if (!input.autonomousSurface) {
    return { allowed: true, reason: 'manual_surface' };
  }
  if (input.journaledTransportInternal) {
    return { allowed: true, reason: 'journaled_transport_internal' };
  }
  if (containsRawWorkerSendInvocation(input.commandLine) && !isGatedWorkerNudgeParentCommandLine(input.commandLine)) {
    return { allowed: false, reason: 'autonomous_raw_worker_send_denied' };
  }
  return { allowed: true, reason: 'not_raw_worker_send' };
}

/**
 * @param {string[]} commandLines
 */
export function findForbiddenAutonomousWorkerSendInvocations(commandLines) {
  return toArray(commandLines)
    .map((commandLine) => ({
      commandLine,
      verdict: evaluateBoundary({ commandLine, autonomousSurface: true, journaledTransportInternal: false }),
    }))
    .filter((entry) => !entry.verdict.allowed);
}

/**
 * @param {object} input
 */
export function evaluatePreflight(input) {
  return evaluateAutonomousGatePreflight(input, {
    expectedGateVersion: WORKER_NUDGE_GATE_VERSION,
    atomicClaimCapability: ATOMIC_WORKER_NUDGE_CLAIM_CAPABILITY,
    rawCapabilityId: 'ao-worker-send-raw',
    rawNotUnavailableReason: 'raw_worker_send_not_unavailable',
  });
}

/**
 * @param {string} [inventoryPath]
 */
export function loadAutonomousWorkerNudgeCapabilities(inventoryPath) {
  return loadMergedAutonomousCapabilitiesInventory(inventoryPath, 'docs/autonomous-worker-nudge-capabilities.json');
}

/**
 * @param {object} input
 */
/**
 * @param {object} input
 */
export function evaluateAdoptionGate(input) {
  const gatedCommandPresent = Boolean(input.gatedCommandPresent);
  const rawDenied = Boolean(input.rawWorkerSendDenied);
  const ok = gatedCommandPresent && rawDenied;
  return {
    ok,
    nudgeSurfaceEnabled: ok,
    degraded: !ok,
    gatedCommandPresent,
    rawWorkerSendDenied: rawDenied,
    errors: ok
      ? []
      : [
          ...(gatedCommandPresent ? [] : ['orchestratorRules missing invoke-gated-worker-nudge.ps1']),
          ...(rawDenied ? [] : ['raw ao send not denied at process boundary']),
        ],
  };
}

runStdinJsonCli('worker-nudge-gate.mjs', {
  evaluateClaimStoreFailure: () => evaluateClaimStoreFailure(readStdinJson()),
  evaluateNudgeGate: () => evaluateNudgeGate(readStdinJson()),
  acquireClaim: () => acquireClaim(readStdinJson()),
  finalizeClaim: () => finalizeClaim(readStdinJson()),
  evaluateBoundary: () => evaluateBoundary(readStdinJson()),
  evaluatePreflight: () => evaluatePreflight(readStdinJson()),
  evaluateAdoption: () => evaluateAdoptionGate(readStdinJson()),
  classifyIntent: () => {
    const input = readStdinJson();
    return { intentClass: classifyIntent(input) };
  },
  deriveCycleKey: () => {
    const input = readStdinJson();
    const intentClass = classifyIntent(input);
    return { intentClass, cycleKey: deriveCycleKey(intentClass, input) };
  },
  canonicalizeStorePath: () => {
    const input = readStdinJson();
    const storePath = String(input.storePath ?? '');
    return {
      canonicalPath: canonicalizeStorePath(storePath),
      storeId: canonicalStoreId(storePath),
    };
  },
  remapLegacy332: () => remapLegacy332Record(readStdinJson()),
  syncPrOwnershipClaim: () => syncPrOwnershipClaimRecord(readStdinJson()),
  resolveWorkerTarget: () => resolveWorkerTargetFromPrClaim(readStdinJson()),
  resolvePrOwnerSession: () => resolvePrOwnerSessionForNudge(readStdinJson()),
  resolveIssueOwnerSession: () => resolveIssueOwnerSessionForNudge(readStdinJson()),
  syncIssueOwnershipClaim: () => syncIssueOwnershipClaimRecord(readStdinJson()),
  resolveIssueWorkerTarget: () => resolveWorkerTargetFromIssueClaim(readStdinJson()),
  hashMessageContent: () => {
    const input = readStdinJson();
    const messageContentHash = hashNudgeMessageContent(input.message ?? '');
    return { messageContentHash };
  },
  inferResumeLineage: () => inferResumeLineageFromOwnershipChange(readStdinJson()),
});
