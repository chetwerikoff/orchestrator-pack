import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { processAlive, readProcessIdentity } from '../lib/cutover/activation-cordon.ts';
import { writeDurableJson } from '../lib/cutover/activation-evidence.ts';

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
}

function ownerPath(lockDir: string): string {
  return join(lockDir, 'owner.json');
}

export function readLiveSingleInstanceLease(lockDir: string): SingleInstanceLeaseOwner | null {
  if (!existsSync(lockDir)) return null;
  let owner: SingleInstanceLeaseOwner;
  try {
    owner = JSON.parse(readFileSync(ownerPath(lockDir), 'utf8')) as SingleInstanceLeaseOwner;
  } catch {
    throw new Error('single_instance_lease_unreadable');
  }
  if (owner.schemaVersion !== 1
    || !Number.isInteger(owner.pid)
    || owner.pid <= 0
    || !owner.startTicks
    || !owner.generation) throw new Error('single_instance_lease_invalid');
  if (!processAlive(owner.pid)) return null;
  const identity = readProcessIdentity(owner.pid);
  return identity?.startTicks === owner.startTicks ? owner : null;
}

/**
 * Acquire one process-generation lease. A stale directory is reclaimed only
 * after its recorded PID/start-ticks pair is no longer live.
 */
export function acquireSingleInstanceLease(input: {
  readonly lockDir: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}): SingleInstanceLeaseHandle {
  const identity = readProcessIdentity(process.pid);
  if (!identity) throw new Error('single_instance_identity_unreadable');
  mkdirSync(dirname(input.lockDir), { recursive: true });
  const candidate = `${input.lockDir}.candidate-${process.pid}-${randomUUID()}`;
  mkdirSync(candidate);
  const owner: SingleInstanceLeaseOwner = {
    schemaVersion: 1,
    pid: identity.pid,
    startTicks: identity.startTicks,
    generation: randomUUID().replace(/-/g, ''),
    acquiredAt: new Date().toISOString(),
    metadata: input.metadata ?? {},
  };
  writeDurableJson(ownerPath(candidate), owner);
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        renameSync(candidate, input.lockDir);
        return { lockDir: input.lockDir, owner };
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error
          ? String((error as NodeJS.ErrnoException).code ?? '')
          : '';
        if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error;
        const live = readLiveSingleInstanceLease(input.lockDir);
        if (live) throw new Error(`single_instance_busy:${live.pid}`);
        rmSync(input.lockDir, { recursive: true, force: true });
      }
    }
    throw new Error('single_instance_lease_acquire_failed');
  } finally {
    if (existsSync(candidate)) rmSync(candidate, { recursive: true, force: true });
  }
}

export function releaseSingleInstanceLease(handle: SingleInstanceLeaseHandle): boolean {
  if (!existsSync(handle.lockDir)) return true;
  let owner: SingleInstanceLeaseOwner;
  try {
    owner = JSON.parse(readFileSync(ownerPath(handle.lockDir), 'utf8')) as SingleInstanceLeaseOwner;
  } catch {
    return false;
  }
  if (owner.pid !== handle.owner.pid
    || owner.startTicks !== handle.owner.startTicks
    || owner.generation !== handle.owner.generation) return false;
  rmSync(handle.lockDir, { recursive: true, force: true });
  return true;
}
