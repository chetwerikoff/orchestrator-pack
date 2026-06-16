/**
 * Crash-safe review-run recovery (Issue #287).
 *
 * The recovery tick is intentionally file-backed: AO 0.9.x stores review runs as
 * JSON records under the project code-reviews/runs directory, and `ao review list`
 * reads those records through the same store.  This module never starts reviews or
 * sends findings; it only terminalizes non-terminal runs whose reviewer liveness is
 * provably dead (after a short grace) or unverifiable long past the enforced review
 * timeout.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { printJson, readStdinJson, runAsyncStdinJsonCliMain } from './review-mechanical-cli.mjs';
import { enrichRecoveryEvidenceWithFailure } from './reviewer-failure-evidence.mjs';

export const REVIEW_RECOVERY_SCHEMA_VERSION = 1;
export const DEFAULT_CRASH_GRACE_MS = 2 * 60 * 1000;
export const DEFAULT_MAX_REVIEW_DURATION_MS = 10 * 60 * 1000;
export const DEFAULT_AMBIGUOUS_STALE_MS = 15 * 60 * 1000;

export const RECOVERY_TERMINAL_STATUS = 'failed';
export const RECOVERY_REASON_PROVABLY_DEAD = 'reviewer_liveness_provably_dead';
export const RECOVERY_REASON_AMBIGUOUS_STALE = 'reviewer_liveness_ambiguous_stale';
export const RECOVERY_REASON_LEGACY_AMBIGUOUS = 'reviewer_liveness_legacy_ambiguous_stale';
export const RECOVERY_TERMINATION_REASONS = new Set([
  RECOVERY_REASON_PROVABLY_DEAD,
  RECOVERY_REASON_AMBIGUOUS_STALE,
  RECOVERY_REASON_LEGACY_AMBIGUOUS,
]);

export const NON_TERMINAL_REVIEW_STATUSES = new Set([
  'queued',
  'preparing',
  'running',
  'reviewing',
]);

export const TERMINAL_REVIEW_STATUSES = new Set([
  'clean',
  'needs_triage',
  'sent_to_agent',
  'waiting_update',
  'outdated',
  'failed',
  'cancelled',
]);

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function toArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function parsePositiveMs(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

export function resolveRecoveryConfig(config = {}, env = process.env) {
  const maxReviewDurationMs = parsePositiveMs(
    config.maxReviewDurationMs ?? env.AO_REVIEW_RECOVERY_MAX_REVIEW_DURATION_MS,
    DEFAULT_MAX_REVIEW_DURATION_MS,
  );
  const crashGraceMs = parsePositiveMs(
    config.crashGraceMs ?? env.AO_REVIEW_RECOVERY_CRASH_GRACE_MS,
    DEFAULT_CRASH_GRACE_MS,
  );
  const ambiguousStaleMs = parsePositiveMs(
    config.ambiguousStaleMs ?? env.AO_REVIEW_RECOVERY_AMBIGUOUS_STALE_MS,
    DEFAULT_AMBIGUOUS_STALE_MS,
  );
  return { crashGraceMs, maxReviewDurationMs, ambiguousStaleMs };
}

export function validateRecoveryConfig(config = resolveRecoveryConfig()) {
  const errors = [];
  if (!(config.ambiguousStaleMs > config.maxReviewDurationMs)) {
    errors.push('ambiguous stale threshold must exceed enforced review timeout');
  }
  if (!(config.crashGraceMs > 0)) {
    errors.push('crash stability grace must be positive');
  }
  if (!(config.maxReviewDurationMs > 0)) {
    errors.push('enforced review timeout must be positive');
  }
  return { ok: errors.length === 0, errors };
}

function normalizeStatus(status) {
  return String(status ?? '').trim().toLowerCase();
}

export function classifyReviewStatus(status) {
  const normalized = normalizeStatus(status);
  if (NON_TERMINAL_REVIEW_STATUSES.has(normalized)) return 'non_terminal';
  if (TERMINAL_REVIEW_STATUSES.has(normalized)) return 'terminal';
  return 'unknown';
}

function safeRunId(run) {
  const id = String(run?.id ?? run?.runId ?? '').trim();
  return SAFE_ID.test(id) ? id : '';
}

export function fingerprintRun(run) {
  const id = safeRunId(run);
  const createdAt = String(run?.createdAt ?? '').trim();
  const reviewerSessionId = String(run?.reviewerSessionId ?? '').trim();
  const linkedSessionId = String(run?.linkedSessionId ?? '').trim();
  return createHash('sha256')
    .update([id, createdAt, reviewerSessionId, linkedSessionId].join('\n'))
    .digest('hex')
    .slice(0, 32);
}

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export function getAoProjectDir(projectId, baseDir = process.env.AO_BASE_DIR) {
  const root = baseDir || join(homedir(), '.agent-orchestrator');
  return join(root, 'projects', projectId);
}

export function getCodeReviewStoreDir(projectId, options = {}) {
  return options.storeDir || join(getAoProjectDir(projectId, options.aoBaseDir), 'code-reviews');
}

function listRunFiles(storeDir) {
  const runsDir = join(storeDir, 'runs');
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => join(runsDir, entry.name));
}

export function readRunRecords(storeDir) {
  return listRunFiles(storeDir)
    .map((path) => ({ path, run: asRecord(readJsonFile(path)) }))
    .filter((entry) => entry.run);
}

export function getSidecarDir(storeDir) {
  return join(storeDir, 'reviewer-liveness');
}

export function getRecoveryStatePath(storeDir) {
  return join(storeDir, 'review-run-recovery-state.json');
}

export function getRecoveryAuditPath(storeDir) {
  return join(storeDir, 'review-run-recovery-audit.json');
}

function identitySidecarPath(storeDir, runId) {
  return join(getSidecarDir(storeDir), `${runId}.json`);
}

export function readRecoveryState(storeDir) {
  const state = asRecord(readJsonFile(getRecoveryStatePath(storeDir))) ?? {};
  return {
    schemaVersion: REVIEW_RECOVERY_SCHEMA_VERSION,
    observations: asRecord(state.observations) ?? {},
    escalations: asRecord(state.escalations) ?? {},
    auditBackfills: asRecord(state.auditBackfills) ?? {},
  };
}

export function writeRecoveryState(storeDir, state) {
  writeJsonAtomic(getRecoveryStatePath(storeDir), {
    schemaVersion: REVIEW_RECOVERY_SCHEMA_VERSION,
    observations: asRecord(state.observations) ?? {},
    escalations: asRecord(state.escalations) ?? {},
    auditBackfills: asRecord(state.auditBackfills) ?? {},
  });
}

function readAudit(storeDir) {
  const audit = asRecord(readJsonFile(getRecoveryAuditPath(storeDir))) ?? {};
  return {
    schemaVersion: REVIEW_RECOVERY_SCHEMA_VERSION,
    records: toArray(audit.records).filter(asRecord),
  };
}

function appendAuditOnce(storeDir, record) {
  const audit = readAudit(storeDir);
  const key = String(record.key ?? '').trim();
  if (key && audit.records.some((entry) => entry.key === key)) {
    return { written: false, key };
  }
  audit.records.push({ schemaVersion: REVIEW_RECOVERY_SCHEMA_VERSION, ...record });
  writeJsonAtomic(getRecoveryAuditPath(storeDir), audit);
  return { written: true, key };
}

function sidecarCompleteForRun(sidecar, run) {
  if (!asRecord(sidecar)) return false;
  const identity = asRecord(sidecar.identity);
  const processIdentity = asRecord(identity?.process);
  return Boolean(
    sidecar.schemaVersion === REVIEW_RECOVERY_SCHEMA_VERSION &&
      sidecar.runId === safeRunId(run) &&
      sidecar.runFingerprint === fingerprintRun(run) &&
      identity?.kind === 'linux_proc_pid_starttime_boot' &&
      Number.isInteger(processIdentity?.pid) &&
      String(processIdentity?.startTimeTicks ?? '').trim() &&
      String(processIdentity?.bootIdHash ?? '').trim(),
  );
}

function sidecarBoundForRun(sidecar, run) {
  return Boolean(
    asRecord(sidecar) &&
      sidecar.schemaVersion === REVIEW_RECOVERY_SCHEMA_VERSION &&
      sidecar.runId === safeRunId(run) &&
      sidecar.runFingerprint === fingerprintRun(run),
  );
}

function getEffectiveWindows(run, sidecar, config, state, nowMs, hasBoundSidecar = false) {
  const sidecarWindows = hasBoundSidecar ? asRecord(sidecar?.windows) : null;
  if (sidecarWindows) {
    return {
      crashGraceMs: parsePositiveMs(sidecarWindows.crashGraceMs, config.crashGraceMs),
      maxReviewDurationMs: parsePositiveMs(sidecarWindows.maxReviewDurationMs, config.maxReviewDurationMs),
      ambiguousStaleMs: parsePositiveMs(sidecarWindows.ambiguousStaleMs, config.ambiguousStaleMs),
      source: 'captured_at_start',
    };
  }
  const key = observationKey(run);
  const existing = asRecord(state.observations[key]);
  if (existing?.windows) {
    const windows = asRecord(existing.windows);
    return {
      crashGraceMs: parsePositiveMs(windows.crashGraceMs, config.crashGraceMs),
      maxReviewDurationMs: parsePositiveMs(windows.maxReviewDurationMs, config.maxReviewDurationMs),
      ambiguousStaleMs: parsePositiveMs(windows.ambiguousStaleMs, config.ambiguousStaleMs),
      source: existing.legacy ? 'legacy_first_observation' : 'first_observation',
    };
  }
  state.observations[key] = {
    runId: safeRunId(run),
    runFingerprint: fingerprintRun(run),
    firstObservedMs: nowMs,
    legacy: !hasBoundSidecar,
    windows: { ...config },
  };
  return { ...config, source: hasBoundSidecar ? 'first_observation' : 'legacy_first_observation' };
}

function runStartedMs(run, state, preferFirstObservation = false) {
  const observation = asRecord(state.observations[observationKey(run)]);
  if (preferFirstObservation && Number(observation?.firstObservedMs)) {
    return Number(observation.firstObservedMs);
  }
  const parsed = Date.parse(String(run?.startedAt ?? run?.createdAt ?? ''));
  if (Number.isFinite(parsed)) return parsed;
  return Number(observation?.firstObservedMs) || 0;
}

function observationKey(run) {
  return `${safeRunId(run)}:${fingerprintRun(run)}`;
}

function hashBootId(value) {
  return createHash('sha256').update(String(value ?? '').trim()).digest('hex').slice(0, 16);
}

function readCurrentBootHash() {
  try {
    return hashBootId(readFileSync('/proc/sys/kernel/random/boot_id', 'utf8'));
  } catch {
    return null;
  }
}

function readProcStartTimeTicks(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const end = stat.lastIndexOf(')');
    const rest = stat.slice(end + 2).trim().split(/\s+/);
    return rest[19] ?? null; // field 22, after pid and comm.
  } catch {
    return null;
  }
}

export function classifyReviewerLiveness(sidecar, options = {}) {
  if (!asRecord(sidecar) || !asRecord(sidecar.identity)) {
    return { outcome: 'ambiguous', reason: 'missing_identity' };
  }
  const identity = sidecar.identity;
  if (identity.kind !== 'linux_proc_pid_starttime_boot') {
    return { outcome: 'ambiguous', reason: 'unsupported_identity_kind' };
  }
  const proc = asRecord(identity.process);
  const pid = Number(proc?.pid);
  const expectedStart = String(proc?.startTimeTicks ?? '').trim();
  const expectedBoot = String(proc?.bootIdHash ?? '').trim();
  if (!Number.isInteger(pid) || pid <= 0 || !expectedStart || !expectedBoot) {
    return { outcome: 'ambiguous', reason: 'partial_identity' };
  }
  if (process.platform !== 'linux' && !options.allowNonLinuxProc) {
    return { outcome: 'ambiguous', reason: 'process_table_unverifiable' };
  }
  const bootHash = options.bootIdHash ?? readCurrentBootHash();
  if (!bootHash || bootHash !== expectedBoot) {
    return { outcome: 'ambiguous', reason: 'boot_identity_unverifiable' };
  }
  const actualStart = options.procStartTimeTicks ?? readProcStartTimeTicks(pid);
  if (!actualStart) {
    return { outcome: 'provably_not_alive', reason: 'proc_entry_missing' };
  }
  if (String(actualStart) !== expectedStart) {
    return { outcome: 'provably_not_alive', reason: 'pid_reused_or_wrong_instance' };
  }
  return { outcome: 'alive', reason: 'pid_starttime_boot_match' };
}

function buildLivenessEvidence(liveness, sidecar) {
  const proc = asRecord(sidecar?.identity?.process) ?? {};
  return {
    livenessOutcome: liveness.outcome,
    livenessReason: liveness.reason,
    identityKind: String(sidecar?.identity?.kind ?? 'missing'),
    pid: Number.isInteger(proc.pid) ? proc.pid : undefined,
    bootIdHash: typeof proc.bootIdHash === 'string' ? proc.bootIdHash : undefined,
    startTimeTicksHash: proc.startTimeTicks
      ? createHash('sha256').update(String(proc.startTimeTicks)).digest('hex').slice(0, 16)
      : undefined,
  };
}

function buildEvidence(liveness, sidecar, storeDir, run) {
  const livenessEvidence = buildLivenessEvidence(liveness, sidecar);
  if (!storeDir || !run) return livenessEvidence;
  return enrichRecoveryEvidenceWithFailure(storeDir, run, livenessEvidence);
}

export function evaluateRecoveryForRun({ run, sidecar, state, nowMs, config, storeDir }) {
  const statusClass = classifyReviewStatus(run?.status);
  const runId = safeRunId(run);
  if (!runId) return { action: 'skip', reason: 'missing_run_id' };
  if (statusClass === 'unknown') {
    return { action: 'escalate', reason: 'unknown_status', status: String(run?.status ?? '') };
  }
  if (statusClass === 'terminal') {
    return { action: 'skip', reason: 'already_terminal' };
  }

  const hasUsableSidecar = sidecarCompleteForRun(sidecar, run);
  const hasBoundSidecar = sidecarBoundForRun(sidecar, run);
  const windows = getEffectiveWindows(run, sidecar, config, state, nowMs, hasBoundSidecar);
  const liveness = hasUsableSidecar
    ? classifyReviewerLiveness(sidecar)
    : { outcome: 'ambiguous', reason: sidecar ? 'sidecar_mismatch_or_partial' : 'missing_identity' };
  const startedMs = runStartedMs(run, state, !hasBoundSidecar);
  const ageMs = Math.max(0, nowMs - startedMs);
  const evidence = buildEvidence(liveness, sidecar, storeDir, run);

  if (liveness.outcome === 'alive') {
    return { action: 'skip', reason: 'reviewer_alive', windows, ageMs, evidence };
  }

  if (liveness.outcome === 'provably_not_alive') {
    if (ageMs < windows.crashGraceMs) {
      return { action: 'skip_audit_once', reason: 'dead_within_crash_grace', windows, ageMs, evidence };
    }
    return {
      action: 'terminalize',
      terminalReason: RECOVERY_REASON_PROVABLY_DEAD,
      windows,
      ageMs,
      evidence,
    };
  }

  if (ageMs < windows.ambiguousStaleMs) {
    return { action: 'skip_audit_once', reason: 'ambiguous_before_stale_threshold', windows, ageMs, evidence };
  }
  const terminalReason = windows.source === 'legacy_first_observation'
    ? RECOVERY_REASON_LEGACY_AMBIGUOUS
    : RECOVERY_REASON_AMBIGUOUS_STALE;
  return { action: 'terminalize', terminalReason, windows, ageMs, evidence };
}

function recoverySummary(reason, evidence) {
  const failurePhase = evidence.failureEvidence?.lastPhase ?? evidence.failureEvidenceDiagnostic ?? 'none';
  return `AO review recovery terminalized non-clean run: ${reason}; liveness=${evidence.livenessOutcome}/${evidence.livenessReason}; failureEvidence=${failurePhase}`;
}

export function terminalizeRunRecord({ path, expectedRun, expectedSidecar, terminalReason, evidence, now = new Date() }) {
  const latest = asRecord(readJsonFile(path));
  if (!latest) return { ok: false, reason: 'authoritative_read_failed' };
  const statusClass = classifyReviewStatus(latest.status);
  if (statusClass !== 'non_terminal') return { ok: false, reason: 'authoritative_not_non_terminal', status: latest.status };
  if (fingerprintRun(latest) !== fingerprintRun(expectedRun)) {
    return { ok: false, reason: 'run_fingerprint_changed' };
  }
  if (expectedSidecar && sidecarCompleteForRun(expectedSidecar, expectedRun)) {
    const latestSidecarRunFingerprint = expectedSidecar.runFingerprint;
    if (latestSidecarRunFingerprint !== fingerprintRun(latest)) {
      return { ok: false, reason: 'liveness_identity_no_longer_attached' };
    }
  }
  if (!RECOVERY_TERMINATION_REASONS.has(terminalReason)) {
    return { ok: false, reason: 'invalid_terminal_reason' };
  }
  const timestamp = now.toISOString();
  const next = {
    ...latest,
    status: RECOVERY_TERMINAL_STATUS,
    completedAt: timestamp,
    updatedAt: timestamp,
    terminationReason: terminalReason,
    recovery: {
      schemaVersion: REVIEW_RECOVERY_SCHEMA_VERSION,
      terminalReason,
      evidence,
      recoveredAt: timestamp,
    },
  };
  try {
    writeJsonAtomic(path, next);
    return { ok: true, run: next };
  } catch (error) {
    return { ok: false, reason: 'atomic_write_failed', error: error instanceof Error ? error.message : String(error) };
  }
}

function auditKey(kind, run, reason = '') {
  return `${kind}:${observationKey(run)}:${reason}`;
}

function markEscalationOnce(storeDir, state, run, reason, detail, nowMs) {
  const key = auditKey('escalation', run, reason);
  if (state.escalations[key]) return { emitted: false, key };
  state.escalations[key] = { runId: safeRunId(run), reason, firstSeenMs: nowMs };
  appendAuditOnce(storeDir, {
    key,
    type: 'recovery_escalation',
    runId: safeRunId(run),
    runFingerprint: fingerprintRun(run),
    reason,
    detail: String(detail ?? '').slice(0, 500),
    observedAtMs: nowMs,
  });
  return { emitted: true, key };
}

function backfillMissingTransitionAudits(storeDir, state, runEntries, nowMs) {
  let count = 0;
  const audit = readAudit(storeDir);
  for (const { run } of runEntries) {
    const reason = String(run?.terminationReason ?? '').trim();
    if (!RECOVERY_TERMINATION_REASONS.has(reason)) continue;
    const key = auditKey('transition', run, reason);
    if (audit.records.some((entry) => entry.key === key) || state.auditBackfills[key]) continue;
    const existingEvidence = asRecord(run?.recovery?.evidence);
    const evidence = existingEvidence
      ? {
          ...existingEvidence,
          ...(existingEvidence.failureEvidence || existingEvidence.failureEvidenceDiagnostic
            ? {}
            : enrichRecoveryEvidenceWithFailure(storeDir, run, existingEvidence)),
        }
      : enrichRecoveryEvidenceWithFailure(
          storeDir,
          run,
          buildLivenessEvidence({ outcome: 'unknown', reason: 'audit_backfill' }, null),
        );
    appendAuditOnce(storeDir, {
      key,
      type: 'recovery_transition',
      runId: safeRunId(run),
      runFingerprint: fingerprintRun(run),
      terminalReason: reason,
      evidence,
      observedAtMs: nowMs,
      backfilled: true,
    });
    state.auditBackfills[key] = { runId: safeRunId(run), reason, backfilledAtMs: nowMs };
    count += 1;
  }
  return count;
}

export function runRecoveryTick({ projectId = 'orchestrator-pack', storeDir, nowMs = Date.now(), config: inputConfig = {}, dryRun = false } = {}) {
  const resolvedStoreDir = storeDir || getCodeReviewStoreDir(projectId);
  const config = resolveRecoveryConfig(inputConfig);
  const validation = validateRecoveryConfig(config);
  const state = readRecoveryState(resolvedStoreDir);
  const runEntries = readRunRecords(resolvedStoreDir);
  const actions = [];
  if (!validation.ok) {
    const synthetic = { id: 'config', createdAt: 'config', reviewerSessionId: 'config', linkedSessionId: 'config' };
    markEscalationOnce(resolvedStoreDir, state, synthetic, 'invalid_config', validation.errors.join('; '), nowMs);
    writeRecoveryState(resolvedStoreDir, state);
    return { ok: false, reason: 'invalid_config', errors: validation.errors, actions };
  }

  const backfilled = backfillMissingTransitionAudits(resolvedStoreDir, state, runEntries, nowMs);

  for (const entry of runEntries) {
    const run = entry.run;
    const runId = safeRunId(run);
    const sidecar = runId ? asRecord(readJsonFile(identitySidecarPath(resolvedStoreDir, runId))) : null;
    const decision = evaluateRecoveryForRun({ run, sidecar, state, nowMs, config, storeDir: resolvedStoreDir });
    const base = {
      runId,
      status: run.status,
      decision: decision.action,
      reason: decision.reason ?? decision.terminalReason,
      prNumber: run.prNumber ?? run.pr_number ?? null,
      targetSha: run.targetSha ?? run.target_sha ?? null,
    };

    if (decision.action === 'escalate') {
      markEscalationOnce(resolvedStoreDir, state, run, decision.reason, decision.status, nowMs);
      actions.push({ ...base, escalated: true });
      continue;
    }
    if (decision.action === 'skip_audit_once') {
      appendAuditOnce(resolvedStoreDir, {
        key: auditKey('skip', run, `${decision.reason}:${decision.evidence?.livenessReason ?? ''}`),
        type: 'recovery_skip',
        runId,
        runFingerprint: fingerprintRun(run),
        reason: decision.reason,
        evidence: decision.evidence,
        observedAtMs: nowMs,
      });
      actions.push(base);
      continue;
    }
    if (decision.action !== 'terminalize') {
      actions.push(base);
      continue;
    }
    if (dryRun) {
      actions.push({ ...base, terminalReason: decision.terminalReason, dryRun: true });
      continue;
    }
    const result = terminalizeRunRecord({
      path: entry.path,
      expectedRun: run,
      expectedSidecar: sidecar,
      terminalReason: decision.terminalReason,
      evidence: decision.evidence,
      now: new Date(nowMs),
    });
    if (!result.ok) {
      markEscalationOnce(resolvedStoreDir, state, run, 'atomic_terminal_write_failed', result.reason, nowMs);
      actions.push({ ...base, terminalReason: decision.terminalReason, terminalized: false, writeFailure: result.reason });
      continue;
    }
    appendAuditOnce(resolvedStoreDir, {
      key: auditKey('transition', result.run, decision.terminalReason),
      type: 'recovery_transition',
      runId,
      runFingerprint: fingerprintRun(result.run),
      terminalReason: decision.terminalReason,
      evidence: decision.evidence,
      summary: recoverySummary(decision.terminalReason, decision.evidence),
      observedAtMs: nowMs,
    });
    actions.push({ ...base, terminalReason: decision.terminalReason, terminalized: true });
  }

  writeRecoveryState(resolvedStoreDir, state);
  return { ok: true, storeDir: resolvedStoreDir, backfilled, actions };
}

export function findRunForReviewerSession(storeDir, reviewerSessionId) {
  const reviewer = String(reviewerSessionId ?? '').trim();
  if (!reviewer) return null;
  const entries = readRunRecords(storeDir)
    .filter(({ run }) => String(run?.reviewerSessionId ?? '') === reviewer)
    .sort((a, b) => Date.parse(String(b.run.createdAt ?? '')) - Date.parse(String(a.run.createdAt ?? '')));
  return entries.find(({ run }) => classifyReviewStatus(run.status) === 'non_terminal') ?? entries[0] ?? null;
}

export function captureReviewerLiveness({ projectId = 'orchestrator-pack', storeDir, reviewerSessionId, pid, startTimeTicks, bootIdHash, windows = {} }) {
  const resolvedStoreDir = storeDir || getCodeReviewStoreDir(projectId);
  const entry = findRunForReviewerSession(resolvedStoreDir, reviewerSessionId);
  if (!entry) return { ok: false, reason: 'run_not_found' };
  const run = entry.run;
  const runId = safeRunId(run);
  const suppliedWindows = asRecord(windows) ?? {};
  const capturedWindows = {};
  for (const key of ['crashGraceMs', 'maxReviewDurationMs', 'ambiguousStaleMs']) {
    if (Object.hasOwn(suppliedWindows, key)) {
      const parsed = Number(suppliedWindows[key]);
      if (Number.isFinite(parsed) && parsed > 0) capturedWindows[key] = Math.floor(parsed);
    }
  }
  const sidecar = {
    schemaVersion: REVIEW_RECOVERY_SCHEMA_VERSION,
    runId,
    runFingerprint: fingerprintRun(run),
    reviewerSessionId: String(reviewerSessionId),
    capturedAt: new Date().toISOString(),
    identity: {
      kind: 'linux_proc_pid_starttime_boot',
      process: {
        pid: Number(pid),
        startTimeTicks: String(startTimeTicks),
        bootIdHash: String(bootIdHash),
      },
    },
  };
  if (Object.keys(capturedWindows).length > 0) {
    sidecar.windows = capturedWindows;
  }
  writeJsonAtomic(identitySidecarPath(resolvedStoreDir, runId), sidecar);
  return { ok: true, runId, path: identitySidecarPath(resolvedStoreDir, runId) };
}

async function main() {
  const subcommand = process.argv[2] ?? 'tick';
  const payload = await readStdinJson();
  if (subcommand === 'tick') {
    return runRecoveryTick(payload);
  }
  if (subcommand === 'validate-config') {
    const config = resolveRecoveryConfig(payload?.config ?? {});
    return { config, ...validateRecoveryConfig(config) };
  }
  if (subcommand === 'capture') {
    return captureReviewerLiveness(payload ?? {});
  }
  throw new Error(`Unknown review-run-recovery subcommand: ${subcommand}`);
}

runAsyncStdinJsonCliMain('review-run-recovery.mjs', main);
