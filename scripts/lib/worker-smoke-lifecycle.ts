import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

export const SMOKE_LIFECYCLE_ROOT = '.orca-worker-smoke/runs';
export const SMOKE_ADMISSION_LOCK = '.orca-worker-smoke/admission.lock.json';
export const SMOKE_CREATE_TIMEOUT_MS = 60_000;
export const SMOKE_DELIVERY_TIMEOUT_MS = 10 * 60_000;
export const SMOKE_PROGRESS_STALL_MS = 25 * 60_000;
export const SMOKE_ABSOLUTE_CEILING_MS = 4 * 60 * 60_000;
export const SMOKE_SHUTDOWN_TIMEOUT_MS = 2 * 60_000;
export const SMOKE_LIFECYCLE_POLL_MS = 250;

export type SmokeSpawnState =
  | 'reserved'
  | 'create_in_progress'
  | 'bound'
  | 'ambiguous_unbound'
  | 'abandoned_unbound'
  | 'cleanup_pending'
  | 'clean'
  | 'cleanup_failed';

export interface SmokeLifecycleRegistry {
  version: 1;
  runId: string;
  issueNumber: number;
  prNumber: number;
  headSha: string;
  artifactDir: string;
  supervisorPid: number;
  createdAtMs: number;
  updatedAtMs: number;
  spawnState: SmokeSpawnState;
  createDeadlineMs: number;
  terminalHandle?: string;
  createDiagnostic?: string;
  cleanup?: {
    reason: string;
    cooperativeAcknowledgementObserved: boolean;
    closeOutcome: string;
    operatorFilesCleared: boolean;
    completedAtMs: number;
  };
}

export interface SmokeProgressEvent {
  runId: string;
  scenarioOrdinal: number;
  phase: 'started' | 'terminal';
  outcome?: 'pass' | 'fail' | 'blocked' | 'skipped';
}

export interface SmokeProgressInspection {
  acceptedCount: number;
  completedScenarios: number;
  nextScenarioOrdinal: number;
  planComplete: boolean;
  invalidEvents: string[];
  acceptedDigest: string;
}

export interface SmokeLifecycleCleanliness {
  clean: boolean;
  reasons: string[];
  blockingRunIds: string[];
}

export interface SmokeAdmissionResult {
  admitted: boolean;
  reason?: string;
  diagnostics: string[];
}

export interface SmokeCleanupResult {
  clean: boolean;
  cooperativeAcknowledgementObserved: boolean;
  closeOutcome: string;
  operatorFilesCleared: boolean;
  reason: string;
}

interface AdmissionLock {
  version: 1;
  runId: string;
  supervisorPid: number;
  startedAtMs: number;
}

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  renameSync(temp, path);
}

function readJson(path: string): unknown | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function parseCleanup(value: unknown): SmokeLifecycleRegistry['cleanup'] | undefined {
  if (!isRecord(value)) return undefined;
  const completedAtMs = Number(value.completedAtMs);
  if (!Number.isFinite(completedAtMs)) return undefined;
  return {
    reason: String(value.reason ?? ''),
    cooperativeAcknowledgementObserved: Boolean(value.cooperativeAcknowledgementObserved),
    closeOutcome: String(value.closeOutcome ?? ''),
    operatorFilesCleared: Boolean(value.operatorFilesCleared),
    completedAtMs,
  };
}

function parseRegistry(value: unknown): SmokeLifecycleRegistry | undefined {
  if (!isRecord(value)) return undefined;
  const spawnState = String(value.spawnState ?? '') as SmokeSpawnState;
  if (![
    'reserved', 'create_in_progress', 'bound', 'ambiguous_unbound',
    'abandoned_unbound', 'cleanup_pending', 'clean', 'cleanup_failed',
  ].includes(spawnState)) return undefined;
  const registry: SmokeLifecycleRegistry = {
    version: 1,
    runId: String(value.runId ?? '').trim(),
    issueNumber: Number(value.issueNumber),
    prNumber: Number(value.prNumber),
    headSha: String(value.headSha ?? '').trim().toLowerCase(),
    artifactDir: String(value.artifactDir ?? '').trim(),
    supervisorPid: Number(value.supervisorPid),
    createdAtMs: Number(value.createdAtMs),
    updatedAtMs: Number(value.updatedAtMs),
    spawnState,
    createDeadlineMs: Number(value.createDeadlineMs),
    ...(typeof value.terminalHandle === 'string' && value.terminalHandle.trim()
      ? { terminalHandle: value.terminalHandle.trim() }
      : {}),
    ...(typeof value.createDiagnostic === 'string'
      ? { createDiagnostic: value.createDiagnostic.slice(0, 512) }
      : {}),
    ...(parseCleanup(value.cleanup) ? { cleanup: parseCleanup(value.cleanup)! } : {}),
  };
  if (
    Number(value.version) !== 1
    || !registry.runId
    || !registry.artifactDir
    || !/^[0-9a-f]{40}$/u.test(registry.headSha)
    || !Number.isInteger(registry.issueNumber)
    || !Number.isInteger(registry.prNumber)
    || !Number.isInteger(registry.supervisorPid)
    || !Number.isFinite(registry.createdAtMs)
    || !Number.isFinite(registry.updatedAtMs)
    || !Number.isFinite(registry.createDeadlineMs)
  ) return undefined;
  return registry;
}

