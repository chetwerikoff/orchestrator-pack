/**
 * ready_for_review hand-off wake admission (Issue #381).
 * Vitest: scripts/review-handoff-wake-trigger.test.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { readStdinJson, runStdinJsonCli } from './review-mechanical-cli.mjs';
import { resolveCurrentPrHeadSha } from './review-head-ready.mjs';
import { findSessionById, normalizeSha, toArray } from './review-trigger-reconcile.mjs';
import {
  getNotificationData,
  isRecord,
  nonEmptyString,
} from './orchestrator-wake-filter.mjs';

export const HANDOFF_WAKE_KIND = 'ready_for_review';
export const REVIEW_PENDING_HANDOFF_SEMANTIC_TYPE = 'review.pending';
export const REVIEW_PENDING_HANDOFF_EVENT_TYPE = 'review.pending';
export const HANDOFF_RECEIPT_TO_RUN_MAX_MS = 30_000;
export const HANDOFF_LISTENER_RECOVERY_MAX_MS = 30_000;
export const HANDOFF_REPLAY_BATCH_SIZE_MAX = 10;
export const HANDOFF_LOOKUP_RETRY_MAX_IDENTICAL = 3;
export const HANDOFF_LOOKUP_RETRY_MIN_SPACING_MS = 10_000;

export const HANDOFF_AUDIT_PREFIX = 'review-handoff-wake';

/** @typedef {'openPr' | 'session' | 'supervisedRepo'} HandoffLookupDimension */

/**
 * @param {object} audit
 * @param {HandoffLookupDimension} lookupDimension
 */
function admissionLookupUnknownResult(audit, lookupDimension) {
  return {
    admitted: false,
    outcome: 'unknown',
    reason: 'admission_lookup_unknown',
    retryable: true,
    lookupDimension,
    audit: {
      ...audit,
      outcome: 'unknown',
      reason: 'admission_lookup_unknown',
      lookupDimension,
    },
  };
}

const NOTIFICATION_ENVELOPE_TYPES = new Set(['notification', 'notification_with_actions']);

/**
 * @param {Record<string, unknown>} data
 */
function hasHandoffSubjectIdentity(data) {
  const subject = data.subject;
  if (!isRecord(subject)) {
    return false;
  }
  const session = subject.session;
  const pr = subject.pr;
  if (!isRecord(session) || !nonEmptyString(session.id)) {
    return false;
  }
  if (!isRecord(pr)) {
    return false;
  }
  const prNumber = typeof pr.number === 'number' ? pr.number : undefined;
  const prUrl = nonEmptyString(pr.url);
  if (!prNumber && !prUrl) {
    return false;
  }
  return true;
}

/**
 * @param {unknown} body
 * @param {Record<string, unknown>} event
 */
function isSessionWorkingReadyForReviewHandoffEnvelope(body, event) {
  if (nonEmptyString(event.type) !== 'session.working') {
    return false;
  }
  const data = getNotificationData(event);
  if (!data || nonEmptyString(data.semanticType) !== HANDOFF_WAKE_KIND) {
    return false;
  }
  return hasHandoffSubjectIdentity(data);
}

/**
 * Live AO 0.9.2 wire: review.pending at info with schemaVersion 3 (Issue #390).
 * @param {unknown} body
 * @param {Record<string, unknown>} event
 */
export function isQualifiedReviewPendingInfoHandoffEnvelope(body, event) {
  if (nonEmptyString(event.type) !== REVIEW_PENDING_HANDOFF_EVENT_TYPE) {
    return false;
  }
  if (nonEmptyString(event.priority) !== 'info') {
    return false;
  }
  const data = getNotificationData(event);
  if (!data || data.schemaVersion !== 3) {
    return false;
  }
  if (nonEmptyString(data.semanticType) !== REVIEW_PENDING_HANDOFF_SEMANTIC_TYPE) {
    return false;
  }
  return hasHandoffSubjectIdentity(data);
}

/**
 * @param {unknown} body
 * @param {Record<string, unknown>} [event]
 */
export function isReadyForReviewHandoffEnvelope(body, event = isRecord(body) ? body.event : undefined) {
  if (!isRecord(body) || !isRecord(event)) {
    return false;
  }
  const envelopeType = nonEmptyString(body.type);
  if (!envelopeType || !NOTIFICATION_ENVELOPE_TYPES.has(envelopeType)) {
    return false;
  }
  return (
    isSessionWorkingReadyForReviewHandoffEnvelope(body, event) ||
    isQualifiedReviewPendingInfoHandoffEnvelope(body, event)
  );
}

/**
 * @param {Record<string, unknown>} event
 */
export function parseHandoffNotificationSubject(event) {
  const data = getNotificationData(event);
  const subject = isRecord(data?.subject) ? data.subject : {};
  const session = isRecord(subject.session) ? subject.session : {};
  const pr = isRecord(subject.pr) ? subject.pr : {};
  const prUrl = nonEmptyString(pr.url);
  const prNumber =
    typeof pr.number === 'number' ? pr.number : parsePrNumberFromPrUrl(prUrl);
  const subjectSessionId = nonEmptyString(session.id);
  const envelopeSessionId = nonEmptyString(event.sessionId);
  return {
    sessionId: subjectSessionId ?? envelopeSessionId,
    subjectSessionId,
    envelopeSessionId,
    projectId: nonEmptyString(event.projectId) ?? nonEmptyString(session.projectId),
    prNumber,
    prUrl,
    priority: nonEmptyString(event.priority),
    receivedAtMs: Number(event.receivedAtMs) || undefined,
  };
}

/**
 * @param {string | undefined} prUrl
 */
export function normalizeRepoSlugFromPrUrl(prUrl) {
  const raw = nonEmptyString(prUrl);
  if (!raw) return undefined;
  const match = raw.match(/github\.com\/([^/]+\/[^/]+)\/pull\/\d+/i);
  return match ? match[1].toLowerCase() : undefined;
}

/**
 * @param {string | undefined} prUrl
 */
/**
 * @param {string | undefined} remoteUrl
 */
