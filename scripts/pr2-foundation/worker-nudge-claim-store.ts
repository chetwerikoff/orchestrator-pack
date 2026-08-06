import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  opendirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, hostname, tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildS2EpisodeKey,
  buildS2EpisodeTupleKey,
  buildS2SafeWorkerReference,
  canonicalStoreId,
  hashNudgeMessageContent,
} from './worker-nudge-gate.ts';

export type WorkerNudgeClaimPhase =
  | 'CLAIMED'
  | 'SEND_ATTEMPTED'
  | 'SENT'
  | 'FAILED_DEFINITIVE'
  | 'UNCERTAIN';

export interface WorkerNudgeClaimRecord extends Record<string, unknown> {
  schemaVersion: 1;
  key: string;
  tupleKey: string;
  prNumber: number;
  issueNumber: number;
  projectId: string;
  cycleKey: string;
  intentClass: string;
  workerTarget: string;
  sessionId: string;
  targetId: string;
  targetGeneration: string;
  phase: WorkerNudgeClaimPhase;
  state: WorkerNudgeClaimPhase;
  holder: {
    processGuid: string;
    pid: number;
    surface: string;
    host: string;
  };
  acquiredAtUtc: string;
  claimLeaseExpiresAtMs: number;
  tokenNonce: string;
  messageContentHash?: string;
}

export interface WorkerNudgeClaimHandle {
  acquired: true;
  claim: WorkerNudgeClaimRecord;
  path: string;
  namespace: string;
  key: string;
  projectId: string;
}

export type WorkerNudgeClaimAcquireResult =
  | WorkerNudgeClaimHandle
  | {
    acquired: false;
    reason: string;
    path?: string;
    namespace?: string;
    key?: string;
    terminal?: boolean;
    phase?: string;
    escalate?: boolean;
  };

export interface WorkerNudgeDeadlineOptions {
  readonly deadlineMs: number;
  readonly settlementDeadlineMs?: number;
}

const CLAIM_LEASE_DEFAULT_MS = 120_000;
const CLAIM_LEASE_MAX_MS = 30 * 60 * 1_000;
const CLAIM_STALE_DEFAULT_MINUTES = 2;
const CLAIM_STALE_FLOOR_MINUTES = 1;
const MUTEX_STALE_MS = 5_000;
const TERMINAL_RETAIN = 64;

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function claimLeaseMs(): number {
  return Math.min(
    parsePositiveInteger(process.env.OPK_WORKER_NUDGE_CLAIM_LEASE_MS, CLAIM_LEASE_DEFAULT_MS),
    CLAIM_LEASE_MAX_MS,
  );
}

function claimStaleMs(): number {
  const minutes = Math.max(
    parsePositiveInteger(process.env.OPK_WORKER_NUDGE_CLAIM_STALE_MINUTES, CLAIM_STALE_DEFAULT_MINUTES),
    CLAIM_STALE_FLOOR_MINUTES,
  );
  return minutes * 60_000;
}

function safeSegment(value: string): string {
  const trimmed = String(value ?? '').trim();
  return (trimmed || 'empty').replace(/[^\w\-.:]/g, '_');
}

function claimKey(input: {
  prNumber: number;
  issueNumber?: number;
  cycleKey: string;
  intentClass: string;
  workerTarget: string;
}): string {
  const prefix = input.issueNumber && input.intentClass === 'task-continuation'
    ? `issue-${input.issueNumber}`
    : `pr-${input.prNumber}`;
  return [
    prefix,
    safeSegment(input.intentClass),
    safeSegment(input.cycleKey),
    safeSegment(input.workerTarget),
  ].join('-');
}

export function workerNudgeClaimProjectNamespace(projectId = 'orchestrator-pack'): string {
  const base = process.env.OPK_BASE_DIR?.trim() || path.join(homedir(), '.agent-orchestrator');
  return path.join(base, 'projects', projectId.trim() || 'orchestrator-pack', 'worker-nudge-claims');
}

export function workerNudgeClaimNamespace(projectId = 'orchestrator-pack'): string {
  const root = workerNudgeClaimProjectNamespace(projectId);
  const override = process.env.OPK_WORKER_NUDGE_CLAIM_DIR?.trim();
  if (!override) return root;
  const candidate = existsSync(override) ? realpathSync(override) : override;
  const storeId = canonicalStoreId(candidate);
  return storeId ? path.join(root, 'by-store-id', storeId) : root;
}

function claimPath(namespace: string, key: string): string {
  return path.join(namespace, `${key}.json`);
}

function lockDir(namespace: string, key: string): string {
  return path.join(namespace, `.lock-${key}`);
}