function parseLock(value: unknown): AdmissionLock | undefined {
  if (!isRecord(value)) return undefined;
  const lock: AdmissionLock = {
    version: 1,
    runId: String(value.runId ?? '').trim(),
    supervisorPid: Number(value.supervisorPid),
    startedAtMs: Number(value.startedAtMs),
  };
  if (
    Number(value.version) !== 1
    || !lock.runId
    || !Number.isInteger(lock.supervisorPid)
    || lock.supervisorPid <= 0
    || !Number.isFinite(lock.startedAtMs)
  ) return undefined;
  return lock;
}

export const smokeLifecycleRegistryPath = (artifactDir: string): string =>
  join(artifactDir, 'lifecycle.json');
export const smokeProgressPath = (artifactDir: string): string =>
  join(artifactDir, 'progress.ndjson');
export const smokeCancelRequestPath = (artifactDir: string): string =>
  join(artifactDir, 'cancel-request.json');
export const smokeCancelAcknowledgementPath = (artifactDir: string): string =>
  join(artifactDir, 'cancel-acknowledgement.json');
export const smokeTerminalRecordPath = (artifactDir: string): string =>
  join(artifactDir, 'terminal.json');
export const smokeAdmissionLockPath = (repoRoot: string): string =>
  join(repoRoot, SMOKE_ADMISSION_LOCK);

export function readSmokeLifecycleRegistry(artifactDir: string): SmokeLifecycleRegistry | undefined {
  return parseRegistry(readJson(smokeLifecycleRegistryPath(artifactDir)));
}

function mutateRegistry(
  artifactDir: string,
  mutate: (registry: SmokeLifecycleRegistry) => SmokeLifecycleRegistry,
): SmokeLifecycleRegistry {
  const current = readSmokeLifecycleRegistry(artifactDir);
  if (!current) throw new Error(`smoke lifecycle registry unreadable: ${artifactDir}`);
  const next = mutate(current);
  atomicJson(smokeLifecycleRegistryPath(artifactDir), next);
  return next;
}

export function createSmokeLifecycleReservation(input: {
  runId: string;
  artifactDir: string;
  issueNumber: number;
  prNumber: number;
  headSha: string;
  supervisorPid?: number;
  nowMs?: number;
  createTimeoutMs?: number;
}): SmokeLifecycleRegistry {
  const nowMs = input.nowMs ?? Date.now();
  const registry: SmokeLifecycleRegistry = {
    version: 1,
    runId: input.runId,
    issueNumber: input.issueNumber,
    prNumber: input.prNumber,
    headSha: input.headSha.trim().toLowerCase(),
    artifactDir: input.artifactDir,
    supervisorPid: input.supervisorPid ?? process.pid,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    spawnState: 'reserved',
    createDeadlineMs: nowMs + (input.createTimeoutMs ?? SMOKE_CREATE_TIMEOUT_MS),
  };
  mkdirSync(input.artifactDir, { recursive: true });
  atomicJson(smokeLifecycleRegistryPath(input.artifactDir), registry);
  return registry;
}

export function markSmokeCreateInProgress(
  artifactDir: string,
  nowMs = Date.now(),
): SmokeLifecycleRegistry {
  return mutateRegistry(artifactDir, (registry) => ({
    ...registry, spawnState: 'create_in_progress', updatedAtMs: nowMs,
  }));
}

export function bindSmokeTerminalHandle(
  artifactDir: string,
  terminalHandle: string,
  nowMs = Date.now(),
): SmokeLifecycleRegistry {
  const handle = terminalHandle.trim();
  if (!handle) throw new Error('terminal handle is required');
  return mutateRegistry(artifactDir, (registry) => ({
    ...registry, terminalHandle: handle, spawnState: 'bound', updatedAtMs: nowMs,
  }));
}

