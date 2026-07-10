/**
 * Exclusive lock helper for JSON state files (compare-and-swap writers).
 */
import { closeSync, existsSync, mkdirSync, openSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const DEFAULT_LOCK_WAIT_MS = 5_000;
const DEFAULT_LOCK_STALE_MS = 30_000;

function sleepMs(ms) {
  if (ms <= 0) {
    return;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function stateFileLockPath(stateFilePath) {
  return `${stateFilePath}.lock`;
}

/**
 * @param {string} stateFilePath
 * @param {{ maxWaitMs?: number, staleMs?: number }} [options]
 */
export function acquireJsonStateFileLock(stateFilePath, options = {}) {
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_LOCK_WAIT_MS;
  const staleMs = options.staleMs ?? DEFAULT_LOCK_STALE_MS;
  const lockPath = stateFileLockPath(stateFilePath);
  mkdirSync(dirname(stateFilePath), { recursive: true });
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    try {
      const fd = openSync(lockPath, 'wx');
      try {
        writeFileSync(fd, `${process.pid}\n`, 'utf8');
      } catch (writeErr) {
        closeSync(fd);
        throw writeErr;
      }
      return { fd, lockPath };
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined;
      if (code !== 'EEXIST') {
        throw err;
      }
      try {
        if (existsSync(lockPath) && Date.now() - statSync(lockPath).mtimeMs > staleMs) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        // lock removed by peer — retry
      }
      sleepMs(5);
    }
  }
  return null;
}

/** @param {{ fd: number, lockPath: string } | null} lock */
export function releaseJsonStateFileLock(lock) {
  if (!lock) {
    return;
  }
  try {
    closeSync(lock.fd);
  } catch {
    // ignore
  }
  try {
    unlinkSync(lock.lockPath);
  } catch {
    // ignore
  }
}

/**
 * @template T
 * @param {string} stateFilePath
 * @param {() => T} fn
 * @param {{ maxWaitMs?: number, staleMs?: number }} [options]
 * @returns {T | { ok: false, reason: 'state_file_lock_timeout' }}
 */
export function withJsonStateFileLock(stateFilePath, fn, options = {}) {
  const lock = acquireJsonStateFileLock(stateFilePath, options);
  if (!lock) {
    return { ok: false, reason: 'state_file_lock_timeout' };
  }
  try {
    return fn();
  } finally {
    releaseJsonStateFileLock(lock);
  }
}
