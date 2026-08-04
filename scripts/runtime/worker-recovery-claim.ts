import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { processAlive, readProcessIdentity } from '../lib/cutover/activation-cordon.ts';
import {
  clearLockedFileContents,
  readLockedFileContents,
  releaseHeldFileLock,
  replaceLockedFileContents,
  tryAcquireHeldFileLock,
} from './single-instance-lease.ts';

export interface WorkerRecoveryClaimRecord {
  readonly schemaVersion: 1;
  readonly claimKey: string;
  readonly workspacePath: string;
  readonly workerId: string | null;
  readonly workerGeneration: string | null;
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
  readonly descriptor: number;
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

function parseRecord(raw: string): WorkerRecoveryClaimRecord | null {
  try {
    const parsed = JSON.parse(raw) as WorkerRecoveryClaimRecord;
    if (parsed.schemaVersion !== 1
      || !parsed.claimKey
      || !parsed.workspacePath
      || (parsed.workerId !== null && typeof parsed.workerId !== 'string')
      || (parsed.workerGeneration !== null && typeof parsed.workerGeneration !== 'string')
      || !Number.isInteger(parsed.holder?.pid)
      || !parsed.holder.startTicks
      || !parsed.holder.processGuid
      || !Number.isFinite(parsed.acquiredAtMs)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function readLockedRecord(descriptor: number): WorkerRecoveryClaimRecord | null {
  const raw = readLockedFileContents(descriptor).trim();
  return raw ? parseRecord(raw) : null;
}

function holderAlive(record: WorkerRecoveryClaimRecord): boolean {
  if (!processAlive(record.holder.pid)) return false;
  const identity = readProcessIdentity(record.holder.pid);
  return identity?.startTicks === record.holder.startTicks;
}

function writeExclusive(path: string, value: unknown): void {
  fs.mkdirSync(dirname(path), { recursive: true });
  const descriptor = fs.openSync(path, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function terminalizeExisting(
  namespace: string,
  record: WorkerRecoveryClaimRecord,
  outcome: string,
  details: Readonly<Record<string, unknown>> = {},
): void {
  fs.mkdirSync(join(namespace, 'terminal'), { recursive: true });
  writeExclusive(terminalPath(namespace, record.claimKey, outcome), {
    ...record,
    outcome,
    details,
    completedAtMs: Date.now(),
  });
}

function sameClaimOwner(
  current: WorkerRecoveryClaimRecord,
  expected: WorkerRecoveryClaimRecord,
): boolean {
  return current.holder.processGuid === expected.holder.processGuid
    && current.holder.pid === expected.holder.pid
    && current.holder.startTicks === expected.holder.startTicks;
}

/**
 * One process-generation claim for one exact recovery workspace. The stable
 * active file is kernel-locked for the full claim lifetime. Reclaim, finalize,
 * and release therefore cannot delete or replace another holder's generation.
 */
export function acquireWorkerRecoveryClaim(input: {
  readonly namespace: string;
  readonly claimKey: string;
  readonly workspacePath: string;
  readonly workerId?: string;
  readonly workerGeneration?: string;
  readonly surface?: string;
  readonly staleMs?: number;
}): WorkerRecoveryClaimResult {
  const identity = readProcessIdentity(process.pid);
  if (!identity) return { acquired: false, reason: 'claim_untrusted' };
  const path = claimPath(input.namespace, input.claimKey);
  fs.mkdirSync(dirname(path), { recursive: true });
  fs.mkdirSync(join(input.namespace, 'terminal'), { recursive: true });

  const held = tryAcquireHeldFileLock(path);
  if (!held.acquired) {
    return {
      acquired: false,
      reason: held.reason === 'busy' ? 'claim_held' : 'claim_untrusted',
    };
  }

  const record: WorkerRecoveryClaimRecord = {
    schemaVersion: 1,
    claimKey: safeKey(input.claimKey),
    workspacePath: input.workspacePath,
    workerId: input.workerId?.trim() || null,
    workerGeneration: input.workerGeneration?.trim() || null,
    holder: {
      pid: identity.pid,
      startTicks: identity.startTicks,
      processGuid: randomUUID().replace(/-/g, ''),
      host: hostname(),
      surface: input.surface?.trim() || 'worker-recovery',
    },
    acquiredAtMs: Date.now(),
  };

  try {
    const raw = readLockedFileContents(held.descriptor).trim();
    if (raw) {
      const existing = parseRecord(raw);
      if (!existing) {
        releaseHeldFileLock(held.descriptor);
        return { acquired: false, reason: 'claim_untrusted' };
      }
      const staleMs = Math.max(120_000, input.staleMs ?? 15 * 60_000);
      const stale = !holderAlive(existing) || Date.now() - existing.acquiredAtMs >= staleMs;
      if (!stale) {
        releaseHeldFileLock(held.descriptor);
        return { acquired: false, reason: 'claim_held' };
      }
      terminalizeExisting(input.namespace, existing, 'recovered_stale');
    }
    replaceLockedFileContents(held.descriptor, `${JSON.stringify(record, null, 2)}\n`);
    return {
      acquired: true,
      handle: { path, namespace: input.namespace, record, descriptor: held.descriptor },
    };
  } catch {
    releaseHeldFileLock(held.descriptor);
    return { acquired: false, reason: 'claim_untrusted' };
  }
}

export function finalizeWorkerRecoveryClaim(
  handle: WorkerRecoveryClaimHandle,
  outcome: string,
  details: Readonly<Record<string, unknown>> = {},
): boolean {
  const current = readLockedRecord(handle.descriptor);
  if (!current || !sameClaimOwner(current, handle.record)) return false;
  terminalizeExisting(handle.namespace, current, outcome, details);
  clearLockedFileContents(handle.descriptor);
  return true;
}

export function releaseWorkerRecoveryClaim(handle: WorkerRecoveryClaimHandle): boolean {
  let released = false;
  try {
    const raw = readLockedFileContents(handle.descriptor).trim();
    if (!raw) {
      released = true;
    } else {
      const current = parseRecord(raw);
      if (current && sameClaimOwner(current, handle.record)) {
        clearLockedFileContents(handle.descriptor);
        released = true;
      }
    }
  } finally {
    releaseHeldFileLock(handle.descriptor);
  }
  return released;
}