export function markSmokeCreateAmbiguous(
  artifactDir: string,
  diagnostic: string,
  nowMs = Date.now(),
): SmokeLifecycleRegistry {
  return mutateRegistry(artifactDir, (registry) => ({
    ...registry,
    spawnState: 'ambiguous_unbound',
    createDiagnostic: diagnostic.slice(0, 512),
    updatedAtMs: nowMs,
  }));
}

const hasCompletionSeal = (artifactDir: string): boolean => {
  try {
    return existsSync(artifactDir)
      && readdirSync(artifactDir).some((entry) => /^completion-[0-9a-f]{64}\.sealed\.json$/u.test(entry));
  } catch {
    return true;
  }
};

const hasProgressBytes = (artifactDir: string): boolean => {
  const path = smokeProgressPath(artifactDir);
  if (!existsSync(path)) return false;
  try { return statSync(path).size > 0; } catch { return true; }
};

export function observeSmokeCancellationAcknowledgement(
  artifactDir: string,
  runId: string,
): boolean {
  const raw = readJson(smokeCancelAcknowledgementPath(artifactDir));
  return isRecord(raw) && String(raw.runId ?? '').trim() === runId;
}

export function canAbandonAmbiguousUnbound(registry: SmokeLifecycleRegistry): boolean {
  return registry.spawnState === 'ambiguous_unbound'
    && !registry.terminalHandle
    && !existsSync(join(registry.artifactDir, 'delivery.sealed.json'))
    && !hasProgressBytes(registry.artifactDir)
    && !hasCompletionSeal(registry.artifactDir)
    && !observeSmokeCancellationAcknowledgement(registry.artifactDir, registry.runId);
}

export function abandonAmbiguousUnbound(
  artifactDir: string,
  nowMs = Date.now(),
): SmokeLifecycleRegistry {
  return mutateRegistry(artifactDir, (registry) => {
    if (!canAbandonAmbiguousUnbound(registry)) {
      throw new Error(`ambiguous reservation is not abandonable: ${registry.runId}`);
    }
    return {
      ...registry,
      spawnState: 'abandoned_unbound',
      updatedAtMs: nowMs,
      cleanup: {
        reason: 'abandoned_unbound_no_execution_evidence',
        cooperativeAcknowledgementObserved: false,
        closeOutcome: 'no_bound_handle',
        operatorFilesCleared: true,
        completedAtMs: nowMs,
      },
    };
  });
}

function parseProgressEvent(raw: unknown): SmokeProgressEvent | undefined {
  if (!isRecord(raw)) return undefined;
  const runId = String(raw.runId ?? '').trim();
  const scenarioOrdinal = Number(raw.scenarioOrdinal);
  const phase = String(raw.phase ?? '');
  const outcome = raw.outcome === undefined ? undefined : String(raw.outcome);
  if (
    !runId
    || !Number.isInteger(scenarioOrdinal)
    || scenarioOrdinal < 1
    || (phase !== 'started' && phase !== 'terminal')
    || (phase === 'started' && outcome !== undefined)
    || (phase === 'terminal' && !['pass', 'fail', 'blocked', 'skipped'].includes(outcome ?? ''))
  ) return undefined;
  return {
    runId,
    scenarioOrdinal,
    phase,
    ...(outcome ? { outcome: outcome as SmokeProgressEvent['outcome'] } : {}),
  };
}

export function inspectSmokeProgress(input: {
  artifactDir: string;
  runId: string;
  scenarioCount: number;
}): SmokeProgressInspection {
  const accepted: SmokeProgressEvent[] = [];
  const invalidEvents: string[] = [];
  let ordinal = 1;
  let started = false;
  const path = smokeProgressPath(input.artifactDir);
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/u) : [];
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    let event: SmokeProgressEvent | undefined;
    try { event = parseProgressEvent(JSON.parse(line) as unknown); } catch { /* diagnosed below */ }
    const prefix = `line_${index + 1}:`;
    if (!event) { invalidEvents.push(`${prefix}malformed_event`); return; }
    if (event.runId !== input.runId) { invalidEvents.push(`${prefix}wrong_run`); return; }
    if (event.scenarioOrdinal > input.scenarioCount) { invalidEvents.push(`${prefix}unknown_ordinal`); return; }
    if (ordinal > input.scenarioCount) { invalidEvents.push(`${prefix}post_terminal`); return; }
    if (event.scenarioOrdinal !== ordinal) {
      invalidEvents.push(`${prefix}${event.scenarioOrdinal < ordinal ? 'backward_or_duplicate' : 'non_monotonic'}`);
      return;
    }
    if (event.phase === 'started') {
      if (started) { invalidEvents.push(`${prefix}duplicate_start`); return; }
      started = true;
      accepted.push(event);
      return;
    }
    if (!started) { invalidEvents.push(`${prefix}terminal_before_start`); return; }
    accepted.push(event);
    started = false;
    ordinal += 1;
  });
  return {
    acceptedCount: accepted.length,
    completedScenarios: ordinal - 1,
    nextScenarioOrdinal: ordinal,
    planComplete: input.scenarioCount > 0 && ordinal > input.scenarioCount,
    invalidEvents,
    acceptedDigest: createHash('sha256').update(JSON.stringify(accepted)).digest('hex'),
  };
}