function terminalDir(namespace: string): string {
  return path.join(namespace, 'terminal');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJsonRecord(file: string): Record<string, unknown> | null {
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function asClaimRecord(value: Record<string, unknown> | null): WorkerNudgeClaimRecord | null {
  if (!value) return null;
  const phase = String(value.phase ?? value.state ?? '');
  if (!['CLAIMED', 'SEND_ATTEMPTED', 'SENT', 'FAILED_DEFINITIVE', 'UNCERTAIN'].includes(phase)) {
    return null;
  }
  if (!isRecord(value.holder)) return null;
  return value as WorkerNudgeClaimRecord;
}

function writeJsonAtomic(file: string, value: unknown, overwrite = true): void {
  mkdirSync(path.dirname(file), { recursive: true });
  if (!overwrite) {
    const descriptor = openSync(file, 'wx', 0o600);
    try {
      writeFileSync(descriptor, `${JSON.stringify(value)}\n`, 'utf8');
    } finally {
      closeSync(descriptor);
    }
    return;
  }
  const temporary = path.join(path.dirname(file), `.${randomUUID().replace(/-/g, '')}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, file);
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function mutexAbandoned(directory: string): boolean {
  if (!existsSync(directory)) return false;
  const owner = readJsonRecord(path.join(directory, 'owner.json'));
  const pid = Number(owner?.pid ?? 0);
  if (pid > 0) return !processAlive(pid);
  try {
    return Date.now() - statSync(directory).mtimeMs >= MUTEX_STALE_MS;
  } catch {
    return true;
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function withClaimMutex<T>(directory: string, action: () => T | Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    try {
      mkdirSync(directory);
      writeJsonAtomic(path.join(directory, 'owner.json'), {
        pid: process.pid,
        acquiredAtUtc: new Date().toISOString(),
      }, false);
      try {
        return await action();
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code ?? '')
        : '';
      if (code !== 'EEXIST') throw error;
      if (mutexAbandoned(directory)) {
        rmSync(directory, { recursive: true, force: true });
        continue;
      }
      await delay(50 * (attempt + 1));
    }
  }
  throw new Error('mutex_contended');
}

function pruneTerminal(namespace: string): void {
  const directory = terminalDir(namespace);
  if (!existsSync(directory)) return;
  const files = readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .map((name) => ({ name, mtimeMs: statSync(path.join(directory, name)).mtimeMs }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  for (const stale of files.slice(TERMINAL_RETAIN)) {
    rmSync(path.join(directory, stale.name), { force: true });
  }
}

function moveToTerminal(
  namespace: string,
  activePath: string,
  record: WorkerNudgeClaimRecord,
  outcome: WorkerNudgeClaimPhase | 'released_stale' | 'recovered_stale',
  extra: Record<string, unknown> = {},
): string {
  const directory = terminalDir(namespace);
  mkdirSync(directory, { recursive: true });
  const terminalPath = path.join(
    directory,
    `${record.key}-${outcome}-${randomUUID().replace(/-/g, '')}.json`,
  );
  writeJsonAtomic(terminalPath, {
    ...record,
    ...extra,
    phase: outcome,
    state: outcome,
    finalizedAtUtc: new Date().toISOString(),
  }, false);
  rmSync(activePath, { force: true });
  pruneTerminal(namespace);
  return terminalPath;
}

function terminalHit(
  namespace: string,
  key: string,
  tupleKey: string,
): { record: WorkerNudgeClaimRecord; phase: string } | null {
  const directory = terminalDir(namespace);
  if (!existsSync(directory)) return null;
  const files = readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .map((name) => ({ name, mtimeMs: statSync(path.join(directory, name)).mtimeMs }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  for (const file of files) {
    const record = asClaimRecord(readJsonRecord(path.join(directory, file.name)));
    // Legacy D4 behavior: uncertain attempts remain history, but only SENT deduplicates.
    if (!record || record.phase !== 'SENT') continue;
    if (record.key === key || record.tupleKey === tupleKey) {
      return { record, phase: String(record.phase) };
    }
  }
  return null;
}

function newClaimRecord(input: {
  prNumber: number;
  issueNumber?: number;
  cycleKey: string;
  intentClass: string;
  workerTarget: string;
  sessionId: string;
  targetId: string;
  targetGeneration: string;
  surface: string;
  tupleKey: string;
  projectId: string;
  key: string;
}): WorkerNudgeClaimRecord {
  const nowMs = Date.now();
  return {
    schemaVersion: 1,
    key: input.key,
    tupleKey: input.tupleKey,
    prNumber: input.prNumber,
    issueNumber: input.issueNumber ?? 0,
    projectId: input.projectId,
    cycleKey: input.cycleKey,
    intentClass: input.intentClass,
    workerTarget: input.workerTarget,
    sessionId: input.sessionId,
    targetId: input.targetId || input.sessionId,
    targetGeneration: input.targetGeneration || input.targetId || input.sessionId,
    phase: 'CLAIMED',
    state: 'CLAIMED',
    holder: {
      processGuid: randomUUID().replace(/-/g, ''),
      pid: process.pid,
      surface: input.surface,
      host: hostname(),
    },
    acquiredAtUtc: new Date(nowMs).toISOString(),
    claimLeaseExpiresAtMs: nowMs + claimLeaseMs(),
    tokenNonce: randomUUID().replace(/-/g, ''),
  };
}

export async function acquireWorkerNudgeClaim(input: {
  prNumber: number;
  issueNumber?: number;
  cycleKey: string;
  intentClass: string;
  workerTarget: string;
  sessionId: string;
  targetId?: string;
  targetGeneration?: string;
  tupleKey?: string;
  surface?: string;
  projectId?: string;
  message?: string;
  namespace?: string;
}): Promise<WorkerNudgeClaimAcquireResult> {
  const projectId = input.projectId?.trim() || 'orchestrator-pack';
  const namespace = input.namespace || workerNudgeClaimNamespace(projectId);
  mkdirSync(namespace, { recursive: true });
  mkdirSync(terminalDir(namespace), { recursive: true });
  const key = claimKey(input);
  const tupleKey = input.tupleKey || `${input.prNumber}|${input.cycleKey}|${input.intentClass}|${input.workerTarget}`;
  const activePath = claimPath(namespace, key);
  const mutex = lockDir(namespace, key);

  try {
    return await withClaimMutex(mutex, () => {
      const incomingHash = input.message ? hashNudgeMessageContent(input.message) : '';
      const served = terminalHit(namespace, key, tupleKey);
      if (served) {
        const servedHash = String(served.record.messageContentHash ?? '');
        if (incomingHash && servedHash && incomingHash !== servedHash) {
          return {
            acquired: false,
            reason: 'materially_new_content',
            path: activePath,
            namespace,
            key,
            terminal: true,
            phase: served.phase,
            escalate: true,
          };
        }
        return {
          acquired: false,
          reason: 'already_served',
          path: activePath,
          namespace,
          key,
          terminal: true,
          phase: served.phase,
        };
      }

      const replacement = newClaimRecord({
        prNumber: input.prNumber,
        issueNumber: input.issueNumber,
        cycleKey: input.cycleKey,
        intentClass: input.intentClass,
        workerTarget: input.workerTarget,
        sessionId: input.sessionId,
        targetId: input.targetId || input.sessionId,
        targetGeneration: input.targetGeneration || input.targetId || input.sessionId,
        surface: input.surface || 'unknown',
        tupleKey,
        projectId,
        key,
      });
      const existingRaw = readJsonRecord(activePath);
      if (existsSync(activePath) && !existingRaw) {
        return { acquired: false, reason: 'ambiguous_claim', path: activePath, namespace, key };
      }
      const existing = asClaimRecord(existingRaw);
      if (existing) {
        if (existing.phase === 'SENT') {
          return { acquired: false, reason: 'already_served', path: activePath, namespace, key };
        }
        const nowMs = Date.now();
        const leaseExpiresAtMs = Number(existing.claimLeaseExpiresAtMs);
        const leaseExpired = !Number.isFinite(leaseExpiresAtMs) || leaseExpiresAtMs <= nowMs;
        const acquiredAtMs = Date.parse(existing.acquiredAtUtc);
        const staleByAge = !Number.isFinite(acquiredAtMs)
          || nowMs - acquiredAtMs >= claimStaleMs();

        if (existing.phase === 'SEND_ATTEMPTED') {
          const holderAlive = processAlive(Number(existing.holder.pid));
          if (holderAlive && !leaseExpired && !staleByAge) {
            return {
              acquired: false,
              reason: 'claimed',
              path: activePath,
              namespace,
              key,
              phase: existing.phase,
            };
          }
          moveToTerminal(namespace, activePath, existing, 'UNCERTAIN', {
            recoveredBy: replacement.holder,
            recoveredFromPhase: existing.phase,
            recoveryFence: !holderAlive
              ? 'owner_dead'
              : leaseExpired
                ? 'lease_expired'
                : 'stale',
            retryAllowed: true,
          });
        } else if (existing.phase === 'UNCERTAIN') {
          moveToTerminal(namespace, activePath, existing, 'UNCERTAIN', {
            recoveredBy: replacement.holder,
            recoveredFromPhase: existing.phase,
            recoveryFence: 'uncertain_terminalization_replay',
            retryAllowed: true,
          });
        } else {
          if (existing.phase === 'CLAIMED' && !leaseExpired && !staleByAge) {
            return { acquired: false, reason: 'claimed', path: activePath, namespace, key };
          }
          moveToTerminal(
            namespace,
            activePath,
            existing,
            existing.phase === 'FAILED_DEFINITIVE' ? 'released_stale' : 'recovered_stale',
            { recoveredBy: replacement.holder },
          );
        }
      }

      writeJsonAtomic(activePath, replacement, false);
      const reread = asClaimRecord(readJsonRecord(activePath));
      if (reread?.holder.processGuid !== replacement.holder.processGuid) {
        return { acquired: false, reason: 'lost_race', path: activePath, namespace, key };
      }
      return {
        acquired: true,
        claim: replacement,
        path: activePath,
        namespace,
        key,
        projectId,
      };
    });
  } catch (error) {
    return {
      acquired: false,
      reason: error instanceof Error ? error.message : 'storage_failure',
      path: activePath,
      namespace,
      key,
    };
  }
}

export const S2_ONE_SHOT_CLAIM_POLICY = 's2-one-shot-v1' as const;
const S2_RETENTION_TICKS = 128;
const S2_MAX_TERMINALS_PER_GENERATION = 1_024;
const S2_TERMINAL_SCAN_LIMIT = S2_MAX_TERMINALS_PER_GENERATION + 1;

export interface S2OneShotWorkerNudgeClaimRecord extends WorkerNudgeClaimRecord {
  policyTag: typeof S2_ONE_SHOT_CLAIM_POLICY;
  schedulerGeneration: string;
  tickSequence: number;
  transitionIdentity: string;
  unitRef: string;
  eligibleClass: 'idle' | 'livelock';
}

export interface S2OneShotWorkerNudgeClaimHandle extends WorkerNudgeClaimHandle {
  claim: S2OneShotWorkerNudgeClaimRecord;
  deadlineMs: number;
}

export type S2OneShotWorkerNudgeClaimAcquireResult =
  | S2OneShotWorkerNudgeClaimHandle
  | {
    acquired: false;
    reason: string;
    path?: string;
    namespace?: string;
    key?: string;
    terminal?: boolean;
    phase?: string;
  };

export type S2SendAttemptAdmissionResult =
  | { readonly status: 'recorded' }
  | { readonly status: 'definitely_not_recorded' }
  | { readonly status: 'state_untrusted' };

function assertBeforeDeadline(deadlineMs: number): void {
  if (!Number.isFinite(deadlineMs) || Date.now() >= deadlineMs) {
    throw new Error('claim_deadline_expired');
  }
}

function mkdirUntil(directory: string, deadlineMs: number): void {
  assertBeforeDeadline(deadlineMs);
  mkdirSync(directory, { recursive: true });
}

function unlinkUntil(file: string, deadlineMs: number): void {
  assertBeforeDeadline(deadlineMs);
  unlinkSync(file);
}

function removeUntil(file: string, deadlineMs: number): void {
  assertBeforeDeadline(deadlineMs);
  rmSync(file, { force: true });
}

function readJsonRecordUntil(file: string, deadlineMs: number): Record<string, unknown> | null {
  assertBeforeDeadline(deadlineMs);
  if (!existsSync(file)) return null;
  assertBeforeDeadline(deadlineMs);
  const bytes = readFileSync(file, 'utf8');
  assertBeforeDeadline(deadlineMs);
  try {
    const parsed = JSON.parse(bytes) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeJsonAtomicUntil(
  file: string,
  value: unknown,
  deadlineMs: number,
  overwrite = true,
): void {
  mkdirUntil(path.dirname(file), deadlineMs);
  if (!overwrite) {
    assertBeforeDeadline(deadlineMs);
    const descriptor = openSync(file, 'wx', 0o600);
    try {
      assertBeforeDeadline(deadlineMs);
      writeFileSync(descriptor, `${JSON.stringify(value)}\n`, 'utf8');
    } finally {
      closeSync(descriptor);
    }
    return;
  }
  const temporary = path.join(path.dirname(file), `.${randomUUID().replace(/-/g, '')}.tmp`);
  try {
    assertBeforeDeadline(deadlineMs);
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
    assertBeforeDeadline(deadlineMs);
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

async function withClaimMutexUntil<T>(
  directory: string,
  deadlineMs: number,
  action: () => T | Promise<T>,
): Promise<T> {
  assertBeforeDeadline(deadlineMs);
  for (let attempt = 0; Date.now() < deadlineMs; attempt += 1) {
    try {
      mkdirSync(directory);
      writeJsonAtomicUntil(path.join(directory, 'owner.json'), {
        pid: process.pid,
        acquiredAtUtc: new Date().toISOString(),
      }, deadlineMs, false);
      try {
        assertBeforeDeadline(deadlineMs);
        const result = await action();
        assertBeforeDeadline(deadlineMs);
        return result;
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code ?? '')
        : '';
      if (code !== 'EEXIST') throw error;
      if (mutexAbandoned(directory)) {
        assertBeforeDeadline(deadlineMs);
        rmSync(directory, { recursive: true, force: true });
        continue;
      }
      const remaining = deadlineMs - Date.now();
      if (remaining <= 0) break;
      await delay(Math.min(10 * (attempt + 1), remaining));
    }
  }
  throw new Error('claim_deadline_expired');
}

function s2TerminalDir(namespace: string): string {
  return path.join(terminalDir(namespace), S2_ONE_SHOT_CLAIM_POLICY);
}

function s2TerminalPath(namespace: string, key: string): string {
  return path.join(s2TerminalDir(namespace), `${key}.json`);
}

function s2ClaimKey(input: {
  projectId: string;
  issueNumber: number;
  schedulerGeneration: string;
  transitionIdentity: string;
  unitRef: string;
  eligibleClass: 'idle' | 'livelock';
}): string {
  return buildS2EpisodeKey(input);
}

function asS2ClaimRecord(value: Record<string, unknown> | null): S2OneShotWorkerNudgeClaimRecord | null {
  const record = asClaimRecord(value);
  if (!record
    || record.policyTag !== S2_ONE_SHOT_CLAIM_POLICY
    || typeof record.schedulerGeneration !== 'string'
    || !Number.isInteger(record.tickSequence)
    || typeof record.transitionIdentity !== 'string'
    || typeof record.unitRef !== 'string'
    || !['idle', 'livelock'].includes(String(record.eligibleClass))) return null;
  return record as S2OneShotWorkerNudgeClaimRecord;
}

function listS2TerminalEntriesBounded(directory: string, deadlineMs: number): string[] {
  assertBeforeDeadline(deadlineMs);
  if (!existsSync(directory)) return [];
  const opened = opendirSync(directory);
  const names: string[] = [];
  try {
    for (;;) {
      assertBeforeDeadline(deadlineMs);
      const entry = opened.readSync();
      if (!entry) break;
      names.push(entry.name);
      if (names.length > S2_TERMINAL_SCAN_LIMIT) throw new Error('claim_untrusted');
    }
  } finally {
    opened.closeSync();
  }
  return names;
}

export function pruneS2OneShotWorkerNudgeClaims(input: {
  namespace: string;
  schedulerGeneration: string;
  tickSequence: number;
  deadlineMs: number;
}): { removed: number; retained: number; untrusted: number } {
  assertBeforeDeadline(input.deadlineMs);
  const directory = s2TerminalDir(input.namespace);
  if (!existsSync(directory)) return { removed: 0, retained: 0, untrusted: 0 };
  const names = listS2TerminalEntriesBounded(directory, input.deadlineMs);
  let removed = 0;
  let retained = 0;
  let untrusted = 0;
  for (const name of names) {
    assertBeforeDeadline(input.deadlineMs);
    if (!name.endsWith('.json')) {
      untrusted += 1;
      retained += 1;
      continue;
    }
    const file = path.join(directory, name);
    const record = asS2ClaimRecord(readJsonRecordUntil(file, input.deadlineMs));
    if (!record) {
      untrusted += 1;
      retained += 1;
      continue;
    }
    const expired = record.schedulerGeneration !== input.schedulerGeneration
      || input.tickSequence - record.tickSequence >= S2_RETENTION_TICKS;
    if (expired) {
      removeUntil(file, input.deadlineMs);
      removed += 1;
    } else {
      retained += 1;
    }
  }
  if (untrusted > 0 || retained > S2_MAX_TERMINALS_PER_GENERATION) {
    throw new Error('claim_untrusted');
  }
  return { removed, retained, untrusted };
}

type S2TerminalHit =
  | { status: 'none' }
  | { status: 'terminal'; record: S2OneShotWorkerNudgeClaimRecord }
  | { status: 'untrusted' };

function s2TerminalHit(
  namespace: string,
  key: string,
  tupleKey: string,
  deadlineMs: number,
): S2TerminalHit {
  const directory = s2TerminalDir(namespace);
  if (!existsSync(directory)) return { status: 'none' };
  const expectedPath = s2TerminalPath(namespace, key);
  let expected: S2OneShotWorkerNudgeClaimRecord | null = null;
  if (existsSync(expectedPath)) {
    expected = asS2ClaimRecord(readJsonRecordUntil(expectedPath, deadlineMs));
    if (!expected
      || expected.key !== key
      || expected.tupleKey !== tupleKey
      || !['SENT', 'FAILED_DEFINITIVE', 'UNCERTAIN'].includes(expected.phase)) {
      return { status: 'untrusted' };
    }
  }

  let duplicate = false;
  for (const name of listS2TerminalEntriesBounded(directory, deadlineMs)) {
    assertBeforeDeadline(deadlineMs);
    if (name === `${key}.json`) continue;
    if (name.startsWith(`${key}-`) || name.startsWith(`${key}.`)) duplicate = true;
  }
  if (duplicate) return { status: 'untrusted' };
  return expected ? { status: 'terminal', record: expected } : { status: 'none' };
}

function moveS2ToTerminal(
  namespace: string,
  activePath: string,
  record: S2OneShotWorkerNudgeClaimRecord,
  outcome: Extract<WorkerNudgeClaimPhase, 'SENT' | 'FAILED_DEFINITIVE' | 'UNCERTAIN'>,
  deadlineMs: number,
  extra: Record<string, unknown> = {},
): string {
  pruneS2OneShotWorkerNudgeClaims({
    namespace,
    schedulerGeneration: record.schedulerGeneration,
    tickSequence: record.tickSequence,
    deadlineMs,
  });
  const directory = s2TerminalDir(namespace);
  const existingCount = listS2TerminalEntriesBounded(directory, deadlineMs).length;
  if (existingCount >= S2_MAX_TERMINALS_PER_GENERATION) throw new Error('claim_untrusted');
  const terminalPath = s2TerminalPath(namespace, record.key);
  if (existsSync(terminalPath)) throw new Error('claim_untrusted');
  writeJsonAtomicUntil(terminalPath, {
    ...record,
    ...extra,
    phase: outcome,
    state: outcome,
    finalizedAtUtc: new Date().toISOString(),
  }, deadlineMs, false);
  if (existsSync(activePath)) unlinkUntil(activePath, deadlineMs);
  return terminalPath;
}

export async function acquireS2OneShotWorkerNudgeClaim(input: {
  projectId?: string;
  issueNumber: number;
  schedulerGeneration: string;
  tickSequence: number;
  transitionIdentity: string;
  unitRef: string;
  eligibleClass: 'idle' | 'livelock';
  surface?: string;
  namespace?: string;
  deadlineMs: number;
}): Promise<S2OneShotWorkerNudgeClaimAcquireResult> {
  const projectId = input.projectId?.trim() || 'orchestrator-pack';
  const namespace = input.namespace || workerNudgeClaimNamespace(projectId);
  let tupleKey: string;
  let workerTarget: string;
  let key: string;
  try {
    tupleKey = buildS2EpisodeTupleKey({ ...input, projectId });
    workerTarget = buildS2SafeWorkerReference(input);
    key = s2ClaimKey({ ...input, projectId });
    mkdirUntil(namespace, input.deadlineMs);
    mkdirUntil(s2TerminalDir(namespace), input.deadlineMs);
    pruneS2OneShotWorkerNudgeClaims({
      namespace,
      schedulerGeneration: input.schedulerGeneration,
      tickSequence: input.tickSequence,
      deadlineMs: input.deadlineMs,
    });
  } catch {
    return { acquired: false, reason: 'claim_untrusted' };
  }
  const activePath = claimPath(namespace, key);
  const mutex = lockDir(namespace, key);

  try {
    return await withClaimMutexUntil(mutex, input.deadlineMs, () => {
      const served = s2TerminalHit(namespace, key, tupleKey, input.deadlineMs);
      if (served.status === 'untrusted') {
        return { acquired: false, reason: 'claim_untrusted', path: activePath, namespace, key };
      }
      if (served.status === 'terminal') {
        return {
          acquired: false,
          reason: 'claim_terminal',
          path: activePath,
          namespace,
          key,
          terminal: true,
          phase: served.record.phase,
        };
      }

      const existingRaw = readJsonRecordUntil(activePath, input.deadlineMs);
      if (existsSync(activePath) && !existingRaw) {
        return { acquired: false, reason: 'claim_untrusted', path: activePath, namespace, key };
      }
      const existing = asS2ClaimRecord(existingRaw);
      if (existingRaw && !existing) {
        return { acquired: false, reason: 'claim_untrusted', path: activePath, namespace, key };
      }
      if (existing && (existing.key !== key || existing.tupleKey !== tupleKey)) {
        return { acquired: false, reason: 'claim_untrusted', path: activePath, namespace, key };
      }
      if (existing) {
        const leaseExpired = !Number.isFinite(Number(existing.claimLeaseExpiresAtMs))
          || Number(existing.claimLeaseExpiresAtMs) <= Date.now();
        const holderAlive = processAlive(Number(existing.holder.pid));
        if (existing.phase === 'CLAIMED') {
          if (!leaseExpired && holderAlive) {
            return {
              acquired: false,
              reason: 'claim_terminal',
              path: activePath,
              namespace,
              key,
              terminal: true,
              phase: existing.phase,
            };
          }
          unlinkUntil(activePath, input.deadlineMs);
        } else if (existing.phase === 'SEND_ATTEMPTED') {
          if (leaseExpired || !holderAlive) {
            moveS2ToTerminal(namespace, activePath, existing, 'UNCERTAIN', input.deadlineMs, {
              recoveryFence: !holderAlive ? 'owner_dead' : 'lease_expired',
              retryAllowed: false,
            });
          }
          return {
            acquired: false,
            reason: 'claim_terminal',
            path: activePath,
            namespace,
            key,
            terminal: true,
            phase: leaseExpired || !holderAlive ? 'UNCERTAIN' : 'SEND_ATTEMPTED',
          };
        } else {
          moveS2ToTerminal(namespace, activePath, existing, existing.phase, input.deadlineMs);
          return {
            acquired: false,
            reason: 'claim_terminal',
            path: activePath,
            namespace,
            key,
            terminal: true,
            phase: existing.phase,
          };
        }
      }

      const base = newClaimRecord({
        prNumber: 0,
        issueNumber: input.issueNumber,
        cycleKey: input.transitionIdentity,
        intentClass: 'task-continuation',
        workerTarget,
        sessionId: workerTarget,
        targetId: input.unitRef,
        targetGeneration: input.schedulerGeneration,
        surface: input.surface || 's2-fleet-nudge',
        tupleKey,
        projectId,
        key,
      });
      const replacement: S2OneShotWorkerNudgeClaimRecord = {
        ...base,
        policyTag: S2_ONE_SHOT_CLAIM_POLICY,
        schedulerGeneration: input.schedulerGeneration,
        tickSequence: input.tickSequence,
        transitionIdentity: input.transitionIdentity,
        unitRef: input.unitRef,
        eligibleClass: input.eligibleClass,
      };
      writeJsonAtomicUntil(activePath, replacement, input.deadlineMs, false);
      const reread = asS2ClaimRecord(readJsonRecordUntil(activePath, input.deadlineMs));
      if (reread?.holder.processGuid !== replacement.holder.processGuid
        || reread.key !== key
        || reread.tupleKey !== tupleKey) {
        return { acquired: false, reason: 'claim_untrusted', path: activePath, namespace, key };
      }
      return {
        acquired: true,
        claim: replacement,
        path: activePath,
        namespace,
        key,
        projectId,
        deadlineMs: input.deadlineMs,
      };
    });
  } catch (error) {
    return {
      acquired: false,
      reason: error instanceof Error ? error.message : 'claim_untrusted',
      path: activePath,
      namespace,
      key,
    };
  }
}

function handleDeadline(
  handle: WorkerNudgeClaimHandle,
  options?: WorkerNudgeDeadlineOptions,
): number | null {
  const s2 = (handle.claim as Partial<S2OneShotWorkerNudgeClaimRecord>).policyTag === S2_ONE_SHOT_CLAIM_POLICY;
  if (!s2) return null;
  const deadlineMs = options?.deadlineMs
    ?? (handle as Partial<S2OneShotWorkerNudgeClaimHandle>).deadlineMs;
  return typeof deadlineMs === 'number' && Number.isFinite(deadlineMs) ? deadlineMs : 0;
}

async function mutateOwnedClaim(
  handle: WorkerNudgeClaimHandle,
  mutation: (record: WorkerNudgeClaimRecord) => WorkerNudgeClaimRecord,
  options?: WorkerNudgeDeadlineOptions,
): Promise<{ ok: true; record: WorkerNudgeClaimRecord } | { ok: false; reason: string }> {
  const mutex = lockDir(handle.namespace, handle.key);
  const deadlineMs = handleDeadline(handle, options);
  const action = () => {
    if (deadlineMs !== null) assertBeforeDeadline(deadlineMs);
    const current = deadlineMs === null
      ? asClaimRecord(readJsonRecord(handle.path))
      : asClaimRecord(readJsonRecordUntil(handle.path, deadlineMs));
    if (!current) return { ok: false as const, reason: 'claim_missing' };
    if (current.holder.processGuid !== handle.claim.holder.processGuid) {
      return { ok: false as const, reason: 'lost_ownership' };
    }
    const next = mutation(current);
    if (deadlineMs !== null) writeJsonAtomicUntil(handle.path, next, deadlineMs, true);
    else writeJsonAtomic(handle.path, next, true);
    handle.claim = next;
    return { ok: true as const, record: next };
  };
  try {
    return deadlineMs === null
      ? await withClaimMutex(mutex, action)
      : await withClaimMutexUntil(mutex, deadlineMs, action);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'storage_failure' };
  }
}

export async function persistWorkerNudgeMessageHash(
  handle: WorkerNudgeClaimHandle,
  message: string,
  options?: WorkerNudgeDeadlineOptions,
): Promise<{ ok: boolean; reason?: string; messageContentHash?: string }> {
  const messageContentHash = hashNudgeMessageContent(message);
  const result = await mutateOwnedClaim(handle, (record) => {
    if (record.phase !== 'CLAIMED') throw new Error('token_phase_invalid');
    return { ...record, messageContentHash };
  }, options);
  return result.ok
    ? { ok: true, messageContentHash }
    : { ok: false, reason: result.reason };
}

function inspectS2SendAttemptState(
  handle: S2OneShotWorkerNudgeClaimHandle,
  deadlineMs: number,
): S2SendAttemptAdmissionResult {
  try {
    const currentRaw = readJsonRecordUntil(handle.path, deadlineMs);
    if (currentRaw) {
      const current = asS2ClaimRecord(currentRaw);
      if (!current
        || current.key !== handle.key
        || current.holder.processGuid !== handle.claim.holder.processGuid) {
        return { status: 'state_untrusted' };
      }
      if (current.phase === 'SEND_ATTEMPTED') {
        handle.claim = current;
        return { status: 'recorded' };
      }
      if (current.phase === 'CLAIMED') {
        handle.claim = current;
        return { status: 'definitely_not_recorded' };
      }
      return { status: 'recorded' };
    }
    const terminal = asS2ClaimRecord(readJsonRecordUntil(
      s2TerminalPath(handle.namespace, handle.key),
      deadlineMs,
    ));
    return terminal && ['SENT', 'FAILED_DEFINITIVE', 'UNCERTAIN'].includes(terminal.phase)
      ? { status: 'recorded' }
      : { status: 'state_untrusted' };
  } catch {
    return { status: 'state_untrusted' };
  }
}

export async function markS2OneShotWorkerNudgeSendAttempted(
  handle: S2OneShotWorkerNudgeClaimHandle,
  options: WorkerNudgeDeadlineOptions,
): Promise<S2SendAttemptAdmissionResult> {
  const attemptDeadline = options.deadlineMs;
  const settlementDeadline = Math.max(
    attemptDeadline,
    options.settlementDeadlineMs ?? attemptDeadline,
  );
  const mutex = lockDir(handle.namespace, handle.key);
  try {
    return await withClaimMutexUntil(mutex, attemptDeadline, () => {
      const current = asS2ClaimRecord(readJsonRecordUntil(handle.path, attemptDeadline));
      if (!current
        || current.key !== handle.key
        || current.holder.processGuid !== handle.claim.holder.processGuid) {
        return { status: 'state_untrusted' as const };
      }
      if (current.phase === 'SEND_ATTEMPTED') {
        handle.claim = current;
        return { status: 'recorded' as const };
      }
      if (current.phase !== 'CLAIMED' || current.claimLeaseExpiresAtMs <= Date.now()) {
        return current.phase === 'CLAIMED'
          ? { status: 'definitely_not_recorded' as const }
          : { status: 'state_untrusted' as const };
      }
      const next: S2OneShotWorkerNudgeClaimRecord = {
        ...current,
        phase: 'SEND_ATTEMPTED',
        state: 'SEND_ATTEMPTED',
        sendAttemptedAtUtc: new Date().toISOString(),
      };
      writeJsonAtomicUntil(handle.path, next, attemptDeadline, true);
      const reread = asS2ClaimRecord(readJsonRecordUntil(handle.path, attemptDeadline));
      if (!reread
        || reread.phase !== 'SEND_ATTEMPTED'
        || reread.key !== handle.key
        || reread.holder.processGuid !== handle.claim.holder.processGuid) {
        return { status: 'state_untrusted' as const };
      }
      handle.claim = reread;
      return { status: 'recorded' as const };
    });
  } catch {
    try {
      return await withClaimMutexUntil(mutex, settlementDeadline, () =>
        inspectS2SendAttemptState(handle, settlementDeadline));
    } catch {
      return inspectS2SendAttemptState(handle, settlementDeadline);
    }
  }
}

export async function markWorkerNudgeSendAttempted(
  handle: WorkerNudgeClaimHandle,
  options?: WorkerNudgeDeadlineOptions,
): Promise<{ ok: boolean; reason?: string }> {
  if ((handle.claim as Partial<S2OneShotWorkerNudgeClaimRecord>).policyTag === S2_ONE_SHOT_CLAIM_POLICY) {
    const s2Handle = handle as S2OneShotWorkerNudgeClaimHandle;
    const deadlineMs = options?.deadlineMs ?? s2Handle.deadlineMs;
    const result = await markS2OneShotWorkerNudgeSendAttempted(s2Handle, {
      deadlineMs,
      settlementDeadlineMs: options?.settlementDeadlineMs,
    });
    return result.status === 'recorded'
      ? { ok: true }
      : { ok: false, reason: result.status };
  }
  const result = await mutateOwnedClaim(handle, (record) => {
    if (record.phase !== 'CLAIMED') {
      throw new Error(record.phase === 'SEND_ATTEMPTED' ? 'token_replayed' : 'token_phase_invalid');
    }
    if (record.claimLeaseExpiresAtMs <= Date.now()) throw new Error('claim_lease_expired');
    return {
      ...record,
      phase: 'SEND_ATTEMPTED',
      state: 'SEND_ATTEMPTED',
      sendAttemptedAtUtc: new Date().toISOString(),
    };
  }, options);
  return result.ok ? { ok: true } : { ok: false, reason: result.reason };
}

export async function releaseWorkerNudgeClaim(
  handle: WorkerNudgeClaimHandle,
): Promise<{ ok: boolean; reason: string }> {
  const mutex = lockDir(handle.namespace, handle.key);
  try {
    return await withClaimMutex(mutex, () => {
      const current = asClaimRecord(readJsonRecord(handle.path));
      if (!current) return { ok: true, reason: 'already_released' };
      if (current.holder.processGuid !== handle.claim.holder.processGuid) {
        return { ok: false, reason: 'lost_ownership' };
      }
      unlinkSync(handle.path);
      return { ok: true, reason: 'released' };
    });
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'storage_failure' };
  }
}

export async function releaseS2OneShotWorkerNudgeClaim(
  handle: S2OneShotWorkerNudgeClaimHandle,
  options?: WorkerNudgeDeadlineOptions,
): Promise<{ ok: boolean; reason: string }> {
  const mutex = lockDir(handle.namespace, handle.key);
  const deadlineMs = options?.deadlineMs ?? handle.deadlineMs;
  try {
    return await withClaimMutexUntil(mutex, deadlineMs, () => {
      const current = asS2ClaimRecord(readJsonRecordUntil(handle.path, deadlineMs));
      if (!current) return { ok: true, reason: 'already_released' };
      if (current.holder.processGuid !== handle.claim.holder.processGuid
        || current.key !== handle.key) {
        return { ok: false, reason: 'lost_ownership' };
      }
      if (current.phase !== 'CLAIMED') return { ok: false, reason: 'send_attempted' };
      unlinkUntil(handle.path, deadlineMs);
      return { ok: true, reason: 'released' };
    });
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'storage_failure' };
  }
}

export async function finalizeWorkerNudgeClaim(
  handle: WorkerNudgeClaimHandle,
  outcome: Extract<WorkerNudgeClaimPhase, 'SENT' | 'FAILED_DEFINITIVE' | 'UNCERTAIN'>,
  extra: Record<string, unknown> = {},
): Promise<{ ok: boolean; reason?: string; terminalPath?: string }> {
  if ((handle.claim as Partial<S2OneShotWorkerNudgeClaimRecord>).policyTag === S2_ONE_SHOT_CLAIM_POLICY) {
    return finalizeS2OneShotWorkerNudgeClaim(
      handle as S2OneShotWorkerNudgeClaimHandle,
      outcome,
      extra,
    );
  }
  const mutex = lockDir(handle.namespace, handle.key);
  try {
    return await withClaimMutex(mutex, () => {
      const current = asClaimRecord(readJsonRecord(handle.path));
      if (!current) return { ok: false, reason: 'claim_missing' };
      if (current.holder.processGuid !== handle.claim.holder.processGuid) {
        return { ok: false, reason: 'lost_ownership' };
      }
      const terminalPath = moveToTerminal(handle.namespace, handle.path, current, outcome, extra);
      return { ok: true, terminalPath };
    });
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'storage_failure' };
  }
}

export async function finalizeS2OneShotWorkerNudgeClaim(
  handle: S2OneShotWorkerNudgeClaimHandle,
  outcome: Extract<WorkerNudgeClaimPhase, 'SENT' | 'FAILED_DEFINITIVE' | 'UNCERTAIN'>,
  extra: Record<string, unknown> = {},
  options?: WorkerNudgeDeadlineOptions,
): Promise<{ ok: boolean; reason?: string; terminalPath?: string }> {
  const mutex = lockDir(handle.namespace, handle.key);
  const deadlineMs = options?.deadlineMs ?? handle.deadlineMs;
  try {
    return await withClaimMutexUntil(mutex, deadlineMs, () => {
      const current = asS2ClaimRecord(readJsonRecordUntil(handle.path, deadlineMs));
      if (!current) return { ok: false, reason: 'claim_missing' };
      if (current.holder.processGuid !== handle.claim.holder.processGuid
        || current.key !== handle.key) {
        return { ok: false, reason: 'lost_ownership' };
      }
      if (current.phase !== 'SEND_ATTEMPTED') {
        return { ok: false, reason: 'token_phase_invalid' };
      }
      const terminalPath = moveS2ToTerminal(
        handle.namespace,
        handle.path,
        current,
        outcome,
        deadlineMs,
        extra,
      );
      return { ok: true, terminalPath };
    });
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'storage_failure' };
  }
}

export async function withWorkerNudgeSideEffectFence<T>(
  action: () => T | Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; reason: 'side_effect_busy' }> {
  const explicitRoot = process.env.OPK_SIDE_PROCESS_STATE_DIR?.trim();
  const lockPath = explicitRoot
    ? path.join(explicitRoot, 'scripted-review-stdout-delivery.lock')
    : path.join(tmpdir(), 'orchestrator-scripted-review-stdout-delivery.lock');
  mkdirSync(path.dirname(lockPath), { recursive: true });

  const clearStale = (): void => {
    const record = readJsonRecord(lockPath);
    if (!existsSync(lockPath)) return;
    const pid = Number(record?.pid ?? 0);
    const startedAtMs = Date.parse(String(record?.startedAt ?? ''));
    const maxAgeMinutes = parsePositiveInteger(process.env.OPK_SIDE_EFFECT_LOCK_MAX_AGE_MINUTES, 180);
    const stale = pid > 0
      ? !processAlive(pid)
      : !Number.isFinite(startedAtMs) || Date.now() - startedAtMs > maxAgeMinutes * 60_000;
    if (stale) rmSync(lockPath, { force: true });
  };

  clearStale();
  try {
    writeJsonAtomic(lockPath, { pid: process.pid, startedAt: new Date().toISOString() }, false);
  } catch {
    clearStale();
    try {
      writeJsonAtomic(lockPath, { pid: process.pid, startedAt: new Date().toISOString() }, false);
    } catch {
      return { ok: false, reason: 'side_effect_busy' };
    }
  }
  try {
    return { ok: true, value: await action() };
  } finally {
    rmSync(lockPath, { force: true });
  }
}
