/**
 * Pack-owned worker report store (Issue #717).
 * Vitest: scripts/worker-report-store.test.ts
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { normalizeSha, toArray } from './review-reconcile-primitives.mjs';
import { readStdinJson, runStdinJsonCli } from './review-mechanical-cli.mjs';
import {
  resolveSessionPrBinding,
  sessionDetailFromSessionGetPayload,
} from './session-pr-binding-resolver.mjs';
import { isPendingWorkerDeliveryConfirmation } from './review-producer-contract.mjs';

export const WORKER_REPORT_STORE_SCHEMA_VERSION = 2;
export const PACK_WORKER_REPORT_STORE_SURFACE = 'pack-worker-report-store';
export const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_NONTERMINAL_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

/** @typedef {{ reportState?: string, accepted?: boolean, repoSlug?: string, sessionId?: string, prNumber?: number, headSha?: string, reportedAtMs?: number, lastObservedMs?: number, deliveryRunId?: string, note?: string, reason?: string, handoffKind?: string, degradedCiEscalation?: boolean }} WorkerReportRecord */

export const WORKER_REPORT_STATES = Object.freeze([
  'ready_for_review',
  'fixing_ci',
  'addressing_reviews',
  'completed',
  'blocked',
  'pr_created',
  'working',
  'started',
]);

/**
 * @param {Record<string, unknown>} [env]
 */
export function resolveWorkerReportStorePath(env = process.env) {
  if (env.AO_WORKER_REPORT_STORE) {
    return String(env.AO_WORKER_REPORT_STORE);
  }
  if (env.AO_REPORT_STATE_SEED_STATE) {
    const seedPath = String(env.AO_REPORT_STATE_SEED_STATE);
    const dir = dirname(seedPath);
    return join(dir, 'worker-report-store.json');
  }
  return join(homedir(), '.local', 'state', 'orchestrator-pack-wake-supervisor', 'worker-report-store.json');
}

/**
 * @param {Record<string, unknown>} record
 */
export function buildWorkerReportRecordKey(record) {
  const repoSlug = String(record?.repoSlug ?? '').trim().toLowerCase();
  const sessionId = String(record?.sessionId ?? '').trim();
  const prNumber = Number(record?.prNumber ?? 0);
  const headSha = normalizeSha(record?.headSha);
  const base = `${repoSlug}|${sessionId}|${prNumber}|${headSha}`;
  const state = String(record?.reportState ?? '').toLowerCase();
  if (state === 'addressing_reviews') {
    const runId = String(record?.deliveryRunId ?? '').trim();
    if (runId) {
      return `${base}|ack|${runId}`;
    }
    const reportedAtMs = Number(record?.reportedAtMs ?? record?.lastObservedMs ?? 0);
    if (reportedAtMs > 0) {
      return `${base}|ack|${reportedAtMs}`;
    }
    return `${base}|ack`;
  }
  return base;
}

/**
 * @param {Record<string, unknown>} [raw]
 */
export function createDefaultWorkerReportStore(raw = {}) {
  const seedFields = {
    bindingByKey: raw.bindingByKey && typeof raw.bindingByKey === 'object' ? raw.bindingByKey : {},
    seededKeys: Array.isArray(raw.seededKeys) ? [...raw.seededKeys] : [],
    deferredScanKeys: Array.isArray(raw.deferredScanKeys) ? [...raw.deferredScanKeys] : [],
    githubSnapshot: raw.githubSnapshot ?? null,
  };
  return {
    schemaVersion: WORKER_REPORT_STORE_SCHEMA_VERSION,
    lastUpdatedMs: Number(raw.lastUpdatedMs ?? 0) || null,
    generation: Number(raw.generation ?? 0) || 0,
    sourceRecords: raw.sourceRecords && typeof raw.sourceRecords === 'object' ? { ...raw.sourceRecords } : (raw.records && typeof raw.records === 'object' ? { ...raw.records } : {}),
    ...seedFields,
  };
}

/**
 * @param {Record<string, unknown>} legacy
 */