export function writeSmokeCancelRequest(input: {
  artifactDir: string;
  runId: string;
  reason: string;
  nowMs?: number;
}): boolean {
  const path = smokeCancelRequestPath(input.artifactDir);
  const current = readJson(path);
  if (isRecord(current) && String(current.runId ?? '') === input.runId) return true;
  try {
    atomicJson(path, {
      version: 1,
      runId: input.runId,
      reason: input.reason,
      requestedAtMs: input.nowMs ?? Date.now(),
    });
    return true;
  } catch {
    return false;
  }
}

export function tombstoneSmokeOperatorFiles(
  artifactDir: string,
  nowMs = Date.now(),
): { cleared: boolean; tombstoned: string[]; failures: string[] } {
  const liveDir = join(artifactDir, 'live');
  if (!existsSync(liveDir)) return { cleared: true, tombstoned: [], failures: [] };
  let entries: string[];
  try { entries = readdirSync(liveDir); } catch {
    return { cleared: false, tombstoned: [], failures: ['operator_live_dir_unreadable'] };
  }
  const tombstoned: string[] = [];
  const failures: string[] = [];
  for (const entry of entries) {
    if (!/^OPERATOR-ACTION-.*\.txt$/u.test(entry)) continue;
    try {
      const target = `${entry}.tombstoned-${nowMs}-${process.pid}`;
      renameSync(join(liveDir, entry), join(liveDir, target));
      tombstoned.push(target);
    } catch {
      failures.push(entry);
    }
  }
  return { cleared: failures.length === 0, tombstoned, failures };
}

function beginCleanup(artifactDir: string, nowMs: number): SmokeLifecycleRegistry {
  return mutateRegistry(artifactDir, (registry) => ({
    ...registry, spawnState: 'cleanup_pending', updatedAtMs: nowMs,
  }));
}

function finalize(input: {
  artifactDir: string;
  runId: string;
  reason: string;
  cooperativeAcknowledgementObserved: boolean;
  closeOutcome: string;
  operatorFilesCleared: boolean;
  nowMs: number;
}): SmokeLifecycleRegistry {
  const clean = input.operatorFilesCleared
    && ['closed_owned_handle', 'no_bound_handle'].includes(input.closeOutcome);
  atomicJson(smokeTerminalRecordPath(input.artifactDir), {
    version: 1,
    runId: input.runId,
    reason: input.reason,
    cooperativeAcknowledgementObserved: input.cooperativeAcknowledgementObserved,
    closeOutcome: input.closeOutcome,
    operatorFilesCleared: input.operatorFilesCleared,
    cleanupClean: clean,
    completedAtMs: input.nowMs,
  });
  return mutateRegistry(input.artifactDir, (registry) => ({
    ...registry,
    spawnState: clean ? 'clean' : 'cleanup_failed',
    updatedAtMs: input.nowMs,
    cleanup: {
      reason: input.reason,
      cooperativeAcknowledgementObserved: input.cooperativeAcknowledgementObserved,
      closeOutcome: input.closeOutcome,
      operatorFilesCleared: input.operatorFilesCleared,
      completedAtMs: input.nowMs,
    },
  }));
}

function runDirs(repoRoot: string): string[] {
  const root = join(repoRoot, SMOKE_LIFECYCLE_ROOT);
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name));
  } catch {
    return [];
  }
}

function operatorFilesRemain(artifactDir: string): boolean {
  const liveDir = join(artifactDir, 'live');
  if (!existsSync(liveDir)) return false;
  try { return readdirSync(liveDir).some((entry) => /^OPERATOR-ACTION-.*\.txt$/u.test(entry)); }
  catch { return true; }
}

