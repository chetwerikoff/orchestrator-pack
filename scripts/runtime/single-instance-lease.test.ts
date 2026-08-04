import { spawn, type ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireSingleInstanceLease,
  readLiveSingleInstanceLease,
  releaseSingleInstanceLease,
} from './single-instance-lease.ts';

function firstJsonLine(child: ChildProcess): Promise<{ acquired: boolean; reason?: string }> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timeout = setTimeout(() => reject(new Error('lease contender timed out')), 5_000);
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

function spawnLeaseContender(lockDir: string, releaseGate: string): ChildProcess {
  const moduleUrl = new URL('./single-instance-lease.ts', import.meta.url).href;
  const source = `
    import { existsSync } from 'node:fs';
    import { acquireSingleInstanceLease, releaseSingleInstanceLease } from ${JSON.stringify(moduleUrl)};
    try {
      const handle = acquireSingleInstanceLease({ lockDir: ${JSON.stringify(lockDir)} });
      process.stdout.write(JSON.stringify({ acquired: true }) + '\\n');
      while (!existsSync(${JSON.stringify(releaseGate)})) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      releaseSingleInstanceLease(handle);
    } catch (error) {
      process.stdout.write(JSON.stringify({
        acquired: false,
        reason: error instanceof Error ? error.message : String(error),
      }) + '\\n');
    }
  `;
  return spawn(process.execPath, [
    '--experimental-strip-types',
    '--input-type=module',
    '--eval',
    source,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
}

describe('single-instance process-generation lease', () => {
  it('rejects a second live owner', () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-lease-'));
    try {
      const lockDir = join(root, 'supervisor.lock');
      const first = acquireSingleInstanceLease({ lockDir });
      expect(() => acquireSingleInstanceLease({ lockDir })).toThrow(/single_instance_busy/);
      expect(readLiveSingleInstanceLease(lockDir)?.generation).toBe(first.owner.generation);
      expect(releaseSingleInstanceLease(first)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not release a different generation', () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-lease-'));
    try {
      const lockDir = join(root, 'supervisor.lock');
      const first = acquireSingleInstanceLease({ lockDir });
      expect(releaseSingleInstanceLease({
        ...first,
        owner: { ...first.owner, generation: 'foreign-generation' },
      })).toBe(false);
      expect(readLiveSingleInstanceLease(lockDir)).not.toBeNull();
      expect(releaseSingleInstanceLease(first)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('serializes two processes reclaiming one stale lease', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-lease-race-'));
    const lockDir = join(root, 'supervisor.lock');
    const releaseGate = join(root, 'release');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, 'owner.json'), `${JSON.stringify({
      schemaVersion: 1,
      pid: 999_999_999,
      startTicks: 'dead',
      generation: 'stale',
      acquiredAt: new Date(0).toISOString(),
      metadata: {},
    })}\n`, 'utf8');
    const first = spawnLeaseContender(lockDir, releaseGate);
    let second: ChildProcess | null = null;
    try {
      expect(await firstJsonLine(first)).toEqual({ acquired: true });
      second = spawnLeaseContender(lockDir, releaseGate);
      const competing = await firstJsonLine(second);
      expect(competing.acquired).toBe(false);
      expect(competing.reason).toMatch(/single_instance_busy/);
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