export function migrateLegacySeedStateToWorkerReportStore(legacy) {
  if (!legacy || typeof legacy !== 'object') {
    return createDefaultWorkerReportStore();
  }
  const schemaVersion = Number(legacy.schemaVersion ?? 1);
  if (schemaVersion >= WORKER_REPORT_STORE_SCHEMA_VERSION) {
    return createDefaultWorkerReportStore(legacy);
  }
  const next = createDefaultWorkerReportStore({
    bindingByKey: legacy.bindingByKey,
    seededKeys: legacy.seededKeys,
    deferredScanKeys: legacy.deferredScanKeys,
    githubSnapshot: legacy.githubSnapshot,
    lastUpdatedMs: legacy.lastUpdatedMs,
    generation: legacy.generation ?? 0,
    sourceRecords: legacy.sourceRecords,
    records: legacy.records,
  });
  next.schemaVersion = WORKER_REPORT_STORE_SCHEMA_VERSION;
  return next;
}

/**
 * @param {string} path
 */
export function readWorkerReportStoreFile(path) {
  if (!existsSync(path)) {
    return createDefaultWorkerReportStore();
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  return migrateLegacySeedStateToWorkerReportStore(parsed);
}

/**
 * @param {string} path
 * @param {Record<string, unknown>} store
 */
export function writeWorkerReportStoreFile(path, store) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tempPath = `${path}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(store)}\n`, 'utf8');
  renameSync(tempPath, path);
}

/**
 * @param {Record<string, unknown>} store
 * @param {Record<string, unknown>} record
 * @param {number} nowMs
 */
export function upsertWorkerReportRecord(store, record, nowMs) {
  const key = buildWorkerReportRecordKey(record);
  const existing = store.sourceRecords[key] ?? {};
  store.sourceRecords[key] = {
    ...existing,
    reportState: String(record.reportState ?? existing.reportState ?? '').toLowerCase(),
    accepted: record.accepted !== undefined ? Boolean(record.accepted) : Boolean(existing.accepted ?? true),
    repoSlug: String(record.repoSlug ?? existing.repoSlug ?? '').trim(),
    sessionId: String(record.sessionId ?? existing.sessionId ?? '').trim(),
    prNumber: Number(record.prNumber ?? existing.prNumber ?? 0),
    headSha: normalizeSha(record.headSha ?? existing.headSha),
    reportedAtMs: Number(record.reportedAtMs ?? nowMs),
    lastObservedMs: nowMs,
    deliveryRunId: record.deliveryRunId ? String(record.deliveryRunId) : existing.deliveryRunId,
    note: record.note !== undefined ? String(record.note) : existing.note,
    reason: record.reason !== undefined ? String(record.reason) : existing.reason,
    handoffKind: record.handoffKind !== undefined ? String(record.handoffKind) : existing.handoffKind,
    degradedCiEscalation:
      record.degradedCiEscalation !== undefined
        ? Boolean(record.degradedCiEscalation)
        : Boolean(existing.degradedCiEscalation ?? false),
  };
  store.lastUpdatedMs = nowMs;
  store.generation = Number(store.generation ?? 0) + 1;
  return { key, record: store.sourceRecords[key] };
}

/**
 * @param {Record<string, unknown>} store
 * @param {string} repoSlug
 * @param {string} sessionId
 */
export function listWorkerReportRecordsForSession(store, repoSlug, sessionId) {
  const repo = String(repoSlug ?? '').trim().toLowerCase();
  const session = String(sessionId ?? '').trim();
  return Object.values(store.sourceRecords ?? {}).filter((record) => {
    return (
      String(record?.repoSlug ?? '').trim().toLowerCase() === repo &&
      String(record?.sessionId ?? '').trim() === session
    );
  });
}

/**
 * @param {WorkerReportRecord} record
 */
export function workerReportRecordToSessionReportRow(record) {
  const reportedAtMs = Number(record?.reportedAtMs ?? record?.lastObservedMs ?? 0);
  return {
    reportState: String(record?.reportState ?? '').toLowerCase(),
    accepted: Boolean(record?.accepted ?? true),
    prNumber: Number(record?.prNumber ?? 0) || undefined,
    headSha: normalizeSha(record?.headSha) || undefined,
    repoSlug: String(record?.repoSlug ?? '').trim() || undefined,
    deliveryRunId: record?.deliveryRunId ? String(record.deliveryRunId) : undefined,
    note: record?.note ? String(record.note) : undefined,
    reason: record?.reason ? String(record.reason) : undefined,
    handoffKind: record?.handoffKind ? String(record.handoffKind) : undefined,
    degradedCiEscalation:
      record?.degradedCiEscalation !== undefined ? Boolean(record.degradedCiEscalation) : undefined,
    reportedAt: reportedAtMs > 0 ? new Date(reportedAtMs).toISOString() : undefined,
    timestamp: reportedAtMs > 0 ? new Date(reportedAtMs).toISOString() : undefined,
    source: PACK_WORKER_REPORT_STORE_SURFACE,
  };
}