export function parseSupervisedRepoSlugFromGitRemote(remoteUrl) {
  const raw = nonEmptyString(remoteUrl);
  if (!raw) return undefined;
  const match = raw.match(/github\.com[:/]([^/\s#?]+)\/([^/\s#?]+)/i);
  if (!match) return undefined;
  let repo = match[2];
  if (repo.toLowerCase().endsWith('.git')) {
    repo = repo.slice(0, -4);
  }
  return `${match[1]}/${repo}`.toLowerCase();
}

export function parsePrNumberFromPrUrl(prUrl) {
  const raw = nonEmptyString(prUrl);
  if (!raw) return undefined;
  const match = raw.match(/\/pull\/(\d+)/i);
  if (!match) return undefined;
  const prNumber = Number(match[1]);
  return Number.isFinite(prNumber) && prNumber > 0 ? prNumber : undefined;
}


/**
 * @param {object} input
 * @param {Record<string, unknown>} input.event
 * @param {string} [input.supervisedProjectId]
 * @param {string} [input.supervisedRepoSlug]
 * @param {import('./review-trigger-reconcile.mjs').AoSession[]} [input.supervisedSessions]
 * @param {boolean} [input.sessionLookupFailed]
 * @param {boolean} [input.supervisedRepoLookupFailed]
 * @param {import('./review-trigger-reconcile.mjs').OpenPr[]} [input.openPrs]
 * @param {boolean} [input.openPrLookupFailed]
 */
export function evaluateHandoffIdentityAdmission(input) {
  const event = input.event ?? {};
  const subject = parseHandoffNotificationSubject(event);
  const audit = {
    prefix: HANDOFF_AUDIT_PREFIX,
    outcome: 'filter_reject',
    wakeKind: HANDOFF_WAKE_KIND,
    priority: subject.priority,
    sessionId: subject.sessionId,
    prNumber: subject.prNumber,
    prUrl: subject.prUrl,
  };

  if (!isReadyForReviewHandoffEnvelope({ type: 'notification', event }, event)) {
    return {
      admitted: false,
      outcome: 'filter_reject',
      reason: 'envelope_mismatch',
      audit: { ...audit, outcome: 'filter_reject', reason: 'envelope_mismatch' },
    };
  }

  const subjectSessionId = nonEmptyString(subject.subjectSessionId);
  const envelopeSessionId = nonEmptyString(subject.envelopeSessionId);
  if (subjectSessionId && envelopeSessionId && subjectSessionId !== envelopeSessionId) {
    return {
      admitted: false,
      outcome: 'filter_reject',
      reason: 'session_identity_mismatch',
      audit: {
        ...audit,
        outcome: 'filter_reject',
        reason: 'session_identity_mismatch',
        sessionId: subjectSessionId,
      },
    };
  }
  if (!subjectSessionId) {
    return {
      admitted: false,
      outcome: 'filter_reject',
      reason: 'missing_session_identity',
      audit: { ...audit, outcome: 'filter_reject', reason: 'missing_session_identity' },
    };
  }

  const supervisedProject = nonEmptyString(input.supervisedProjectId);
  if (supervisedProject && !nonEmptyString(subject.projectId)) {
    return {
      admitted: false,
      outcome: 'filter_reject',
      reason: 'missing_project_identity',
      audit: { ...audit, outcome: 'filter_reject', reason: 'missing_project_identity' },
    };
  }
  if (supervisedProject && supervisedProject !== subject.projectId) {
    return {
      admitted: false,
      outcome: 'filter_reject',
      reason: 'foreign_project',
      audit: { ...audit, outcome: 'filter_reject', reason: 'foreign_project' },
    };
  }

  if (supervisedProject && Boolean(input.supervisedRepoLookupFailed)) {
    return admissionLookupUnknownResult(audit, 'supervisedRepo');
  }

  const supervisedRepo = nonEmptyString(input.supervisedRepoSlug)?.toLowerCase();
  const notificationRepo = normalizeRepoSlugFromPrUrl(subject.prUrl);
  if (supervisedRepo && !notificationRepo) {
    return {
      admitted: false,
      outcome: 'filter_reject',
      reason: 'missing_repository_identity',
      audit: { ...audit, outcome: 'filter_reject', reason: 'missing_repository_identity' },
    };
  }
  if (supervisedRepo && notificationRepo && supervisedRepo !== notificationRepo) {
    return {
      admitted: false,
      outcome: 'filter_reject',
      reason: 'foreign_repository',
      audit: { ...audit, outcome: 'filter_reject', reason: 'foreign_repository' },
    };
  }

  const sessionMembershipRequired =
    input.supervisedSessions !== undefined || Boolean(input.sessionLookupFailed);
  if (sessionMembershipRequired) {
    if (Boolean(input.sessionLookupFailed)) {
      return admissionLookupUnknownResult(audit, 'session');
    }
    const supervisedSessions = toArray(input.supervisedSessions);
    const matchedSession = findSessionById(supervisedSessions, subjectSessionId);
    if (!matchedSession) {
      return {
        admitted: false,
        outcome: 'filter_reject',
        reason: 'foreign_session',
        audit: { ...audit, outcome: 'filter_reject', reason: 'foreign_session' },
      };
    }
  }

  if (Boolean(input.openPrLookupFailed)) {
    return admissionLookupUnknownResult(audit, 'openPr');
  }

  const openPrs = toArray(input.openPrs);
  if (openPrs.length === 0) {
    return {
      admitted: false,
      outcome: 'filter_reject',
      reason: 'no_open_pr',
      audit: { ...audit, outcome: 'filter_reject', reason: 'no_open_pr' },
    };
  }

  const prNumber = Number(subject.prNumber);
  const open = openPrs.find((pr) => Number(pr?.number) === prNumber);
  if (!open) {
    return {
      admitted: false,
      outcome: 'filter_reject',
      reason: 'no_open_pr',
      audit: { ...audit, outcome: 'filter_reject', reason: 'no_open_pr' },
    };
  }
  const baseRefName = nonEmptyString(open.baseRefName) ?? nonEmptyString(open.baseRef);
  if (!baseRefName) {
    return {
      admitted: false,
      outcome: 'filter_reject',
      reason: 'missing_base_ref',
      audit: { ...audit, outcome: 'filter_reject', reason: 'missing_base_ref' },
    };
  }
  return {
    admitted: true,
    outcome: 'promoted',
    reason: 'handoff_promoted',
    subject,
    admittedBaseRef: baseRefName,
    admittedHeadSha: normalizeSha(String(open.headRefOid ?? '')),
    audit: {
      ...audit,
      outcome: 'promoted',
      reason: 'handoff_promoted',
      admittedBaseRef: baseRefName,
    },
  };
}

/**
 * @param {object} audit
 */
export function formatHandoffWakeAuditLine(audit) {
  const parts = [
    `${HANDOFF_AUDIT_PREFIX}:`,
    `outcome=${String(audit?.outcome ?? 'unknown')}`,
    `reason=${String(audit?.reason ?? 'unspecified')}`,
  ];
  if (audit?.wakeKind) parts.push(`wakeKind=${audit.wakeKind}`);
  if (audit?.priority) parts.push(`priority=${audit.priority}`);
  if (audit?.sessionId) parts.push(`session=${audit.sessionId}`);
  if (audit?.prNumber != null) parts.push(`pr=#${audit.prNumber}`);
  if (audit?.lookupDimension) parts.push(`lookupDimension=${audit.lookupDimension}`);
  if (audit?.claimOutcome) parts.push(`claim=${audit.claimOutcome}`);
  return parts.join(' ');
}

/**
 * @param {object} input
 * @param {{ prNumber: number, headSha: string, sessionId: string, admittedBaseRef?: string }} input.planned
 * @param {object} input.fresh
 */
export function evaluateHandoffPreClaimRecheck(input) {
  const planned = input.planned ?? {};
  const fresh = input.fresh ?? {};
  const prNumber = Number(planned.prNumber);
  const plannedHead = normalizeSha(String(planned.headSha ?? ''));
  const currentHead = normalizeSha(resolveCurrentPrHeadSha(fresh.openPrs, prNumber));
  const openPr = toArray(fresh.openPrs).find((pr) => Number(pr?.number) === prNumber);

  if (!openPr) {
    return {
      emitReviewRun: false,
      reason: 'pre_claim_toctou_pr_closed',
      audit: { outcome: 'toctou_reject', reason: 'pre_claim_toctou_pr_closed' },
    };
  }

  const admittedBase = nonEmptyString(planned.admittedBaseRef);
  if (!admittedBase) {
    return {
      emitReviewRun: false,
      reason: 'missing_admitted_base_ref',
      audit: { outcome: 'toctou_reject', reason: 'missing_admitted_base_ref' },
    };
  }
  const currentBase =
    nonEmptyString(openPr.baseRefName) ?? nonEmptyString(openPr.baseRef) ?? nonEmptyString(fresh.baseRefName);
  if (!currentBase) {
    return {
      emitReviewRun: false,
      reason: 'missing_current_base_ref',
      audit: { outcome: 'toctou_reject', reason: 'missing_current_base_ref' },
    };
  }
  if (admittedBase !== currentBase) {
    return {
      emitReviewRun: false,
      reason: 'pre_claim_toctou_base_retargeted',
      audit: { outcome: 'toctou_reject', reason: 'pre_claim_toctou_base_retargeted' },
    };
  }

  if (!plannedHead || !currentHead || plannedHead !== currentHead) {
    return {
      emitReviewRun: false,
      reason: 'pre_claim_toctou_head_advanced',
      audit: { outcome: 'toctou_reject', reason: 'pre_claim_toctou_head_advanced' },
    };
  }

  return {
    emitReviewRun: true,
    reason: 'handoff_pre_claim_ok',
    audit: { outcome: 'pre_claim_ok', reason: 'handoff_pre_claim_ok' },
  };
}

const TERMINAL_HANDOFF_ADMISSION_OUTCOMES = new Set([
  'claim_win',
  'toctou_reject',
]);

const TERMINAL_HANDOFF_ADMISSION_REASONS = new Set([
  'pre_claim_toctou_pr_closed',
  'pre_claim_toctou_base_retargeted',
  'pre_claim_toctou_head_advanced',
  'handoff_receipt_bound_exceeded',
]);

/**
 * @param {Record<string, unknown> | null | undefined} record
 */
export function isTerminalHandoffAdmissionRecord(record) {
  if (!record || typeof record !== 'object') {
    return false;
  }
  const outcome = String(record.outcome ?? '').trim().toLowerCase();
  if (!outcome || outcome === 'promoted') {
    return false;
  }
  if (TERMINAL_HANDOFF_ADMISSION_OUTCOMES.has(outcome)) {
    return true;
  }
  if (record.terminal === true) {
    return true;
  }
  const reason = String(record.reason ?? record.deferReason ?? '').trim();
  return TERMINAL_HANDOFF_ADMISSION_REASONS.has(reason);
}

export function handoffAdmissionKey({ projectId, repoSlug, prNumber, headSha }) {
  return [projectId ?? '', repoSlug ?? '', String(prNumber ?? ''), normalizeSha(headSha)].join('|');
}

export function handoffPrSubjectKey({ projectId, repoSlug, prNumber }) {
  const normalizedRepo = nonEmptyString(repoSlug)?.toLowerCase() ?? '';
  const normalizedProject = nonEmptyString(projectId) ?? '';
  return [normalizedProject, normalizedRepo, String(prNumber ?? '')].join('|');
}

export function deriveHandoffAdmissionId(input) {
  const eventId = nonEmptyString(input.eventId);
  if (eventId) {
    return eventId;
  }
  const sessionId = nonEmptyString(input.sessionId) ?? '';
  const prNumber = String(input.prNumber ?? '');
  const headSha = normalizeSha(String(input.headSha ?? ''));
  if (!sessionId || !prNumber || !headSha) {
    return '';
  }
  return [sessionId, prNumber, headSha].join('|');
}

export function findOpenPrForHandoffRecord(record, openPrs) {
  const prNumber = Number(record?.prNumber);
  if (!Number.isFinite(prNumber) || prNumber <= 0) {
    return undefined;
  }
  const recordRepo = nonEmptyString(record?.repoSlug)?.toLowerCase();
  return toArray(openPrs).find((pr) => {
    if (Number(pr?.number) !== prNumber) {
      return false;
    }
    if (!recordRepo) {
      return true;
    }
    const prRepo = nonEmptyString(pr?.repoSlug)?.toLowerCase()
      ?? normalizeRepoSlugFromPrUrl(nonEmptyString(pr?.url));
    return !prRepo || prRepo === recordRepo;
  });
}

export function isHandoffReceiptBoundTerminalForEviction(record, nowMs = Date.now()) {
  if (!record || typeof record !== 'object') {
    return false;
  }
  const reason = String(record.reason ?? record.deferReason ?? '').trim();
  const outcome = String(record.outcome ?? '').trim().toLowerCase();
  if (reason !== 'handoff_receipt_bound_exceeded' && outcome !== 'handoff_receipt_bound_exceeded') {
    return false;
  }
  const receivedAtMs = Number(record.receivedAtMs);
  if (!Number.isFinite(receivedAtMs)) {
    return false;
  }
  return nowMs - receivedAtMs > HANDOFF_RECEIPT_TO_RUN_MAX_MS;
}

export function isHandoffRecordAgedOut(record, nowMs = Date.now()) {
  const receivedAtMs = Number(record?.receivedAtMs);
  if (!Number.isFinite(receivedAtMs)) {
    return false;
  }
  return nowMs - receivedAtMs > HANDOFF_RECEIPT_TO_RUN_MAX_MS;
}

function reclassifyHandoffReceiptBoundTerminal(record, nowMs) {
  const reason = String(record.reason ?? record.deferReason ?? '').trim();
  const outcome = String(record.outcome ?? '').trim().toLowerCase();
  if (reason !== 'handoff_receipt_bound_exceeded' && outcome !== 'handoff_receipt_bound_exceeded') {
    return record;
  }
  if (isHandoffReceiptBoundTerminalForEviction(record, nowMs)) {
    return { ...record, outcome: 'handoff_receipt_bound_exceeded', reason: 'handoff_receipt_bound_exceeded', terminal: true };
  }
  return { ...record, outcome: 'promoted', reason: '', terminal: false };
}

export function classifyHandoffRecordEviction(input) {
  const record = isRecord(input.record) ? input.record : {};
  const nowMs = Number(input.nowMs ?? Date.now());
  const openPrs = toArray(input.openPrs);
  const openPrIndexTrusted = input.openPrIndexTrusted === true;
  const reclassified = reclassifyHandoffReceiptBoundTerminal(record, nowMs);

  if (isTerminalHandoffAdmissionRecord(reclassified)) {
    return { evict: true, reason: 'terminal_outcome', record: reclassified };
  }
  if (isHandoffRecordAgedOut(reclassified, nowMs)) {
    return {
      evict: true,
      reason: 'receipt_age_cap',
      record: {
        ...reclassified,
        outcome: 'handoff_receipt_bound_exceeded',
        reason: 'handoff_receipt_bound_exceeded',
        terminal: true,
      },
    };
  }
  if (openPrIndexTrusted) {
    const open = findOpenPrForHandoffRecord(reclassified, openPrs);
    if (!open) {
      return { evict: true, reason: 'closed_merged_absent_from_index', record: reclassified };
    }
  }
  return { evict: false, reason: '', record: reclassified };
}

export function pruneHandoffAdmissionRecords(input) {
  const records = isRecord(input.records) ? { ...input.records } : {};
  const existing = isRecord(input.existing) ? { ...input.existing } : {};
  const actedOn = isRecord(input.actedOn) ? { ...input.actedOn } : {};
  const nowMs = Number(input.nowMs ?? Date.now());
  const openPrs = toArray(input.openPrs);
  const openPrIndexTrusted = input.openPrIndexTrusted === true;
  const evicted = [];

  for (const [key, raw] of Object.entries(records)) {
    if (!isRecord(raw)) {
      delete records[key];
      continue;
    }
    const decision = classifyHandoffRecordEviction({
      record: raw,
      nowMs,
      openPrs,
      openPrIndexTrusted,
    });
    if (decision.evict) {
      evicted.push({
        key,
        admissionId: nonEmptyString(decision.record.admissionId),
        prNumber: decision.record.prNumber,
        headSha: decision.record.headSha,
        reason: decision.reason,
        record: decision.record,
      });
      delete records[key];
      const admissionId = nonEmptyString(decision.record.admissionId);
      if (admissionId) {
        actedOn[admissionId] = {
          admissionId,
          outcome: String(decision.record.outcome ?? 'evicted'),
          reason: decision.reason,
          actedAtMs: nowMs,
          prNumber: decision.record.prNumber,
          headSha: decision.record.headSha,
        };
      }
    }
    else if (decision.record !== raw) {
      records[key] = decision.record;
    }
  }

  return { records, actedOn, evicted };
}

export function supersedeHandoffAdmissionRecords(input) {
  const records = isRecord(input.records) ? { ...input.records } : {};
  let actedOn = isRecord(input.actedOn) ? { ...input.actedOn } : {};
  const openPrs = toArray(input.openPrs);
  const openPrIndexTrusted = input.openPrIndexTrusted === true;
  const nowMs = Number(input.nowMs ?? Date.now());
  const superseded = [];
  const bySubject = new Map();

  for (const [key, raw] of Object.entries(records)) {
    if (!isRecord(raw)) continue;
    const subjectKey = handoffPrSubjectKey(raw);
    const list = bySubject.get(subjectKey) ?? [];
    list.push({ key, record: raw });
    bySubject.set(subjectKey, list);
  }

  for (const [, entries] of bySubject) {
    if (entries.length <= 1) continue;
    let winner = entries[0];
    for (const entry of entries.slice(1)) {
      const winnerReceived = Number(winner.record.receivedAtMs ?? 0);
      const entryReceived = Number(entry.record.receivedAtMs ?? 0);
      let pickEntry = entryReceived > winnerReceived;
      if (openPrIndexTrusted && entryReceived === winnerReceived) {
        const open = findOpenPrForHandoffRecord(entry.record, openPrs);
        const openHead = normalizeSha(String(open?.headRefOid ?? ''));
        if (openHead && openHead === normalizeSha(String(entry.record.headSha ?? ''))) {
          pickEntry = true;
        }
      }
      if (pickEntry) {
        winner = entry;
      }
    }
    for (const entry of entries) {
      if (entry.key === winner.key) continue;
      const admissionId = nonEmptyString(entry.record.admissionId);
      superseded.push({
        key: entry.key,
        admissionId,
        prNumber: entry.record.prNumber,
        headSha: entry.record.headSha,
        reason: 'superseded_by_newer_head',
        record: entry.record,
      });
      if (admissionId) {
        const tombstone = recordHandoffActedOnIdentity({
          actedOn,
          admissionId,
          outcome: 'superseded',
          reason: 'superseded_by_newer_head',
          nowMs,
          prNumber: entry.record.prNumber,
        });
        actedOn = tombstone.actedOn;
      }
      delete records[entry.key];
    }
  }

  return { records, superseded, actedOn, nowMs };
}

export function isHandoffAdmissionIdActedOn(input) {
  const admissionId = nonEmptyString(input.admissionId);
  if (!admissionId) {
    return { actedOn: false, reason: 'missing_admission_id' };
  }
  const existing = isRecord(input.existing) ? { ...input.existing } : {};
  const actedOn = isRecord(input.actedOn) ? input.actedOn : {};
  if (actedOn[admissionId]) {
    return { actedOn: true, reason: 'already_acted_on', entry: actedOn[admissionId] };
  }
  return { actedOn: false, reason: '' };
}

export function recordHandoffActedOnIdentity(input) {
  const admissionId = nonEmptyString(input.admissionId);
  if (!admissionId) {
    return { recorded: false, reason: 'missing_admission_id', actedOn: isRecord(input.actedOn) ? input.actedOn : {} };
  }
  const existing = isRecord(input.existing) ? { ...input.existing } : {};
  const actedOn = isRecord(input.actedOn) ? { ...input.actedOn } : {};
  const nowMs = Number(input.nowMs ?? Date.now());
  actedOn[admissionId] = {
    admissionId,
    outcome: nonEmptyString(input.outcome) ?? 'acted_on',
    reason: nonEmptyString(input.reason) ?? '',
    actedAtMs: nowMs,
    prNumber: input.prNumber,
    headSha: input.headSha,
  };
  return { recorded: true, admissionId, actedOn };
}

export function clearHandoffAdmissionRecord(input) {
  const key = nonEmptyString(input.key);
  const records = isRecord(input.existing) ? { ...input.existing } : {};
  const prior = key ? records[key] : undefined;
  if (!key || !isRecord(prior)) {
    return { cleared: false, reason: 'missing_record', records, actedOn: isRecord(input.actedOn) ? input.actedOn : {} };
  }
  delete records[key];
  const admissionId = nonEmptyString(prior.admissionId);
  let actedOn = isRecord(input.actedOn) ? { ...input.actedOn } : {};
  if (admissionId) {
    const tombstone = recordHandoffActedOnIdentity({
      actedOn,
      admissionId,
      outcome: nonEmptyString(input.outcome) ?? 'delete_on_durable_trigger',
      reason: nonEmptyString(input.reason) ?? 'delete_on_durable_trigger',
      nowMs: input.nowMs,
      prNumber: prior.prNumber,
      headSha: prior.headSha,
    });
    actedOn = tombstone.actedOn;
  }
  return { cleared: true, key, record: prior, records, actedOn };
}

export function updateHandoffAdmissionRecordOutcome(input) {
  const key = nonEmptyString(input.key);
  const records = isRecord(input.existing) ? { ...input.existing } : {};
  const prior = key ? records[key] : undefined;
  if (!key || !isRecord(prior)) {
    return { updated: false, reason: 'missing_record', records };
  }
  const record = {
    ...prior,
    outcome: nonEmptyString(input.outcome) ?? prior.outcome,
    reason: nonEmptyString(input.reason) ?? prior.reason,
    updatedAtMs: Number(input.nowMs ?? Date.now()),
    durableTriggerPersisted: input.durableTriggerPersisted === true ? true : prior.durableTriggerPersisted,
  };
  records[key] = record;
  return { updated: true, key, record, records };
}

export function formatHandoffRecordTransitionLine(audit) {
  const parts = [
    `${HANDOFF_AUDIT_PREFIX}:`,
    `transition=${String(audit?.transition ?? 'record')}`,
    `reason=${String(audit?.reason ?? 'unspecified')}`,
  ];
  if (audit?.key) parts.push(`key=${audit.key}`);
  if (audit?.admissionId) parts.push(`admissionId=${audit.admissionId}`);
  if (audit?.prNumber != null) parts.push(`pr=#${audit.prNumber}`);
  if (audit?.headSha) parts.push(`head=${audit.headSha}`);
  return parts.join(' ');
}

function findActiveHandoffRecordForSubject(records, subjectKey) {
  for (const record of Object.values(records)) {
    if (!isRecord(record)) continue;
    if (handoffPrSubjectKey(record) === subjectKey) {
      return record;
    }
  }
  return undefined;
}

export function seedHandoffAdmissionRecord(input) {
  const admission = input.admission ?? {};
  const subject = admission.subject ?? {};
  const prNumber = Number(subject.prNumber);
  const headSha = normalizeSha(String(admission.admittedHeadSha ?? ''));
  const admittedBaseRef = nonEmptyString(admission.admittedBaseRef);
  if (!prNumber || !headSha) {
    return { seeded: false, reason: 'missing_pr_or_head' };
  }
  if (!admittedBaseRef) {
    return { seeded: false, reason: 'missing_admitted_base_ref' };
  }
  const receivedAtMs = Number(subject.receivedAtMs ?? input.nowMs ?? Date.now());
  const admissionId = deriveHandoffAdmissionId({
    eventId: subject.eventId ?? admission.eventId,
    sessionId: subject.sessionId,
    prNumber,
    receivedAtMs,
    headSha,
  });
  if (!admissionId) {
    return { seeded: false, reason: 'missing_admission_id' };
  }
  const existing = isRecord(input.existing) ? { ...input.existing } : {};
  const actedOn = isRecord(input.actedOn) ? input.actedOn : {};
  const acted = isHandoffAdmissionIdActedOn({ admissionId, actedOn });
  if (acted.actedOn) {
    return { seeded: false, reason: 'already_acted_on', noop: true, admissionId, records: existing };
  }

  const repoSlug = normalizeRepoSlugFromPrUrl(subject.prUrl);
  const subjectKey = handoffPrSubjectKey({ projectId: subject.projectId, repoSlug, prNumber });
  const nowMs = Number(input.nowMs ?? Date.now());
  const active = findActiveHandoffRecordForSubject(existing, subjectKey);
  if (active) {
    const activeHead = normalizeSha(String(active.headSha ?? ''));
    const activeReceived = Number(active.receivedAtMs ?? 0);
    if (activeHead && activeHead !== headSha) {
      if (receivedAtMs < activeReceived) {
        return { seeded: false, reason: 'stale_head_regressed', noop: true, admissionId };
      }
      const openPrIndexTrusted = input.openPrIndexTrusted === true;
      if (!openPrIndexTrusted) {
        return { seeded: false, reason: 'stale_head_regressed', noop: true, admissionId };
      }
      const open = findOpenPrForHandoffRecord(
        { projectId: subject.projectId, repoSlug, prNumber },
        toArray(input.openPrs),
      );
      const trustedCurrentHead = normalizeSha(String(open?.headRefOid ?? ''));
      if (trustedCurrentHead && headSha !== trustedCurrentHead) {
        return { seeded: false, reason: 'stale_head_regressed', noop: true, admissionId };
      }
      if (trustedCurrentHead && trustedCurrentHead === activeHead && headSha !== activeHead) {
        return { seeded: false, reason: 'stale_head_regressed', noop: true, admissionId };
      }
    }
    if (nonEmptyString(active.admissionId) === admissionId) {
      return { seeded: false, reason: 'already_acted_on', noop: true, admissionId, records: existing };
    }
  }

  const key = handoffAdmissionKey({
    projectId: subject.projectId,
    repoSlug,
    prNumber,
    headSha,
  });
  const prior = existing[key];
  const record = {
    key,
    admissionId,
    projectId: subject.projectId,
    repoSlug,
    prNumber,
    headSha,
    sessionId: subject.sessionId,
    admittedBaseRef,
    priority: subject.priority,
    receivedAtMs: Number.isFinite(receivedAtMs) ? receivedAtMs : (prior?.receivedAtMs ?? nowMs),
    updatedAtMs: nowMs,
    outcome: admission.outcome ?? 'promoted',
  };

  for (const [existingKey, existingRecord] of Object.entries(existing)) {
    if (!isRecord(existingRecord)) continue;
    if (handoffPrSubjectKey(existingRecord) === subjectKey && existingKey !== key) {
      delete existing[existingKey];
    }
  }
  existing[key] = record;

  return {
    seeded: true,
    key,
    admissionId,
    record,
    records: existing,
  };
}

export function prepareHandoffAdmissionRecordsForReplay(input) {
  const pruned = pruneHandoffAdmissionRecords(input);
  const superseded = supersedeHandoffAdmissionRecords({
    records: pruned.records,
    actedOn: pruned.actedOn,
    openPrs: input.openPrs,
    openPrIndexTrusted: input.openPrIndexTrusted,
    nowMs: input.nowMs,
  });
  return {
    records: superseded.records,
    actedOn: superseded.actedOn,
    evicted: pruned.evicted,
    superseded: superseded.superseded,
  };
}


/**
 * @param {object} input
 * @param {Record<string, unknown>} [input.records]
 * @param {number} [input.listenerReadyMs]
 * @param {number} [input.nowMs]
 */
/**
 * @param {number} wakeReceivedMs
 * @param {number} runCreatedAtMs
 * @param {number} [boundMs]
 */
export function evaluateHandoffReceiptToRunBound(
  wakeReceivedMs,
  runCreatedAtMs,
  boundMs = HANDOFF_RECEIPT_TO_RUN_MAX_MS,
) {
  const receiptMs = Number(wakeReceivedMs);
  const createdMs = Number(runCreatedAtMs);
  if (!Number.isFinite(receiptMs) || !Number.isFinite(createdMs)) {
    return { withinBound: false, reason: 'missing_timestamps', receiptToRunMs: null, boundMs };
  }
  const receiptToRunMs = Math.max(0, createdMs - receiptMs);
  return {
    withinBound: receiptToRunMs <= boundMs,
    receiptToRunMs,
    boundMs,
  };
}

function pendingAdmissionRetryKey(bodyJson) {
  const raw = nonEmptyString(bodyJson);
  if (!raw) return '';
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return '';
  }
  const event = isRecord(parsed?.event) ? parsed.event : isRecord(parsed?.body?.event) ? parsed.body.event : undefined;
  if (!event) return '';
  const subject = parseHandoffNotificationSubject(event);
  return [subject.sessionId ?? '', String(subject.prNumber ?? ''), subject.prUrl ?? ''].join('|');
}

/**
 * @param {object} input
 * @param {Record<string, unknown>} [input.existing]
 * @param {string} input.bodyJson
 * @param {number} [input.nowMs]
 */
/**
 * @param {string | undefined} lookupDimension
 * @returns {HandoffLookupDimension}
 */
function normalizeLookupDimension(lookupDimension) {
  const raw = nonEmptyString(lookupDimension);
  if (raw === 'session' || raw === 'supervisedRepo' || raw === 'openPr') {
    return raw;
  }
  return 'openPr';
}

/**
 * @param {string} key
 * @param {HandoffLookupDimension} lookupDimension
 */
function pendingLookupFailureIdentity(key, lookupDimension) {
  return `${lookupDimension}|${key}`;
}

/**
 * @param {string} key
 * @param {Record<string, unknown>} prior
 * @param {HandoffLookupDimension} lookupDimension
 * @param {number} nowMs
 */
function resolvePendingLookupAttemptState(key, prior, lookupDimension, nowMs) {
  const failureIdentity = pendingLookupFailureIdentity(key, lookupDimension);
  const priorIdentity = nonEmptyString(prior.failureIdentity);
  const dimensionChanged = Boolean(priorIdentity) && priorIdentity !== failureIdentity;
  if (dimensionChanged) {
    return {
      lookupDimension,
      failureIdentity,
      lookupAttemptCount: 1,
      lastLookupAttemptAtMs: nowMs,
      lookupDegraded: false,
    };
  }
  const priorAttempts = Number(prior.lookupAttemptCount ?? 0);
  return {
    lookupDimension,
    failureIdentity,
    lookupAttemptCount: priorAttempts > 0 ? priorAttempts : 1,
    lastLookupAttemptAtMs: Number(prior.lastLookupAttemptAtMs ?? nowMs),
    lookupDegraded: Boolean(prior.lookupDegraded),
  };
}

export function seedPendingAdmissionRetry(input) {
  const bodyJson = nonEmptyString(input.bodyJson);
  if (!bodyJson) {
    return { seeded: false, reason: 'missing_body_json' };
  }
  const key = pendingAdmissionRetryKey(bodyJson);
  if (!key || key === '||') {
    return { seeded: false, reason: 'not_handoff_envelope' };
  }
  const nowMs = Number(input.nowMs ?? Date.now());
  const existing = isRecord(input.existing) ? input.existing : {};
  const prior = isRecord(existing[key]) ? existing[key] : {};
  const lookupDimension = normalizeLookupDimension(
    nonEmptyString(input.lookupDimension) ?? nonEmptyString(prior.lookupDimension),
  );
  const attemptState = resolvePendingLookupAttemptState(key, prior, lookupDimension, nowMs);
  const record = {
    key,
    bodyJson,
    reason: 'admission_lookup_unknown',
    ...attemptState,
    receivedAtMs: Number(prior.receivedAtMs ?? nowMs),
    updatedAtMs: nowMs,
  };
  return {
    seeded: true,
    key,
    record,
    pendingRetries: { ...existing, [key]: record },
  };
}

/**
 * @param {object} input
 * @param {Record<string, unknown>} [input.record]
 * @param {number} [input.nowMs]
 */
export function evaluatePendingAdmissionLookupRetry(input) {
  const record = isRecord(input.record) ? input.record : {};
  const nowMs = Number(input.nowMs ?? Date.now());
  const lookupDimension = normalizeLookupDimension(nonEmptyString(record.lookupDimension));
  const attemptCount = Number(record.lookupAttemptCount ?? 0);
  const lastAttemptMs = Number(record.lastLookupAttemptAtMs ?? record.receivedAtMs ?? 0);

  if (record.lookupDegraded === true) {
    return {
      shouldAttempt: false,
      reason: 'lookup_degraded',
      yieldToBackstop: true,
      lookupDimension,
      attemptCount,
    };
  }

  if (attemptCount >= HANDOFF_LOOKUP_RETRY_MAX_IDENTICAL) {
    return {
      shouldAttempt: false,
      reason: 'lookup_retry_exhausted',
      yieldToBackstop: true,
      lookupDimension,
      attemptCount,
    };
  }

  if (attemptCount > 1 && nowMs - lastAttemptMs < HANDOFF_LOOKUP_RETRY_MIN_SPACING_MS) {
    return {
      shouldAttempt: false,
      reason: 'lookup_retry_backoff',
      yieldToBackstop: false,
      lookupDimension,
      attemptCount,
      retryAfterMs: HANDOFF_LOOKUP_RETRY_MIN_SPACING_MS - (nowMs - lastAttemptMs),
    };
  }

  return {
    shouldAttempt: true,
    reason: 'lookup_retry_eligible',
    yieldToBackstop: false,
    lookupDimension,
    attemptCount,
  };
}

/**
 * @param {object} input
 * @param {Record<string, unknown>} [input.existing]
 * @param {string} input.key
 * @param {string} [input.lookupDimension]
 * @param {number} [input.nowMs]
 */
export function recordPendingAdmissionLookupAttempt(input) {
  const key = nonEmptyString(input.key);
  const existing = isRecord(input.existing) ? { ...input.existing } : {};
  const prior = isRecord(existing[key]) ? existing[key] : null;
  if (!key || !prior) {
    return { recorded: false, reason: 'missing_pending_retry', pendingRetries: existing };
  }

  const nowMs = Number(input.nowMs ?? Date.now());
  const lookupDimension = normalizeLookupDimension(
    nonEmptyString(input.lookupDimension) ?? nonEmptyString(prior.lookupDimension),
  );
  const failureIdentity = pendingLookupFailureIdentity(key, lookupDimension);
  const priorIdentity = nonEmptyString(prior.failureIdentity);
  const dimensionChanged = priorIdentity !== failureIdentity;
  const nextAttemptCount = dimensionChanged ? 1 : Number(prior.lookupAttemptCount ?? 0) + 1;
  const lookupDegraded = dimensionChanged
    ? false
    : nextAttemptCount >= HANDOFF_LOOKUP_RETRY_MAX_IDENTICAL;
  const record = {
    ...prior,
    lookupDimension,
    failureIdentity,
    lookupAttemptCount: nextAttemptCount,
    lastLookupAttemptAtMs: nowMs,
    lookupDegraded,
    updatedAtMs: nowMs,
  };

  return {
    recorded: true,
    key,
    record,
    lookupDegraded,
    pendingRetries: { ...existing, [key]: record },
  };
}

/**
 * @param {object} input
 * @param {Record<string, unknown>} [input.existing]
 * @param {string} input.key
 * @param {number} [input.nowMs]
 */
export function markPendingAdmissionLookupDegraded(input) {
  const key = nonEmptyString(input.key);
  const existing = isRecord(input.existing) ? { ...input.existing } : {};
  const prior = isRecord(existing[key]) ? existing[key] : null;
  if (!key || !prior) {
    return { marked: false, reason: 'missing_pending_retry', pendingRetries: existing };
  }

  const nowMs = Number(input.nowMs ?? Date.now());
  const lookupDimension = normalizeLookupDimension(nonEmptyString(prior.lookupDimension));
  const record = {
    ...prior,
    lookupDimension,
    failureIdentity: pendingLookupFailureIdentity(key, lookupDimension),
    lookupDegraded: true,
    updatedAtMs: nowMs,
  };

  return {
    marked: true,
    key,
    record,
    pendingRetries: { ...existing, [key]: record },
  };
}

/**
 * @param {object} input
 * @param {Record<string, unknown>} [input.pendingRetries]
 */
export function selectPendingAdmissionRetries(input) {
  const pendingRetries = isRecord(input.pendingRetries) ? input.pendingRetries : {};
  return {
    retries: Object.values(pendingRetries).filter((entry) => isRecord(entry) && nonEmptyString(entry.bodyJson)),
  };
}

/**
 * @param {object} input
 * @param {Record<string, unknown>} [input.existing]
 * @param {string} input.key
 */
export function clearPendingAdmissionRetry(input) {
  const key = nonEmptyString(input.key);
  const existing = isRecord(input.existing) ? { ...input.existing } : {};
  if (!key || !existing[key]) {
    return { cleared: false, reason: 'missing_pending_retry', pendingRetries: existing };
  }
  delete existing[key];
  return { cleared: true, key, pendingRetries: existing };
}

function sortHandoffRecordsForReplay(records) {
  return Object.values(records)
    .filter((record) => isRecord(record))
    .sort((a, b) => {
      const aReceived = Number(a.receivedAtMs ?? 0);
      const bReceived = Number(b.receivedAtMs ?? 0);
      if (aReceived !== bReceived) return aReceived - bReceived;
      return String(a.key ?? '').localeCompare(String(b.key ?? ''));
    });
}

export function selectHandoffAdmissionReplay(input) {
  const prepared = prepareHandoffAdmissionRecordsForReplay(input);
  const records = prepared.records;
  const listenerReadyMs = Number(input.listenerReadyMs ?? input.nowMs ?? Date.now());
  const replayCursor = Number(input.replayCursor ?? 0);
  const batchSize = Number(input.batchSize ?? HANDOFF_REPLAY_BATCH_SIZE_MAX);
  const ordered = sortHandoffRecordsForReplay(records);
  const replay = [];
  let cursor = Math.max(0, replayCursor);
  if (ordered.length > 0 && cursor > ordered.length) {
    cursor = 0;
  }
  let nextCursor = cursor;
  let lastRecordNowMs = Number(input.nowMs ?? listenerReadyMs);

  const resolveRecordNowMs = (recordIndex) => {
    if (typeof input.nowMsForCursor === 'function') {
      return Number(input.nowMsForCursor(recordIndex));
    }
    if (input.nowMs != null) {
      return Number(input.nowMs);
    }
    return Date.now();
  };

  while (cursor < ordered.length && replay.length < batchSize) {
    const record = ordered[cursor];
    const recordIndex = cursor;
    cursor += 1;
    const recordNowMs = resolveRecordNowMs(recordIndex);
    lastRecordNowMs = recordNowMs;
    const withinRecoveryBound = recordNowMs - listenerReadyMs <= HANDOFF_LISTENER_RECOVERY_MAX_MS;
    if (!withinRecoveryBound) {
      nextCursor = cursor - 1;
      break;
    }
    const receivedAtMs = Number(record.receivedAtMs ?? listenerReadyMs);
    const receiptBound = evaluateHandoffReceiptToRunBound(receivedAtMs, recordNowMs);
    if (!receiptBound.withinBound) {
      continue;
    }
    replay.push({
      ...record,
      replayEligible: true,
      withinRecoveryBound,
      originalReceivedAtMs: receivedAtMs,
    });
    nextCursor = cursor;
  }

  if (cursor >= ordered.length) {
    nextCursor = 0;
  }

  return {
    replay,
    listenerReadyMs,
    nowMs: lastRecordNowMs,
    replayCursor: nextCursor,
    records,
    actedOn: prepared.actedOn,
    evicted: prepared.evicted,
    superseded: prepared.superseded,
    hasMore: nextCursor !== 0 && replay.length > 0,
  };
}

export function getHandoffAdmissionStatePath(stateRoot) {
  return path.join(String(stateRoot), 'review-handoff-wake-admission.json');
}

export function loadHandoffAdmissionState(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return { records: {}, pendingRetries: {}, actedOn: {}, replayCursor: 0, lastUpdatedMs: null, corrupt: false };
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!isRecord(parsed)) {
      return { records: {}, pendingRetries: {}, actedOn: {}, replayCursor: 0, lastUpdatedMs: null, corrupt: true };
    }
    return {
      records: isRecord(parsed.records) ? parsed.records : {},
      pendingRetries: isRecord(parsed.pendingRetries) ? parsed.pendingRetries : {},
      actedOn: isRecord(parsed.actedOn) ? parsed.actedOn : {},
      replayCursor: typeof parsed.replayCursor === 'number' ? parsed.replayCursor : 0,
      lastUpdatedMs: typeof parsed.lastUpdatedMs === 'number' ? parsed.lastUpdatedMs : null,
      corrupt: false,
    };
  } catch {
    return { records: {}, pendingRetries: {}, actedOn: {}, replayCursor: 0, lastUpdatedMs: null, corrupt: true };
  }
}

