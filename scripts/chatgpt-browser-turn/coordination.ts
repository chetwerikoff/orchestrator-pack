import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { atomicJson, profileDirs, sha256 } from './storage-common.ts';

interface LockRecordV1 {
  readonly schema: 'chatgpt-browser-turn-lock/v1';
  readonly version: 1;
  readonly configured_profile_key: string;
  readonly key: string;
  readonly generation: number;
  readonly pid: number;
  readonly process_start_token: string;
  readonly nonce: string;
  readonly phase: 'pre_send' | 'possible_delivery';
  readonly created_at: string;
  readonly updated_at: string;
}

export interface DomainLock {
  readonly key: string;
  readonly generation: number;
  readonly nonce: string;
  readonly phase: 'pre_send' | 'possible_delivery';
  updatePhase(phase: 'pre_send' | 'possible_delivery'): void;
  release(): void;
}

export interface DestinationReservation {
  readonly identity: string;
  readonly finalPath: string;
  readonly lock: DomainLock;
  markPossibleDelivery(): void;
  release(): void;
}

const activeProcessDestinations = new Map<string, string>();

function errnoCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function processStartToken(pid: number): string | null {
  if (process.platform !== 'linux') return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    if (close < 0) return null;
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    const token = fields[19] ?? '';
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

function pidProvablyDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return errnoCode(error) === 'ESRCH';
  }
}

function ownerProvablyDead(record: LockRecordV1): boolean {
  if (pidProvablyDead(record.pid)) return true;
  if (process.platform !== 'linux') return false;
  if (!record.process_start_token) return false;
  const current = processStartToken(record.pid);
  return current !== null && current !== record.process_start_token;
}

function lockDirectory(profileKey: string, key: string): string {
  return join(profileDirs(profileKey).locks, sha256(key));
}

function ownerPath(directory: string): string {
  return join(directory, 'owner.json');
}

