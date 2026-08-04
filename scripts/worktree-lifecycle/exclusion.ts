import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';

export const DEFAULT_WORKTREE_LIFECYCLE_EXCLUSION_PATH = resolve(
  '/tmp',
  'opk-worktree-teardown.lock',
);

export interface LifecycleExclusionHandle {
  readonly fd: number | null;
  readonly token: string;
  readonly ownsFile: boolean;
}

interface LockRecord {
  readonly pid: number;
  readonly starttime: string | null;
  readonly token: string | null;
}

function processStarttime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
  } catch {
    return null;
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function decodeLock(raw: string): LockRecord | null {
  const [pidText, starttimeText, tokenText] = raw.trim().split(/\r?\n/);
  const pid = Number.parseInt(pidText ?? '', 10);
  if (!Number.isInteger(pid) || pid <= 1) return null;
  return {
    pid,
    starttime: starttimeText?.trim() || null,
    token: tokenText?.trim() || null,
  };
}

function lockOwnerAlive(record: LockRecord): boolean {
  if (!processExists(record.pid)) return false;
  const observed = processStarttime(record.pid);
  return !record.starttime || observed === null || observed === record.starttime;
}

function readLock(path: string): { raw: string; record: LockRecord } | null {
  try {
    const raw = readFileSync(path, 'utf8');
    const record = decodeLock(raw);
    return record ? { raw, record } : null;
  } catch {
    return null;
  }
}

export function acquireLifecycleExclusion(path = DEFAULT_WORKTREE_LIFECYCLE_EXCLUSION_PATH): LifecycleExclusionHandle | null {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      const token = randomUUID();
      writeFileSync(fd, `${String(process.pid)}\n${processStarttime(process.pid) ?? ''}\n${token}\n`, 'utf8');
      fsyncSync(fd);
      return { fd, token, ownsFile: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return null;
      const observed = readLock(path);
      if (!observed || lockOwnerAlive(observed.record)) return null;
      try {
        if (readFileSync(path, 'utf8') !== observed.raw) return null;
        unlinkSync(path);
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function borrowLifecycleExclusion(
  path: string,
  token: string,
): LifecycleExclusionHandle | null {
  if (!token.trim()) return null;
  const observed = readLock(path);
  if (!observed || observed.record.token !== token || !lockOwnerAlive(observed.record)) return null;
  return { fd: null, token, ownsFile: false };
}

export function releaseLifecycleExclusion(
  path: string,
  handle: LifecycleExclusionHandle,
): void {
  if (handle.fd !== null) {
    try {
      closeSync(handle.fd);
    } catch {
      // Token ownership still guards unlink below.
    }
  }
  if (!handle.ownsFile) return;
  try {
    if (readLock(path)?.record.token === handle.token) unlinkSync(path);
  } catch {
    // Missing-at-release or changed ownership is fail-closed and harmless.
  }
}
