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

interface SmokeAdmissionLockRecord {
  version: 1;
  runId: string;
  supervisorPid: number;
  startedAtMs: number;
}

function normalizeHeadSha(value: string): string {
  return value.trim().toLowerCase();
}

function jsonStringify(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temp, jsonStringify(value), { encoding: 'utf8', flag: 'wx' });
  renameSync(temp, path);
}

function readJson(path: string): unknown | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseRegistry(value: unknown): SmokeLifecycleRegistry | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const spawnState = String(value.spawnState ?? '') as SmokeSpawnState;
  if (![
    'reserved',
    'create_in_progress',
    'bound',
    'ambiguous_unbound',
    'abandoned_unbound',
    'cleanup_pending',
    'clean',
    'cleanup_failed',
  ].includes(spawnState)) {
    return undefined;
  }
  const runId = String(value.runId ?? '').trim();
  const artifactDir = String(value.artifactDir ?? '').trim();
  const headSha = normalizeHeadSha(String(value.headSha ?? ''));
  const issueNumber = Number(value.issueNumber);
  const prNumber = Number(value.prNumber);
  const supervisorPid = Number(value.supervisorPid);
  const createdAtMs = Number(value.createdAtMs);
  const updatedAtMs = Number(value.updatedAtMs);
  const createDeadlineMs = Number(value.createDeadlineMs);
  if (
    Number(value.version) !== 1
    || !runId
    || !artifactDir
    || !/^[0-9a-f]{40}$/u.test(headSha)
    || !Number.isInteger(issueNumber)
    || !Number.isInteger(prNumber)
    || !Number.isInteger(supervisorPid)
    || !Number.isFinite(createdAtMs)
    || !Number.isFinite(updatedAtMs)
    || !Number.isFinite(createDeadlineMs)
  ) {
    return undefined;
  }
  const terminalHandle = typeof value.terminalHandle === 'string' && value.terminalHandle.trim()
    ? value.terminalHandle.trim()
    : undefined;
  const createDiagnostic = typeof value.createDiagnostic === 'string'
    ? value.createDiagnostic.slice(0, 512)
    : undefined;
  const cleanup = isRecord(value.cleanup)
    ? {
      reason: String(value.cleanup.reason ?? ''),
      cooperativeAcknowledgementObserved: Boolean(
        value.cleanup.cooperativeAcknowledgementObserved,
      ),
      closeOutcome: String(value.cleanup.closeOutcome ?? ''),
      operatorFilesCleared: Boolean(value.cleanup.operatorFilesCleared),
      completedAtMs: Number(value.cleanup.completedAtMs),
    }
    : undefined;
  return {
    version: 1,
    runId,
    issueNumber,
    prNumber,
    headSha,
    artifactDir,
    supervisorPid,
    createdAtMs,
    updatedAtMs,
    spawnState,
    createDeadlineMs,
    ...(terminalHandle ? { terminalHandle } : {}),
    ...(createDiagnostic ? { createDiagnostic } : {}),
    ...(cleanup && Number.isFinite(cleanup.completedAtMs) ? { cleanup } : {}),
  };
}

export function smokeLifecycleRegistryPath(artifactDir: string): string {
  return join(artifactDir, 'lifecycle.json');
}

export function smokeProgressPath(artifactDir: string): string {
  return join(artifactDir, 'progress.ndjson');
}

export function smokeCancelRequestPath(artifactDir: string): string {
  return join(artifactDir, 'cancel-request.json');
}

export function smokeCancelAcknowledgementPath(artifactDir: string): string {
  return join(artifactDir, 'cancel-acknowledgement.json');
}

export function smokeTerminalRecordPath(artifactDir: string): string {
  return join(artifactDir, 'terminal.json');
}

export function smokeAdmissionLockPath(repoRoot: string): string {
  return join(repoRoot, SMOKE_ADMISSION_LOCK);
}

export function readSmokeLifecycleRegistry(
  artifactDir: string,
): SmokeLifecycleRegistry | undefined {
  return parseRegistry(readJson(smokeLifecycleRegistryPath(artifactDir)));
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
  mkdirSync(input.artifactDir, { recursive: true });
  const registry: SmokeLifecycleRegistry = {
    version: 1,
    runId: input.runId,
    issueNumber: input.issueNumber,
    prNumber: input.prNumber,
    headSha: normalizeHeadSha(input.headSha),
    artifactDir: input.artifactDir,
    supervisorPid: input.supervisorPid ?? process.pid,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    spawnState: 'reserved',
    createDeadlineMs: nowMs + (input.createTimeoutMs ?? SMOKE_CREATE_TIMEOUT_MS),
  };
  writeJsonAtomic(smokeLifecycleRegistryPath(input.artifactDir), registry);
  return registry;
}

