import { spawn, type ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireSideEffectFence,
  releaseSideEffectFence,
  withSideEffectFence,
} from './side-effect-fence.ts';

function firstJsonLine(child: ChildProcess): Promise<{ acquired: boolean; reason?: string }> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timeout = setTimeout(() => reject(new Error('fence contender timed out')), 5_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timeout);
      try {
        resolve(JSON.parse(buffer.slice(0, newline)) as { acquired: boolean; reason?: string });
      } catch (error) {
        reject(error);
      }
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function spawnFenceContender(path: string, releaseGate: string): ChildProcess {
  const moduleUrl = new URL('./side-effect-fence.ts', import.meta.url).href;
  const source = `
    import { existsSync } from 'node:fs';
    import { acquireSideEffectFence, releaseSideEffectFence } from ${JSON.stringify(moduleUrl)};
    const result = acquireSideEffectFence({ path: ${JSON.stringify(path)}, ownerlessMaxAgeMs: 0 });
    if (!result.acquired) {
      process.stdout.write(JSON.stringify({ acquired: false, reason: result.reason }) + '\\n');
    } else {
      process.stdout.write(JSON.stringify({ acquired: true }) + '\\n');
      while (!existsSync(${JSON.stringify(releaseGate)})) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      releaseSideEffectFence(result.handle);
    }
  `;
  return spawn(process.execPath, [
    '--experimental-strip-types',
    '--input-type=module',
    '--eval',
    source,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
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
    writeFileSync(path, `${JSON.stringify({
      schemaVersion: 1,
      pid: 999_999_999,
      nonce: 'stale',
      startedAtMs: 0,
      metadata: {},
    })}\n`, 'utf8');
    const first = spawnFenceContender(path, releaseGate);
    let second: ChildProcess | null = null;
    try {
      expect(await firstJsonLine(first)).toEqual({ acquired: true });
      second = spawnFenceContender(path, releaseGate);
      expect(await firstJsonLine(second)).toEqual({
        acquired: false,
        reason: 'side_effect_busy',
      });
      writeFileSync(releaseGate, 'release', 'utf8');
      await new Promise<void>((resolve, reject) => {
        first.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`first exit ${code}`)));
      });
    } finally {
      writeFileSync(releaseGate, 'release', 'utf8');
      first.kill('SIGKILL');
      second?.kill('SIGKILL');
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);
});
