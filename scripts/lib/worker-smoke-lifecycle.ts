import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync as readFileUtf8Sync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  createSmokeCompletionObservationState,
  observeSmokeCompletionEvidence,
} from './worker-smoke-core.ts';

export const SMOKE_LIFECYCLE_ROOT = '.orca-worker-smoke/runs';
export const SMOKE_ADMISSION_LOCK = '.orca-worker-smoke/admission.lock.json';
export const SMOKE_ADMISSION_RECLAIM_ROOT = '.orca-worker-smoke/admission-reclaims';
export const SMOKE_CREATE_TIMEOUT_MS = 60_000;
export const SMOKE_DELIVERY_TIMEOUT_MS = 10 * 60_000;
export const SMOKE_PROGRESS_STALL_MS = 25 * 60_000;
export const SMOKE_ABSOLUTE_CEILING_MS = 4 * 60 * 60_000;
export const SMOKE_ORCA_OPERATION_TIMEOUT_MS = 30_000;
const IS_VITEST_RUNTIME = process.env.VITEST === 'true' || Boolean(process.env.VITEST_WORKER_ID);
export const SMOKE_SHUTDOWN_TIMEOUT_MS = IS_VITEST_RUNTIME ? 50 : 2 * 60_000;
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
  scenarioCount: number;
  terminalHandle?: string;
  createDiagnostic?: string;
  closeAttemptedAtMs?: number;
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

interface AdmissionReclaimMarker {
  version: 1;
  runId: string;
  supervisorPid: number;
  createdAtMs: number;
  observedLock: AdmissionLock;
}