function updateRegistry(
  artifactDir: string,
  mutate: (registry: SmokeLifecycleRegistry) => SmokeLifecycleRegistry,
): SmokeLifecycleRegistry {
  const current = readSmokeLifecycleRegistry(artifactDir);
  if (!current) {
    throw new Error(`smoke lifecycle registry unreadable: ${artifactDir}`);
  }
  const next = mutate(current);
  writeJsonAtomic(smokeLifecycleRegistryPath(artifactDir), next);
  return next;
}

export function markSmokeCreateInProgress(
  artifactDir: string,
  nowMs = Date.now(),
): SmokeLifecycleRegistry {
  return updateRegistry(artifactDir, (registry) => ({
    ...registry,
    spawnState: 'create_in_progress',
    updatedAtMs: nowMs,
  }));
}

export function bindSmokeTerminalHandle(
  artifactDir: string,
  terminalHandle: string,
  nowMs = Date.now(),
): SmokeLifecycleRegistry {
  const normalized = terminalHandle.trim();
  if (!normalized) {
    throw new Error('terminal handle is required');
  }
  return updateRegistry(artifactDir, (registry) => ({
    ...registry,
    terminalHandle: normalized,
    spawnState: 'bound',
    updatedAtMs: nowMs,
  }));
}

export function markSmokeCreateAmbiguous(
  artifactDir: string,
  diagnostic: string,
  nowMs = Date.now(),
): SmokeLifecycleRegistry {
  return updateRegistry(artifactDir, (registry) => ({
    ...registry,
    spawnState: 'ambiguous_unbound',
    createDiagnostic: diagnostic.slice(0, 512),
    updatedAtMs: nowMs,
  }));
}

function completionSealExists(artifactDir: string): boolean {
  if (!existsSync(artifactDir)) {
    return false;
  }
  try {
    return readdirSync(artifactDir).some((entry) => /^completion-[0-9a-f]{64}\.sealed\.json$/u.test(entry));
  } catch {
    return true;
  }
}

function deliveryEvidenceExists(artifactDir: string): boolean {
  return existsSync(join(artifactDir, 'delivery.sealed.json'));
}

function cancellationAcknowledgementExists(artifactDir: string, runId?: string): boolean {
  const value = readJson(smokeCancelAcknowledgementPath(artifactDir));
  if (!isRecord(value)) {
    return false;
  }
  const observedRunId = String(value.runId ?? '').trim();
  return Boolean(observedRunId) && (!runId || observedRunId === runId);
}

function progressBytesExist(artifactDir: string): boolean {
  const path = smokeProgressPath(artifactDir);
  if (!existsSync(path)) {
    return false;
  }
  try {
    return statSync(path).size > 0;
  } catch {
    return true;
  }
}

export function canAbandonAmbiguousUnbound(registry: SmokeLifecycleRegistry): boolean {
  return registry.spawnState === 'ambiguous_unbound'
    && !registry.terminalHandle
    && !deliveryEvidenceExists(registry.artifactDir)
    && !progressBytesExist(registry.artifactDir)
    && !completionSealExists(registry.artifactDir)
    && !cancellationAcknowledgementExists(registry.artifactDir, registry.runId);
}

