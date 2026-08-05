import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProcess } from './kernel/subprocess.ts';
import { DeterministicRuntimeAdapter } from './runtime/test-adapter.ts';
import {
  parseWorkerRecoveryArgs,
  runWorkerRecovery,
} from './invoke-worker-recovery.ts';
import {
  acquireWorkerRecoveryClaim,
  finalizeWorkerRecoveryClaim,
  releaseWorkerRecoveryClaim,
} from './runtime/worker-recovery-claim.ts';

async function probeRecoveryClaim(namespace: string, workspacePath: string): Promise<Record<string, unknown>> {
  const moduleUrl = new URL('./runtime/worker-recovery-claim.ts', import.meta.url).href;
  const source = `
    import { acquireWorkerRecoveryClaim, releaseWorkerRecoveryClaim } from ${JSON.stringify(moduleUrl)};
    const result = acquireWorkerRecoveryClaim({
      namespace: ${JSON.stringify(namespace)},
      claimKey: 'shared-claim',
      workspacePath: ${JSON.stringify(workspacePath)},
      staleMs: 120000,
    });
    process.stdout.write(JSON.stringify(result.acquired
      ? { acquired: true }
      : { acquired: false, reason: result.reason }) + '\\n');
    if (result.acquired) releaseWorkerRecoveryClaim(result.handle);
  `;
  const result = await runProcess({
    command: process.execPath,
    args: ['--experimental-strip-types', '--input-type=module', '--eval', source],
    inheritParentEnv: true,
  });
  if (!result.ok) throw new Error(`claim contender failed: ${result.error ?? result.stderr ?? result.outcome}`);
  return JSON.parse(result.stdout.trim()) as Record<string, unknown>;
}

describe('TypeScript worker recovery entrypoint', () => {
  it('holds one claim across exact cleanup and spawn', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-recovery-cli-'));
    try {
      const adapter = new DeterministicRuntimeAdapter();
      const remove = vi.spyOn(adapter, 'removeWorkspace');
      const spawnWorker = vi.spyOn(adapter, 'spawnWorker');
      const options = parseWorkerRecoveryArgs([
        '--cleanup-workspace', join(root, 'stale-worktree'),
        '--expected-head-sha', 'test-head',
        '--spawn-workspace', 'active',
        '--claim-key', 'issue-1248-worker',
        '--repo-root', root,
      ]);
      const result = await runWorkerRecovery({
        options,
        adapter,
        claimNamespace: join(root, 'claims'),
      });

      expect(result.outcome).toBe('spawn_started');
      expect(result.claimFinalized).toBe(true);
      expect(remove).toHaveBeenCalledTimes(1);
      expect(spawnWorker).toHaveBeenCalledTimes(1);
      expect(remove.mock.invocationCallOrder[0]).toBeLessThan(spawnWorker.mock.invocationCallOrder[0] ?? 0);
      expect(spawnWorker.mock.calls[0]?.[0].workspace).toBe('active');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed while another live recovery claim exists', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-recovery-cli-'));
    try {
      const adapter = new DeterministicRuntimeAdapter();
      const cleanupWorkspace = join(root, 'stale-worktree');
      const options = parseWorkerRecoveryArgs([
        '--cleanup-workspace', cleanupWorkspace,
        '--expected-head-sha', 'test-head',
        '--claim-key', 'shared-claim',
        '--repo-root', root,
      ]);
      const namespace = join(root, 'claims');
      const held = acquireWorkerRecoveryClaim({
        namespace,
        claimKey: options.claimKey,
        workspacePath: cleanupWorkspace,
        surface: 'test-holder',
      });
      expect(held.acquired).toBe(true);
      if (!held.acquired) return;
      try {
        const result = await runWorkerRecovery({ options, adapter, claimNamespace: namespace });
        expect(result).toMatchObject({ outcome: 'spawn_denied', reason: 'claim_held' });
      } finally {
        releaseWorkerRecoveryClaim(held.handle);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects missing and option-looking cleanup values before resolution', () => {
    expect(() => parseWorkerRecoveryArgs(['--cleanup-workspace'])).toThrow(
      '--cleanup-workspace requires a non-empty value',
    );
    expect(() => parseWorkerRecoveryArgs([
      '--cleanup-workspace',
      '--expected-head-sha',
      'test-head',
    ])).toThrow('--cleanup-workspace requires a non-empty value');
  });

  it('requires expected head and exact generation bindings', () => {
    expect(() => parseWorkerRecoveryArgs([
      '--cleanup-workspace', '/tmp/stale-worktree',
    ])).toThrow('--expected-head-sha is required');
    expect(() => parseWorkerRecoveryArgs([
      '--cleanup-workspace', '/tmp/stale-worktree',
      '--expected-head-sha', 'test-head',
      '--worker-id', 'worker-1',
    ])).toThrow('--worker-generation is required with --worker-id');
  });

  it('rejects cleanup and spawn selector equality during parsing', () => {
    expect(() => parseWorkerRecoveryArgs([
      '--cleanup-workspace', '/tmp/stale-worktree',
      '--expected-head-sha', 'test-head',
      '--spawn-workspace', '/tmp/stale-worktree',
    ])).toThrow('--spawn-workspace must differ from --cleanup-workspace');
  });

  it('performs no runtime side effect in dry-run mode', async () => {
    const adapter = new DeterministicRuntimeAdapter();
    const spawnWorker = vi.spyOn(adapter, 'spawnWorker');
    const remove = vi.spyOn(adapter, 'removeWorkspace');
    const options = parseWorkerRecoveryArgs([
      '--cleanup-workspace', '/tmp/stale-worktree',
      '--expected-head-sha', 'test-head',
      '--dry-run',
    ]);
    const result = await runWorkerRecovery({ options, adapter });
    expect(result.outcome).toBe('dry_run');
    expect(spawnWorker).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('serializes stale reclaim against concurrent finalize and replacement', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-recovery-claim-race-'));
    const namespace = join(root, 'claims');
    const workspacePath = join(root, 'stale-worktree');
    const activePath = join(namespace, 'active', 'shared-claim.json');
    mkdirSync(join(namespace, 'active'), { recursive: true });
    writeFileSync(activePath, `${JSON.stringify({
      schemaVersion: 1,
      claimKey: 'shared-claim',
      workspacePath,
      workerId: 'stale-worker',
      workerGeneration: 'stale-generation',
      holder: {
        pid: 999_999_999,
        startTicks: 'dead',
        processGuid: 'stale-guid',
        host: 'stale-host',
        surface: 'stale',
      },
      acquiredAtMs: 0,
    })}\n`, 'utf8');

    try {
      const reclaimed = acquireWorkerRecoveryClaim({
        namespace,
        claimKey: 'shared-claim',
        workspacePath,
        staleMs: 120_000,
      });
      expect(reclaimed.acquired).toBe(true);
      if (!reclaimed.acquired) return;

      expect(await probeRecoveryClaim(namespace, workspacePath)).toEqual({
        acquired: false,
        reason: 'claim_held',
      });
      expect(finalizeWorkerRecoveryClaim(reclaimed.handle, 'complete')).toBe(true);
      expect(releaseWorkerRecoveryClaim(reclaimed.handle)).toBe(true);

      const replacement = acquireWorkerRecoveryClaim({
        namespace,
        claimKey: 'shared-claim',
        workspacePath,
      });
      expect(replacement.acquired).toBe(true);
      if (replacement.acquired) releaseWorkerRecoveryClaim(replacement.handle);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);
});
