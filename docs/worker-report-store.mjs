/**
 * Pack-owned worker report store.
 * Runtime identity is always the exact adapter-produced composite
 * `{ runtime, id, generation }`. Pre-v3 session-keyed records are ignored and
 * never authorize a report, delivery acknowledgement, or state transition.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { normalizeSha, toArray } from './review-reconcile-primitives.mjs';
import { readStdinJson, runStdinJsonCli } from './review-mechanical-cli.mjs';
import { isPendingWorkerDeliveryConfirmation } from './review-producer-contract.mjs';

export const WORKER_REPORT_STORE_SCHEMA_VERSION = 3;
export const PACK_WORKER_REPORT_STORE_SURFACE = 'pack-worker-report-store';
export const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_NONTERMINAL_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

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

function normalizeWorkerIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const runtime = String(value.runtime ?? '').trim();
  const id = String(value.id ?? '').trim();
  const generation = String(value.generation ?? '').trim();
  if (!runtime || !id || !generation) return null;
  return { runtime, id, generation };
}

function sameWorker(left, right) {
  const a = normalizeWorkerIdentity(left);
  const b = normalizeWorkerIdentity(right);
  return Boolean(a && b && a.runtime === b.runtime && a.id === b.id && a.generation === b.generation);
}

function workerKey(worker) {
  const exact = normalizeWorkerIdentity(worker);
  return exact ? `${exact.runtime}:${exact.id}:${exact.generation}` : '';
}

export function resolveWorkerReportStorePath(env = process.env) {
  if (env.OPK_WORKER_REPORT_STORE) return String(env.OPK_WORKER_REPORT_STORE);
  if (env.OPK_REPORT_STATE_SEED_STATE) return join(dirname(String(env.OPK_REPORT_STATE_SEED_STATE)), 'worker-report-store.json');
  return join(homedir(), '.local', 'state', 'orchestrator-pack-wake-supervisor', 'worker-report-store.json');
}

export function buildWorkerReportRecordKey(record) {
  const repoSlug = String(record?.repoSlug ?? '').trim().toLowerCase();
  const worker = workerKey(record?.worker);
  const prNumber = Number(record?.prNumber ?? 0);
  const headSha = normalizeSha(record?.headSha);
  const base = `${repoSlug}|${worker}|${prNumber}|${headSha}`;
  if (String(record?.reportState ?? '').toLowerCase() === 'addressing_reviews') {
    const runId = String(record?.deliveryRunId ?? '').trim();
    if (runId) return `${base}|ack|${runId}`;
    const timestamp = Number(record?.reportedAtMs ?? record?.lastObservedMs ?? 0);
    return timestamp > 0 ? `${base}|ack|${timestamp}` : `${base}|ack`;
  }
  return base;
}

export function createDefaultWorkerReportStore(raw = {}) {
  const current = Number(raw?.schemaVersion ?? 0) === WORKER_REPORT_STORE_SCHEMA_VERSION;
  return {
    schemaVersion: WORKER_REPORT_STORE_SCHEMA_VERSION,
    lastUpdatedMs: current ? (Number(raw.lastUpdatedMs ?? 0) || null) : null,
    generation: current ? (Number(raw.generation ?? 0) || 0) : 0,
    sourceRecords: current && raw.sourceRecords && typeof raw.sourceRecords === 'object'
      ? { ...raw.sourceRecords }
      : {},
    bindingByKey: current && raw.bindingByKey && typeof raw.bindingByKey === 'object' ? raw.bindingByKey : {},
    seededKeys: current && Array.isArray(raw.seededKeys) ? [...raw.seededKeys] : [],
    deferredScanKeys: current && Array.isArray(raw.deferredScanKeys) ? [...raw.deferredScanKeys] : [],
    githubSnapshot: current ? (raw.githubSnapshot ?? null) : null,
  };
}

export function normalizeWorkerReportStore(raw) {
  return createDefaultWorkerReportStore(raw ?? {});
}

export function readWorkerReportStoreFile(path) {
  if (!existsSync(path)) return createDefaultWorkerReportStore();
  return normalizeWorkerReportStore(JSON.parse(readFileSync(path, 'utf8')));
}

export function writeWorkerReportStoreFile(path, store) {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(normalizeWorkerReportStore(store))}\n`, 'utf8');
  renameSync(tempPath, path);
}

export function upsertWorkerReportRecord(store, record, nowMs) {
  const key = buildWorkerReportRecordKey(record);
  const existing = store.sourceRecords[key] ?? {};
  store.sourceRecords[key] = {
    ...existing,
    reportState: String(record.reportState ?? existing.reportState ?? '').toLowerCase(),
    accepted: record.accepted !== undefined ? Boolean(record.accepted) : Boolean(existing.accepted ?? true),
    repoSlug: String(record.repoSlug ?? existing.repoSlug ?? '').trim(),
    worker: normalizeWorkerIdentity(record.worker ?? existing.worker),
    prNumber: Number(record.prNumber ?? existing.prNumber ?? 0),
    headSha: normalizeSha(record.headSha ?? existing.headSha),
    reportedAtMs: Number(record.reportedAtMs ?? nowMs),
    lastObservedMs: nowMs,
    deliveryRunId: record.deliveryRunId ? String(record.deliveryRunId) : existing.deliveryRunId,
    note: record.note !== undefined ? String(record.note) : existing.note,
    reason: record.reason !== undefined ? String(record.reason) : existing.reason,
    handoffKind: record.handoffKind !== undefined ? String(record.handoffKind) : existing.handoffKind,
    degradedCiEscalation: record.degradedCiEscalation !== undefined
      ? Boolean(record.degradedCiEscalation)
      : Boolean(existing.degradedCiEscalation ?? false),
  };
  store.lastUpdatedMs = nowMs;
  store.generation = Number(store.generation ?? 0) + 1;
  return { key, record: store.sourceRecords[key] };
}

export function listWorkerReportRecordsForWorker(store, repoSlug, worker) {
  const repo = String(repoSlug ?? '').trim().toLowerCase();
  const exact = normalizeWorkerIdentity(worker);
  if (!exact) return [];
  return Object.values(store.sourceRecords ?? {}).filter((record) => (
    String(record?.repoSlug ?? '').trim().toLowerCase() === repo
      && sameWorker(record?.worker, exact)
  ));
}

export function workerReportRecordToRuntimeReportRow(record) {
  const reportedAtMs = Number(record?.reportedAtMs ?? record?.lastObservedMs ?? 0);
  return {
    reportState: String(record?.reportState ?? '').toLowerCase(),
    accepted: Boolean(record?.accepted ?? true),
    prNumber: Number(record?.prNumber ?? 0) || undefined,
    headSha: normalizeSha(record?.headSha) || undefined,
    repoSlug: String(record?.repoSlug ?? '').trim() || undefined,
    worker: normalizeWorkerIdentity(record?.worker) ?? undefined,
    deliveryRunId: record?.deliveryRunId ? String(record.deliveryRunId) : undefined,
    note: record?.note ? String(record.note) : undefined,
    reason: record?.reason ? String(record.reason) : undefined,
    handoffKind: record?.handoffKind ? String(record.handoffKind) : undefined,
    degradedCiEscalation: record?.degradedCiEscalation !== undefined ? Boolean(record.degradedCiEscalation) : undefined,
    reportedAt: reportedAtMs > 0 ? new Date(reportedAtMs).toISOString() : undefined,
    timestamp: reportedAtMs > 0 ? new Date(reportedAtMs).toISOString() : undefined,
    source: PACK_WORKER_REPORT_STORE_SURFACE,
  };
}

export function mergePackWorkerReportsIntoWorkers(workers, store, repoSlug = '') {
  const repo = String(repoSlug ?? '').trim().toLowerCase();
  return toArray(workers).map((workerRow) => {
    const identity = normalizeWorkerIdentity(workerRow?.identity ?? workerRow?.worker);
    const rowRepo = String(workerRow?.repoSlug ?? repo ?? '').trim().toLowerCase();
    const records = listWorkerReportRecordsForWorker(store, rowRepo, identity)
      .sort((a, b) => Number(b.reportedAtMs ?? 0) - Number(a.reportedAtMs ?? 0))
      .map(workerReportRecordToRuntimeReportRow);
    if (records.length === 0) {
      if (String(workerRow?.reportSnapshotKind ?? '') === PACK_WORKER_REPORT_STORE_SURFACE) {
        const next = { ...workerRow };
        delete next.reports;
        delete next.reportSourcePath;
        delete next.reportSnapshotKind;
        return next;
      }
      return workerRow;
    }
    return {
      ...workerRow,
      reports: records,
      reportSourcePath: `pack-worker-report-store/${rowRepo}/${workerKey(identity)}`,
      reportSnapshotKind: PACK_WORKER_REPORT_STORE_SURFACE,
    };
  });
}

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
    if (prNumber <= 0) continue;
    const prRepo = scopeRepo || String(pr?.repoSlug ?? pr?.repository ?? '').trim().toLowerCase();
    openByRepoPr.set(prRepo ? `${prRepo}|${prNumber}` : String(prNumber), pr);
  }
  let removed = 0;
  for (const [key, record] of Object.entries(store.sourceRecords ?? {})) {
    const prNumber = Number(record?.prNumber ?? 0);
    const recordRepo = String(record?.repoSlug ?? '').trim().toLowerCase();
    const recordHead = normalizeSha(record?.headSha);
    const prKey = recordRepo ? `${recordRepo}|${prNumber}` : String(prNumber);
    const inScope = !scopeRepo || !recordRepo || recordRepo === scopeRepo;
    const openPr = inScope ? (openByRepoPr.get(prKey) ?? (scopeRepo ? undefined : openByRepoPr.get(String(prNumber)))) : undefined;
    const currentHead = inScope ? normalizeSha(currentHeadByPr[prKey] ?? (scopeRepo ? undefined : currentHeadByPr[String(prNumber)])) : undefined;
    const prState = String(openPr?.state ?? '').toLowerCase();
    const terminal = (Boolean(openPr) && (prState === 'closed' || prState === 'merged' || openPr?.merged === true || openPr?.closed === true))
      || (openListAuthoritative && inScope && !openPr);
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

export function resolveWorkerReportTrustedBinding({ worker, openPrs = [], worktreeHeadSha = '', prNumber = 0 }) {
  const exactWorker = normalizeWorkerIdentity(worker);
  if (!exactWorker) return { ok: false, reason: 'missing_runtime_worker_identity' };
  const headSha = normalizeSha(worktreeHeadSha);
  if (!headSha) return { ok: false, reason: 'missing_worktree_head' };
  const pr = Number(prNumber ?? 0);
  if (!Number.isInteger(pr) || pr <= 0) return { ok: false, reason: 'missing_pr_number' };
  const row = toArray(openPrs).find((candidate) => Number(candidate?.number ?? 0) === pr);
  if (!row) return { ok: false, reason: 'pr_binding_unresolved' };
  const openHead = normalizeSha(row?.headRefOid);
  if (!openHead || openHead !== headSha) return { ok: false, reason: 'trust_boundary_head_mismatch' };
  return { ok: true, prNumber: pr, headSha, worker: exactWorker, bindingSource: 'explicit_github_task' };
}

export function validateWorkerReportTrustBoundary({ record, trustedBinding = null }) {
  const worker = normalizeWorkerIdentity(record?.worker);
  if (!worker) return { ok: false, reason: 'missing_runtime_worker_identity' };
  if (!String(record?.repoSlug ?? '').trim()) return { ok: false, reason: 'missing_repo_slug' };
  if (Number(record?.prNumber ?? 0) <= 0) return { ok: false, reason: 'missing_pr_number' };
  if (!normalizeSha(record?.headSha)) return { ok: false, reason: 'missing_head_sha' };
  if (!WORKER_REPORT_STATES.includes(String(record?.reportState ?? '').toLowerCase())) return { ok: false, reason: 'invalid_report_state' };
  if (!trustedBinding || trustedBinding.ok !== true) return { ok: false, reason: String(trustedBinding?.reason ?? 'trust_boundary_binding_unresolved') };
  if (!sameWorker(worker, trustedBinding.worker)) return { ok: false, reason: 'trust_boundary_worker_mismatch' };
  if (Number(record?.prNumber ?? 0) !== Number(trustedBinding.prNumber ?? 0)) return { ok: false, reason: 'trust_boundary_pr_mismatch' };
  if (normalizeSha(record?.headSha) !== normalizeSha(trustedBinding.headSha)) return { ok: false, reason: 'trust_boundary_head_mismatch' };
  return { ok: true };
}

export function workerHasPackWorkerReportReceiptSurface(worker) {
  return String(worker?.reportSnapshotKind ?? '') === PACK_WORKER_REPORT_STORE_SURFACE && toArray(worker?.reports).length > 0;
}

export function resolvePackWorkerReportDeliveryRunId({ reportState = '', prNumber = 0, headSha = '', deliveryRunId = '', reviewRuns = [] }) {
  if (String(reportState ?? '').toLowerCase() !== 'addressing_reviews') return '';
  const explicit = String(deliveryRunId ?? '').trim();
  if (explicit) return explicit;
  const pr = Number(prNumber ?? 0);
  const head = normalizeSha(headSha);
  if (pr <= 0 || !head) return '';
  for (const run of toArray(reviewRuns)) {
    if (Number(run?.prNumber ?? 0) !== pr) continue;
    const targetHead = normalizeSha(run?.targetSha ?? run?.headSha);
    if (targetHead && targetHead !== head) continue;
    if (!isPendingWorkerDeliveryConfirmation(run)) continue;
    const runId = String(run?.id ?? run?.runId ?? '').trim();
    if (runId) return runId;
  }
  return '';
}

export function findPackWorkerAckReportAfterDelivery(worker, run, sendObservedAtMs) {
  if (!workerHasPackWorkerReportReceiptSurface(worker)) return null;
  const runHead = normalizeSha(run?.targetSha ?? run?.headSha);
  const runId = String(run?.id ?? run?.runId ?? '').trim();
  for (const report of toArray(worker?.reports)) {
    if (String(report?.reportState ?? '').toLowerCase() !== 'addressing_reviews') continue;
    const reportHead = normalizeSha(report?.headSha);
    if (runHead && reportHead && reportHead !== runHead) continue;
    const timestamp = Date.parse(String(report?.reportedAt ?? report?.timestamp ?? '')) || 0;
    if (timestamp <= sendObservedAtMs) continue;
    if (runId && String(report?.deliveryRunId ?? '').trim() !== runId) continue;
    return report;
  }
  return null;
}

export function upsertWorkerReportRecordInMemory({ store, record, nowMs, trustedBinding = null }) {
  const trust = validateWorkerReportTrustBoundary({ record, trustedBinding });
  if (!trust.ok) return { ok: false, reason: trust.reason };
  const normalized = normalizeWorkerReportStore(store ?? {});
  const result = upsertWorkerReportRecord(normalized, record, nowMs);
  return { ok: true, store: normalized, key: result.key, record: result.record, generation: normalized.generation };
}

export function writeWorkerReportRecordWithCas({ storePath, record, nowMs, expectedGeneration, trustedBinding = null }) {
  const trust = validateWorkerReportTrustBoundary({ record, trustedBinding });
  if (!trust.ok) return { ok: false, reason: trust.reason };
  if (expectedGeneration === undefined || expectedGeneration === null) return { ok: false, reason: 'missing_expected_generation' };
  const store = readWorkerReportStoreFile(storePath);
  if (Number(store.generation ?? 0) !== Number(expectedGeneration)) return { ok: false, reason: 'generation_mismatch', generation: store.generation };
  const result = upsertWorkerReportRecord(store, record, nowMs);
  writeWorkerReportStoreFile(storePath, store);
  return { ok: true, key: result.key, record: result.record, generation: store.generation };
}

export function seedShouldPromoteReadyForReview(store, repoSlug, prNumber, headSha, currentHeadSha) {
  const repo = String(repoSlug ?? '').trim().toLowerCase();
  const head = normalizeSha(headSha);
  const current = normalizeSha(currentHeadSha);
  if (current && head && current !== head) return { promote: false, reason: 'superseded_head' };
  for (const record of Object.values(store.sourceRecords ?? {})) {
    if (String(record?.repoSlug ?? '').trim().toLowerCase() !== repo) continue;
    if (Number(record?.prNumber ?? 0) !== Number(prNumber)) continue;
    if (normalizeSha(record?.headSha) !== head) continue;
    if (String(record?.reportState ?? '').toLowerCase() === 'ready_for_review' && Boolean(record?.accepted ?? true)) return { promote: true, record };
  }
  return { promote: false, reason: 'no_ready_record' };
}

runStdinJsonCli('worker-report-store.mjs', {
  normalize: () => normalizeWorkerReportStore(readStdinJson()),
  mergeIntoWorkers: () => {
    const payload = readStdinJson();
    return mergePackWorkerReportsIntoWorkers(toArray(payload.workers), normalizeWorkerReportStore(payload.store ?? {}), String(payload.repoSlug ?? ''));
  },
  evict: () => {
    const payload = readStdinJson();
    const store = normalizeWorkerReportStore(payload.store ?? {});
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
    return { deliveryRunId: resolvePackWorkerReportDeliveryRunId({
      reportState: String(payload.reportState ?? ''),
      prNumber: Number(payload.prNumber ?? 0),
      headSha: String(payload.headSha ?? ''),
      deliveryRunId: String(payload.deliveryRunId ?? ''),
      reviewRuns: toArray(payload.reviewRuns),
    }) };
  },
  resolveTrustedBinding: () => {
    const payload = readStdinJson();
    return resolveWorkerReportTrustedBinding({
      worker: payload.worker ?? null,
      openPrs: toArray(payload.openPrs),
      worktreeHeadSha: String(payload.worktreeHeadSha ?? ''),
      prNumber: Number(payload.prNumber ?? 0),
    });
  },
  upsertRecord: () => {
    const payload = readStdinJson();
    return upsertWorkerReportRecordInMemory({
      store: normalizeWorkerReportStore(payload.store ?? {}),
      record: payload.record ?? {},
      nowMs: Number(payload.nowMs ?? Date.now()),
      trustedBinding: payload.trustedBinding ?? null,
    });
  },
  writeRecord: () => {
    const payload = readStdinJson();
    return writeWorkerReportRecordWithCas({
      storePath: String(payload.storePath ?? resolveWorkerReportStorePath()),
      record: payload.record ?? {},
      nowMs: Number(payload.nowMs ?? Date.now()),
      expectedGeneration: payload.expectedGeneration,
      trustedBinding: payload.trustedBinding ?? null,
    });
  },
  seedShouldPromote: () => {
    const payload = readStdinJson();
    return seedShouldPromoteReadyForReview(normalizeWorkerReportStore(payload.store ?? {}), String(payload.repoSlug ?? ''), Number(payload.prNumber ?? 0), String(payload.headSha ?? ''), String(payload.currentHeadSha ?? ''));
  },
  findPackAck: () => {
    const payload = readStdinJson();
    return findPackWorkerAckReportAfterDelivery(payload.worker ?? {}, payload.run ?? {}, Number(payload.sendObservedAtMs ?? 0));
  },
});
