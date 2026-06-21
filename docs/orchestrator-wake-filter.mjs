/**
 * AO webhook payload → orchestrator wake decision (plain ESM for node without tsx).
 * Vitest coverage: scripts/orchestrator-wake-listener.test.ts,
 * scripts/orchestrator-wake-heartbeat.test.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  evaluateHandoffIdentityAdmission,
  formatHandoffWakeAuditLine,
  isReadyForReviewHandoffEnvelope,
} from './review-handoff-wake-admission.mjs';

export const DEFAULT_WAKE_DEDUP_WINDOW_MS = 30_000;
/** Low-frequency heartbeat interval (15 minutes). See docs/orchestrator-wake-runbook.md */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15 * 60 * 1000;
export const HEARTBEAT_WAKE_KIND = 'heartbeat.reconcile';
/** Cross-process dedup: any orchestrator wake within the window blocks another. */
export const GLOBAL_ORCHESTRATOR_WAKE_KEY = '__orchestrator_wake__';
export const HEARTBEAT_DEDUPE_KEY = `${HEARTBEAT_WAKE_KIND}|orchestrator`;
/** Stale lock removal when a subprocess died without releasing `.lock`. */
export const DEDUP_LOCK_STALE_MS = 5_000;
/** Max wait for the exclusive dedup lock before skipping the wake (fail closed). */
export const DEDUP_LOCK_WAIT_MS = 500;

export const WAKE_RELEVANT_KINDS = new Set([
  'review.needs_triage',
  'pr_created',
  'ready_for_review',
  'ci.failing',
  'report.stale',
  'merge.ready',
]);

/** Completion-time wake that may carry merge intent (Issue #207 fast review trigger). */
export const COMPLETION_MERGE_INTENT_WAKE_KINDS = new Set(['merge.ready']);

/**
 * @param {string | null | undefined} wakeKind
 */
export function isCompletionMergeIntentWake(wakeKind) {
  return COMPLETION_MERGE_INTENT_WAKE_KINDS.has(String(wakeKind ?? '').trim());
}

const EVENT_TYPE_TO_WAKE_KIND = {
  'ci.failing': 'ci.failing',
  'merge.ready': 'merge.ready',
  'review.pending': 'review.needs_triage',
};

const SEMANTIC_TYPE_TO_WAKE_KIND = {
  'ci.failing': 'ci.failing',
  'merge.ready': 'merge.ready',
  'report.stale': 'report.stale',
  'report.no_acknowledge': 'report.stale',
  'review.needs_triage': 'review.needs_triage',
  'review.pending': 'review.needs_triage',
  pr_created: 'pr_created',
  ready_for_review: 'ready_for_review',
};

export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export function getNotificationData(event) {
  const data = event.data;
  if (!isRecord(data)) return null;
  if (data.schemaVersion === 3 && isRecord(data.subject)) return data;
  return data;
}

function prIdentifier(data) {
  if (!data) return {};
  const subject = data.subject;
  if (!isRecord(subject)) return {};
  const pr = subject.pr;
  if (!isRecord(pr)) return {};
  const prNumber = typeof pr.number === 'number' ? pr.number : undefined;
  const prUrl = nonEmptyString(pr.url);
  return { prNumber, prUrl };
}

function codeReviewRunId(data) {
  if (!data) return undefined;
  const review = data.codeReview;
  if (isRecord(review)) {
    return nonEmptyString(review.runId) ?? nonEmptyString(review.id);
  }
  const runId = nonEmptyString(data.runId);
  if (runId) return runId;
  return undefined;
}

function resolveWakeKind(event) {
  const data = getNotificationData(event);
  const semanticType = nonEmptyString(data?.semanticType);
  if (semanticType) {
    if (WAKE_RELEVANT_KINDS.has(semanticType)) return semanticType;
    const mapped = SEMANTIC_TYPE_TO_WAKE_KIND[semanticType];
    if (mapped) return mapped;
  }

  const eventType = nonEmptyString(event.type);
  if (eventType) {
    if (WAKE_RELEVANT_KINDS.has(eventType)) return eventType;
    const mapped = EVENT_TYPE_TO_WAKE_KIND[eventType];
    if (mapped) return mapped;
  }

  if (data && isRecord(data.reaction)) {
    const reactionKey = nonEmptyString(data.reaction.key);
    if (reactionKey === 'report-stale') return 'report.stale';
  }

  if (data && isRecord(data.codeReview)) {
    const status = nonEmptyString(data.codeReview.status);
    if (status === 'needs_triage') return 'review.needs_triage';
  }

  const message = nonEmptyString(event.message) ?? '';
  if (/needs_triage/i.test(message)) return 'review.needs_triage';

  return null;
}

