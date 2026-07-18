/** Pack-owned worker report store with the Issue #857 binding contract. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { readStdinJson, runStdinJsonCli } from './review-mechanical-cli.mjs';
import { normalizeSha } from './review-reconcile-primitives.mjs';
import {
  buildSessionBindingKey,
  createDefaultPrSessionBindingCache,
  readPrSessionBindingCacheFile,
  resolveBindingRepoSlug,
  resolvePrSessionBindingCachePath,
  resolveSessionPrBindingForConsumer,
  writePrSessionBindingCacheFile,
} from './pr-session-binding-cache.mjs';
import { isPendingWorkerDeliveryConfirmation } from './review-producer-contract.mjs';

const array = (v) => Array.isArray(v) ? v : v == null ? [] : [v];
const sessionIdOf = (s) => String(s?.sessionId ?? s?.id ?? s?.name ?? '').trim();
export const WORKER_REPORT_STORE_SCHEMA_VERSION = 2;
export const PACK_WORKER_REPORT_STORE_SURFACE = 'pack-worker-report-store';
export const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_NONTERMINAL_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
export const WORKER_REPORT_STATES = Object.freeze(['ready_for_review', 'fixing_ci', 'addressing_reviews', 'completed', 'blocked', 'pr_created', 'working', 'started']);

export function resolveWorkerReportStorePath(env = process.env) {
  if (env.AO_WORKER_REPORT_STORE) return String(env.AO_WORKER_REPORT_STORE);
  if (env.AO_REPORT_STATE_SEED_STATE) return join(dirname(String(env.AO_REPORT_STATE_SEED_STATE)), 'worker-report-store.json');
  return join(homedir(), '.local', 'state', 'orchestrator-pack-wake-supervisor', 'worker-report-store.json');
}

export function buildWorkerReportRecordKey(record) {
  const base = `${String(record?.repoSlug ?? '').trim().toLowerCase()}|${String(record?.sessionId ?? '').trim()}|${Number(record?.prNumber ?? 0)}|${normalizeSha(record?.headSha)}`;
  if (String(record?.reportState ?? '').toLowerCase() !== 'addressing_reviews') return base;
  const suffix = String(record?.deliveryRunId ?? '').trim() || Number(record?.reportedAtMs ?? record?.lastObservedMs ?? 0) || '';
  return `${base}|ack${suffix ? `|${suffix}` : ''}`;
}

export function createDefaultWorkerReportStore(raw = {}) {
  return {
    schemaVersion: 2, lastUpdatedMs: Number(raw.lastUpdatedMs ?? 0) || null, generation: Number(raw.generation ?? 0) || 0,
    sourceRecords: raw.sourceRecords && typeof raw.sourceRecords === 'object' ? { ...raw.sourceRecords } : raw.records && typeof raw.records === 'object' ? { ...raw.records } : {},
    bindingByKey: raw.bindingByKey && typeof raw.bindingByKey === 'object' ? { ...raw.bindingByKey } : {},
    seededKeys: Array.isArray(raw.seededKeys) ? [...raw.seededKeys] : [],
    deferredScanKeys: Array.isArray(raw.deferredScanKeys) ? [...raw.deferredScanKeys] : [],
    githubSnapshot: raw.githubSnapshot ?? null,
  };
}
export const migrateLegacySeedStateToWorkerReportStore = (legacy) => createDefaultWorkerReportStore(legacy && typeof legacy === 'object' ? legacy : {});
export const readWorkerReportStoreFile = (path) => existsSync(path) ? migrateLegacySeedStateToWorkerReportStore(JSON.parse(readFileSync(path, 'utf8'))) : createDefaultWorkerReportStore();
export function writeWorkerReportStoreFile(path, store) { mkdirSync(dirname(path), { recursive: true }); const tmp = `${path}.tmp`; writeFileSync(tmp, `${JSON.stringify(store)}\n`, 'utf8'); renameSync(tmp, path); }

export function upsertWorkerReportRecord(store, input, nowMs) {
  const key = buildWorkerReportRecordKey(input), old = store.sourceRecords[key] ?? {};
  store.sourceRecords[key] = {
    ...old, reportState: String(input.reportState ?? old.reportState ?? '').toLowerCase(),
    accepted: input.accepted !== undefined ? Boolean(input.accepted) : Boolean(old.accepted ?? true),
    repoSlug: String(input.repoSlug ?? old.repoSlug ?? '').trim(), sessionId: String(input.sessionId ?? old.sessionId ?? '').trim(),
    prNumber: Number(input.prNumber ?? old.prNumber ?? 0), headSha: normalizeSha(input.headSha ?? old.headSha),
    reportedAtMs: Number(input.reportedAtMs ?? nowMs), lastObservedMs: nowMs,
    deliveryRunId: input.deliveryRunId ? String(input.deliveryRunId) : old.deliveryRunId,
    note: input.note !== undefined ? String(input.note) : old.note, reason: input.reason !== undefined ? String(input.reason) : old.reason,
    handoffKind: input.handoffKind !== undefined ? String(input.handoffKind) : old.handoffKind,
    degradedCiEscalation: input.degradedCiEscalation !== undefined ? Boolean(input.degradedCiEscalation) : Boolean(old.degradedCiEscalation ?? false),
  };
  store.lastUpdatedMs = nowMs; store.generation = Number(store.generation ?? 0) + 1;
  return { key, record: store.sourceRecords[key] };
}

export function listWorkerReportRecordsForSession(store, repoSlug, sessionId) {
  const repo = String(repoSlug ?? '').trim().toLowerCase(), id = String(sessionId ?? '').trim();
  return Object.values(store.sourceRecords ?? {}).filter((r) => String(r?.repoSlug ?? '').trim().toLowerCase() === repo && String(r?.sessionId ?? '').trim() === id);
}

export function workerReportRecordToSessionReportRow(r) {
  const ms = Number(r?.reportedAtMs ?? r?.lastObservedMs ?? 0);
  return {
    reportState: String(r?.reportState ?? '').toLowerCase(), accepted: Boolean(r?.accepted ?? true),
    prNumber: Number(r?.prNumber ?? 0) || undefined, headSha: normalizeSha(r?.headSha) || undefined,
    repoSlug: String(r?.repoSlug ?? '').trim() || undefined, deliveryRunId: r?.deliveryRunId ? String(r.deliveryRunId) : undefined,
    note: r?.note ? String(r.note) : undefined, reason: r?.reason ? String(r.reason) : undefined,
    handoffKind: r?.handoffKind ? String(r.handoffKind) : undefined,
    degradedCiEscalation: r?.degradedCiEscalation !== undefined ? Boolean(r.degradedCiEscalation) : undefined,
    reportedAt: ms > 0 ? new Date(ms).toISOString() : undefined, timestamp: ms > 0 ? new Date(ms).toISOString() : undefined,
    source: PACK_WORKER_REPORT_STORE_SURFACE,
  };
}

export function mergePackWorkerReportsIntoSessions(sessions, store, repoSlug = '') {
  const fallbackRepo = String(repoSlug ?? '').trim().toLowerCase();
  return array(sessions).map((session) => {
    const id = sessionIdOf(session), scope = String(session?.repoSlug ?? fallbackRepo).trim().toLowerCase();
    const reports = listWorkerReportRecordsForSession(store, scope, id).sort((a, b) => Number(b.reportedAtMs ?? 0) - Number(a.reportedAtMs ?? 0)).map(workerReportRecordToSessionReportRow);
    if (!reports.length) {
      if (String(session?.reportSnapshotKind ?? '') !== PACK_WORKER_REPORT_STORE_SURFACE) return session;
      const next = { ...session }; delete next.reports; delete next.reportSourcePath; delete next.reportSnapshotKind; return next;
    }
    return { ...session, reports, reportSourcePath: `pack-worker-report-store/${scope}/${id}`, reportSnapshotKind: PACK_WORKER_REPORT_STORE_SURFACE };
  });
}

export function evictWorkerReportRecords({ store, openPrs = [], currentHeadByPr = {}, nowMs, maxAgeMs = DEFAULT_MAX_AGE_MS, nonterminalMaxAgeMs = DEFAULT_NONTERMINAL_MAX_AGE_MS, openListAuthoritative = false, repoSlug = '' }) {
  const scope = String(repoSlug ?? '').trim().toLowerCase(), open = new Map();
  for (const pr of array(openPrs)) {
    const number = Number(pr?.number ?? 0), rowRepo = scope || String(pr?.repoSlug ?? pr?.repository ?? '').trim().toLowerCase();
    if (number > 0) open.set(rowRepo ? `${rowRepo}|${number}` : String(number), pr);
  }
  let removed = 0;
  for (const [key, record] of Object.entries(store.sourceRecords ?? {})) {
    const number = Number(record?.prNumber ?? 0), rowRepo = String(record?.repoSlug ?? '').trim().toLowerCase();
    const scoped = !scope || !rowRepo || rowRepo === scope, prKey = rowRepo ? `${rowRepo}|${number}` : String(number);
    const pr = scoped ? (open.get(prKey) ?? (scope ? undefined : open.get(String(number)))) : undefined;
    const state = String(pr?.state ?? '').toLowerCase(), terminal = Boolean(pr) && (['closed', 'merged'].includes(state) || pr?.merged === true || pr?.closed === true);
    const absentTerminal = openListAuthoritative && scoped && !pr, current = scoped ? normalizeSha(currentHeadByPr[prKey] ?? currentHeadByPr[String(number)]) : '';
    const staleHead = current && normalizeSha(record?.headSha) && current !== normalizeSha(record?.headSha), observed = Number(record?.lastObservedMs ?? record?.reportedAtMs ?? 0);
    const stale = observed > 0 && nowMs - observed > ((terminal || absentTerminal) ? maxAgeMs : nonterminalMaxAgeMs);
    if (terminal || absentTerminal || staleHead || stale) { delete store.sourceRecords[key]; removed += 1; }
  }
  if (removed) { store.lastUpdatedMs = nowMs; store.generation = Number(store.generation ?? 0) + 1; }
  return { removed, recordCount: Object.keys(store.sourceRecords ?? {}).length };
}

function getBindingStore(bindingStore, cachePath) {
  if (bindingStore) return createDefaultPrSessionBindingCache(bindingStore);
  try { return readPrSessionBindingCacheFile(cachePath ?? resolvePrSessionBindingCachePath()); }
  catch { return createDefaultPrSessionBindingCache(); }
}

export function resolveWorkerReportTrustedBinding({ session, openPrs = [], worktreeHeadSha = '', repoSlug = '', cachePath, bindingStore, nowMs = Date.now(), openListAuthoritative = false, writeBackfill = true }) {
  const headSha = normalizeSha(worktreeHeadSha);
  if (!headSha) return { ok: false, reason: 'missing_worktree_head', sessionId: sessionIdOf(session) || null };
  const hasBulkPrList = Object.prototype.hasOwnProperty.call(session ?? {}, 'prs');
  const explicitCallerPr = !hasBulkPrList && !session?.role && !session?.status
    ? Number(session?.prNumber ?? 0)
    : 0;
  if (explicitCallerPr > 0) {
    const explicitRow = array(openPrs).find((row) => Number(row?.number ?? 0) === explicitCallerPr);
    const explicitHead = normalizeSha(explicitRow?.headRefOid);
    if (explicitHead && explicitHead !== headSha) {
      return { ok: false, reason: 'trust_boundary_head_mismatch', sessionId: sessionIdOf(session) || null };
    }
    return {
      ok: true,
      prNumber: explicitCallerPr,
      headSha,
      sessionId: sessionIdOf(session) || null,
      bindingSource: 'explicit_caller',
      bindingReason: 'explicit_caller',
    };
  }
  const scope = resolveBindingRepoSlug({ repoSlug: repoSlug || session?.repoSlug }, openPrs);
  if (!scope) return { ok: false, reason: 'missing_repo_slug', sessionId: sessionIdOf(session) || null };
  const result = resolveSessionPrBindingForConsumer({
    store: getBindingStore(bindingStore, cachePath), cachePath, repoSlug: scope, session, openPrs,
    headSha, nowMs, openListAuthoritative, writeBackfill,
  });
  if (!result.bound) return { ok: false, ...result };
  const pr = array(openPrs).find((row) => Number(row?.number ?? 0) === Number(result.prNumber));
  const openHead = normalizeSha(pr?.headRefOid);
  if (openHead && openHead !== headSha) return { ok: false, reason: 'trust_boundary_head_mismatch', sessionId: result.sessionId };
  return { ok: true, prNumber: Number(result.prNumber), headSha, sessionId: result.sessionId, bindingSource: result.bindingSource ?? result.source, bindingReason: result.reason, bindingCacheGeneration: result.bindingCacheGeneration };
}

export function resolveWorkerReportTrustedBindings({ sessions = [], openPrs = [], repoSlug = '', cachePath, bindingStore, worktreeHeadSha = '', worktreeHeadBySession = {}, nowMs = Date.now(), openListAuthoritative = false, writeBackfill = true }) {
  const scope = resolveBindingRepoSlug({ repoSlug }, openPrs), path = cachePath ?? resolvePrSessionBindingCachePath();
  const store = getBindingStore(bindingStore, path), bindingByKey = {};
  for (const session of array(sessions)) {
    const id = sessionIdOf(session); if (!id) continue;
    const result = resolveSessionPrBindingForConsumer({ store, repoSlug: scope || String(session?.repoSlug ?? ''), session, openPrs, headSha: worktreeHeadBySession[id] ?? worktreeHeadSha, nowMs, openListAuthoritative, writeBackfill: false });
    bindingByKey[buildSessionBindingKey(scope || session?.repoSlug, id)] = result;
  }
  if (writeBackfill && cachePath && !bindingStore) writePrSessionBindingCacheFile(path, store);
  return { bindingByKey, callCounts: { bulkSessionList: 1, sessionDetail: 0 }, cacheGeneration: Number(store.generation ?? 0) };
}

export function validateWorkerReportTrustBoundary({ callerSessionId, record, trustedBinding = null }) {
  const caller = String(callerSessionId ?? '').trim(), target = String(record?.sessionId ?? '').trim();
  if (!caller || !target || caller !== target) return { ok: false, reason: 'trust_boundary_session_mismatch' };
  if (!String(record?.repoSlug ?? '').trim()) return { ok: false, reason: 'missing_repo_slug' };
  if (Number(record?.prNumber ?? 0) <= 0) return { ok: false, reason: 'missing_pr_number' };
  if (!normalizeSha(record?.headSha)) return { ok: false, reason: 'missing_head_sha' };
  if (!WORKER_REPORT_STATES.includes(String(record?.reportState ?? '').toLowerCase())) return { ok: false, reason: 'invalid_report_state' };
  if (trustedBinding?.ok !== true) return { ok: false, reason: String(trustedBinding?.reason ?? 'no_source') };
  if (Number(record.prNumber) !== Number(trustedBinding.prNumber)) return { ok: false, reason: 'trust_boundary_pr_mismatch' };
  if (normalizeSha(record.headSha) !== normalizeSha(trustedBinding.headSha)) return { ok: false, reason: 'trust_boundary_head_mismatch' };
  return { ok: true };
}

export const sessionHasPackWorkerReportReceiptSurface = (session) => String(session?.reportSnapshotKind ?? '') === PACK_WORKER_REPORT_STORE_SURFACE && array(session?.reports).length > 0;
export function resolvePackWorkerReportDeliveryRunId({ reportState = '', sessionId = '', prNumber = 0, headSha = '', deliveryRunId = '', reviewRuns = [] }) {
  if (String(reportState).toLowerCase() !== 'addressing_reviews') return '';
  if (String(deliveryRunId).trim()) return String(deliveryRunId).trim();
  const head = normalizeSha(headSha);
  for (const run of array(reviewRuns)) {
    if (String(run?.linkedSessionId ?? '').trim() !== String(sessionId).trim() || Number(run?.prNumber) !== Number(prNumber)) continue;
    if (head && normalizeSha(run?.targetSha) && normalizeSha(run.targetSha) !== head) continue;
    if (isPendingWorkerDeliveryConfirmation(run)) return String(run?.id ?? run?.reviewerSessionId ?? '').trim();
  }
  return '';
}

export function findPackWorkerAckReportAfterDelivery(session, run, sendObservedAtMs) {
  if (!sessionHasPackWorkerReportReceiptSurface(session)) return null;
  const head = normalizeSha(run?.targetSha), runId = String(run?.id ?? run?.reviewerSessionId ?? '').trim();
  return array(session.reports).find((report) => {
    if (String(report?.reportState ?? report?.report_state ?? '').toLowerCase() !== 'addressing_reviews') return false;
    const reportHead = normalizeSha(report?.headSha ?? report?.headRefOid); if (head && reportHead && head !== reportHead) return false;
    if ((Date.parse(String(report?.reportedAt ?? report?.timestamp ?? report?.createdAt ?? '')) || 0) <= sendObservedAtMs) return false;
    return !runId || String(report?.deliveryRunId ?? '').trim() === runId;
  }) ?? null;
}

export function upsertWorkerReportRecordInMemory({ store, record, callerSessionId, nowMs, trustedBinding = null }) {
  const trust = validateWorkerReportTrustBoundary({ callerSessionId, record, trustedBinding }); if (!trust.ok) return trust;
  const next = createDefaultWorkerReportStore(store ?? {}), result = upsertWorkerReportRecord(next, record, nowMs);
  return { ok: true, store: next, key: result.key, record: result.record, generation: next.generation };
}
export function writeWorkerReportRecordWithCas({ storePath, record, callerSessionId, nowMs, expectedGeneration, trustedBinding = null }) {
  const trust = validateWorkerReportTrustBoundary({ callerSessionId, record, trustedBinding }); if (!trust.ok) return trust;
  if (expectedGeneration == null) return { ok: false, reason: 'missing_expected_generation' };
  const store = readWorkerReportStoreFile(storePath); if (Number(store.generation) !== Number(expectedGeneration)) return { ok: false, reason: 'generation_mismatch', generation: store.generation };
  const result = upsertWorkerReportRecord(store, record, nowMs); writeWorkerReportStoreFile(storePath, store);
  return { ok: true, key: result.key, record: result.record, generation: store.generation };
}
export function seedShouldPromoteReadyForReview(store, repoSlug, prNumber, headSha, currentHeadSha) {
  const scope = String(repoSlug ?? '').trim().toLowerCase(), head = normalizeSha(headSha), current = normalizeSha(currentHeadSha);
  if (current && head && current !== head) return { promote: false, reason: 'superseded_head' };
  const record = Object.values(store.sourceRecords ?? {}).find((r) => String(r?.repoSlug ?? '').trim().toLowerCase() === scope && Number(r?.prNumber) === Number(prNumber) && normalizeSha(r?.headSha) === head && String(r?.reportState ?? '').toLowerCase() === 'ready_for_review' && Boolean(r?.accepted ?? true));
  return record ? { promote: true, record } : { promote: false, reason: 'no_ready_record' };
}

runStdinJsonCli('worker-report-store.mjs', {
  migrate: () => migrateLegacySeedStateToWorkerReportStore(readStdinJson()),
  mergeIntoSessions: () => { const p = readStdinJson(); return mergePackWorkerReportsIntoSessions(array(p.sessions), createDefaultWorkerReportStore(p.store ?? {}), String(p.repoSlug ?? '')); },
  evict: () => { const p = readStdinJson(), store = createDefaultWorkerReportStore(p.store ?? {}); return { ...evictWorkerReportRecords({ store, openPrs: array(p.openPrs), currentHeadByPr: p.currentHeadByPr ?? {}, nowMs: Number(p.nowMs ?? Date.now()), maxAgeMs: Number(p.maxAgeMs ?? DEFAULT_MAX_AGE_MS), nonterminalMaxAgeMs: Number(p.nonterminalMaxAgeMs ?? DEFAULT_NONTERMINAL_MAX_AGE_MS), openListAuthoritative: Boolean(p.openListAuthoritative), repoSlug: String(p.repoSlug ?? '') }), store }; },
  resolveDeliveryRunId: () => { const p = readStdinJson(); return { deliveryRunId: resolvePackWorkerReportDeliveryRunId({ ...p, reviewRuns: array(p.reviewRuns) }) }; },
  resolveTrustedBinding: () => { const p = readStdinJson(); return resolveWorkerReportTrustedBinding({ session: p.session ?? {}, openPrs: array(p.openPrs), worktreeHeadSha: String(p.worktreeHeadSha ?? ''), repoSlug: String(p.repoSlug ?? ''), cachePath: p.cachePath ? String(p.cachePath) : undefined, nowMs: Number(p.nowMs ?? Date.now()), openListAuthoritative: Boolean(p.openListAuthoritative), writeBackfill: p.writeBackfill !== false }); },
  resolveTrustedBindings: () => { const p = readStdinJson(); return resolveWorkerReportTrustedBindings({ sessions: array(p.sessions), openPrs: array(p.openPrs), repoSlug: String(p.repoSlug ?? ''), cachePath: p.cachePath ? String(p.cachePath) : undefined, worktreeHeadSha: String(p.worktreeHeadSha ?? ''), worktreeHeadBySession: p.worktreeHeadBySession ?? {}, nowMs: Number(p.nowMs ?? Date.now()), openListAuthoritative: Boolean(p.openListAuthoritative), writeBackfill: p.writeBackfill !== false }); },
  upsertRecord: () => { const p = readStdinJson(); return upsertWorkerReportRecordInMemory({ store: createDefaultWorkerReportStore(p.store ?? {}), record: p.record ?? {}, callerSessionId: String(p.callerSessionId ?? ''), nowMs: Number(p.nowMs ?? Date.now()), trustedBinding: p.trustedBinding ?? null }); },
  writeRecord: () => { const p = readStdinJson(); return writeWorkerReportRecordWithCas({ storePath: String(p.storePath ?? resolveWorkerReportStorePath()), record: p.record ?? {}, callerSessionId: String(p.callerSessionId ?? ''), nowMs: Number(p.nowMs ?? Date.now()), expectedGeneration: p.expectedGeneration, trustedBinding: p.trustedBinding ?? null }); },
  seedShouldPromote: () => { const p = readStdinJson(); return seedShouldPromoteReadyForReview(createDefaultWorkerReportStore(p.store ?? {}), String(p.repoSlug ?? ''), Number(p.prNumber ?? 0), String(p.headSha ?? ''), String(p.currentHeadSha ?? '')); },
  findPackAck: () => { const p = readStdinJson(); return findPackWorkerAckReportAfterDelivery(p.session ?? {}, p.run ?? {}, Number(p.sendObservedAtMs ?? 0)); },
});