/**
 * @param {Record<string, unknown>[]} sessions
 * @param {Record<string, unknown>} store
 * @param {string} [repoSlug]
 */
export function mergePackWorkerReportsIntoSessions(sessions, store, repoSlug = '') {
  const repo = String(repoSlug ?? '').trim().toLowerCase();
  return toArray(sessions).map((session) => {
    const sessionId = String(session?.id ?? session?.name ?? session?.sessionId ?? '').trim();
    const sessionRepo = String(session?.repoSlug ?? repo ?? '').trim().toLowerCase();
    const records = listWorkerReportRecordsForSession(store, sessionRepo, sessionId)
      .sort((a, b) => Number(b.reportedAtMs ?? 0) - Number(a.reportedAtMs ?? 0))
      .map((record) => workerReportRecordToSessionReportRow(record));
    if (records.length === 0) {
      if (String(session?.reportSnapshotKind ?? '') === PACK_WORKER_REPORT_STORE_SURFACE) {
        const next = { ...session };
        delete next.reports;
        delete next.reportSourcePath;
        delete next.reportSnapshotKind;
        return next;
      }
      return session;
    }
    return {
      ...session,
      reports: records,
      reportSourcePath: `pack-worker-report-store/${sessionRepo}/${sessionId}`,
      reportSnapshotKind: PACK_WORKER_REPORT_STORE_SURFACE,
    };
  });
}

/**
 * @param {object} input
 * @param {Record<string, unknown>} input.store
 * @param {Array<{ number?: number, state?: string, merged?: boolean, closed?: boolean, headRefOid?: string }>} [input.openPrs]
 * @param {Record<string, string>} [input.currentHeadByPr]
 * @param {number} input.nowMs
 * @param {number} [input.maxAgeMs]
 * @param {number} [input.nonterminalMaxAgeMs]
 * @param {boolean} [input.openListAuthoritative]
 * @param {string} [input.repoSlug]
 */
export function evictWorkerReportRecords({
  store,
  openPrs = [],
  currentHeadByPr = {},
  nowMs,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  nonterminalMaxAgeMs = DEFAULT_NONTERMINAL_MAX_AGE_MS,
  openListAuthoritative = false,
  repoSlug = '',
}) {
  const scopeRepo = String(repoSlug ?? '').trim().toLowerCase();
  const openByRepoPr = new Map();
  for (const pr of toArray(openPrs)) {
    const prNumber = Number(pr?.number ?? 0);
    if (prNumber <= 0) {
      continue;
    }
    const prRepo = scopeRepo || String(pr?.repoSlug ?? pr?.repository ?? '').trim().toLowerCase();
    if (prRepo) {
      openByRepoPr.set(`${prRepo}|${prNumber}`, pr);
    } else {
      openByRepoPr.set(String(prNumber), pr);
    }
  }
  let removed = 0;
  for (const [key, record] of Object.entries(store.sourceRecords ?? {})) {
    const prNumber = Number(record?.prNumber ?? 0);
    const recordRepo = String(record?.repoSlug ?? '').trim().toLowerCase();
    const recordHead = normalizeSha(record?.headSha);
    const prKey = recordRepo ? `${recordRepo}|${prNumber}` : String(prNumber);
    const inScope = !scopeRepo || !recordRepo || recordRepo === scopeRepo;
    const openPr = inScope
      ? (openByRepoPr.get(prKey) ?? (scopeRepo ? undefined : openByRepoPr.get(String(prNumber))))
      : undefined;
    const currentHead = inScope
      ? normalizeSha(
        currentHeadByPr[prKey] ?? (scopeRepo ? undefined : currentHeadByPr[String(prNumber)]),
      )
      : undefined;
    const prState = String(openPr?.state ?? '').toLowerCase();
    const explicitlyTerminal = Boolean(openPr)
      && (prState === 'closed' || prState === 'merged' || openPr?.merged === true || openPr?.closed === true);
    const unlistedTerminal = openListAuthoritative && inScope && !openPr;
    const terminal = explicitlyTerminal || unlistedTerminal;
    const superseded = currentHead && recordHead && currentHead !== recordHead;
    const lastObserved = Number(record?.lastObservedMs ?? record?.reportedAtMs ?? 0);
    const stale = lastObserved > 0 && nowMs - lastObserved > (terminal ? maxAgeMs : nonterminalMaxAgeMs);
    if (terminal || superseded || stale) {
      delete store.sourceRecords[key];
      removed += 1;
    }
  }
  if (removed > 0) {
    store.lastUpdatedMs = nowMs;
    store.generation = Number(store.generation ?? 0) + 1;
  }
  return { removed, recordCount: Object.keys(store.sourceRecords ?? {}).length };
}

