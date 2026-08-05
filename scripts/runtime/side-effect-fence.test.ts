import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProcess, type ProcessResult } from '../kernel/subprocess.ts';
import {
  acquireSideEffectFence,
  releaseSideEffectFence,
  withSideEffectFence,
} from './side-effect-fence.ts';

interface FenceOwnerProcess {
  readonly result: Promise<ProcessResult>;
  readonly cancel: () => void;
}

async function readFenceOwnerMarker(path: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('fence contender timed out');
}

function launchFenceOwner(path: string, releaseGate: string, markerPath: string): FenceOwnerProcess {
  const moduleUrl = new URL('./side-effect-fence.ts', import.meta.url).href;
  const source = `
    import { existsSync, writeFileSync } from 'node:fs';
    import { acquireSideEffectFence, releaseSideEffectFence } from ${JSON.stringify(moduleUrl)};
    const acquired = acquireSideEffectFence({ path: ${JSON.stringify(path)}, ownerlessMaxAgeMs: 0 });
    if (!acquired.acquired) {
      writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({ acquired: false, reason: acquired.reason }), 'utf8');
      process.exitCode = 1;
    } else {
      writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({ acquired: true }), 'utf8');
      while (!existsSync(${JSON.stringify(releaseGate)})) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      releaseSideEffectFence(acquired.handle);
    }
  `;
  const controller = new AbortController();
  const result = runProcess({
    command: process.execPath,
    args: ['--experimental-strip-types', '--input-type=module', '--eval', source],
    inheritParentEnv: true,
    signal: controller.signal,
    allowEmptyStdout: true,
  });
  return { result, cancel: () => controller.abort() };
}

async function attemptFence(path: string): Promise<{ acquired: boolean; reason?: string }> {
  const moduleUrl = new URL('./side-effect-fence.ts', import.meta.url).href;
  const source = `
    import { acquireSideEffectFence, releaseSideEffectFence } from ${JSON.stringify(moduleUrl)};
    const acquired = acquireSideEffectFence({ path: ${JSON.stringify(path)}, ownerlessMaxAgeMs: 0 });
    process.stdout.write(JSON.stringify(acquired.acquired
      ? { acquired: true }
      : { acquired: false, reason: acquired.reason }) + '\\n');
    if (acquired.acquired) releaseSideEffectFence(acquired.handle);
  `;
  const result = await runProcess({
    command: process.execPath,
    args: ['--experimental-strip-types', '--input-type=module', '--eval', source],
    inheritParentEnv: true,
  });
  if (!result.ok) throw new Error(`fence probe failed: ${result.error ?? result.stderr ?? result.outcome}`);
  return JSON.parse(result.stdout.trim()) as { acquired: boolean; reason?: string };
}

describe('TypeScript side-effect fence', () => {
  it('admits one owner and rejects a competing owner', () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-fence-'));
    try {
      const path = join(root, 'effect.lock');
      const first = acquireSideEffectFence({ path, metadata: { operation: 'review-start' } });
      expect(first.acquired).toBe(true);
      const second = acquireSideEffectFence({ path });
      expect(second).toEqual({ acquired: false, reason: 'side_effect_busy' });
      if (first.acquired) expect(releaseSideEffectFence(first.handle)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('never clears a replaced owner record on release', () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-fence-'));
    try {
      const path = join(root, 'effect.lock');
      const acquired = acquireSideEffectFence({ path });
      expect(acquired.acquired).toBe(true);
      if (!acquired.acquired) return;
      writeFileSync(path, JSON.stringify({
        schemaVersion: 1,
        pid: process.pid,
        startTicks: acquired.handle.owner.startTicks,
        nonce: 'replacement',
        startedAtMs: Date.now(),
        metadata: {},
      }), 'utf8');
      expect(releaseSideEffectFence(acquired.handle)).toBe(false);
      expect(readFileSync(path, 'utf8')).toContain('replacement');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reclaims a same-PID record from a different process generation', () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-fence-pid-reuse-'));
    try {
      const path = join(root, 'effect.lock');
      writeFileSync(path, `${JSON.stringify({
        schemaVersion: 1,
        pid: process.pid,
        startTicks: 'different-process-generation',
        nonce: 'stale-pid-reuse',
        startedAtMs: 0,
        metadata: {},
      })}\n`, 'utf8');
      const acquired = acquireSideEffectFence({ path, ownerlessMaxAgeMs: 0 });
      expect(acquired.acquired).toBe(true);
      if (acquired.acquired) expect(releaseSideEffectFence(acquired.handle)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('releases after a fenced action', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-fence-'));
    try {
      const path = join(root, 'effect.lock');
      const result = await withSideEffectFence({ path, action: () => 42 });
      expect(result).toEqual({ ok: true, value: 42 });
      const next = acquireSideEffectFence({ path });
      expect(next.acquired).toBe(true);
      if (next.acquired) releaseSideEffectFence(next.handle);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('serializes a concurrent stale reclaim and replacement', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-fence-race-'));
    const path = join(root, 'effect.lock');
    const releaseGate = join(root, 'release');
    const markerPath = join(root, 'owner.json');
    writeFileSync(path, `${JSON.stringify({
      schemaVersion: 1,
      pid: 999_999_999,
      startTicks: 'dead',
      nonce: 'stale',
      startedAtMs: 0,
      metadata: {},
    })}\n`, 'utf8');
    const first = launchFenceOwner(path, releaseGate, markerPath);
    try {
      expect(await readFenceOwnerMarker(markerPath)).toEqual({ acquired: true });
      expect(await attemptFence(path)).toEqual({
        acquired: false,
        reason: 'side_effect_busy',
      });
      writeFileSync(releaseGate, 'release', 'utf8');
      expect((await first.result).ok).toBe(true);
    } finally {
      writeFileSync(releaseGate, 'release', 'utf8');
      first.cancel();
      await first.result;
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);
});