export function abandonAmbiguousUnbound(
  artifactDir: string,
  nowMs = Date.now(),
): SmokeLifecycleRegistry {
  return updateRegistry(artifactDir, (registry) => {
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

function parseProgressEvent(value: unknown): SmokeProgressEvent | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const runId = String(value.runId ?? '').trim();
  const scenarioOrdinal = Number(value.scenarioOrdinal);
  const phase = String(value.phase ?? '');
  const outcome = value.outcome === undefined ? undefined : String(value.outcome);
  if (
    !runId
    || !Number.isInteger(scenarioOrdinal)
    || scenarioOrdinal < 1
    || (phase !== 'started' && phase !== 'terminal')
    || (phase === 'started' && outcome !== undefined)
    || (phase === 'terminal' && !['pass', 'fail', 'blocked', 'skipped'].includes(outcome ?? ''))
  ) {
    return undefined;
  }
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
  const path = smokeProgressPath(input.artifactDir);
  const invalidEvents: string[] = [];
  const accepted: SmokeProgressEvent[] = [];
  let nextScenarioOrdinal = 1;
  let started = false;
  if (existsSync(path)) {
    const lines = readFileSync(path, 'utf8').split(/\r?\n/u);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]?.trim();
      if (!line) {
        continue;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(line) as unknown;
      } catch {
        invalidEvents.push(`line_${index + 1}:malformed_json`);
        continue;
      }
      const event = parseProgressEvent(raw);
      if (!event) {
        invalidEvents.push(`line_${index + 1}:malformed_event`);
        continue;
      }
      if (event.runId !== input.runId) {
        invalidEvents.push(`line_${index + 1}:wrong_run`);
        continue;
      }
      if (event.scenarioOrdinal > input.scenarioCount) {
        invalidEvents.push(`line_${index + 1}:unknown_ordinal`);
        continue;
      }
      if (nextScenarioOrdinal > input.scenarioCount) {
        invalidEvents.push(`line_${index + 1}:post_terminal`);
        continue;
      }
      if (event.scenarioOrdinal !== nextScenarioOrdinal) {
        invalidEvents.push(
          `line_${index + 1}:${event.scenarioOrdinal < nextScenarioOrdinal ? 'backward_or_duplicate' : 'non_monotonic'}`,
        );
        continue;
      }
      if (event.phase === 'started') {
        if (started) {
          invalidEvents.push(`line_${index + 1}:duplicate_start`);
          continue;
        }
        started = true;
        accepted.push(event);
        continue;
      }
      if (!started) {
        invalidEvents.push(`line_${index + 1}:terminal_before_start`);
        continue;
      }
      accepted.push(event);
      started = false;
      nextScenarioOrdinal += 1;
    }
  }
  const acceptedDigest = createHash('sha256')
    .update(JSON.stringify(accepted), 'utf8')
    .digest('hex');
  return {
    acceptedCount: accepted.length,
    completedScenarios: nextScenarioOrdinal - 1,
    nextScenarioOrdinal,
    planComplete: input.scenarioCount > 0 && nextScenarioOrdinal > input.scenarioCount,
    invalidEvents,
    acceptedDigest,
  };
}

export function writeSmokeCancelRequest(input: {
  artifactDir: string;
  runId: string;
  reason: string;
  nowMs?: number;
}): boolean {
  const path = smokeCancelRequestPath(input.artifactDir);
  const existing = readJson(path);
  if (isRecord(existing) && String(existing.runId ?? '') === input.runId) {
    return true;
  }
  try {
    writeJsonAtomic(path, {
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

export function observeSmokeCancellationAcknowledgement(
  artifactDir: string,
  runId: string,
): boolean {
  return cancellationAcknowledgementExists(artifactDir, runId);
}

export function tombstoneSmokeOperatorFiles(
  artifactDir: string,
  nowMs = Date.now(),
): { cleared: boolean; tombstoned: string[]; failures: string[] } {
  const liveDir = join(artifactDir, 'live');
  if (!existsSync(liveDir)) {
    return { cleared: true, tombstoned: [], failures: [] };
  }
  const tombstoned: string[] = [];
  const failures: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(liveDir);
  } catch {
    return { cleared: false, tombstoned, failures: ['operator_live_dir_unreadable'] };
  }
  for (const entry of entries) {
    if (!/^OPERATOR-ACTION-.*\.txt$/u.test(entry)) {
      continue;
    }
    const source = join(liveDir, entry);
    const target = join(
      liveDir,
      `${entry}.tombstoned-${nowMs}-${process.pid}`,
    );
    try {
      renameSync(source, target);
      tombstoned.push(basename(target));
    } catch {
      failures.push(entry);
    }
  }
  return { cleared: failures.length === 0, tombstoned, failures };
}

export function finalizeSmokeLifecycle(input: {
  artifactDir: string;
  runId: string;
  reason: string;
  cooperativeAcknowledgementObserved: boolean;
  closeOutcome: string;
  operatorFilesCleared: boolean;
  nowMs?: number;
}): SmokeLifecycleRegistry {
  const nowMs = input.nowMs ?? Date.now();
  const clean = input.operatorFilesCleared
    && (input.closeOutcome === 'closed_owned_handle' || input.closeOutcome === 'no_bound_handle');
  writeJsonAtomic(smokeTerminalRecordPath(input.artifactDir), {
    version: 1,
    runId: input.runId,
    reason: input.reason,
    cooperativeAcknowledgementObserved: input.cooperativeAcknowledgementObserved,
    closeOutcome: input.closeOutcome,
    operatorFilesCleared: input.operatorFilesCleared,
    cleanupClean: clean,
    completedAtMs: nowMs,
  });
  return updateRegistry(input.artifactDir, (registry) => ({
    ...registry,
    spawnState: clean ? 'clean' : 'cleanup_failed',
    updatedAtMs: nowMs,
    cleanup: {
      reason: input.reason,
      cooperativeAcknowledgementObserved: input.cooperativeAcknowledgementObserved,
      closeOutcome: input.closeOutcome,
      operatorFilesCleared: input.operatorFilesCleared,
      completedAtMs: nowMs,
    },
  }));
}

export function beginSmokeCleanup(
  artifactDir: string,
  nowMs = Date.now(),
): SmokeLifecycleRegistry {
  return updateRegistry(artifactDir, (registry) => ({
    ...registry,
    spawnState: 'cleanup_pending',
    updatedAtMs: nowMs,
  }));
}

function listRunArtifactDirs(repoRoot: string): string[] {
  const root = join(repoRoot, SMOKE_LIFECYCLE_ROOT);
  if (!existsSync(root)) {
    return [];
  }
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name));
  } catch {
    return [];
  }
}