/**
 * @param {object} input
 * @param {string} input.callerSessionId
 * @param {Record<string, unknown>} input.record
 */
/**
 * @param {object} input
 * @param {Record<string, unknown>} input.session
 * @param {Array<Record<string, unknown>>} [input.openPrs]
 * @param {string} [input.worktreeHeadSha]
 * @param {Record<string, unknown> | null} [input.sessionGetPayload]
 */
export function resolveWorkerReportTrustedBinding({
  session,
  openPrs = [],
  worktreeHeadSha = '',
  sessionGetPayload = null,
}) {
  const headSha = normalizeSha(worktreeHeadSha);
  if (!headSha) {
    return { ok: false, reason: 'missing_worktree_head' };
  }
  const sessionDetail = sessionGetPayload
    ? sessionDetailFromSessionGetPayload(sessionGetPayload)
    : null;
  const binding = resolveSessionPrBinding(session, toArray(openPrs), {
    headSha,
    sessionDetail,
  });
  if (!binding.bound || Number(binding.prNumber ?? 0) <= 0) {
    return {
      ok: false,
      reason: binding.deferReason ?? 'trust_boundary_binding_unresolved',
    };
  }
  const prNumber = Number(binding.prNumber);
  const prRow = toArray(openPrs).find((pr) => Number(pr?.number ?? 0) === prNumber);
  const openHead = normalizeSha(prRow?.headRefOid);
  if (openHead && openHead !== headSha) {
    return { ok: false, reason: 'trust_boundary_head_mismatch' };
  }
  return {
    ok: true,
    prNumber,
    headSha,
    bindingSource: binding.source,
  };
}

/**
 * @param {object} input
 * @param {string} input.callerSessionId
 * @param {Record<string, unknown>} input.record
 * @param {{ ok?: boolean, prNumber?: number, headSha?: string, reason?: string } | null} [input.trustedBinding]
 */
export function validateWorkerReportTrustBoundary({ callerSessionId, record, trustedBinding = null }) {
  const caller = String(callerSessionId ?? '').trim();
  const target = String(record?.sessionId ?? '').trim();
  if (!caller || !target || caller !== target) {
    return { ok: false, reason: 'trust_boundary_session_mismatch' };
  }
  if (!String(record?.repoSlug ?? '').trim()) {
    return { ok: false, reason: 'missing_repo_slug' };
  }
  if (Number(record?.prNumber ?? 0) <= 0) {
    return { ok: false, reason: 'missing_pr_number' };
  }
  if (!normalizeSha(record?.headSha)) {
    return { ok: false, reason: 'missing_head_sha' };
  }
  const state = String(record?.reportState ?? '').toLowerCase();
  if (!WORKER_REPORT_STATES.includes(state)) {
    return { ok: false, reason: 'invalid_report_state' };
  }
  if (!trustedBinding || trustedBinding.ok !== true) {
    return {
      ok: false,
      reason: String(trustedBinding?.reason ?? 'trust_boundary_binding_unresolved'),
    };
  }
  if (Number(record?.prNumber ?? 0) !== Number(trustedBinding.prNumber ?? 0)) {
    return { ok: false, reason: 'trust_boundary_pr_mismatch' };
  }
  if (normalizeSha(record?.headSha) !== normalizeSha(trustedBinding.headSha)) {
    return { ok: false, reason: 'trust_boundary_head_mismatch' };
  }
  return { ok: true };
}

/**
 * @param {Record<string, unknown>} session
 */
export function sessionHasPackWorkerReportReceiptSurface(session) {
  return (
    String(session?.reportSnapshotKind ?? '') === PACK_WORKER_REPORT_STORE_SURFACE &&
    toArray(session?.reports).length > 0
  );
}

/**
 * Pack-store worker ack: addressing_reviews only, correlated to delivery head and timestamp.
 *
 * @param {Record<string, unknown>} session
 * @param {object} run
 * @param {number} sendObservedAtMs
 */

/**
 * @param {object} input
 * @param {string} [input.reportState]
 * @param {string} [input.sessionId]
 * @param {number} [input.prNumber]
 * @param {string} [input.headSha]
 * @param {string} [input.deliveryRunId]
 * @param {Array<Record<string, unknown>>} [input.reviewRuns]
 */
