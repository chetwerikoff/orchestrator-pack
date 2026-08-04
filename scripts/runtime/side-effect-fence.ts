import { randomUUID } from 'node:crypto';
import {
  fstatSync,
  mkdirSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { processAlive } from '../lib/cutover/activation-cordon.ts';
import {
  clearLockedFileContents,
  readLockedFileContents,
  releaseHeldFileLock,
  replaceLockedFileContents,
  tryAcquireHeldFileLock,
} from './single-instance-lease.ts';

export interface SideEffectFenceOwner {
  readonly schemaVersion: 1;
  readonly pid: number;
  readonly nonce: string;
  readonly startedAtMs: number;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface SideEffectFenceHandle {
  readonly path: string;
  readonly owner: SideEffectFenceOwner;
  readonly descriptor: number;
}

export type SideEffectFenceAcquireResult =
  | { readonly acquired: true; readonly handle: SideEffectFenceHandle }
  | { readonly acquired: false; readonly reason: 'side_effect_busy' | 'side_effect_fence_untrusted' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseOwnerRaw(raw: string): SideEffectFenceOwner | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)
      || parsed.schemaVersion !== 1
      || !Number.isInteger(parsed.pid)
      || typeof parsed.nonce !== 'string'
      || !parsed.nonce
      || !Number.isFinite(parsed.startedAtMs)
      || !isRecord(parsed.metadata)) return null;
    return {
      schemaVersion: 1,
      pid: Number(parsed.pid),
      nonce: parsed.nonce,
      startedAtMs: Number(parsed.startedAtMs),
      metadata: parsed.metadata,
    };
  } catch {
    return null;
  }
}

function existingFenceDisposition(input: {
  readonly descriptor: number;
  readonly ownerlessMaxAgeMs: number;
  readonly nowMs: number;
}): 'empty' | 'live' | 'stale' | 'untrusted' {
  const raw = readLockedFileContents(input.descriptor).trim();
  if (!raw) return 'empty';
  const owner = parseOwnerRaw(raw);
  if (owner) return processAlive(owner.pid) ? 'live' : 'stale';
  const ageMs = input.nowMs - fstatSync(input.descriptor).mtimeMs;
  return ageMs >= input.ownerlessMaxAgeMs ? 'stale' : 'untrusted';
}

/**
 * Reclaim only while holding the stable fence file's kernel lock. A concurrent
 * replacement cannot be unlinked because reclamation truncates the locked inode
 * instead of deleting a path selected by an earlier stat/read.
 */
export function reclaimStaleSideEffectFence(
  path: string,
  options: { readonly nowMs?: number; readonly ownerlessMaxAgeMs?: number } = {},
): boolean {
  const held = tryAcquireHeldFileLock(path);
  if (!held.acquired) return false;
  try {
    const disposition = existingFenceDisposition({
      descriptor: held.descriptor,
      nowMs: options.nowMs ?? Date.now(),
      ownerlessMaxAgeMs: options.ownerlessMaxAgeMs ?? 3 * 60 * 60 * 1_000,
    });
    if (disposition !== 'stale') return false;
    clearLockedFileContents(held.descriptor);
    return true;
  } finally {
    releaseHeldFileLock(held.descriptor);
  }
}

export function acquireSideEffectFence(input: {
  readonly path: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly ownerlessMaxAgeMs?: number;
}): SideEffectFenceAcquireResult {
  mkdirSync(dirname(input.path), { recursive: true });
  const held = tryAcquireHeldFileLock(input.path);
  if (!held.acquired) {
    return {
      acquired: false,
      reason: held.reason === 'busy' ? 'side_effect_busy' : 'side_effect_fence_untrusted',
    };
  }

  const disposition = existingFenceDisposition({
    descriptor: held.descriptor,
    nowMs: Date.now(),
    ownerlessMaxAgeMs: input.ownerlessMaxAgeMs ?? 3 * 60 * 60 * 1_000,
  });
  if (disposition === 'live') {
    releaseHeldFileLock(held.descriptor);
    return { acquired: false, reason: 'side_effect_busy' };
  }
  if (disposition === 'untrusted') {
    releaseHeldFileLock(held.descriptor);
    return { acquired: false, reason: 'side_effect_fence_untrusted' };
  }

  const owner: SideEffectFenceOwner = {
    schemaVersion: 1,
    pid: process.pid,
    nonce: randomUUID().replace(/-/g, ''),
    startedAtMs: Date.now(),
    metadata: input.metadata ?? {},
  };
  replaceLockedFileContents(held.descriptor, `${JSON.stringify(owner)}\n`);
  return {
    acquired: true,
    handle: { path: input.path, owner, descriptor: held.descriptor },
  };
}

export function releaseSideEffectFence(handle: SideEffectFenceHandle): boolean {
  let owner: SideEffectFenceOwner | null = null;
  try {
    owner = parseOwnerRaw(readLockedFileContents(handle.descriptor).trim());
    if (!owner || owner.nonce !== handle.owner.nonce || owner.pid !== handle.owner.pid) {
      return false;
    }
    clearLockedFileContents(handle.descriptor);
    return true;
  } finally {
    releaseHeldFileLock(handle.descriptor);
  }
}

export async function withSideEffectFence<T>(input: {
  readonly path: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly action: () => Promise<T> | T;
}): Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string }> {
  const acquired = acquireSideEffectFence(input);
  if (!acquired.acquired) return { ok: false, reason: acquired.reason };
  try {
    return { ok: true, value: await input.action() };
  } finally {
    releaseSideEffectFence(acquired.handle);
  }
}