function formatIdentifier(parts) {
  const bits = [`session=${parts.sessionId}`];
  if (parts.prNumber !== undefined) bits.push(`pr=#${parts.prNumber}`);
  else if (parts.prUrl) bits.push(`pr=${parts.prUrl}`);
  if (parts.runId) bits.push(`run=${parts.runId}`);
  return bits.join(' ');
}

export function buildWakeMessage(wakeKind, parts) {
  return `wake ${wakeKind} ${formatIdentifier(parts)}`;
}

/** Periodic nudge — distinct from event-driven `wake <kind> session=…` messages. */
export function buildHeartbeatWakeMessage() {
  return `wake ${HEARTBEAT_WAKE_KIND} periodic=reconcile`;
}

export function pruneDedupEntries(entries, nowMs, windowMs) {
  if (!isRecord(entries)) return {};
  const cutoff = nowMs - windowMs;
  const pruned = {};
  for (const [key, ts] of Object.entries(entries)) {
    if (typeof ts === 'number' && ts >= cutoff) {
      pruned[key] = ts;
    }
  }
  return pruned;
}

export function isDeduped(entries, dedupeKey, nowMs, windowMs) {
  if (!isRecord(entries)) return false;
  const last = entries[dedupeKey];
  if (typeof last !== 'number') return false;
  return nowMs - last < windowMs;
}

/**
 * Returns whether an orchestrator wake may be sent and the updated dedup map.
 * Honors per-key dedup and a global key so heartbeat and events do not double-send.
 */
export function evaluateOrchestratorWakeSend({
  dedupeKey,
  nowMs = Date.now(),
  dedupWindowMs = DEFAULT_WAKE_DEDUP_WINDOW_MS,
  entries = {},
}) {
  const pruned = pruneDedupEntries(entries, nowMs, dedupWindowMs);
  if (isDeduped(pruned, GLOBAL_ORCHESTRATOR_WAKE_KEY, nowMs, dedupWindowMs)) {
    return { ok: false, reason: 'global_deduped', entries: pruned };
  }
  if (isDeduped(pruned, dedupeKey, nowMs, dedupWindowMs)) {
    return { ok: false, reason: 'deduped', entries: pruned };
  }
  const next = { ...pruned, [dedupeKey]: nowMs, [GLOBAL_ORCHESTRATOR_WAKE_KEY]: nowMs };
  return { ok: true, entries: next };
}

/**
 * Heartbeat tick decision (interval + shared dedup). Does not depend on webhook traffic.
 */
export function evaluateHeartbeatTick({
  nowMs = Date.now(),
  intervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
  lastHeartbeatSentMs,
  entries = {},
  dedupWindowMs = DEFAULT_WAKE_DEDUP_WINDOW_MS,
}) {
  if (
    typeof lastHeartbeatSentMs === 'number' &&
    nowMs - lastHeartbeatSentMs < intervalMs
  ) {
    return { ok: false, reason: 'interval_not_elapsed', entries: pruneDedupEntries(entries, nowMs, dedupWindowMs) };
  }

  const sendDecision = evaluateOrchestratorWakeSend({
    dedupeKey: HEARTBEAT_DEDUPE_KEY,
    nowMs,
    dedupWindowMs,
    entries,
  });

  if (!sendDecision.ok) {
    return { ok: false, reason: sendDecision.reason, entries: sendDecision.entries };
  }

  return {
    ok: true,
    wakeKind: HEARTBEAT_WAKE_KIND,
    wakeMessage: buildHeartbeatWakeMessage(),
    dedupeKey: HEARTBEAT_DEDUPE_KEY,
    entries: sendDecision.entries,
    lastHeartbeatSentMs: nowMs,
  };
}

/**
 * @param {unknown} body
 * @param {object} [admissionContext]
 * @param {string} [admissionContext.supervisedProjectId]
 * @param {string} [admissionContext.supervisedRepoSlug]
 * @param {import('./review-trigger-reconcile.mjs').OpenPr[]} [admissionContext.openPrs]
 * @param {boolean} [admissionContext.openPrLookupFailed]
 */
