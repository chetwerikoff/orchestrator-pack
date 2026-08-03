import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeterministicRuntimeAdapter } from './runtime/test-adapter.ts';
import {
  parseWorkerRecoveryArgs,
  runWorkerRecovery,
} from './invoke-worker-recovery.ts';

describe('TypeScript worker recovery entrypoint', () => {
  it('holds one claim across exact cleanup and spawn', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-recovery-cli-'));
    try {
      const adapter = new DeterministicRuntimeAdapter();
      const remove = vi.spyOn(adapter, 'removeWorkspace');
      const spawn = vi.spyOn(adapter, 'spawnWorker');
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
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(remove.mock.invocationCallOrder[0]).toBeLessThan(spawn.mock.invocationCallOrder[0] ?? 0);
      expect(spawn.mock.calls[0]?.[0].workspace).toBe('active');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when another live recovery claim exists', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-recovery-cli-'));
    try {
      const adapter = new DeterministicRuntimeAdapter();
      const options = parseWorkerRecoveryArgs([
        '--cleanup-workspace', join(root, 'stale-worktree'),
        '--claim-key', 'shared-claim',
        '--repo-root', root,
      ]);
      const namespace = join(root, 'claims');
      const first = await runWorkerRecovery({ options, adapter, claimNamespace: namespace });
      expect(first.outcome).toBe('spawn_started');

      // A terminalized first run permits a later independent recovery. The
      // duplicate protection is the active claim, not permanent compatibility state.
      const second = await runWorkerRecovery({ options, adapter, claimNamespace: namespace });
      expect(second.outcome).toBe('spawn_started');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('performs no runtime side effect in dry-run mode', async () => {
    const adapter = new DeterministicRuntimeAdapter();
    const spawn = vi.spyOn(adapter, 'spawnWorker');
    const options = parseWorkerRecoveryArgs([
      '--cleanup-workspace', '/tmp/stale-worktree',
      '--dry-run',
    ]);
    const result = await runWorkerRecovery({ options, adapter });
    expect(result.outcome).toBe('dry_run');
    expect(spawn).not.toHaveBeenCalled();
  });
});
