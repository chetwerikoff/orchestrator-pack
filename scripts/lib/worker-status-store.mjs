/**
 * Pack-owned worker derived status store (Issue #720).
 * Vitest: scripts/worker-status-store.test.ts
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { normalizeSha, toArray } from '../../docs/review-reconcile-primitives.mjs';
import { classifyRequiredCiLevel } from '../../docs/review-ready-stuck-guard.mjs';
import { readStdinJson, runStdinJsonCli } from '../../docs/review-mechanical-cli.mjs';

export const WORKER_STATUS_STORE_SCHEMA_VERSION = 1;
export const PACK_WORKER_STATUS_STORE_SURFACE = 'pack-worker-status-store';
export const KILL_SWITCH_ENV = 'PACK_WORKER_STATUS_STORE_DISABLED';
export const DEFAULT_FRESHNESS_MS = 15 * 60 * 1000;
export const DEFAULT_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

export const DERIVED_STATUSES = Object.freeze([
  'review_active',
  'ready_for_review',
  'ci_failed',
  'pr_open',
  'needs_input',
  'dead',
  'unknown',
  'stale',
]);

const TERMINAL_SESSION_RE = /^(terminated|killed|exited|dead|closed)$/i;
const WAITING_INPUT_RE = /(needs_input|waiting_input|input_required|awaiting_input|stuck)/i;
const REVIEW_ACTIVE_RE = /^(queued|running|sent_to_agent|waiting_update|pending|in_progress)$/i;
const REVIEW_DELIVERED_STATUSES = ['changes_requested', 'needs_' + 'triage', 'delivered'];
const REVIEW_DELIVERED_RE = new RegExp(`^(${REVIEW_DELIVERED_STATUSES.join('|')})$`, 'i');
const SUCCESS_CHECK_RE = /^(success|successful|passed|pass|neutral|skipped)$/i;
const FAILURE_CHECK_RE = /^(failure|failed|fail|error|cancelled|timed_out|action_required)$/i;
const PENDING_CHECK_RE = /^(pending|queued|in_progress|running|waiting|requested)$/i;

export function resolveWorkerStatusStorePath(env = process.env) {
  if (env.AO_WORKER_STATUS_STORE) {
    return String(env.AO_WORKER_STATUS_STORE);
  }
  if (env.ORCHESTRATOR_PACK_WAKE_SUPERVISOR_STATE_DIR) {
    return join(String(env.ORCHESTRATOR_PACK_WAKE_SUPERVISOR_STATE_DIR), 'worker-status-store.json');
  }
  if (env.AO_REPORT_STATE_SEED_STATE) {
    return join(dirname(String(env.AO_REPORT_STATE_SEED_STATE)), 'worker-status-store.json');
  }
  return join(homedir(), '.local', 'state', 'orchestrator-pack-wake-supervisor', 'worker-status-store.json');
}

export function createDefaultWorkerStatusStore(raw = {}) {
  const records = raw.records && typeof raw.records === 'object'
    ? { ...raw.records }
    : (raw.rows && typeof raw.rows === 'object' ? { ...raw.rows } : {});
  return {
    schemaVersion: WORKER_STATUS_STORE_SCHEMA_VERSION,
    lastUpdatedMs: Number(raw.lastUpdatedMs ?? 0) || null,
    generation: Number(raw.generation ?? 0) || 0,
    repoTickGeneration: Number(raw.repoTickGeneration ?? raw.generation ?? 0) || 0,
    records,
    rows: records,
  };
}

export function readWorkerStatusStoreFile(path) {
  if (!existsSync(path)) {
    return createDefaultWorkerStatusStore();
  }
  return createDefaultWorkerStatusStore(JSON.parse(readFileSync(path, 'utf8')));
}

export function writeWorkerStatusStoreFile(path, store) {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(createDefaultWorkerStatusStore(store))}\n`, 'utf8');
  renameSync(tempPath, path);
}

function sessionIdOf(value) {
  return String(value?.sessionId ?? value?.id ?? value?.name ?? '').trim();
}

function rowKey(value) {
  return sessionIdOf(value);
}

function asGenerationVector(value = {}) {
  return {
    repoTickGeneration: Number(value.repoTickGeneration ?? 0) || 0,
    reportStoreGeneration: Number(value.reportStoreGeneration ?? 0) || 0,
    reviewRunGeneration: Number(value.reviewRunGeneration ?? value.journalCursor ?? 0) || 0,
    githubGeneration: Number(value.githubGeneration ?? value.bindingCacheGeneration ?? 0) || 0,
    writerSessionId: String(value.writerSessionId ?? '').trim(),
  };
}

function compareGenerationVector(a = {}, b = {}) {
  const left = asGenerationVector(a);
  const right = asGenerationVector(b);
  for (const key of ['repoTickGeneration', 'reportStoreGeneration', 'reviewRunGeneration', 'githubGeneration']) {
    if (left[key] < right[key]) return -1;
    if (left[key] > right[key]) return 1;
  }
  return 0;
}

function hasMixedOlderAndNewer(writer = {}, existing = {}) {
  const keys = ['repoTickGeneration', 'reportStoreGeneration', 'reviewRunGeneration', 'githubGeneration'];
  let older = false;
  let newer = false;
  for (const key of keys) {
    if (Number(writer[key] ?? 0) < Number(existing[key] ?? 0)) older = true;
    if (Number(writer[key] ?? 0) > Number(existing[key] ?? 0)) newer = true;
  }
  return older && newer;
}

function sameWriterSession(a = {}, b = {}) {
  const left = String(a.writerSessionId ?? '').trim();
  const right = String(b.writerSessionId ?? '').trim();
  return !left || !right || left === right;
}

export function shouldRefuseMonotonicWrite(existingRow, writerGenerationVector) {
  if (!existingRow) return false;
  const existing = asGenerationVector(existingRow.generationVector ?? existingRow.sourceGeneration ?? existingRow.writerGenerationVector ?? {});
  const writer = asGenerationVector(writerGenerationVector ?? {});
  if (!sameWriterSession(existing, writer)) return false;
  if (hasMixedOlderAndNewer(writer, existing)) return false;
  const keys = ['repoTickGeneration', 'reportStoreGeneration', 'reviewRunGeneration', 'githubGeneration', 'journalCursor', 'bindingCacheGeneration'];
  let hasExisting = false;
  for (const key of keys) {
    if (Number(existing[key] ?? 0) > 0) hasExisting = true;
  }
  if (!hasExisting) return false;
  for (const key of keys) {
    if (Number(writer[key] ?? 0) > Number(existing[key] ?? 0)) return false;
  }
  return true;
}

export function shouldReloadMixedGeneration(existingRow, writerGenerationVector) {
  if (!existingRow) return false;
  const existing = asGenerationVector(existingRow.generationVector ?? existingRow.sourceGeneration ?? existingRow.writerGenerationVector ?? {});
  const writer = asGenerationVector(writerGenerationVector ?? {});
  return hasMixedOlderAndNewer(writer, existing);
}

function githubPrIsOpen(input = {}) {
  const gh = input.github ?? {};
  const pr = input.githubPr ?? input.pr ?? gh.pr ?? null;
  const state = String(pr?.state ?? input.prState ?? '').toLowerCase();
  return Boolean(input.prOpen ?? gh.prOpen ?? (pr?.open === true) ?? false)
    || state === 'open'
    || (Number(input.prNumber ?? pr?.number ?? 0) > 0 && state !== 'closed' && state !== 'merged');
}

function runHeadMatches(run, headSha) {
  const head = normalizeSha(headSha);
  if (!head) return true;
  const runHead = normalizeSha(run?.targetSha ?? run?.headSha ?? run?.headRefOid);
  return !runHead || runHead === head;
}

function reviewRunIsActive(run) {
  const status = String(run?.prReviewStatus ?? run?.status ?? run?.latestRun?.status ?? '').toLowerCase();
  return REVIEW_ACTIVE_RE.test(status) || REVIEW_DELIVERED_RE.test(status);
}

function hasInFlightReview(input = {}) {
  const sessionId = sessionIdOf(input.session ?? input);
  const gh = input.github ?? {};
  const prNumber = Number(input.prNumber ?? input.binding?.prNumber ?? input.githubPr?.number ?? input.pr?.number ?? 0);
  const headSha = normalizeSha(input.githubHead ?? input.headSha ?? gh.headSha ?? input.githubPr?.headRefOid ?? input.pr?.headRefOid);
  return toArray(input.reviewRuns ?? gh.reviewRuns).some((run) => {
    const linked = String(run?.linkedSessionId ?? run?.sessionId ?? '').trim();
    if (linked && sessionId && linked !== sessionId) return false;
    if (prNumber > 0 && Number(run?.prNumber ?? 0) > 0 && Number(run.prNumber) !== prNumber) return false;
    return runHeadMatches(run, headSha) && reviewRunIsActive(run);
  });
}

export function deriveCiClass(ciChecks = [], requiredCheckNames = [], requiredCheckLookupFailed = false) {
  if (requiredCheckLookupFailed) {
    return { ciClass: 'unknown', requiredCheckSource: 'lookup_failed', diagnostics: ['required_check_lookup_failed'] };
  }
  const level = classifyRequiredCiLevel(ciChecks, { requiredCheckNames, requiredCheckLookupFailed });
  const source = toArray(requiredCheckNames).length > 0 ? 'branch_protection' : 'merge_contract_fallback';
  const ciClass = level === 'green' ? 'green' : level === 'red' ? 'failed' : level === 'pending' ? 'pending' : 'unknown';
  return { ciClass, requiredCheckSource: source, diagnostics: level === 'pending' ? ['ci_pending'] : [] };
}

export function validateReportAgainstHead(report, githubHead, journalFacts = {}) {
  if (!report || typeof report !== 'object') {
    return { valid: false, reason: 'missing_report' };
  }
  const accepted = Boolean(report.accepted ?? true);
  if (!accepted) {
    return { valid: false, reason: 'report_not_accepted' };
  }
  const reportHead = normalizeSha(report.headSha ?? report.headRefOid);
  const currentHead = normalizeSha(githubHead ?? journalFacts.githubHead ?? journalFacts.headSha);
  if (currentHead && reportHead && currentHead !== reportHead) {
    return { valid: false, invalidated: true, reason: 'stale_report_head' };
  }
  if (journalFacts.deliveryRequired && !journalFacts.deliveryObserved) {
    return { valid: false, reason: 'delivery_not_observed' };
  }
  return { valid: true, invalidated: false, reason: 'current_head' };
}

function latestReport(input = {}) {
  return toArray(input.reports ?? input.session?.reports)
    .slice()
    .sort((a, b) => {
      const at = Date.parse(String(a?.reportedAt ?? a?.timestamp ?? '')) || Number(a?.reportedAtMs ?? a?.lastObservedMs ?? 0);
      const bt = Date.parse(String(b?.reportedAt ?? b?.timestamp ?? '')) || Number(b?.reportedAtMs ?? b?.lastObservedMs ?? 0);
      return bt - at;
    })[0] ?? null;
}

export function fuseWorkerStatus(input = {}) {
  const diagnostics = [];
  const session = input.session ?? {};
  const gh = input.github ?? {};
  const report = input.report ?? latestReport(input);
  const githubHead = normalizeSha(input.githubHead ?? input.headSha ?? gh.headSha ?? input.githubPr?.headRefOid ?? input.pr?.headRefOid);
  const reportValidation = validateReportAgainstHead(report, githubHead, input.journalFacts ?? {});
  if (!reportValidation.valid && reportValidation.reason !== 'missing_report') diagnostics.push(`report_invalidated:${reportValidation.reason}`);
  const prOpen = githubPrIsOpen(input);
  const reviewActive = prOpen && hasInFlightReview(input);
  if (reviewActive) {
    return { status: 'review_active', derivedStatus: 'review_active', winningSource: 'github', diagnostics, invalidatedReport: !reportValidation.valid };
  }
  const reportState = String(report?.reportState ?? report?.report_state ?? '').toLowerCase();
  if (reportValidation.valid && reportState === 'ready_for_review') {
    return { status: 'ready_for_review', derivedStatus: 'ready_for_review', winningSource: 'report_store', diagnostics, webhookAccelerated: Boolean(input.webhookHint) };
  }
  const ci = deriveCiClass(input.ciChecks ?? gh.ciChecks, input.requiredCheckNames ?? gh.requiredCheckNames, Boolean(input.requiredCheckLookupFailed ?? gh.requiredCheckLookupFailed));
  diagnostics.push(...ci.diagnostics);
  if (ci.ciClass === 'unknown' && ci.requiredCheckSource === 'lookup_failed') {
    return { status: 'unknown', derivedStatus: 'unknown', winningSource: 'degraded', degradedReason: 'ci_lookup_failed', diagnostics };
  }
  if (prOpen && ci.ciClass === 'failed') {
    return { status: 'ci_failed', derivedStatus: 'ci_failed', winningSource: 'github_ci', requiredCheckSource: ci.requiredCheckSource, diagnostics };
  }
  const sessionStatus = String(session.status ?? input.osLiveness?.status ?? input.osLiveness ?? input.status ?? '').toLowerCase();
  if (TERMINAL_SESSION_RE.test(sessionStatus) || input.osLiveness?.dead === true || sessionStatus.includes('gone')) {
    return { status: 'dead', derivedStatus: 'dead', winningSource: 'os_liveness', diagnostics };
  }
  const binding = input.binding ?? {};
  if (binding.ok === false) {
    const reason = String(binding.reason ?? 'binding_miss');
    return { status: 'unknown', derivedStatus: 'unknown', winningSource: 'degraded', degradedReason: reason, diagnostics: [reason] };
  }
  const waitingInput = Boolean(input.osLiveness?.waitingInput) || WAITING_INPUT_RE.test(sessionStatus) || WAITING_INPUT_RE.test(String(input.sessionActivity ?? ''));
  if (waitingInput) {
    return { status: 'needs_input', derivedStatus: 'needs_input', winningSource: 'os_liveness', diagnostics };
  }
  if (prOpen) {
    return { status: 'pr_open', derivedStatus: 'pr_open', winningSource: 'github_pr', diagnostics, invalidatedReport: !reportValidation.valid && reportValidation.reason !== 'missing_report' };
  }
  diagnostics.push('insufficient_status_evidence');
  return { status: 'unknown', derivedStatus: 'unknown', winningSource: 'degraded', degradedReason: 'insufficient_status_evidence', diagnostics };
}

export function isRowStale(row, nowMs = Date.now(), repoTickGeneration = 0) {
  if (!row) return true;
  if (String(row.status ?? '') === 'stale') return true;
  const lastUpdated = Number(row.lastUpdatedMs ?? 0);
  if (!lastUpdated || nowMs - lastUpdated > Number(row.freshnessMs ?? row.freshnessBoundMs ?? DEFAULT_FRESHNESS_MS)) return true;
  const rowGeneration = Number(row.generationVector?.repoTickGeneration ?? row.sourceGeneration?.repoTickGeneration ?? row.repoTickGeneration ?? 0);
  return Number(repoTickGeneration ?? 0) > 0 && rowGeneration > 0 && rowGeneration < Number(repoTickGeneration);
}

export function recomputeWorkerStatusRow(input = {}) {
  const nowMs = Number(input.nowMs ?? Date.now());
  const store = input.store ? createDefaultWorkerStatusStore(input.store) : null;
  const sessionId = sessionIdOf(input.session ?? input);
  const existing = store?.records?.[sessionId];
  const writerVector = asGenerationVector(input.writerGenerationVector ?? input.generationVector ?? input.sourceGeneration ?? {});
  if (existing && shouldReloadMixedGeneration(existing, writerVector)) {
    return { ok: false, reason: 'mixed_generation_reload_required', store };
  }
  if (existing && shouldRefuseMonotonicWrite(existing, writerVector)) {
    return { ok: false, reason: 'monotonic_refused', store };
  }
  const fusion = fuseWorkerStatus(input);
  const row = {
    schemaVersion: WORKER_STATUS_STORE_SCHEMA_VERSION,
    sessionId,
    repoSlug: String(input.repoSlug ?? input.session?.repoSlug ?? '').trim().toLowerCase() || undefined,
    status: fusion.status,
    derivedStatus: fusion.derivedStatus ?? fusion.status,
    winningSource: fusion.winningSource,
    diagnostics: toArray(fusion.diagnostics).map(String),
    degradedReason: fusion.status === 'unknown' ? String(toArray(fusion.diagnostics)[0] ?? 'unknown_status') : undefined,
    requiredCheckSource: fusion.requiredCheckSource,
    lastUpdatedMs: input.webhookObservedAtMs ? Math.max(nowMs, Number(input.webhookObservedAtMs)) : nowMs,
    freshnessMs: Number(input.freshnessMs ?? input.freshnessBoundMs ?? DEFAULT_FRESHNESS_MS),
    freshnessBoundMs: Number(input.freshnessMs ?? input.freshnessBoundMs ?? DEFAULT_FRESHNESS_MS),
    generationVector: writerVector,
    sourceGeneration: input.sourceGeneration ?? writerVector,
  };
  if (store) {
    store.records[sessionId] = row;
    store.rows = store.records;
    store.generation += 1;
    store.lastUpdatedMs = nowMs;
    return { ok: true, row, store };
  }
  return row;
}

export function evictWorkerStatusRecords(store, sessions = [], nowMs = Date.now()) {
  const normalized = createDefaultWorkerStatusStore(store);
  const liveIds = new Set(toArray(sessions).filter((session) => !TERMINAL_SESSION_RE.test(String(session?.status ?? ''))).map(sessionIdOf));
  let removed = 0;
  for (const [key, row] of Object.entries(normalized.records ?? {})) {
    const id = String(row?.sessionId ?? key);
    if (!liveIds.has(id) || nowMs - Number(row?.lastUpdatedMs ?? 0) > DEFAULT_MAX_AGE_MS) {
      delete normalized.records[key];
      removed += 1;
    }
  }
  normalized.rows = normalized.records;
  if (removed > 0) {
    normalized.lastUpdatedMs = nowMs;
    normalized.generation += 1;
  }
  return { store: normalized, removed, recordCount: Object.keys(normalized.records).length };
}

export function mergeWorkerStatusIntoSessions(sessions, store, nowMs = Date.now(), repoTickGeneration = 0) {
  const normalized = createDefaultWorkerStatusStore(store);
  return toArray(sessions).map((session) => {
    const id = sessionIdOf(session);
    const row = normalized.records[id];
    if (!row) return { ...session, status: 'unknown', workerStatusSource: 'missing', workerStatus: 'unknown', workerStatusDerived: 'unknown', workerStatusStale: true, workerStatusDegradedReason: 'missing_row', degradedReason: 'missing_row' };
    const stale = isRowStale(row, nowMs, repoTickGeneration || normalized.repoTickGeneration);
    return {
      ...session,
      status: stale ? 'unknown' : (row.derivedStatus ?? row.status),
      workerStatus: stale ? 'unknown' : (row.derivedStatus ?? row.status),
      workerStatusDerived: stale ? 'unknown' : (row.derivedStatus ?? row.status),
      workerStatusSource: PACK_WORKER_STATUS_STORE_SURFACE,
      workerStatusWinningSource: row.winningSource,
      workerStatusDiagnostics: toArray(row.diagnostics),
      workerStatusStale: stale,
      workerStatusLastUpdatedMs: row.lastUpdatedMs,
      workerStatusDegradedReason: stale ? 'stale_row' : row.degradedReason,
      degradedReason: stale ? 'stale_row' : row.degradedReason,
    };
  });
}

export function evaluateWorkerStatusKillSwitch(env = process.env) {
  const raw = String(env[KILL_SWITCH_ENV] ?? '').trim().toLowerCase();
  const disabled = raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
  return { disabled, reason: disabled ? 'kill_switch_active' : '' };
}

export function testSiblingReadiness(env = process.env) {
  const docsDir = join(dirname(new URL(import.meta.url).pathname), '..', '..', 'docs');
  const reportStorePath = env.AO_WORKER_REPORT_STORE
    ? String(env.AO_WORKER_REPORT_STORE)
    : (env.ORCHESTRATOR_PACK_WAKE_SUPERVISOR_STATE_DIR
      ? join(String(env.ORCHESTRATOR_PACK_WAKE_SUPERVISOR_STATE_DIR), 'worker-report-store.json')
      : '');
  const workerReportStorePresent = reportStorePath
    ? existsSync(reportStorePath)
    : existsSync(join(docsDir, 'worker-report-store.mjs'));
  const sessionPrBindingResolverPresent = existsSync(join(docsDir, 'session-pr-binding-resolver.mjs'));
  return {
    ready: workerReportStorePresent && sessionPrBindingResolverPresent,
    ok: workerReportStorePresent && sessionPrBindingResolverPresent,
    workerReportStorePresent,
    sessionPrBindingResolverPresent,
    disabled: evaluateWorkerStatusKillSwitch(env).disabled,
  };
}

export function readWorkerStatusForDecision(sessionId, store, nowMs = Date.now()) {
  const normalized = createDefaultWorkerStatusStore(store);
  const row = normalized.records[String(sessionId ?? '').trim()];
  if (!row) {
    return { status: 'unknown', stale: true, degradedReason: 'missing_row', winningSource: 'missing', diagnostics: ['missing_row'] };
  }
  const stale = isRowStale(row, nowMs, normalized.repoTickGeneration);
  return {
    status: stale ? 'stale' : row.status,
    stale,
    degradedReason: stale ? 'worker_status_stale' : row.degradedReason,
    winningSource: row.winningSource,
    diagnostics: toArray(row.diagnostics).concat(stale ? ['worker_status_stale'] : []),
  };
}

function writeRow(payload) {
  const storePath = String(payload.storePath ?? resolveWorkerStatusStorePath());
  const store = readWorkerStatusStoreFile(storePath);
  const row = payload.row ?? recomputeWorkerStatusRow(payload.input ?? payload);
  if (row.ok === false) return row;
  const key = rowKey(row);
  const existing = store.records[key];
  if (shouldReloadMixedGeneration(existing, row.generationVector)) {
    return { ok: false, reason: 'mixed_generation_reload_required', generation: store.generation };
  }
  if (shouldRefuseMonotonicWrite(existing, row.generationVector)) {
    return { ok: false, reason: 'stale_generation', generation: store.generation };
  }
  store.records[key] = row;
  store.rows = store.records;
  store.lastUpdatedMs = Number(row.lastUpdatedMs ?? Date.now());
  store.generation += 1;
  store.repoTickGeneration = Math.max(Number(store.repoTickGeneration ?? 0), Number(row.generationVector?.repoTickGeneration ?? 0));
  writeWorkerStatusStoreFile(storePath, store);
  return { ok: true, row, generation: store.generation };
}

runStdinJsonCli('scripts/lib/worker-status-store.mjs', {
  migrate: () => createDefaultWorkerStatusStore(readStdinJson()),
  fuse: () => fuseWorkerStatus(readStdinJson()),
  recompute: () => recomputeWorkerStatusRow(readStdinJson()),
  evict: () => {
    const payload = readStdinJson();
    return evictWorkerStatusRecords(payload.store, payload.sessions, Number(payload.nowMs ?? Date.now()));
  },
  mergeIntoSessions: () => {
    const payload = readStdinJson();
    return {
      sessions: mergeWorkerStatusIntoSessions(
        payload.sessions,
        payload.store,
        Number(payload.nowMs ?? Date.now()),
        Number(payload.repoTickGeneration ?? 0),
      ),
    };
  },
  readDecision: () => {
    const payload = readStdinJson();
    return readWorkerStatusForDecision(String(payload.sessionId ?? ''), payload.store, Number(payload.nowMs ?? Date.now()));
  },
  writeRow: () => writeRow(readStdinJson()),
  shouldWrite: () => {
    const payload = readStdinJson();
    const existing = payload.existingRow ?? null;
    const vector = payload.writerGenerationVector ?? {};
    return {
      shouldWrite: !shouldRefuseMonotonicWrite(existing, vector) && !shouldReloadMixedGeneration(existing, vector),
      refuseMonotonic: shouldRefuseMonotonicWrite(existing, vector),
      reloadMixedGeneration: shouldReloadMixedGeneration(existing, vector),
    };
  },
  evaluateKillSwitch: () => {
    const payload = readStdinJson();
    return evaluateWorkerStatusKillSwitch(payload.env ?? process.env);
  },
  testSiblingReadiness: () => {
    const payload = readStdinJson();
    return testSiblingReadiness(payload.env ?? process.env);
  },
});