function lifecycleStateBlocks(registry: SmokeLifecycleRegistry): boolean {
  return registry.spawnState !== 'clean' && registry.spawnState !== 'abandoned_unbound';
}

function operatorFilesRemain(artifactDir: string): boolean {
  const liveDir = join(artifactDir, 'live');
  if (!existsSync(liveDir)) {
    return false;
  }
  try {
    return readdirSync(liveDir).some((entry) => /^OPERATOR-ACTION-.*\.txt$/u.test(entry));
  } catch {
    return true;
  }
}

function parseAdmissionLock(value: unknown): SmokeAdmissionLockRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const runId = String(value.runId ?? '').trim();
  const supervisorPid = Number(value.supervisorPid);
  const startedAtMs = Number(value.startedAtMs);
  if (
    Number(value.version) !== 1
    || !runId
    || !Number.isInteger(supervisorPid)
    || supervisorPid <= 0
    || !Number.isFinite(startedAtMs)
  ) {
    return undefined;
  }
  return { version: 1, runId, supervisorPid, startedAtMs };
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function createAdmissionLock(
  repoRoot: string,
  record: SmokeAdmissionLockRecord,
): boolean {
  const path = smokeAdmissionLockPath(repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  try {
    const descriptor = openSync(path, 'wx');
    try {
      writeFileSync(descriptor, jsonStringify(record), 'utf8');
    } finally {
      closeSync(descriptor);
    }
    return true;
  } catch {
    return false;
  }
}

export function releaseSmokeAdmission(repoRoot: string, runId: string): boolean {
  const path = smokeAdmissionLockPath(repoRoot);
  const lock = parseAdmissionLock(readJson(path));
  if (!lock || lock.runId !== runId) {
    return false;
  }
  try {
    rmSync(path, { force: true });
    return true;
  } catch {
    return false;
  }
}

export function evaluateSmokeLifecycleCleanliness(repoRoot: string): SmokeLifecycleCleanliness {
  const reasons: string[] = [];
  const blockingRunIds: string[] = [];
  const lockPath = smokeAdmissionLockPath(repoRoot);
  if (existsSync(lockPath)) {
    const lock = parseAdmissionLock(readJson(lockPath));
    reasons.push(lock ? `active_smoke_admission:${lock.runId}` : 'corrupt_smoke_admission_lock');
  }
  for (const artifactDir of listRunArtifactDirs(repoRoot)) {
    const registryPath = smokeLifecycleRegistryPath(artifactDir);
    if (!existsSync(registryPath)) {
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
    if (lifecycleStateBlocks(registry)) {
      reasons.push(`blocking_lifecycle:${registry.runId}:${registry.spawnState}`);
      blockingRunIds.push(registry.runId);
    }
    if (operatorFilesRemain(artifactDir)) {
      reasons.push(`unsafe_operator_state:${registry.runId}`);
      if (!blockingRunIds.includes(registry.runId)) {
        blockingRunIds.push(registry.runId);
      }
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
  const supervisorPid = input.supervisorPid ?? process.pid;
  const isProcessAlive = input.isProcessAlive ?? defaultIsProcessAlive;
  const diagnostics: string[] = [];
  const lockPath = smokeAdmissionLockPath(input.repoRoot);
  if (existsSync(lockPath)) {
    const existing = parseAdmissionLock(readJson(lockPath));
    if (!existing) {
      return { admitted: false, reason: 'corrupt_smoke_admission_lock', diagnostics };
    }
    if (isProcessAlive(existing.supervisorPid)) {
      return {
        admitted: false,
        reason: `active_smoke_admission:${existing.runId}`,
        diagnostics,
      };
    }
    rmSync(lockPath, { force: true });
    diagnostics.push(`removed_stale_admission:${existing.runId}`);
  }
  if (!createAdmissionLock(input.repoRoot, {
    version: 1,
    runId: input.runId,
    supervisorPid,
    startedAtMs: nowMs,
  })) {
    return { admitted: false, reason: 'smoke_admission_race_lost', diagnostics };
  }

  let refusal: string | undefined;
  for (const artifactDir of listRunArtifactDirs(input.repoRoot)) {
    if (basename(artifactDir) === input.runId) {
      continue;
    }
    const registryPath = smokeLifecycleRegistryPath(artifactDir);
    if (!existsSync(registryPath)) {
      const tombstone = tombstoneSmokeOperatorFiles(artifactDir, nowMs);
      if (tombstone.cleared) {
        if (tombstone.tombstoned.length > 0) {
          diagnostics.push(`tombstoned_legacy_operator_state:${basename(artifactDir)}`);
        }
      } else {
        refusal ??= `unsafe_legacy_operator_state:${basename(artifactDir)}`;
      }
      continue;
    }
    let registry = readSmokeLifecycleRegistry(artifactDir);
    if (!registry) {
      refusal ??= `corrupt_lifecycle_state:${basename(artifactDir)}`;
      continue;
    }
    const tombstone = tombstoneSmokeOperatorFiles(artifactDir, nowMs);
    if (!tombstone.cleared) {
      refusal ??= `unsafe_operator_state:${registry.runId}`;
      continue;
    }
    if (
      (registry.spawnState === 'reserved' || registry.spawnState === 'create_in_progress')
      && !registry.terminalHandle
      && nowMs > registry.createDeadlineMs
    ) {
      registry = markSmokeCreateAmbiguous(
        artifactDir,
        'interrupted_create_without_bound_handle',
        nowMs,
      );
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
      beginSmokeCleanup(artifactDir, nowMs);
      const closeOutcome = input.closeBoundHandle(registry.terminalHandle, artifactDir);
      const finalized = finalizeSmokeLifecycle({
        artifactDir,
        runId: registry.runId,
        reason: 'restart_recovery',
        cooperativeAcknowledgementObserved: observeSmokeCancellationAcknowledgement(
          artifactDir,
          registry.runId,
        ),
        closeOutcome,
        operatorFilesCleared: tombstone.cleared,
        nowMs,
      });
      diagnostics.push(`recovered_bound_run:${registry.runId}:${closeOutcome}`);
      registry = finalized;
    }
    if (lifecycleStateBlocks(registry)) {
      refusal ??= `blocking_lifecycle:${registry.runId}:${registry.spawnState}`;
    }
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
  beginSmokeCleanup(input.artifactDir, nowMs);
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
  const operatorFilesCleared = operator.cleared && cancellationRecorded;
  const finalized = finalizeSmokeLifecycle({
    artifactDir: input.artifactDir,
    runId: input.runId,
    reason: input.reason,
    cooperativeAcknowledgementObserved: input.cooperativeAcknowledgementObserved,
    closeOutcome,
    operatorFilesCleared,
    nowMs,
  });
  return {
    clean: finalized.spawnState === 'clean',
    cooperativeAcknowledgementObserved: input.cooperativeAcknowledgementObserved,
    closeOutcome,
    operatorFilesCleared,
    reason: input.reason,
  };
}