export function resolvePackWorkerReportDeliveryRunId({
  reportState = '',
  sessionId = '',
  prNumber = 0,
  headSha = '',
  deliveryRunId = '',
  reviewRuns = [],
}) {
  if (String(reportState ?? '').toLowerCase() !== 'addressing_reviews') {
    return '';
  }
  const explicit = String(deliveryRunId ?? '').trim();
  if (explicit) {
    return explicit;
  }
  const session = String(sessionId ?? '').trim();
  const pr = Number(prNumber ?? 0);
  const head = normalizeSha(headSha);
  if (!session || pr <= 0) {
    return '';
  }
  for (const run of toArray(reviewRuns)) {
    const linked = String(run?.linkedSessionId ?? '').trim();
    if (linked !== session) {
      continue;
    }
    if (Number(run?.prNumber ?? 0) !== pr) {
      continue;
    }
    const targetHead = normalizeSha(run?.targetSha);
    if (head && targetHead && targetHead !== head) {
      continue;
    }
    if (!isPendingWorkerDeliveryConfirmation(run)) {
      continue;
    }
    const runId = String(run?.id ?? run?.reviewerSessionId ?? '').trim();
    if (runId) {
      return runId;
    }
  }
  return '';
}

export function findPackWorkerAckReportAfterDelivery(session, run, sendObservedAtMs) {
  if (!sessionHasPackWorkerReportReceiptSurface(session)) {
    return null;
  }
  const runHead = normalizeSha(run?.targetSha);
  const runId = String(run?.id ?? run?.reviewerSessionId ?? '').trim();
  for (const report of toArray(session?.reports)) {
    const state = String(report?.reportState ?? report?.report_state ?? '').toLowerCase();
    if (state !== 'addressing_reviews') {
      continue;
    }
    const reportHead = normalizeSha(report?.headSha ?? report?.headRefOid);
    if (runHead && reportHead && reportHead !== runHead) {
      continue;
    }
    const ts =
      Date.parse(String(report?.reportedAt ?? report?.timestamp ?? report?.createdAt ?? '')) || 0;
    if (ts <= sendObservedAtMs) {
      continue;
    }
    if (runId) {
      const reportRunId = String(report?.deliveryRunId ?? '').trim();
      if (!reportRunId || reportRunId !== runId) {
        continue;
      }
    }
    return report;
  }
  return null;
}

/**
 * @param {object} input
 * @param {string} input.storePath
 * @param {Record<string, unknown>} input.record
 * @param {string} input.callerSessionId
 * @param {number} input.nowMs
 * @param {number} [input.expectedGeneration]
 */
export function upsertWorkerReportRecordInMemory({ store, record, callerSessionId, nowMs, trustedBinding = null }) {
  const trust = validateWorkerReportTrustBoundary({ callerSessionId, record, trustedBinding });
  if (!trust.ok) {
    return { ok: false, reason: trust.reason };
  }
  const normalized = createDefaultWorkerReportStore(store ?? {});
  const result = upsertWorkerReportRecord(normalized, record, nowMs);
  return {
    ok: true,
    store: normalized,
    key: result.key,
    record: result.record,
    generation: normalized.generation,
  };
}

export function writeWorkerReportRecordWithCas({
  storePath,
  record,
  callerSessionId,
  nowMs,
  expectedGeneration,
  trustedBinding = null,
}) {
  const trust = validateWorkerReportTrustBoundary({ callerSessionId, record, trustedBinding });
  if (!trust.ok) {
    return { ok: false, reason: trust.reason };
  }
  if (expectedGeneration === undefined || expectedGeneration === null) {
    return { ok: false, reason: 'missing_expected_generation' };
  }
  const store = readWorkerReportStoreFile(storePath);
  if (Number(store.generation ?? 0) !== Number(expectedGeneration)) {
    return { ok: false, reason: 'generation_mismatch', generation: store.generation };
  }
  const result = upsertWorkerReportRecord(store, record, nowMs);
  writeWorkerReportStoreFile(storePath, store);
  return { ok: true, key: result.key, record: result.record, generation: store.generation };
}

/**
 * @param {Record<string, unknown>} store
 * @param {string} repoSlug
 * @param {number} prNumber
 * @param {string} headSha
 */
