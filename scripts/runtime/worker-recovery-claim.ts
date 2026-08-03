import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { processAlive, readProcessIdentity } from '../lib/cutover/activation-cordon.ts';

export interface WorkerRecoveryClaimRecord {
  readonly schemaVersion: 1;
  readonly claimKey: string;
  readonly workspacePath: string;
  readonly workerId: string | null;
  readonly holder: {
    readonly pid: number;
    readonly startTicks: string;
    readonly processGuid: string;
    readonly host: string;
    readonly surface: string;
  };
  readonly acquiredAtMs: number;
}

export interface WorkerRecoveryClaimHandle {
  readonly path: string;
  readonly namespace: string;
  readonly record: WorkerRecoveryClaimRecord;
}

export type WorkerRecoveryClaimResult =
  | { readonly acquired: true; readonly handle: WorkerRecoveryClaimHandle }
  | { readonly acquired: false; readonly reason: 'claim_held' | 'claim_untrusted' };

function safeKey(value: string): string {
  const normalized = value.trim().replace(/[^\w.:-]/g, '_');
  if (!normalized) throw new Error('worker_recovery_claim_key_missing');
  return normalized;
}

function claimPath(namespace: string, claimKey: string): string {
  return join(namespace, 'active', `${safeKey(claimKey)}.json`);
}

function terminalPath(namespace: string, claimKey: string, outcome: string): string {
  return join(
    namespace,
    'terminal',
    `${safeKey(claimKey)}-${safeKey(outcome)}-${randomUUID().replace(/-/g, '')}.json`,
  );
}

function readRecord(path: string): WorkerRecoveryClaimRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as WorkerRecoveryClaimRecord;
    if (parsed.schemaVersion !== 1
      || !parsed.claimKey
      || !parsed.workspacePath
      || !Number.isInteger(parsed.holder?.pid)
      || !parsed.holder.startTicks
      || !parsed.holder.processGuid
      || !Number.isFinite(parsed.acquiredAtMs)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function holderAlive(record: WorkerRecoveryClaimRecord): boolean {
  if (!processAlive(record.holder.pid)) return false;
  const identity = readProcessIdentity(record.holder.pid);
  return identity?.startTicks === record.holder.startTicks;
}

function writeExclusive(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const descriptor = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  } finally {
    closeSync(descriptor);
  }
}

function terminalizeExisting(
  namespace: string,
  path: string,
  record: WorkerRecoveryClaimRecord,
  outcome: string,
): void {
  mkdirSync(join(namespace, 'terminal'), { recursive: true });
  const terminal = terminalPath(namespace, record.claimKey, outcome);
  writeExclusive(terminal, {
    ...record,
    outcome,
    completedAtMs: Date.now(),
  });
  rmSync(path, { force: true });
}

/**
 * One process-generation claim for one exact recovery workspace. A claim can be
 * reclaimed once only when its PID/start-ticks owner is dead or the bounded
 * stale age has elapsed. No retry counter or scheduler state is stored here.
 */
export function acquireWorkerRecoveryClaim(input: {
  readonly namespace: string;
  readonly claimKey: string;
  readonly workspacePath: string;
  readonly workerId?: string;
  readonly surface?: string;
  readonly staleMs?: number;
}): WorkerRecoveryClaimResult {
  const identity = readProcessIdentity(process.pid);
  if (!identity) return { acquired: false, reason: 'claim_untrusted' };
  const path = claimPath(input.namespace, input.claimKey);
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(join(input.namespace, 'terminal'), { recursive: true });
  const record: WorkerRecoveryClaimRecord = {
    schemaVersion: 1,
    claimKey: safeKey(input.claimKey),
    workspacePath: input.workspacePath,
    workerId: input.workerId?.trim() || null,
    holder: {
      pid: identity.pid,
      startTicks: identity.startTicks,
      processGuid: randomUUID().replace(/-/g, ''),
      host: hostname(),
      surface: input.surface?.trim() || 'worker-recovery',
    },
    acquiredAtMs: Date.now(),
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeExclusive(path, record);
      return { acquired: true, handle: { path, namespace: input.namespace, record } };
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error
        ? String((error as NodeJS.ErrnoException).code ?? '')
        : '';
      if (code !== 'EEXIST') return { acquired: false, reason: 'claim_untrusted' };
      const existing = readRecord(path);
      if (!existing) return { acquired: false, reason: 'claim_untrusted' };
      const staleMs = Math.max(120_000, input.staleMs ?? 15 * 60_000);
      const stale = !holderAlive(existing) || Date.now() - existing.acquiredAtMs >= staleMs;
      if (!stale || attempt > 0) return { acquired: false, reason: 'claim_held' };
      terminalizeExisting(input.namespace, path, existing, 'recovered_stale');
    }
  }
  return { acquired: false, reason: 'claim_held' };
}

export function finalizeWorkerRecoveryClaim(
  handle: WorkerRecoveryClaimHandle,
  outcome: string,
  details: Readonly<Record<string, unknown>> = {},
): boolean {
  const current = readRecord(handle.path);
  if (!current
    || current.holder.processGuid !== handle.record.holder.processGuid
    || current.holder.pid !== handle.record.holder.pid
    || current.holder.startTicks !== handle.record.holder.startTicks) return false;
  const terminal = terminalPath(handle.namespace, current.claimKey, outcome);
  writeExclusive(terminal, {
    ...current,
    outcome,
    details,
    completedAtMs: Date.now(),
  });
  rmSync(handle.path, { force: true });
  return true;
}

export function releaseWorkerRecoveryClaim(handle: WorkerRecoveryClaimHandle): boolean {
  const current = readRecord(handle.path);
  if (!current || current.holder.processGuid !== handle.record.holder.processGuid) return false;
  rmSync(handle.path, { force: true });
  return true;
}