export function saveHandoffAdmissionState(filePath, state) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(state)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

runStdinJsonCli('review-handoff-wake-admission.mjs', {
  formatAudit: () => {
    const payload = readStdinJson();
    const audit = isRecord(payload.audit) ? payload.audit : {};
    return { auditLine: formatHandoffWakeAuditLine(audit) };
  },
  identity: () => evaluateHandoffIdentityAdmission(readStdinJson()),
  preClaim: () => evaluateHandoffPreClaimRecheck(readStdinJson()),
  seed: () => seedHandoffAdmissionRecord(readStdinJson()),
  replay: () => selectHandoffAdmissionReplay(readStdinJson()),
  prepareReplay: () => prepareHandoffAdmissionRecordsForReplay(readStdinJson()),
  prune: () => pruneHandoffAdmissionRecords(readStdinJson()),
  supersede: () => supersedeHandoffAdmissionRecords(readStdinJson()),
  clearRecord: () => clearHandoffAdmissionRecord(readStdinJson()),
  updateRecordOutcome: () => updateHandoffAdmissionRecordOutcome(readStdinJson()),
  actedOn: () => isHandoffAdmissionIdActedOn(readStdinJson()),
  recordActedOn: () => recordHandoffActedOnIdentity(readStdinJson()),
  formatTransition: () => {
    const payload = readStdinJson();
    const audit = isRecord(payload.audit) ? payload.audit : {};
    return { transitionLine: formatHandoffRecordTransitionLine(audit) };
  },
  seedPendingRetry: () => seedPendingAdmissionRetry(readStdinJson()),
  evaluatePendingLookupRetry: () => {
    const payload = readStdinJson();
    return evaluatePendingAdmissionLookupRetry({ record: payload.record, nowMs: payload.nowMs });
  },
  recordPendingLookupAttempt: () => recordPendingAdmissionLookupAttempt(readStdinJson()),
  markPendingLookupDegraded: () => markPendingAdmissionLookupDegraded(readStdinJson()),
  listPendingRetries: () => selectPendingAdmissionRetries(readStdinJson()),
  clearPendingRetry: () => clearPendingAdmissionRetry(readStdinJson()),
  receiptBound: () => {
    const payload = readStdinJson();
    return evaluateHandoffReceiptToRunBound(
      payload.wakeReceivedMs,
      payload.runCreatedAtMs,
      payload.boundMs,
    );
  },
});
