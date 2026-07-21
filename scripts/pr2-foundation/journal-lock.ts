import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface JournalLockOwner {
  schemaVersion: 1;
  pid: number;
  nonce: string;
  acquiredAtMs: number;
}

const DEFAULT_STALE_MS = 120_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function lockStaleMs(): number {
  const raw = Number(process.env.AO_WORKER_NOTIFICATION_JOURNAL_LOCK_STALE_MS ?? DEFAULT_STALE_MS);
  return Number.isInteger(raw) && raw >= 1_000 ? raw : DEFAULT_STALE_MS;
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

function parseOwner(raw: string): JournalLockOwner | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)
      || parsed.schemaVersion !== 1
      || !Number.isInteger(parsed.pid)
      || typeof parsed.nonce !== 'string'
      || !parsed.nonce
      || !Number.isFinite(parsed.acquiredAtMs)) {
      return null;
    }
    return {
      schemaVersion: 1,
      pid: Number(parsed.pid),
      nonce: parsed.nonce,
      acquiredAtMs: Number(parsed.acquiredAtMs),
    };
  } catch {
    return null;
  }
}

function readLockRaw(lockPath: string): string | null {
  try {
    return readFileSync(lockPath, 'utf8');
  } catch {
    return null;
  }
}

function ownerIsStale(owner: JournalLockOwner | null, mtimeMs: number, nowMs: number): boolean {
  const ageAnchor = owner?.acquiredAtMs ?? mtimeMs;
  if (nowMs - ageAnchor >= lockStaleMs()) return true;
  return owner !== null && !processAlive(owner.pid);
}

/**
 * Reclaim only when the same inode/content remains stale across a second read.
 * A live owner is never removed, and a concurrent replacement loses the race
 * without being unlinked.
 */
export function reclaimStaleJournalLock(lockPath: string, nowMs = Date.now()): boolean {
  if (!existsSync(lockPath)) return false;
  let beforeStat;
  let beforeRaw: string | null;
  try {
    beforeStat = statSync(lockPath);
    beforeRaw = readLockRaw(lockPath);
  } catch {
    return false;
  }
  if (beforeRaw === null || !ownerIsStale(parseOwner(beforeRaw), beforeStat.mtimeMs, nowMs)) {
    return false;
  }
  try {
    const afterStat = statSync(lockPath);
    const afterRaw = readLockRaw(lockPath);
    if (afterRaw === null
      || afterStat.dev !== beforeStat.dev
      || afterStat.ino !== beforeStat.ino
      || afterRaw !== beforeRaw) {
      return false;
    }
    unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function stillOwnedBy(lockPath: string, nonce: string): boolean {
  const raw = readLockRaw(lockPath);
  return raw !== null && parseOwner(raw)?.nonce === nonce;
}

export async function withCrashRecoverableFileLock<T>(
  lockPath: string,
  maxAttempts: number,
  action: () => T | Promise<T>,
): Promise<T> {
  mkdirSync(dirname(lockPath), { recursive: true });
  const attempts = Math.max(1, maxAttempts);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let descriptor: number | null = null;
    const owner: JournalLockOwner = {
      schemaVersion: 1,
      pid: process.pid,
      nonce: randomUUID().replace(/-/g, ''),
      acquiredAtMs: Date.now(),
    };
    try {
      descriptor = openSync(lockPath, 'wx', 0o600);
      writeFileSync(descriptor, `${JSON.stringify(owner)}\n`, 'utf8');
      fsyncSync(descriptor);
      return await action();
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code ?? '')
        : '';
      if (code !== 'EEXIST') throw error;
      if (reclaimStaleJournalLock(lockPath)) continue;
      if (attempt === attempts) throw new Error('journal_busy');
      await delay(200 * attempt);
    } finally {
      if (descriptor !== null) {
        closeSync(descriptor);
        if (stillOwnedBy(lockPath, owner.nonce)) {
          try {
            unlinkSync(lockPath);
          } catch {
            // The lock was already removed after ownership verification.
          }
        }
      }
    }
  }
  throw new Error('journal_busy');
}

export function withJournalLock<T>(
  journalPath: string,
  maxAttempts: number,
  action: () => T | Promise<T>,
): Promise<T> {
  return withCrashRecoverableFileLock(`${journalPath}.lock`, maxAttempts, action);
}
