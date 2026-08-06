import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProcess } from './kernel/subprocess.ts';
import { DeterministicRuntimeAdapter } from './runtime/test-adapter.ts';
import {
  loadWorkerRecoveryCleanupAuthority,
  main,
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
  it('holds one claim across exact authorized cleanup and spawn', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-recovery-cli-'));
    try {
      const adapter = new DeterministicRuntimeAdapter();
      const cleanupWorkspace = join(root, 'stale-worktree');
      const owned = adapter.spawnWorker({
        title: 'stale-worker',
        command: 'cursor-agent',
        workspace: cleanupWorkspace,
      });
      expect(owned.status).toBe('ok');
      if (owned.status !== 'ok') return;
      const ownedIdentity = owned.value.identity;
      expect(adapter.stopWorker(ownedIdentity).status).toBe('ok');

      const remove = vi.spyOn(adapter, 'removeWorkspace');
      const spawnWorker = vi.spyOn(adapter, 'spawnWorker');
      const options = parseWorkerRecoveryArgs([
        '--worker-id', ownedIdentity.id,
        '--worker-generation', ownedIdentity.generation,
        '--cleanup-workspace', cleanupWorkspace,
        '--expected-head-sha', 'test-head',
        '--spawn-workspace', 'active',
        '--claim-key', 'issue-1248-worker',
        '--repo-root', root,
      ]);
      const result = await runWorkerRecovery({
        options,
        adapter,
        claimNamespace: join(root, 'claims'),
        cleanupAuthority: {
          source: 'pack-reservation',
          worker: ownedIdentity,
          workspacePath: cleanupWorkspace,
          expectedHeadSha: 'test-head',
        },
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

  it('loads durable runtimeHandle authority in the public main path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-recovery-main-'));
    const previousStateBase = process.env.OPK_BASE_DIR;
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const adapter = new DeterministicRuntimeAdapter();
      const cleanupWorkspace = join(root, 'stale-worktree');
      const owned = adapter.spawnWorker({
        title: 'stale-worker',
        command: 'cursor-agent',
        workspace: cleanupWorkspace,
      });
      expect(owned.status).toBe('ok');
      if (owned.status !== 'ok') return;
      expect(adapter.stopWorker(owned.value.identity).status).toBe('ok');
      process.env.OPK_BASE_DIR = join(root, 'ao');
      const sessionDir = join(process.env.OPK_BASE_DIR, 'projects', 'orchestrator-pack', 'sessions');
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(join(sessionDir, `${owned.value.identity.id}.json`), `${JSON.stringify({
        runtimeHandle: {
          runtime: owned.value.identity.runtime,
          id: owned.value.identity.id,
          generation: owned.value.identity.generation,
          data: {
            workspacePath: cleanupWorkspace,
            headSha: 'test-head',
          },
        },
      })}\n`, 'utf8');
      const remove = vi.spyOn(adapter, 'removeWorkspace');
      const spawnWorker = vi.spyOn(adapter, 'spawnWorker');

      const code = await main([
        '--worker-id', owned.value.identity.id,
        '--worker-generation', owned.value.identity.generation,
        '--cleanup-workspace', cleanupWorkspace,
        '--expected-head-sha', 'test-head',
        '--claim-key', 'public-main-authority',
        '--repo-root', root,
      ], {
        adapter,
        claimNamespace: join(root, 'claims'),
      });

      expect(code).toBe(0);
      expect(remove).toHaveBeenCalledTimes(1);
      expect(spawnWorker).toHaveBeenCalledTimes(1);
      expect(stdout).toHaveBeenCalledWith(expect.stringContaining('"outcome":"spawn_started"'));
    } finally {
      if (previousStateBase === undefined) delete process.env.OPK_BASE_DIR;
      else process.env.OPK_BASE_DIR = previousStateBase;
      stdout.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a durable runtimeHandle generation mismatch', () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-recovery-authority-'));
    const previousStateBase = process.env.OPK_BASE_DIR;
    try {
      process.env.OPK_BASE_DIR = join(root, 'ao');
      const sessionDir = join(process.env.OPK_BASE_DIR, 'projects', 'orchestrator-pack', 'sessions');
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(join(sessionDir, 'worker-1.json'), `${JSON.stringify({
        runtimeHandle: {
          runtime: 'test',
          id: 'worker-1',
          generation: 'old-generation',
          data: { workspacePath: '/tmp/stale-worktree', headSha: 'test-head' },
        },
      })}\n`, 'utf8');
      const options = parseWorkerRecoveryArgs([
        '--worker-id', 'worker-1',
        '--worker-generation', 'new-generation',
        '--cleanup-workspace', '/tmp/stale-worktree',
        '--expected-head-sha', 'test-head',
      ]);
      expect(loadWorkerRecoveryCleanupAuthority(options)).toEqual({
        ok: false,
        reason: 'cleanup_ownership_authority_mismatch',
      });
    } finally {
      if (previousStateBase === undefined) delete process.env.OPK_BASE_DIR;
      else process.env.OPK_BASE_DIR = previousStateBase;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed before claim, cleanup, or spawn without durable ownership authority', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-recovery-cli-'));
    try {
      const adapter = new DeterministicRuntimeAdapter();
      const cleanupWorkspace = join(root, 'stale-worktree');
      const owned = adapter.spawnWorker({
        title: 'stale-worker',
        command: 'cursor-agent',
        workspace: cleanupWorkspace,
      });
      expect(owned.status).toBe('ok');
      if (owned.status !== 'ok') return;
      adapter.setLiveness(owned.value.identity, 'gone');
      const remove = vi.spyOn(adapter, 'removeWorkspace');
      const spawnWorker = vi.spyOn(adapter, 'spawnWorker');
      const options = parseWorkerRecoveryArgs([
        '--worker-id', owned.value.identity.id,
        '--worker-generation', owned.value.identity.generation,
        '--cleanup-workspace', cleanupWorkspace,
        '--expected-head-sha', 'test-head',
        '--repo-root', root,
      ]);

      const result = await runWorkerRecovery({
        options,
        adapter,
        claimNamespace: join(root, 'claims'),
      });

      expect(result).toMatchObject({
        outcome: 'skipped_ambiguous',
        reason: 'cleanup_ownership_authority_missing',
      });
      expect(remove).not.toHaveBeenCalled();
      expect(spawnWorker).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed while another live recovery claim exists', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-recovery-cli-'));
    try {
      const adapter = new DeterministicRuntimeAdapter();
      const cleanupWorkspace = join(root, 'stale-worktree');
      const owned = adapter.spawnWorker({
        title: 'stale-worker',
        command: 'cursor-agent',
        workspace: cleanupWorkspace,
      });
      expect(owned.status).toBe('ok');
      if (owned.status !== 'ok') return;
      adapter.setLiveness(owned.value.identity, 'gone');
      const options = parseWorkerRecoveryArgs([
        '--worker-id', owned.value.identity.id,
        '--worker-generation', owned.value.identity.generation,
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
        workerId: owned.value.identity.id,
        workerGeneration: owned.value.identity.generation,
        surface: 'test-holder',
      });
      expect(held.acquired).toBe(true);
      if (!held.acquired) return;
      try {
        const result = await runWorkerRecovery({
          options,
          adapter,
          claimNamespace: namespace,
          cleanupAuthority: {
            source: 'pack-reservation',
            worker: owned.value.identity,
            workspacePath: cleanupWorkspace,
            expectedHeadSha: 'test-head',
          },
        });
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

  it('requires expected head and complete exact worker identity bindings', () => {
    expect(() => parseWorkerRecoveryArgs([
      '--cleanup-workspace', '/tmp/stale-worktree',
    ])).toThrow('--expected-head-sha is required');
    expect(() => parseWorkerRecoveryArgs([
      '--cleanup-workspace', '/tmp/stale-worktree',
      '--expected-head-sha', 'test-head',
    ])).toThrow('--worker-id is required for destructive recovery');
    expect(() => parseWorkerRecoveryArgs([
      '--cleanup-workspace', '/tmp/stale-worktree',
      '--expected-head-sha', 'test-head',
      '--worker-id', 'worker-1',
    ])).toThrow('--worker-generation is required for destructive recovery');
    expect(() => parseWorkerRecoveryArgs([
      '--cleanup-workspace', '/tmp/stale-worktree',
      '--expected-head-sha', 'test-head',
      '--worker-generation', 'generation-1',
    ])).toThrow('--worker-id is required for destructive recovery');
  });

  it('rejects cleanup and spawn selector equality during parsing', () => {
    expect(() => parseWorkerRecoveryArgs([
      '--worker-id', 'worker-1',
      '--worker-generation', 'generation-1',
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
      '--worker-id', 'worker-1',
      '--worker-generation', 'generation-1',
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