export function seedShouldPromoteReadyForReview(store, repoSlug, prNumber, headSha, currentHeadSha) {
  const repo = String(repoSlug ?? '').trim().toLowerCase();
  const head = normalizeSha(headSha);
  const current = normalizeSha(currentHeadSha);
  if (current && head && current !== head) {
    return { promote: false, reason: 'superseded_head' };
  }
  for (const record of Object.values(store.sourceRecords ?? {})) {
    if (String(record?.repoSlug ?? '').trim().toLowerCase() !== repo) {
      continue;
    }
    if (Number(record?.prNumber ?? 0) !== Number(prNumber)) {
      continue;
    }
    if (normalizeSha(record?.headSha) !== head) {
      continue;
    }
    if (String(record?.reportState ?? '').toLowerCase() === 'ready_for_review' && Boolean(record?.accepted ?? true)) {
      return { promote: true, record };
    }
  }
  return { promote: false, reason: 'no_ready_record' };
}

runStdinJsonCli('worker-report-store.mjs', {
  migrate: () => migrateLegacySeedStateToWorkerReportStore(readStdinJson()),
  mergeIntoSessions: () => {
    const payload = readStdinJson();
    return mergePackWorkerReportsIntoSessions(
      toArray(payload.sessions),
      createDefaultWorkerReportStore(payload.store ?? {}),
      String(payload.repoSlug ?? ''),
    );
  },
  evict: () => {
    const payload = readStdinJson();
    const store = createDefaultWorkerReportStore(payload.store ?? {});
    const result = evictWorkerReportRecords({
      store,
      openPrs: toArray(payload.openPrs),
      currentHeadByPr: payload.currentHeadByPr ?? {},
      nowMs: Number(payload.nowMs ?? Date.now()),
      maxAgeMs: Number(payload.maxAgeMs ?? DEFAULT_MAX_AGE_MS),
      nonterminalMaxAgeMs: Number(payload.nonterminalMaxAgeMs ?? DEFAULT_NONTERMINAL_MAX_AGE_MS),
      openListAuthoritative: Boolean(payload.openListAuthoritative ?? false),
      repoSlug: String(payload.repoSlug ?? ''),
    });
    return { ...result, store };
  },
  resolveDeliveryRunId: () => {
    const payload = readStdinJson();
    return {
      deliveryRunId: resolvePackWorkerReportDeliveryRunId({
        reportState: String(payload.reportState ?? ''),
        sessionId: String(payload.sessionId ?? ''),
        prNumber: Number(payload.prNumber ?? 0),
        headSha: String(payload.headSha ?? ''),
        deliveryRunId: String(payload.deliveryRunId ?? ''),
        reviewRuns: toArray(payload.reviewRuns),
      }),
    };
  },
  resolveTrustedBinding: () => {
    const payload = readStdinJson();
    return resolveWorkerReportTrustedBinding({
      session: payload.session ?? {},
      openPrs: toArray(payload.openPrs),
      worktreeHeadSha: String(payload.worktreeHeadSha ?? ''),
      sessionGetPayload: payload.sessionGetPayload ?? null,
    });
  },
  upsertRecord: () => {
    const payload = readStdinJson();
    return upsertWorkerReportRecordInMemory({
      store: createDefaultWorkerReportStore(payload.store ?? {}),
      record: payload.record ?? {},
      callerSessionId: String(payload.callerSessionId ?? ''),
      nowMs: Number(payload.nowMs ?? Date.now()),
      trustedBinding: payload.trustedBinding ?? null,
    });
  },
  writeRecord: () => {
    const payload = readStdinJson();
    return writeWorkerReportRecordWithCas({
      storePath: String(payload.storePath ?? resolveWorkerReportStorePath()),
      record: payload.record ?? {},
      callerSessionId: String(payload.callerSessionId ?? ''),
      nowMs: Number(payload.nowMs ?? Date.now()),
      expectedGeneration: payload.expectedGeneration,
      trustedBinding: payload.trustedBinding ?? null,
    });
  },
  seedShouldPromote: () => {
    const payload = readStdinJson();
    const store = createDefaultWorkerReportStore(payload.store ?? {});
    return seedShouldPromoteReadyForReview(
      store,
      String(payload.repoSlug ?? ''),
      Number(payload.prNumber ?? 0),
      String(payload.headSha ?? ''),
      String(payload.currentHeadSha ?? ''),
    );
  },
  findPackAck: () => {
    const payload = readStdinJson();
    return findPackWorkerAckReportAfterDelivery(
      payload.session ?? {},
      payload.run ?? {},
      Number(payload.sendObservedAtMs ?? 0),
    );
  },
});
