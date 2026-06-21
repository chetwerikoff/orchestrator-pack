/**
 * ready_for_review hand-off wake admission (Issue #381).
 * Vitest: scripts/review-handoff-wake-trigger.test.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { readStdinJson, runStdinJsonCli } from './review-mechanical-cli.mjs';
import { resolveCurrentPrHeadSha } from './review-head-ready.mjs';
import { normalizeSha, toArray } from './review-trigger-reconcile.mjs';

export const HANDOFF_WAKE_KIND = 'ready_for_review';
export const HANDOFF_RECEIPT_TO_RUN_MAX_MS = 30_000;
export const HANDOFF_LISTENER_RECOVERY_MAX_MS = 30_000;

export const HANDOFF_AUDIT_PREFIX = 'review-handoff-wake';

const NOTIFICATION_ENVELOPE_TYPES = new Set(['notification', 'notification_with_actions']);

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function getNotificationData(event) {
  const data = event?.data;
  if (!isRecord(data)) return null;
  if (data.schemaVersion === 3 && isRecord(data.subject)) return data;
  return data;
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
  if (nonEmptyString(event.type) !== 'session.working') {
    return false;
  }
  const data = getNotificationData(event);
  if (!data || nonEmptyString(data.semanticType) !== HANDOFF_WAKE_KIND) {
    return false;
  }
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
 * @param {Record<string, unknown>} event
 */
export function parseHandoffNotificationSubject(event) {
  const data = getNotificationData(event);
  const subject = isRecord(data?.subject) ? data.subject : {};
  const session = isRecord(subject.session) ? subject.session : {};
  const pr = isRecord(subject.pr) ? subject.pr : {};
  return {
    sessionId: nonEmptyString(event.sessionId) ?? nonEmptyString(session.id),
    projectId: nonEmptyString(event.projectId) ?? nonEmptyString(session.projectId),
    prNumber: typeof pr.number === 'number' ? pr.number : undefined,
    prUrl: nonEmptyString(pr.url),
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
 * @param {object} input
 * @param {Record<string, unknown>} input.event
 * @param {string} [input.supervisedProjectId]
 * @param {string} [input.supervisedRepoSlug]
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

  const supervisedProject = nonEmptyString(input.supervisedProjectId);
  if (supervisedProject && subject.projectId && supervisedProject !== subject.projectId) {
    return {
      admitted: false,
      outcome: 'filter_reject',
      reason: 'foreign_project',
      audit: { ...audit, outcome: 'filter_reject', reason: 'foreign_project' },
    };
  }

  const supervisedRepo = nonEmptyString(input.supervisedRepoSlug)?.toLowerCase();
  const notificationRepo = normalizeRepoSlugFromPrUrl(subject.prUrl);
  if (supervisedRepo && notificationRepo && supervisedRepo !== notificationRepo) {
    return {
      admitted: false,
      outcome: 'filter_reject',
      reason: 'foreign_repository',
      audit: { ...audit, outcome: 'filter_reject', reason: 'foreign_repository' },
    };
  }

  if (Boolean(input.openPrLookupFailed)) {
    return {
      admitted: false,
      outcome: 'unknown',
      reason: 'admission_lookup_unknown',
      retryable: true,
      audit: { ...audit, outcome: 'unknown', reason: 'admission_lookup_unknown' },
    };
  }

  const openPrs = toArray(input.openPrs);
  if (openPrs.length > 0) {
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

  return {
    admitted: true,
    outcome: 'promoted',
    reason: 'handoff_promoted',
    subject,
    audit: { ...audit, outcome: 'promoted', reason: 'handoff_promoted' },
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
  const currentBase =
    nonEmptyString(openPr.baseRefName) ?? nonEmptyString(openPr.baseRef) ?? nonEmptyString(fresh.baseRefName);
  if (admittedBase && currentBase && admittedBase !== currentBase) {
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

function handoffAdmissionKey({ projectId, repoSlug, prNumber, headSha }) {
  return [projectId ?? '', repoSlug ?? '', String(prNumber ?? ''), normalizeSha(headSha)].join('|');
}

/**
 * @param {object} input
 * @param {Record<string, unknown>} [input.existing]
 * @param {object} input.admission
 * @param {number} [input.nowMs]
 */
export function seedHandoffAdmissionRecord(input) {
  const admission = input.admission ?? {};
  const subject = admission.subject ?? {};
  const prNumber = Number(subject.prNumber);
  const headSha = normalizeSha(String(admission.admittedHeadSha ?? ''));
  if (!prNumber || !headSha) {
    return { seeded: false, reason: 'missing_pr_or_head' };
  }
  const repoSlug = normalizeRepoSlugFromPrUrl(subject.prUrl);
  const key = handoffAdmissionKey({
    projectId: subject.projectId,
    repoSlug,
    prNumber,
    headSha,
  });
  const nowMs = Number(input.nowMs ?? Date.now());
  const existing = isRecord(input.existing) ? input.existing : {};
  const prior = existing[key];
  const record = {
    key,
    projectId: subject.projectId,
    repoSlug,
    prNumber,
    headSha,
    sessionId: subject.sessionId,
    admittedBaseRef: admission.admittedBaseRef ?? prior?.admittedBaseRef,
    priority: subject.priority,
    receivedAtMs: subject.receivedAtMs ?? prior?.receivedAtMs ?? nowMs,
    updatedAtMs: nowMs,
    outcome: admission.outcome ?? 'promoted',
  };
  return {
    seeded: true,
    key,
    record,
    records: { ...existing, [key]: record },
  };
}

/**
 * @param {object} input
 * @param {Record<string, unknown>} [input.records]
 * @param {number} [input.listenerReadyMs]
 * @param {number} [input.nowMs]
 */
export function selectHandoffAdmissionReplay(input) {
  const records = isRecord(input.records) ? input.records : {};
  const listenerReadyMs = Number(input.listenerReadyMs ?? input.nowMs ?? Date.now());
  const replay = [];
  for (const record of Object.values(records)) {
    if (!isRecord(record)) continue;
    replay.push({
      ...record,
      replayEligible: true,
      withinRecoveryBound:
        Number(record.receivedAtMs ?? listenerReadyMs) <= listenerReadyMs + HANDOFF_LISTENER_RECOVERY_MAX_MS,
    });
  }
  return { replay, listenerReadyMs };
}

export function getHandoffAdmissionStatePath(stateRoot) {
  return path.join(String(stateRoot), 'review-handoff-wake-admission.json');
}

export function loadHandoffAdmissionState(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return { records: {}, lastUpdatedMs: null };
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!isRecord(parsed)) {
      return { records: {}, lastUpdatedMs: null };
    }
    return {
      records: isRecord(parsed.records) ? parsed.records : {},
      lastUpdatedMs: typeof parsed.lastUpdatedMs === 'number' ? parsed.lastUpdatedMs : null,
    };
  } catch {
    return { records: {}, lastUpdatedMs: null };
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
  identity: () => evaluateHandoffIdentityAdmission(readStdinJson()),
  preClaim: () => evaluateHandoffPreClaimRecheck(readStdinJson()),
  seed: () => seedHandoffAdmissionRecord(readStdinJson()),
  replay: () => selectHandoffAdmissionReplay(readStdinJson()),
});
