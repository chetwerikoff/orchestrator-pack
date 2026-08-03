import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

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
}

export type SideEffectFenceAcquireResult =
  | { readonly acquired: true; readonly handle: SideEffectFenceHandle }
  | { readonly acquired: false; readonly reason: 'side_effect_busy' | 'side_effect_fence_untrusted' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function parseOwner(path: string): SideEffectFenceOwner | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
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

function sameFile(path: string, before: ReturnType<typeof statSync>): boolean {
  try {
    const after = statSync(path);
    return before.dev === after.dev && before.ino === after.ino;
  } catch {
    return false;
  }
}

/**
 * Reclaim only an observed-dead owner, or an ownerless/malformed record whose
 * file age exceeds the explicit fallback bound. The same inode must still be
 * present at deletion time, so a concurrent replacement is never removed.
 */
export function reclaimStaleSideEffectFence(
  path: string,
  options: { readonly nowMs?: number; readonly ownerlessMaxAgeMs?: number } = {},
): boolean {
  if (!existsSync(path)) return false;
  const before = (() => {
    try {
      return statSync(path);
    } catch {
      return null;
    }
  })();
  if (!before) return false;

  const owner = parseOwner(path);
  const nowMs = options.nowMs ?? Date.now();
  const ownerlessMaxAgeMs = options.ownerlessMaxAgeMs ?? 3 * 60 * 60 * 1_000;
  const stale = owner
    ? !processAlive(owner.pid)
    : nowMs - before.mtimeMs >= ownerlessMaxAgeMs;
  if (!stale || !sameFile(path, before)) return false;
  try {
    rmSync(path, { force: false });
    return true;
  } catch {
    return false;
  }
}

export function acquireSideEffectFence(input: {
  readonly path: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly ownerlessMaxAgeMs?: number;
}): SideEffectFenceAcquireResult {
  mkdirSync(dirname(input.path), { recursive: true });
  const owner: SideEffectFenceOwner = {
    schemaVersion: 1,
    pid: process.pid,
    nonce: randomUUID().replace(/-/g, ''),
    startedAtMs: Date.now(),
    metadata: input.metadata ?? {},
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let descriptor: number | null = null;
    try {
      descriptor = openSync(input.path, 'wx', 0o600);
      writeFileSync(descriptor, `${JSON.stringify(owner)}\n`, 'utf8');
      return { acquired: true, handle: { path: input.path, owner } };
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error
        ? String((error as NodeJS.ErrnoException).code ?? '')
        : '';
      if (code !== 'EEXIST') return { acquired: false, reason: 'side_effect_fence_untrusted' };
      if (attempt === 0 && reclaimStaleSideEffectFence(input.path, {
        ownerlessMaxAgeMs: input.ownerlessMaxAgeMs,
      })) continue;
      return { acquired: false, reason: parseOwner(input.path) ? 'side_effect_busy' : 'side_effect_fence_untrusted' };
    } finally {
      if (descriptor !== null) closeSync(descriptor);
    }
  }
  return { acquired: false, reason: 'side_effect_busy' };
}

export function releaseSideEffectFence(handle: SideEffectFenceHandle): boolean {
  const owner = parseOwner(handle.path);
  if (!owner || owner.nonce !== handle.owner.nonce || owner.pid !== handle.owner.pid) return false;
  const tombstone = `${handle.path}.${handle.owner.nonce}.release`;
  try {
    renameSync(handle.path, tombstone);
    rmSync(tombstone, { force: true });
    return true;
  } catch {
    return false;
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