interface RunDirectoryDiscovery {
  state: 'absent' | 'ok' | 'unreadable';
  directories: string[];
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
    return JSON.parse(readFileUtf8Sync(path, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
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

function closeOutcomeIsClean(outcome: string): boolean {
  return outcome === 'closed_owned_handle' || outcome === 'closed_owned_handle_already_absent';
}

function registryStateIsConsistent(registry: SmokeLifecycleRegistry): boolean {
  const hasHandle = Boolean(registry.terminalHandle);
  const closeAttempted = Number.isFinite(registry.closeAttemptedAtMs);
  switch (registry.spawnState) {
    case 'reserved':
    case 'create_in_progress':
    case 'ambiguous_unbound':
      return !hasHandle && !registry.cleanup && !closeAttempted;
    case 'abandoned_unbound':
      return !hasHandle
        && registry.cleanup?.reason === 'abandoned_unbound_no_execution_evidence'
        && registry.cleanup.closeOutcome === 'no_bound_handle'
        && registry.cleanup.operatorFilesCleared
        && !closeAttempted;
    case 'bound':
      return hasHandle && !registry.cleanup && !closeAttempted;
    case 'cleanup_pending':
      return hasHandle && closeAttempted;
    case 'clean':
      return hasHandle
        && closeAttempted
        && Boolean(registry.cleanup)
        && closeOutcomeIsClean(registry.cleanup!.closeOutcome)
        && registry.cleanup!.operatorFilesCleared;
    case 'cleanup_failed':
      return hasHandle && closeAttempted && Boolean(registry.cleanup);
    default:
      return false;
  }
}

function parseRegistry(
  value: unknown,
  expectedArtifactDir?: string,
): SmokeLifecycleRegistry | undefined {
  if (!isRecord(value)) return undefined;
  const spawnState = String(value.spawnState ?? '') as SmokeSpawnState;
  if (![
    'reserved', 'create_in_progress', 'bound', 'ambiguous_unbound',
    'abandoned_unbound', 'cleanup_pending', 'clean', 'cleanup_failed',
  ].includes(spawnState)) return undefined;
  const cleanup = parseCleanup(value.cleanup);
  const closeAttemptedAtMs = value.closeAttemptedAtMs === undefined
    ? undefined
    : Number(value.closeAttemptedAtMs);
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
    scenarioCount: Number(value.scenarioCount),
    ...(typeof value.terminalHandle === 'string' && value.terminalHandle.trim()
      ? { terminalHandle: value.terminalHandle.trim() }
      : {}),
    ...(typeof value.createDiagnostic === 'string'
      ? { createDiagnostic: value.createDiagnostic.slice(0, 512) }
      : {}),
    ...(closeAttemptedAtMs === undefined ? {} : { closeAttemptedAtMs }),
    ...(cleanup ? { cleanup } : {}),
  };
  if (
    Number(value.version) !== 1
    || !registry.runId
    || !registry.artifactDir
    || (expectedArtifactDir !== undefined && !samePath(registry.artifactDir, expectedArtifactDir))
    || (expectedArtifactDir !== undefined && basename(resolve(expectedArtifactDir)) !== registry.runId)
    || !/^[0-9a-f]{40}$/u.test(registry.headSha)
    || !Number.isInteger(registry.issueNumber)
    || registry.issueNumber <= 0
    || !Number.isInteger(registry.prNumber)
    || registry.prNumber <= 0
    || !Number.isInteger(registry.supervisorPid)
    || registry.supervisorPid <= 0
    || !Number.isFinite(registry.createdAtMs)
    || !Number.isFinite(registry.updatedAtMs)
    || !Number.isFinite(registry.createDeadlineMs)
    || !Number.isInteger(registry.scenarioCount)
    || registry.scenarioCount < 1
    || (closeAttemptedAtMs !== undefined && !Number.isFinite(closeAttemptedAtMs))
    || !registryStateIsConsistent(registry)
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

function parseReclaimMarker(value: unknown): AdmissionReclaimMarker | undefined {
  if (!isRecord(value)) return undefined;
  const observedLock = parseLock(value.observedLock);
  const marker: AdmissionReclaimMarker = {
    version: 1,
    runId: String(value.runId ?? '').trim(),
    supervisorPid: Number(value.supervisorPid),
    createdAtMs: Number(value.createdAtMs),
    observedLock: observedLock ?? { version: 1, runId: '', supervisorPid: 0, startedAtMs: 0 },
  };
  if (
    Number(value.version) !== 1
    || !marker.runId
    || !Number.isInteger(marker.supervisorPid)
    || marker.supervisorPid <= 0
    || !Number.isFinite(marker.createdAtMs)
    || !observedLock
  ) return undefined;
  return marker;
}

function sameLock(left: AdmissionLock | undefined, right: AdmissionLock): boolean {
  return Boolean(left)
    && left!.runId === right.runId
    && left!.supervisorPid === right.supervisorPid
    && left!.startedAtMs === right.startedAtMs;
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
export const smokeAdmissionReclaimRootPath = (repoRoot: string): string =>
  join(repoRoot, SMOKE_ADMISSION_RECLAIM_ROOT);

export function readSmokeLifecycleRegistry(artifactDir: string): SmokeLifecycleRegistry | undefined {
  return parseRegistry(readJson(smokeLifecycleRegistryPath(artifactDir)), artifactDir);
}

function mutateRegistry(
  artifactDir: string,
  mutate: (registry: SmokeLifecycleRegistry) => SmokeLifecycleRegistry,
): SmokeLifecycleRegistry {
  const current = readSmokeLifecycleRegistry(artifactDir);
  if (!current) throw new Error(`smoke lifecycle registry unreadable: ${artifactDir}`);
  const next = mutate(current);
  if (!registryStateIsConsistent(next) || !samePath(next.artifactDir, artifactDir)) {
    throw new Error(`smoke lifecycle mutation produced inconsistent state: ${next.runId}`);
  }
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
  scenarioCount: number;
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
    scenarioCount: input.scenarioCount,
  };
  if (!parseRegistry(registry, input.artifactDir)) {
    throw new Error('invalid smoke lifecycle reservation');
  }
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

function progressSurfaceHasBytes(artifactDir: string): boolean {
  const path = smokeProgressPath(artifactDir);
  if (!existsSync(path)) return false;
  try {
    return readFileUtf8Sync(path, 'utf8').trim().length > 0;
  } catch {
    return true;
  }
}

const hasCompletionArtifact = (artifactDir: string): boolean => {
  try {
    return existsSync(artifactDir)
      && readdirSync(artifactDir).some((entry) =>
        entry === 'completion.pending.body'
        || /^completion-[0-9a-f]{64}\.(?:body|sealed\.json)$/u.test(entry));
  } catch {
    return true;
  }
};

function observeSmokePublishCompleteForRun(artifactDir: string, runId: string): boolean {
  const observed = observeSmokeCompletionEvidence(
    { artifactDir, runId },
    createSmokeCompletionObservationState(),
  ).observation;
  return observed.publicationState === 'publish_complete_single';
}

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
    && !progressSurfaceHasBytes(registry.artifactDir)
    && !hasCompletionArtifact(registry.artifactDir)
    && !observeSmokeCancellationAcknowledgement(registry.artifactDir, registry.runId);
}

function writeTerminalRecord(input: {
  artifactDir: string;
  runId: string;
  reason: string;
  cooperativeAcknowledgementObserved: boolean;
  closeOutcome: string;
  operatorFilesCleared: boolean;
  cleanupClean: boolean;
  completedAtMs: number;
}): void {
  atomicJson(smokeTerminalRecordPath(input.artifactDir), {
    version: 1,
    runId: input.runId,
    reason: input.reason,
    cooperativeAcknowledgementObserved: input.cooperativeAcknowledgementObserved,
    closeOutcome: input.closeOutcome,
    operatorFilesCleared: input.operatorFilesCleared,
    cleanupClean: input.cleanupClean,
    completedAtMs: input.completedAtMs,
  });
}

export function abandonAmbiguousUnbound(
  artifactDir: string,
  nowMs = Date.now(),
): SmokeLifecycleRegistry {
  const current = readSmokeLifecycleRegistry(artifactDir);
  if (!current || !canAbandonAmbiguousUnbound(current)) {
    throw new Error(`ambiguous reservation is not abandonable: ${current?.runId ?? artifactDir}`);
  }
  const operator = tombstoneSmokeOperatorFiles(artifactDir, nowMs);
  if (!operator.cleared) {
    throw new Error(`ambiguous abandonment operator cleanup failed: ${current.runId}`);
  }
  writeTerminalRecord({
    artifactDir,
    runId: current.runId,
    reason: 'abandoned_unbound_no_execution_evidence',
    cooperativeAcknowledgementObserved: false,
    closeOutcome: 'no_bound_handle',
    operatorFilesCleared: true,
    cleanupClean: true,
    completedAtMs: nowMs,
  });
  return mutateRegistry(artifactDir, (registry) => ({
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
  }));
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
  const lines = existsSync(path) ? readFileUtf8Sync(path, 'utf8').split(/\r?\n/u) : [];
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
    ...registry,
    spawnState: 'cleanup_pending',
    closeAttemptedAtMs: registry.closeAttemptedAtMs ?? nowMs,
    updatedAtMs: nowMs,
  }));
}

function normalizeRecoveredCloseOutcome(
  closePreviouslyAttempted: boolean,
  closeOutcome: string,
): string {
  return closePreviouslyAttempted && closeOutcome === 'close_failed:channel_stale_handle'
    ? 'closed_owned_handle_already_absent'
    : closeOutcome;
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
  const clean = input.operatorFilesCleared && closeOutcomeIsClean(input.closeOutcome);
  writeTerminalRecord({
    ...input,
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

function discoverRunDirectories(repoRoot: string): RunDirectoryDiscovery {
  const root = join(repoRoot, SMOKE_LIFECYCLE_ROOT);
  if (!existsSync(root)) return { state: 'absent', directories: [] };
  try {
    return {
      state: 'ok',
      directories: readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(root, entry.name)),
    };
  } catch {
    return { state: 'unreadable', directories: [] };
  }
}

function operatorFilesRemain(artifactDir: string): boolean {
  const liveDir = join(artifactDir, 'live');
  if (!existsSync(liveDir)) return false;
  try { return readdirSync(liveDir).some((entry) => /^OPERATOR-ACTION-.*\.txt$/u.test(entry)); }
  catch { return true; }
}

function unregisteredExecutionEvidence(artifactDir: string): string[] {
  const evidence: string[] = [];
  if (existsSync(join(artifactDir, 'delivery.sealed.json'))) evidence.push('delivery');
  if (progressSurfaceHasBytes(artifactDir)) evidence.push('progress');
  if (hasCompletionArtifact(artifactDir)) evidence.push('completion');
  if (existsSync(smokeCancelAcknowledgementPath(artifactDir))) evidence.push('cancel_ack');
  return evidence;
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

function reclaimMarkerPath(repoRoot: string, observedLock: AdmissionLock): string {
  const digest = createHash('sha256').update(JSON.stringify(observedLock)).digest('hex');
  return join(smokeAdmissionReclaimRootPath(repoRoot), `${digest}.json`);
}

function listReclaimMarkers(repoRoot: string): { unreadable: boolean; paths: string[] } {
  const root = smokeAdmissionReclaimRootPath(repoRoot);
  if (!existsSync(root)) return { unreadable: false, paths: [] };
  try {
    return {
      unreadable: false,
      paths: readdirSync(root)
        .filter((entry) => entry.endsWith('.json'))
        .map((entry) => join(root, entry)),
    };
  } catch {
    return { unreadable: true, paths: [] };
  }
}

function createReclaimMarker(
  repoRoot: string,
  marker: AdmissionReclaimMarker,
): string | undefined {
  const path = reclaimMarkerPath(repoRoot, marker.observedLock);
  mkdirSync(dirname(path), { recursive: true });
  try {
    const descriptor = openSync(path, 'wx');
    try { writeFileSync(descriptor, `${JSON.stringify(marker)}\n`, 'utf8'); }
    finally { closeSync(descriptor); }
    return path;
  } catch {
    return undefined;
  }
}

function cleanupOrClassifyReclaimMarkers(
  repoRoot: string,
  isAlive: (pid: number) => boolean,
  diagnostics: string[],
): string | undefined {
  const listed = listReclaimMarkers(repoRoot);
  if (listed.unreadable) return 'smoke_admission_reclaim_root_unreadable';
  for (const path of listed.paths) {
    const marker = parseReclaimMarker(readJson(path));
    if (!marker) return `corrupt_smoke_admission_reclaim:${basename(path)}`;
    if (isAlive(marker.supervisorPid)) {
      return `active_smoke_admission_reclaim:${marker.runId}`;
    }
    try {
      rmSync(path, { force: true });
      diagnostics.push(`removed_stale_admission_reclaim:${marker.runId}`);
    } catch {
      return `stale_smoke_admission_reclaim_unremovable:${marker.runId}`;
    }
  }
  return undefined;
}

function foreignReclaimMarkerExists(repoRoot: string, ownPath?: string): boolean {
  const listed = listReclaimMarkers(repoRoot);
  if (listed.unreadable) return true;
  return listed.paths.some((path) => path !== ownPath);
}

function sleepWithAtomics(milliseconds: number): void {
  if (milliseconds <= 0) return;
  const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  Atomics.wait(signal, 0, 0, milliseconds);
}

function waitForCooperativeShutdown(input: {
  artifactDir: string;
  runId: string;
  timeoutMs: number;
  now: () => number;
  sleepMs: (milliseconds: number) => void;
}): boolean {
  const deadline = input.now() + Math.max(0, input.timeoutMs);
  for (;;) {
    if (
      observeSmokeCancellationAcknowledgement(input.artifactDir, input.runId)
      || observeSmokePublishCompleteForRun(input.artifactDir, input.runId)
    ) return true;
    const remaining = deadline - input.now();
    if (remaining <= 0) return false;
    input.sleepMs(Math.min(SMOKE_LIFECYCLE_POLL_MS, remaining));
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
  const reclaimMarkers = listReclaimMarkers(repoRoot);
  if (reclaimMarkers.unreadable) {
    reasons.push('smoke_admission_reclaim_root_unreadable');
  } else if (reclaimMarkers.paths.length > 0) {
    reasons.push('active_smoke_admission_reclaim');
  }
  const discovered = discoverRunDirectories(repoRoot);
  if (discovered.state === 'unreadable') {
    reasons.push('lifecycle_root_unreadable');
    return { clean: false, reasons, blockingRunIds };
  }
  for (const artifactDir of discovered.directories) {
    const lifecyclePath = smokeLifecycleRegistryPath(artifactDir);
    if (!existsSync(lifecyclePath)) {
      const evidence = unregisteredExecutionEvidence(artifactDir);
      if (evidence.length > 0) {
        reasons.push(`unregistered_execution_evidence:${basename(artifactDir)}:${evidence.join(',')}`);
        blockingRunIds.push(basename(artifactDir));
      } else if (operatorFilesRemain(artifactDir)) {
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
  now?: () => number;
  sleepMs?: (milliseconds: number) => void;
  shutdownMs?: number;
  isProcessAlive?: (pid: number) => boolean;
  closeBoundHandle: (handle: string, artifactDir: string) => string;
  afterAdmissionReclaimMarker?: () => void;
}): SmokeAdmissionResult {
  const now = input.now ?? (() => Date.now());
  const nowMs = input.nowMs ?? now();
  const sleepMs = input.sleepMs ?? sleepWithAtomics;
  const isAlive = input.isProcessAlive ?? processAlive;
  const diagnostics: string[] = [];
  const markerProblem = cleanupOrClassifyReclaimMarkers(input.repoRoot, isAlive, diagnostics);
  if (markerProblem) return { admitted: false, reason: markerProblem, diagnostics };

  const lockPath = smokeAdmissionLockPath(input.repoRoot);
  let ownReclaimMarker: string | undefined;
  if (existsSync(lockPath)) {
    const observedLock = parseLock(readJson(lockPath));
    if (!observedLock) return { admitted: false, reason: 'corrupt_smoke_admission_lock', diagnostics };
    if (isAlive(observedLock.supervisorPid)) {
      return { admitted: false, reason: `active_smoke_admission:${observedLock.runId}`, diagnostics };
    }
    ownReclaimMarker = createReclaimMarker(input.repoRoot, {
      version: 1,
      runId: input.runId,
      supervisorPid: input.supervisorPid ?? process.pid,
      createdAtMs: nowMs,
      observedLock,
    });
    if (!ownReclaimMarker) {
      return { admitted: false, reason: 'smoke_admission_reclaim_race_lost', diagnostics };
    }
    input.afterAdmissionReclaimMarker?.();
    const currentLock = parseLock(readJson(lockPath));
    if (!sameLock(currentLock, observedLock)) {
      rmSync(ownReclaimMarker, { force: true });
      return { admitted: false, reason: 'smoke_admission_changed_during_reclaim', diagnostics };
    }
    try {
      rmSync(lockPath, { force: true });
      diagnostics.push(`removed_stale_admission:${observedLock.runId}`);
    } catch {
      rmSync(ownReclaimMarker, { force: true });
      return { admitted: false, reason: `stale_smoke_admission_unremovable:${observedLock.runId}`, diagnostics };
    }
  }

  if (foreignReclaimMarkerExists(input.repoRoot, ownReclaimMarker)) {
    if (ownReclaimMarker) rmSync(ownReclaimMarker, { force: true });
    return { admitted: false, reason: 'active_smoke_admission_reclaim', diagnostics };
  }
  const ownLock: AdmissionLock = {
    version: 1,
    runId: input.runId,
    supervisorPid: input.supervisorPid ?? process.pid,
    startedAtMs: nowMs,
  };
  if (!createLock(input.repoRoot, ownLock)) {
    if (ownReclaimMarker) rmSync(ownReclaimMarker, { force: true });
    return { admitted: false, reason: 'smoke_admission_race_lost', diagnostics };
  }
  if (!sameLock(parseLock(readJson(lockPath)), ownLock)) {
    if (ownReclaimMarker) rmSync(ownReclaimMarker, { force: true });
    return { admitted: false, reason: 'smoke_admission_ownership_unproven', diagnostics };
  }
  if (ownReclaimMarker) rmSync(ownReclaimMarker, { force: true });

  const discovered = discoverRunDirectories(input.repoRoot);
  if (discovered.state === 'unreadable') {
    releaseSmokeAdmission(input.repoRoot, input.runId);
    return { admitted: false, reason: 'lifecycle_root_unreadable', diagnostics };
  }

  let refusal: string | undefined;
  for (const artifactDir of discovered.directories) {
    if (basename(artifactDir) === input.runId) continue;
    const lifecyclePath = smokeLifecycleRegistryPath(artifactDir);
    if (!existsSync(lifecyclePath)) {
      const evidence = unregisteredExecutionEvidence(artifactDir);
      if (evidence.length > 0) {
        refusal ??= `unregistered_execution_evidence:${basename(artifactDir)}:${evidence.join(',')}`;
        continue;
      }
      const tombstone = tombstoneSmokeOperatorFiles(artifactDir, nowMs);
      if (!tombstone.cleared) refusal ??= `unsafe_legacy_operator_state:${basename(artifactDir)}`;
      else if (tombstone.tombstoned.length) diagnostics.push(`tombstoned_legacy_operator_state:${basename(artifactDir)}`);
      continue;
    }
    let registry = readSmokeLifecycleRegistry(artifactDir);
    if (!registry) { refusal ??= `corrupt_lifecycle_state:${basename(artifactDir)}`; continue; }
    if (
      ['reserved', 'create_in_progress'].includes(registry.spawnState)
      && !registry.terminalHandle
      && nowMs > registry.createDeadlineMs
    ) {
      registry = markSmokeCreateAmbiguous(artifactDir, 'interrupted_create_without_bound_handle', nowMs);
      diagnostics.push(`reclassified_ambiguous_unbound:${registry.runId}`);
    }
    if (registry.spawnState === 'ambiguous_unbound' && canAbandonAmbiguousUnbound(registry)) {
      try {
        registry = abandonAmbiguousUnbound(artifactDir, nowMs);
        diagnostics.push(`abandoned_unbound:${registry.runId}`);
      } catch {
        refusal ??= `ambiguous_abandonment_failed:${registry.runId}`;
      }
    }
    if (
      ['bound', 'cleanup_pending', 'cleanup_failed'].includes(registry.spawnState)
      && registry.terminalHandle
    ) {
      const closePreviouslyAttempted = registry.closeAttemptedAtMs !== undefined
        || registry.spawnState === 'cleanup_pending';
      beginCleanup(artifactDir, nowMs);
      const cancellationRecorded = writeSmokeCancelRequest({
        artifactDir,
        runId: registry.runId,
        reason: 'restart_recovery',
        nowMs,
      });
      const acknowledged = cancellationRecorded && waitForCooperativeShutdown({
        artifactDir,
        runId: registry.runId,
        timeoutMs: input.shutdownMs ?? SMOKE_SHUTDOWN_TIMEOUT_MS,
        now,
        sleepMs,
      });
      const rawCloseOutcome = input.closeBoundHandle(registry.terminalHandle, artifactDir);
      const closeOutcome = normalizeRecoveredCloseOutcome(closePreviouslyAttempted, rawCloseOutcome);
      const tombstone = tombstoneSmokeOperatorFiles(artifactDir, nowMs);
      registry = finalize({
        artifactDir,
        runId: registry.runId,
        reason: 'restart_recovery',
        cooperativeAcknowledgementObserved: acknowledged,
        closeOutcome,
        operatorFilesCleared: tombstone.cleared && cancellationRecorded,
        nowMs,
      });
      diagnostics.push(`recovered_bound_run:${registry.runId}:${closeOutcome}`);
    } else {
      const tombstone = tombstoneSmokeOperatorFiles(artifactDir, nowMs);
      if (!tombstone.cleared) refusal ??= `unsafe_operator_state:${registry.runId}`;
      else if (tombstone.tombstoned.length) diagnostics.push(`tombstoned_operator_state:${registry.runId}`);
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
  if (!registry.terminalHandle && [
    'reserved',
    'create_in_progress',
    'ambiguous_unbound',
  ].includes(registry.spawnState)) {
    if (registry.spawnState !== 'ambiguous_unbound') {
      markSmokeCreateAmbiguous(
        input.artifactDir,
        `cleanup_without_bound_handle:${input.reason}`,
        nowMs,
      );
    }
    return {
      clean: false,
      cooperativeAcknowledgementObserved: input.cooperativeAcknowledgementObserved,
      closeOutcome: 'ambiguous_unbound',
      operatorFilesCleared: false,
      reason: input.reason,
    };
  }
  const closePreviouslyAttempted = registry.closeAttemptedAtMs !== undefined
    || registry.spawnState === 'cleanup_pending';
  beginCleanup(input.artifactDir, nowMs);
  const cancellationRequired = input.requestCancellation || (
    Boolean(registry.terminalHandle)
    && input.reason !== 'child_completed'
    && input.reason !== 'invalid_child_report'
  );
  const cancellationRecorded = !cancellationRequired || writeSmokeCancelRequest({
    artifactDir: input.artifactDir,
    runId: input.runId,
    reason: input.reason,
    nowMs,
  });
  const rawCloseOutcome = registry.terminalHandle
    ? input.closeBoundHandle(registry.terminalHandle)
    : 'no_bound_handle';
  const closeOutcome = normalizeRecoveredCloseOutcome(closePreviouslyAttempted, rawCloseOutcome);
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