const blocks = (registry: SmokeLifecycleRegistry): boolean =>
  registry.spawnState !== 'clean' && registry.spawnState !== 'abandoned_unbound';

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function createLock(repoRoot: string, lock: AdmissionLock): boolean {
  const path = smokeAdmissionLockPath(repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  try {
    const descriptor = openSync(path, 'wx');
    try { writeFileSync(descriptor, `${JSON.stringify(lock)}\n`, 'utf8'); }
    finally { closeSync(descriptor); }
    return true;
  } catch {
    return false;
  }
}

export function releaseSmokeAdmission(repoRoot: string, runId: string): boolean {
  const path = smokeAdmissionLockPath(repoRoot);
  const lock = parseLock(readJson(path));
  if (!lock || lock.runId !== runId) return false;
  try { rmSync(path, { force: true }); return true; } catch { return false; }
}

export function evaluateSmokeLifecycleCleanliness(repoRoot: string): SmokeLifecycleCleanliness {
  const reasons: string[] = [];
  const blockingRunIds: string[] = [];
  const lockPath = smokeAdmissionLockPath(repoRoot);
  if (existsSync(lockPath)) {
    const lock = parseLock(readJson(lockPath));
    reasons.push(lock ? `active_smoke_admission:${lock.runId}` : 'corrupt_smoke_admission_lock');
  }
  for (const artifactDir of runDirs(repoRoot)) {
    const lifecyclePath = smokeLifecycleRegistryPath(artifactDir);
    if (!existsSync(lifecyclePath)) {
      if (operatorFilesRemain(artifactDir)) {
        reasons.push(`unsafe_legacy_operator_state:${basename(artifactDir)}`);
        blockingRunIds.push(basename(artifactDir));
      }
      continue;
    }
    const registry = readSmokeLifecycleRegistry(artifactDir);
    if (!registry) {
      reasons.push(`corrupt_lifecycle_state:${basename(artifactDir)}`);
      blockingRunIds.push(basename(artifactDir));
      continue;
    }
    if (blocks(registry)) {
      reasons.push(`blocking_lifecycle:${registry.runId}:${registry.spawnState}`);
      blockingRunIds.push(registry.runId);
    }
    if (operatorFilesRemain(artifactDir)) {
      reasons.push(`unsafe_operator_state:${registry.runId}`);
      if (!blockingRunIds.includes(registry.runId)) blockingRunIds.push(registry.runId);
    }
  }
  return { clean: reasons.length === 0, reasons, blockingRunIds };
}

export function preflightSmokeLifecycle(input: {
  repoRoot: string;
  runId: string;
  supervisorPid?: number;
  nowMs?: number;
  isProcessAlive?: (pid: number) => boolean;
  closeBoundHandle: (handle: string, artifactDir: string) => string;
}): SmokeAdmissionResult {
  const nowMs = input.nowMs ?? Date.now();
  const isAlive = input.isProcessAlive ?? processAlive;
  const diagnostics: string[] = [];
  const lockPath = smokeAdmissionLockPath(input.repoRoot);
  if (existsSync(lockPath)) {
    const lock = parseLock(readJson(lockPath));
    if (!lock) return { admitted: false, reason: 'corrupt_smoke_admission_lock', diagnostics };
    if (isAlive(lock.supervisorPid)) {
      return { admitted: false, reason: `active_smoke_admission:${lock.runId}`, diagnostics };
    }
    rmSync(lockPath, { force: true });
    diagnostics.push(`removed_stale_admission:${lock.runId}`);
  }
  if (!createLock(input.repoRoot, {
    version: 1,
    runId: input.runId,
    supervisorPid: input.supervisorPid ?? process.pid,
    startedAtMs: nowMs,
  })) return { admitted: false, reason: 'smoke_admission_race_lost', diagnostics };

  let refusal: string | undefined;
  for (const artifactDir of runDirs(input.repoRoot)) {
    if (basename(artifactDir) === input.runId) continue;
    const lifecyclePath = smokeLifecycleRegistryPath(artifactDir);
    if (!existsSync(lifecyclePath)) {
      const tombstone = tombstoneSmokeOperatorFiles(artifactDir, nowMs);
      if (!tombstone.cleared) refusal ??= `unsafe_legacy_operator_state:${basename(artifactDir)}`;
      else if (tombstone.tombstoned.length) diagnostics.push(`tombstoned_legacy_operator_state:${basename(artifactDir)}`);
      continue;
    }
    let registry = readSmokeLifecycleRegistry(artifactDir);
    if (!registry) { refusal ??= `corrupt_lifecycle_state:${basename(artifactDir)}`; continue; }
    const tombstone = tombstoneSmokeOperatorFiles(artifactDir, nowMs);
    if (!tombstone.cleared) { refusal ??= `unsafe_operator_state:${registry.runId}`; continue; }
    if (
      ['reserved', 'create_in_progress'].includes(registry.spawnState)
      && !registry.terminalHandle
      && nowMs > registry.createDeadlineMs
    ) {
      registry = markSmokeCreateAmbiguous(artifactDir, 'interrupted_create_without_bound_handle', nowMs);
      diagnostics.push(`reclassified_ambiguous_unbound:${registry.runId}`);
    }
    if (registry.spawnState === 'ambiguous_unbound' && canAbandonAmbiguousUnbound(registry)) {
      registry = abandonAmbiguousUnbound(artifactDir, nowMs);
      diagnostics.push(`abandoned_unbound:${registry.runId}`);
    }
    if (
      ['bound', 'cleanup_pending', 'cleanup_failed'].includes(registry.spawnState)
      && registry.terminalHandle
    ) {
      beginCleanup(artifactDir, nowMs);
      const closeOutcome = input.closeBoundHandle(registry.terminalHandle, artifactDir);
      registry = finalize({
        artifactDir,
        runId: registry.runId,
        reason: 'restart_recovery',
        cooperativeAcknowledgementObserved: observeSmokeCancellationAcknowledgement(artifactDir, registry.runId),
        closeOutcome,
        operatorFilesCleared: tombstone.cleared,
        nowMs,
      });
      diagnostics.push(`recovered_bound_run:${registry.runId}:${closeOutcome}`);
    }
    if (blocks(registry)) refusal ??= `blocking_lifecycle:${registry.runId}:${registry.spawnState}`;
  }
  if (refusal) {
    releaseSmokeAdmission(input.repoRoot, input.runId);
    return { admitted: false, reason: refusal, diagnostics };
  }
  return { admitted: true, diagnostics };
}

export function cleanupSmokeLifecycle(input: {
  artifactDir: string;
  runId: string;
  reason: string;
  requestCancellation: boolean;
  cooperativeAcknowledgementObserved: boolean;
  closeBoundHandle: (handle: string) => string;
  nowMs?: number;
}): SmokeCleanupResult {
  const nowMs = input.nowMs ?? Date.now();
  const registry = readSmokeLifecycleRegistry(input.artifactDir);
  if (!registry || registry.runId !== input.runId) {
    return {
      clean: false,
      cooperativeAcknowledgementObserved: input.cooperativeAcknowledgementObserved,
      closeOutcome: 'registry_unreadable',
      operatorFilesCleared: false,
      reason: input.reason,
    };
  }
  if (registry.spawnState === 'clean' || registry.spawnState === 'abandoned_unbound') {
    return {
      clean: true,
      cooperativeAcknowledgementObserved:
        registry.cleanup?.cooperativeAcknowledgementObserved ?? false,
      closeOutcome: registry.cleanup?.closeOutcome ?? 'no_bound_handle',
      operatorFilesCleared: registry.cleanup?.operatorFilesCleared ?? true,
      reason: registry.cleanup?.reason ?? input.reason,
    };
  }
  beginCleanup(input.artifactDir, nowMs);
  const cancellationRecorded = !input.requestCancellation || writeSmokeCancelRequest({
    artifactDir: input.artifactDir,
    runId: input.runId,
    reason: input.reason,
    nowMs,
  });
  const closeOutcome = registry.terminalHandle
    ? input.closeBoundHandle(registry.terminalHandle)
    : 'no_bound_handle';
  const operator = tombstoneSmokeOperatorFiles(input.artifactDir, nowMs);
  const finalized = finalize({
    artifactDir: input.artifactDir,
    runId: input.runId,
    reason: input.reason,
    cooperativeAcknowledgementObserved: input.cooperativeAcknowledgementObserved,
    closeOutcome,
    operatorFilesCleared: operator.cleared && cancellationRecorded,
    nowMs,
  });
  return {
    clean: finalized.spawnState === 'clean',
    cooperativeAcknowledgementObserved: input.cooperativeAcknowledgementObserved,
    closeOutcome,
    operatorFilesCleared: operator.cleared && cancellationRecorded,
    reason: input.reason,
  };
}
