import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { processAlive, readProcessIdentity } from '../lib/cutover/activation-cordon.ts';

export interface SingleInstanceLeaseOwner {
  readonly schemaVersion: 1;
  readonly pid: number;
  readonly startTicks: string;
  readonly generation: string;
  readonly acquiredAt: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface SingleInstanceLeaseHandle {
  readonly lockDir: string;
  readonly owner: SingleInstanceLeaseOwner;
  readonly descriptor: number;
}

export type HeldFileLockResult =
  | { readonly acquired: true; readonly descriptor: number }
  | { readonly acquired: false; readonly reason: 'busy' | 'unavailable' };

function ownerPath(lockDir: string): string {
  return join(lockDir, 'owner.json');
}

export function readLockedFileContents(descriptor: number): string {
  const size = fstatSync(descriptor).size;
  if (size === 0) return '';
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = readSync(descriptor, buffer, offset, size - offset, offset);
    if (count === 0) break;
    offset += count;
  }
  return buffer.subarray(0, offset).toString('utf8');
}

export function replaceLockedFileContents(descriptor: number, value: string): void {
  const bytes = Buffer.from(value, 'utf8');
  ftruncateSync(descriptor, 0);
  let offset = 0;
  while (offset < bytes.length) {
    offset += writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
  }
  fsyncSync(descriptor);
}

export function clearLockedFileContents(descriptor: number): void {
  ftruncateSync(descriptor, 0);
  fsyncSync(descriptor);
}

/**
 * Acquire a kernel-held exclusive lock on one stable file inode. The helper
 * delegates only the flock syscall to the system utility; the descriptor stays
 * open in this Node process, so the lock remains held until closeSync().
 */
export function tryAcquireHeldFileLock(path: string): HeldFileLockResult {
  mkdirSync(dirname(path), { recursive: true });
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_CREAT | constants.O_RDWR, 0o600);
  } catch {
    return { acquired: false, reason: 'unavailable' };
  }
  const locked = spawnSync('flock', ['-n', '3'], {
    stdio: ['ignore', 'ignore', 'ignore', descriptor],
  });
  if (locked.error) {
    closeSync(descriptor);
    return { acquired: false, reason: 'unavailable' };
  }
  if (locked.status !== 0) {
    closeSync(descriptor);
    return { acquired: false, reason: 'busy' };
  }
  return { acquired: true, descriptor };
}

export function releaseHeldFileLock(descriptor: number): void {
  closeSync(descriptor);
}

function parseOwner(raw: string): SingleInstanceLeaseOwner {
  let owner: SingleInstanceLeaseOwner;
  try {
    owner = JSON.parse(raw) as SingleInstanceLeaseOwner;
  } catch {
    throw new Error('single_instance_lease_unreadable');
  }
  if (owner.schemaVersion !== 1
    || !Number.isInteger(owner.pid)
    || owner.pid <= 0
    || !owner.startTicks
    || !owner.generation) throw new Error('single_instance_lease_invalid');
  return owner;
}

function liveOwner(owner: SingleInstanceLeaseOwner): boolean {
  if (!processAlive(owner.pid)) return false;
  const identity = readProcessIdentity(owner.pid);
  return identity?.startTicks === owner.startTicks;
}

export function readLiveSingleInstanceLease(lockDir: string): SingleInstanceLeaseOwner | null {
  const path = ownerPath(lockDir);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf8').trim();
  if (!raw) return null;
  const owner = parseOwner(raw);
  return liveOwner(owner) ? owner : null;
}

/**
 * Acquire one process-generation lease. Kernel flock is the single admission
 * authority; stale payload replacement happens only while that lock is held.
 */
export function acquireSingleInstanceLease(input: {
  readonly lockDir: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}): SingleInstanceLeaseHandle {
  const identity = readProcessIdentity(process.pid);
  if (!identity) throw new Error('single_instance_identity_unreadable');
  mkdirSync(input.lockDir, { recursive: true });
  const held = tryAcquireHeldFileLock(ownerPath(input.lockDir));
  if (!held.acquired) {
    if (held.reason === 'unavailable') throw new Error('single_instance_lock_unavailable');
    let live: SingleInstanceLeaseOwner | null = null;
    try {
      live = readLiveSingleInstanceLease(input.lockDir);
    } catch {
      // A held kernel lock is authoritative even when its advisory payload is unreadable.
    }
    throw new Error(`single_instance_busy:${live?.pid ?? 'unknown'}`);
  }

  try {
    const raw = readLockedFileContents(held.descriptor).trim();
    if (raw) {
      const previous = parseOwner(raw);
      if (liveOwner(previous)) {
        throw new Error(`single_instance_busy:${previous.pid}`);
      }
    }
    const owner: SingleInstanceLeaseOwner = {
      schemaVersion: 1,
      pid: identity.pid,
      startTicks: identity.startTicks,
      generation: randomUUID().replace(/-/g, ''),
      acquiredAt: new Date().toISOString(),
      metadata: input.metadata ?? {},
    };
    replaceLockedFileContents(held.descriptor, `${JSON.stringify(owner)}\n`);
    return { lockDir: input.lockDir, owner, descriptor: held.descriptor };
  } catch (error) {
    releaseHeldFileLock(held.descriptor);
    throw error;
  }
}

export function releaseSingleInstanceLease(handle: SingleInstanceLeaseHandle): boolean {
  let owner: SingleInstanceLeaseOwner;
  try {
    const raw = readLockedFileContents(handle.descriptor).trim();
    if (!raw) return false;
    owner = parseOwner(raw);
  } catch {
    return false;
  }
  if (owner.pid !== handle.owner.pid
    || owner.startTicks !== handle.owner.startTicks
    || owner.generation !== handle.owner.generation) return false;
  clearLockedFileContents(handle.descriptor);
  releaseHeldFileLock(handle.descriptor);
  return true;
}