function readLockRecord(directory: string, profileKey: string): LockRecordV1 | null {
  try {
    const value = JSON.parse(readFileSync(ownerPath(directory), 'utf8')) as LockRecordV1;
    if (value.schema !== 'chatgpt-browser-turn-lock/v1'
      || value.version !== 1
      || value.configured_profile_key !== profileKey
      || typeof value.key !== 'string'
      || value.key.length === 0
      || !Number.isInteger(value.generation)
      || value.generation < 1
      || !Number.isInteger(value.pid)
      || value.pid <= 0
      || typeof value.process_start_token !== 'string'
      || !value.nonce
      || !['pre_send', 'possible_delivery'].includes(value.phase)) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

function readLock(directory: string, profileKey: string, key: string): LockRecordV1 | null {
  const value = readLockRecord(directory, profileKey);
  return value?.key === key ? value : null;
}

function createLockRecord(profileKey: string, key: string, generation: number): LockRecordV1 {
  const now = new Date().toISOString();
  return {
    schema: 'chatgpt-browser-turn-lock/v1',
    version: 1,
    configured_profile_key: profileKey,
    key,
    generation,
    pid: process.pid,
    process_start_token: processStartToken(process.pid) ?? '',
    nonce: randomUUID(),
    phase: 'pre_send',
    created_at: now,
    updated_at: now,
  };
}

function createLockDirectory(directory: string, record: LockRecordV1): boolean {
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if (errnoCode(error) === 'EEXIST') return false;
    throw error;
  }
  try {
    atomicJson(ownerPath(directory), record);
    return true;
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function stalePreSend(record: LockRecordV1, staleMs: number): boolean {
  const updatedAt = Date.parse(record.updated_at);
  return record.phase === 'pre_send'
    && Number.isFinite(updatedAt)
    && Date.now() - updatedAt >= staleMs
    && ownerProvablyDead(record);
}

function tryReclaim(profileKey: string, key: string, directory: string, staleMs: number): number | null {
  const first = readLock(directory, profileKey, key);
  if (!first || !stalePreSend(first, staleMs)) return null;

  const guard = `${directory}.reclaim`;
  try {
    mkdirSync(guard, { mode: 0o700 });
  } catch {
    return null;
  }
  try {
    const current = readLock(directory, profileKey, key);
    if (!current
      || current.nonce !== first.nonce
      || current.generation !== first.generation
      || !stalePreSend(current, staleMs)) {
      return null;
    }
    rmSync(directory, { recursive: true, force: false });
    return current.generation + 1;
  } finally {
    rmSync(guard, { recursive: true, force: true });
  }
}

function isSchedulingKey(key: string): boolean {
  return key.startsWith('profile:') || key.startsWith('conversation:') || key.startsWith('fresh:');
}

function hasSchedulingConflict(profileKey: string, requestedKey: string): boolean {
  const locks = profileDirs(profileKey).locks;
  for (const entry of readdirSync(locks, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = join(locks, entry.name);
    if (!existsSync(ownerPath(directory))) continue;
    const current = readLockRecord(directory, profileKey);
    if (!current) return true;
    if (!isSchedulingKey(current.key)) continue;
    if (requestedKey.startsWith('profile:')) {
      if (current.key.startsWith('conversation:') || current.key.startsWith('fresh:')) return true;
    } else if (current.key.startsWith('profile:')) {
      return true;
    }
  }
  return false;
}

export function acquireDomainLock(
  profileKey: string,
  key: string,
  staleMs = 120_000,
): DomainLock | null {
  let admissionGate: DomainLock | null = null;
  if (isSchedulingKey(key)) {
    admissionGate = acquireDomainLock(profileKey, `scheduling-admission:${profileKey}`, staleMs);
    if (!admissionGate) return null;
  }

  try {
    if (isSchedulingKey(key) && hasSchedulingConflict(profileKey, key)) return null;

    const directory = lockDirectory(profileKey, key);
    let record = createLockRecord(profileKey, key, 1);
    if (!createLockDirectory(directory, record)) {
      const nextGeneration = tryReclaim(profileKey, key, directory, staleMs);
      if (nextGeneration === null) return null;
      record = createLockRecord(profileKey, key, nextGeneration);
      if (!createLockDirectory(directory, record)) return null;
    }

    const assertOwned = (): LockRecordV1 => {
      const current = readLock(directory, profileKey, key);
      if (!current
        || current.nonce !== record.nonce
        || current.generation !== record.generation
        || current.pid !== record.pid
        || current.process_start_token !== record.process_start_token) {
        throw new Error('lock_ownership_lost');
      }
      return current;
    };

    return {
      key,
      generation: record.generation,
      nonce: record.nonce,
      phase: record.phase,
      updatePhase(phase) {
        const current = assertOwned();
        record = { ...current, phase, updated_at: new Date().toISOString() };
        atomicJson(ownerPath(directory), record);
        (this as { phase: 'pre_send' | 'possible_delivery' }).phase = phase;
      },
      release() {
        assertOwned();
        rmSync(directory, { recursive: true, force: false });
      },
    };
  } finally {
    if (admissionGate) {
      try { admissionGate.release(); } catch { /* fail-closed scheduling state remains on disk */ }
    }
  }
}

export function clearDomainLock(profileKey: string, key: string): boolean {
  const directory = lockDirectory(profileKey, key);
  if (!existsSync(directory)) return true;
  const record = readLock(directory, profileKey, key);
  if (!record || !ownerProvablyDead(record)) return false;
  try {
    rmSync(directory, { recursive: true, force: false });
    return true;
  } catch {
    return false;
  }
}

function likelyCaseInsensitive(path: string): boolean {
  return process.platform === 'win32' || /^\/mnt\/[a-z](?:\/|$)/i.test(path);
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return false;
    throw new Error('output_conflict:destination_unreadable');
  }
}

function assertDestinationVacant(finalPath: string): void {
  if (pathEntryExists(finalPath)) throw new Error('output_conflict:exists');
  const parent = dirname(finalPath);
  const name = basename(finalPath);
  if (likelyCaseInsensitive(parent)) {
    const collision = readdirSync(parent).some((entry) => entry.toLowerCase() === name.toLowerCase());
    if (collision) throw new Error('output_conflict:case_alias_exists');
  }
}

export function destinationIdentityForPath(outputPath: string): { finalPath: string; identity: string } {
  const absolute = resolve(outputPath);
  let parent: string;
  try {
    parent = realpathSync.native(dirname(absolute));
  } catch {
    throw new Error('output_conflict:parent_unavailable');
  }
  const name = basename(absolute);
  const finalPath = join(parent, name);
  const fold = likelyCaseInsensitive(parent);
  const identityPath = fold ? finalPath.toLowerCase() : finalPath;
  return { finalPath, identity: `output-${sha256(identityPath)}` };
}

export function destinationIdentity(outputPath: string): { finalPath: string; identity: string } {
  const result = destinationIdentityForPath(outputPath);
  assertDestinationVacant(result.finalPath);
  return result;
}

export function revalidateProcessDestinationReservations(): void {
  for (const finalPath of activeProcessDestinations.values()) assertDestinationVacant(finalPath);
}

export function reserveDestination(profileKey: string, outputPath: string): DestinationReservation {
  const { finalPath, identity } = destinationIdentity(outputPath);
  const lock = acquireDomainLock(profileKey, `destination:${identity}`);
  if (!lock) throw new Error('output_conflict:reserved');
  try {
    assertDestinationVacant(finalPath);
    activeProcessDestinations.set(identity, finalPath);
    return {
      identity,
      finalPath,
      lock,
      markPossibleDelivery() {
        lock.updatePhase('possible_delivery');
      },
      release() {
        lock.release();
        activeProcessDestinations.delete(identity);
      },
    };
  } catch (error) {
    activeProcessDestinations.delete(identity);
    try {
      lock.release();
    } catch {
      // The original error is the actionable result.
    }
    throw error;
  }
}