export function evaluateWakePayload(body, admissionContext = {}) {
  if (!isRecord(body)) {
    return { ok: false, reason: 'malformed_payload', detail: 'body is not an object' };
  }

  const envelopeType = nonEmptyString(body.type);
  if (envelopeType !== 'notification' && envelopeType !== 'notification_with_actions') {
    return {
      ok: false,
      reason: 'not_notification',
      detail: envelopeType ?? 'missing type',
    };
  }

  const event = body.event;
  if (!isRecord(event)) {
    return { ok: false, reason: 'malformed_payload', detail: 'missing event object' };
  }

  const sessionId = nonEmptyString(event.sessionId);
  if (!sessionId) {
    return { ok: false, reason: 'missing_session_id' };
  }

  const handoffEnvelope = isReadyForReviewHandoffEnvelope(body, event);
  const priority = nonEmptyString(event.priority);
  let handoffAdmission = null;
  if (priority === 'info' || priority === 'warning') {
    if (!handoffEnvelope) {
      return { ok: false, reason: 'info_priority', detail: priority };
    }
    handoffAdmission = evaluateHandoffIdentityAdmission({
      event,
      supervisedProjectId: admissionContext.supervisedProjectId,
      supervisedRepoSlug: admissionContext.supervisedRepoSlug,
      openPrs: admissionContext.openPrs,
      openPrLookupFailed: admissionContext.openPrLookupFailed,
    });
    if (!handoffAdmission.admitted) {
      const auditLine = formatHandoffWakeAuditLine(handoffAdmission.audit);
      if (handoffAdmission.outcome === 'unknown') {
        return {
          ok: false,
          reason: 'admission_lookup_unknown',
          retryable: true,
          audit: handoffAdmission.audit,
          auditLine,
        };
      }
      return {
        ok: false,
        reason: handoffAdmission.reason,
        audit: handoffAdmission.audit,
        auditLine,
      };
    }
  }

  const wakeKind = handoffEnvelope ? 'ready_for_review' : resolveWakeKind(event);
  if (!wakeKind) {
    return { ok: false, reason: 'not_wake_relevant' };
  }

  const data = getNotificationData(event);
  const { prNumber, prUrl } = prIdentifier(data);
  const runId = codeReviewRunId(data);
  const projectId = nonEmptyString(event.projectId);

  const wakeMessage = buildWakeMessage(wakeKind, {
    sessionId,
    prNumber,
    prUrl,
    runId,
  });

  const dedupeKey = [wakeKind, sessionId, String(prNumber ?? ''), runId ?? ''].join('|');

  const result = {
    ok: true,
    wakeKind,
    sessionId,
    projectId,
    prNumber,
    prUrl,
    runId,
    wakeMessage,
    dedupeKey,
  };
  if (handoffAdmission?.admitted) {
    result.handoffAdmission = {
      promotedFromInfoPriority: priority === 'info' || priority === 'warning',
      admittedBaseRef: handoffAdmission.admittedBaseRef,
      admittedHeadSha: handoffAdmission.admittedHeadSha,
      audit: handoffAdmission.audit,
      auditLine: formatHandoffWakeAuditLine(handoffAdmission.audit),
    };
  }
  return result;
}

export function parseWebhookJson(raw) {
  try {
    return JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`invalid JSON: ${message}`);
  }
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

function parseFlag(args, name, fallback) {
  const idx = args.indexOf(name);
  if (idx >= 0 && args[idx + 1] !== undefined) {
    return args[idx + 1];
  }
  return fallback;
}

function parseIntFlag(args, name, fallback) {
  const raw = parseFlag(args, name, String(fallback));
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

export function dedupLockPath(stateFilePath) {
  return `${stateFilePath}.lock`;
}

function sleepMs(ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    // short busy wait under lock contention (subprocess hold time is tiny)
  }
}

/**
 * Exclusive lock for read-modify-write on the shared dedup JSON (listener + heartbeat).
 * @returns {{ fd: number, lockPath: string } | null}
 */
export function acquireDedupStateLock(stateFilePath, options = {}) {
  const maxWaitMs = options.maxWaitMs ?? DEDUP_LOCK_WAIT_MS;
  const staleMs = options.staleMs ?? DEDUP_LOCK_STALE_MS;
  const lockPath = dedupLockPath(stateFilePath);
  fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try {
        fs.writeFileSync(fd, `${process.pid}\n`, 'utf8');
      } catch (writeErr) {
        fs.closeSync(fd);
        throw writeErr;
      }
      return { fd, lockPath };
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined;
      if (code !== 'EEXIST') {
        throw err;
      }
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > staleMs) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
        // lock removed by peer — retry
      }
      sleepMs(5);
    }
  }
  return null;
}

export function releaseDedupStateLock(lock) {
  if (!lock) {
    return;
  }
  try {
    fs.closeSync(lock.fd);
  } catch {
    // ignore
  }
  try {
    fs.unlinkSync(lock.lockPath);
  } catch {
    // ignore
  }
}

/**
 * @template T
 * @param {string} stateFilePath
 * @param {() => T} fn
 * @param {{ maxWaitMs?: number, staleMs?: number }} [options]
 * @returns {T | { ok: false, reason: 'dedup_lock_timeout' }}
 */
export function withDedupStateFileLock(stateFilePath, fn, options = {}) {
  const lock = acquireDedupStateLock(stateFilePath, options);
  if (!lock) {
    return { ok: false, reason: 'dedup_lock_timeout' };
  }
  try {
    return fn();
  } finally {
    releaseDedupStateLock(lock);
  }
}

