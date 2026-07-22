import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
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
import { canonicalStoreId, hashNudgeMessageContent } from './worker-nudge-gate.ts';

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
    parsePositiveInteger(process.env.AO_WORKER_NUDGE_CLAIM_LEASE_MS, CLAIM_LEASE_DEFAULT_MS),
    CLAIM_LEASE_MAX_MS,
  );
}

function claimStaleMs(): number {
  const minutes = Math.max(
    parsePositiveInteger(process.env.AO_WORKER_NUDGE_CLAIM_STALE_MINUTES, CLAIM_STALE_DEFAULT_MINUTES),
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
  const base = process.env.AO_BASE_DIR?.trim() || path.join(homedir(), '.agent-orchestrator');
  return path.join(base, 'projects', projectId.trim() || 'orchestrator-pack', 'worker-nudge-claims');
}

export function workerNudgeClaimNamespace(projectId = 'orchestrator-pack'): string {
  const root = workerNudgeClaimProjectNamespace(projectId);
  const override = process.env.AO_WORKER_NUDGE_CLAIM_DIR?.trim();
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
    // D4: uncertain attempts remain durable history, but only SENT deduplicates.
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
        if (existing.phase === 'SEND_ATTEMPTED' || existing.phase === 'UNCERTAIN') {
          // D4 intentionally retries at least once. Archive the uncertain attempt,
          // then install a fresh claim so duplicate delivery can be accounted for.
          moveToTerminal(namespace, activePath, existing, 'UNCERTAIN', {
            recoveredBy: replacement.holder,
            recoveredFromPhase: existing.phase,
            retryAllowed: true,
          });
        } else {
          const leaseExpired = existing.phase === 'CLAIMED'
            && existing.claimLeaseExpiresAtMs <= Date.now();
          if (existing.phase === 'CLAIMED' && !leaseExpired) {
            return { acquired: false, reason: 'claimed', path: activePath, namespace, key };
          }
          const acquiredAtMs = Date.parse(existing.acquiredAtUtc);
          const staleByAge = !Number.isFinite(acquiredAtMs)
            || Date.now() - acquiredAtMs >= claimStaleMs();
          if (!leaseExpired && !staleByAge && existing.phase === 'CLAIMED') {
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

async function mutateOwnedClaim(
  handle: WorkerNudgeClaimHandle,
  mutation: (record: WorkerNudgeClaimRecord) => WorkerNudgeClaimRecord,
): Promise<{ ok: true; record: WorkerNudgeClaimRecord } | { ok: false; reason: string }> {
  const mutex = lockDir(handle.namespace, handle.key);
  try {
    return await withClaimMutex(mutex, () => {
      const current = asClaimRecord(readJsonRecord(handle.path));
      if (!current) return { ok: false as const, reason: 'claim_missing' };
      if (current.holder.processGuid !== handle.claim.holder.processGuid) {
        return { ok: false as const, reason: 'lost_ownership' };
      }
      const next = mutation(current);
      writeJsonAtomic(handle.path, next, true);
      handle.claim = next;
      return { ok: true as const, record: next };
    });
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'storage_failure' };
  }
}

export async function persistWorkerNudgeMessageHash(
  handle: WorkerNudgeClaimHandle,
  message: string,
): Promise<{ ok: boolean; reason?: string; messageContentHash?: string }> {
  const messageContentHash = hashNudgeMessageContent(message);
  const result = await mutateOwnedClaim(handle, (record) => {
    if (record.phase !== 'CLAIMED') throw new Error('token_phase_invalid');
    return { ...record, messageContentHash };
  });
  return result.ok
    ? { ok: true, messageContentHash }
    : { ok: false, reason: result.reason };
}

export async function markWorkerNudgeSendAttempted(
  handle: WorkerNudgeClaimHandle,
): Promise<{ ok: boolean; reason?: string }> {
  const result = await mutateOwnedClaim(handle, (record) => {
    if (record.phase !== 'CLAIMED') throw new Error(record.phase === 'SEND_ATTEMPTED' ? 'token_replayed' : 'token_phase_invalid');
    if (record.claimLeaseExpiresAtMs <= Date.now()) throw new Error('claim_lease_expired');
    return {
      ...record,
      phase: 'SEND_ATTEMPTED',
      state: 'SEND_ATTEMPTED',
      sendAttemptedAtUtc: new Date().toISOString(),
    };
  });
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

export async function finalizeWorkerNudgeClaim(
  handle: WorkerNudgeClaimHandle,
  outcome: Extract<WorkerNudgeClaimPhase, 'SENT' | 'FAILED_DEFINITIVE' | 'UNCERTAIN'>,
  extra: Record<string, unknown> = {},
): Promise<{ ok: boolean; reason?: string; terminalPath?: string }> {
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

export async function withWorkerNudgeSideEffectFence<T>(
  action: () => T | Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; reason: 'side_effect_busy' }> {
  const explicitRoot = process.env.AO_SIDE_PROCESS_STATE_DIR?.trim();
  const lockPath = explicitRoot
    ? path.join(explicitRoot, 'scripted-review-stdout-delivery.lock')
    : path.join(tmpdir(), 'orchestrator-scripted-review-stdout-delivery.lock');
  mkdirSync(path.dirname(lockPath), { recursive: true });

  const clearStale = (): void => {
    const record = readJsonRecord(lockPath);
    if (!existsSync(lockPath)) return;
    const pid = Number(record?.pid ?? 0);
    const startedAtMs = Date.parse(String(record?.startedAt ?? ''));
    const maxAgeMinutes = parsePositiveInteger(process.env.AO_SIDE_EFFECT_LOCK_MAX_AGE_MINUTES, 180);
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
