import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProcess, type ProcessResult } from '../kernel/subprocess.ts';
import {
  acquireSingleInstanceLease,
  readLiveSingleInstanceLease,
  releaseSingleInstanceLease,
} from './single-instance-lease.ts';

interface LeaseHolderProcess {
  readonly completion: Promise<ProcessResult>;
  readonly stop: () => void;
}

async function waitForLeaseMarker(path: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('lease contender timed out');
}

function startLeaseHolder(lockDir: string, releaseGate: string, markerPath: string): LeaseHolderProcess {
  const moduleUrl = new URL('./single-instance-lease.ts', import.meta.url).href;
  const source = `
    import { existsSync, writeFileSync } from 'node:fs';
    import { acquireSingleInstanceLease, releaseSingleInstanceLease } from ${JSON.stringify(moduleUrl)};
    try {
      const handle = acquireSingleInstanceLease({ lockDir: ${JSON.stringify(lockDir)} });
      writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({ acquired: true }), 'utf8');
      while (!existsSync(${JSON.stringify(releaseGate)})) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      releaseSingleInstanceLease(handle);
    } catch (error) {
      writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({
        acquired: false,
        reason: error instanceof Error ? error.message : String(error),
      }), 'utf8');
      process.exitCode = 1;
    }
  `;
  const controller = new AbortController();
  const completion = runProcess({
    command: process.execPath,
    args: ['--experimental-strip-types', '--input-type=module', '--eval', source],
    inheritParentEnv: true,
    signal: controller.signal,
    allowEmptyStdout: true,
  });
  return { completion, stop: () => controller.abort() };
}

async function probeLease(lockDir: string): Promise<{ acquired: boolean; reason?: string }> {
  const moduleUrl = new URL('./single-instance-lease.ts', import.meta.url).href;
  const source = `
    import { acquireSingleInstanceLease, releaseSingleInstanceLease } from ${JSON.stringify(moduleUrl)};
    try {
      const handle = acquireSingleInstanceLease({ lockDir: ${JSON.stringify(lockDir)} });
      process.stdout.write(JSON.stringify({ acquired: true }) + '\\n');
      releaseSingleInstanceLease(handle);
    } catch (error) {
      process.stdout.write(JSON.stringify({
        acquired: false,
        reason: error instanceof Error ? error.message : String(error),
      }) + '\\n');
    }
  `;
  const result = await runProcess({
    command: process.execPath,
    args: ['--experimental-strip-types', '--input-type=module', '--eval', source],
    inheritParentEnv: true,
  });
  if (!result.ok) throw new Error(`lease probe failed: ${result.error ?? result.stderr ?? result.outcome}`);
  return JSON.parse(result.stdout.trim()) as { acquired: boolean; reason?: string };
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
    const markerPath = join(root, 'holder.json');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, 'owner.json'), `${JSON.stringify({
      schemaVersion: 1,
      pid: 999_999_999,
      startTicks: 'dead',
      generation: 'stale',
      acquiredAt: new Date(0).toISOString(),
      metadata: {},
    })}\n`, 'utf8');
    const first = startLeaseHolder(lockDir, releaseGate, markerPath);
    try {
      expect(await waitForLeaseMarker(markerPath)).toEqual({ acquired: true });
      const competing = await probeLease(lockDir);
      expect(competing.acquired).toBe(false);
      expect(competing.reason).toMatch(/single_instance_busy/);
      writeFileSync(releaseGate, 'release', 'utf8');
      expect((await first.completion).ok).toBe(true);
    } finally {
      writeFileSync(releaseGate, 'release', 'utf8');
      first.stop();
      await first.completion;
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);
});