export function loadDedupStateFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return { entries: {}, lastHeartbeatSentMs: undefined };
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return { entries: {}, lastHeartbeatSentMs: undefined };
    }
    const entries = isRecord(parsed.entries) ? parsed.entries : {};
    const lastHeartbeatSentMs =
      typeof parsed.lastHeartbeatSentMs === 'number' ? parsed.lastHeartbeatSentMs : undefined;
    return { entries, lastHeartbeatSentMs };
  } catch {
    return { entries: {}, lastHeartbeatSentMs: undefined };
  }
}

export function saveDedupStateFile(filePath, state) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
  fs.writeFileSync(tmpPath, `${JSON.stringify(state)}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

export function applyDedupTry({ filePath, dedupeKey, dedupWindowMs, nowMs }) {
  return withDedupStateFileLock(filePath, () => {
    const loaded = loadDedupStateFile(filePath);
    const decision = evaluateOrchestratorWakeSend({
      dedupeKey,
      nowMs,
      dedupWindowMs,
      entries: loaded.entries,
    });
    if (decision.ok) {
      saveDedupStateFile(filePath, {
        entries: decision.entries,
        lastHeartbeatSentMs: loaded.lastHeartbeatSentMs,
      });
    }
    return decision;
  });
}

export function applyHeartbeatTick({ filePath, intervalMs, dedupWindowMs, nowMs }) {
  return withDedupStateFileLock(filePath, () => {
    const loaded = loadDedupStateFile(filePath);
    const decision = evaluateHeartbeatTick({
      nowMs,
      intervalMs,
      lastHeartbeatSentMs: loaded.lastHeartbeatSentMs,
      entries: loaded.entries,
      dedupWindowMs,
    });
    if (decision.ok) {
      saveDedupStateFile(filePath, {
        entries: decision.entries,
        lastHeartbeatSentMs: decision.lastHeartbeatSentMs,
      });
    } else if (decision.entries) {
      saveDedupStateFile(filePath, {
        entries: decision.entries,
        lastHeartbeatSentMs: loaded.lastHeartbeatSentMs,
      });
    }
    return decision;
  });
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] ?? 'evaluate';

  if (command === 'dedup' && args[1] === 'try') {
    const filePath = parseFlag(args, '--file', '');
    const dedupeKey = parseFlag(args, '--key', '');
    const windowMs = parseIntFlag(args, '--window-ms', DEFAULT_WAKE_DEDUP_WINDOW_MS);
    const nowMs = parseIntFlag(args, '--now-ms', Date.now());
    if (!filePath || !dedupeKey) {
      console.error('dedup try requires --file and --key');
      process.exit(2);
      return;
    }
    const decision = applyDedupTry({
      filePath,
      dedupeKey,
      dedupWindowMs: windowMs,
      nowMs,
    });
    process.stdout.write(`${JSON.stringify(decision)}\n`);
    return;
  }

  if (command === 'heartbeat' && args[1] === 'tick') {
    const filePath = parseFlag(args, '--file', '');
    const intervalMs = parseIntFlag(args, '--interval-ms', DEFAULT_HEARTBEAT_INTERVAL_MS);
    const windowMs = parseIntFlag(args, '--window-ms', DEFAULT_WAKE_DEDUP_WINDOW_MS);
    const nowMs = parseIntFlag(args, '--now-ms', Date.now());
    if (!filePath) {
      console.error('heartbeat tick requires --file');
      process.exit(2);
      return;
    }
    const decision = applyHeartbeatTick({
      filePath,
      intervalMs,
      dedupWindowMs: windowMs,
      nowMs,
    });
    process.stdout.write(`${JSON.stringify(decision)}\n`);
    return;
  }

  if (command === 'evaluate') {
    const jsonFlag = args.indexOf('--json');
    let raw;
    if (jsonFlag >= 0 && args[jsonFlag + 1]) {
      raw = args[jsonFlag + 1];
    } else {
      raw = await readStdin();
    }
    let parsed;
    try {
      parsed = parseWebhookJson(raw);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stdout.write(`${JSON.stringify({ ok: false, reason: 'malformed_payload', detail: message })}\n`);
      process.exit(0);
      return;
    }
    const admissionContext = isRecord(parsed.admissionContext) ? parsed.admissionContext : {};
    const body = parsed.body ?? parsed;
    const result = evaluateWakePayload(body, admissionContext);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  console.error(`Unknown command: ${command}`);
  process.exit(2);
}

const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  (process.argv[1].endsWith('orchestrator-wake-filter.mjs') ||
    process.argv[1].endsWith('orchestrator-wake-filter.js'));

if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
