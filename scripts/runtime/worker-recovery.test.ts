import { describe, expect, it, vi } from 'vitest';
import { DeterministicRuntimeAdapter } from './test-adapter.ts';
import {
  recoverRuntimeWorker,
  type WorkerRecoveryCleanupAuthority,
} from './worker-recovery.ts';

function cleanupAuthority(input: {
  worker: Parameters<DeterministicRuntimeAdapter['setLiveness']>[0];
  workspacePath?: string;
  expectedHeadSha?: string;
}): WorkerRecoveryCleanupAuthority {
  return {
    source: 'pack-reservation',
    worker: input.worker,
    workspacePath: input.workspacePath ?? '/tmp/recovery-workspace',
    expectedHeadSha: input.expectedHeadSha ?? 'test-head',
  };
}

describe('runtime-neutral worker recovery', () => {
  it('acquires the claim before the spawn side effect', () => {
    const adapter = new DeterministicRuntimeAdapter();
    const events: string[] = [];
    const spawn = adapter.spawnWorker.bind(adapter);
    vi.spyOn(adapter, 'spawnWorker').mockImplementation((...args) => {
      events.push('spawn');
      return spawn(...args);
    });
    const result = recoverRuntimeWorker({
      adapter,
      workspace: '/tmp/recovery-workspace',
      title: 'recovered-worker',
      command: 'cursor-agent',
      acquireClaim: () => {
        events.push('claim');
        return { ok: true };
      },
    });
    expect(result.outcome).toBe('spawn_started');
    expect(events).toEqual(['claim', 'spawn']);
  });

  it('removes the exact authorized workspace after claim and before spawn', () => {
    const adapter = new DeterministicRuntimeAdapter();
    const owned = adapter.spawnWorker({
      title: 'dead-worker',
      command: 'cursor-agent',
      workspace: '/tmp/recovery-workspace',
    });
    expect(owned.status).toBe('ok');
    if (owned.status !== 'ok') return;
    adapter.setLiveness(owned.value.identity, 'gone');

    const events: string[] = [];
    const remove = adapter.removeWorkspace.bind(adapter);
    const spawn = adapter.spawnWorker.bind(adapter);
    vi.spyOn(adapter, 'removeWorkspace').mockImplementation((...args) => {
      events.push('remove');
      return remove(...args);
    });
    vi.spyOn(adapter, 'spawnWorker').mockImplementation((...args) => {
      events.push('spawn');
      return spawn(...args);
    });

    const result = recoverRuntimeWorker({
      adapter,
      targetId: owned.value.identity.id,
      targetGeneration: owned.value.identity.generation,
      cleanupWorkspace: {
        workspacePath: '/tmp/recovery-workspace',
        expectedHeadSha: 'test-head',
      },
      cleanupAuthority: cleanupAuthority({ worker: owned.value.identity }),
      title: 'recovered-worker',
      command: 'cursor-agent',
      acquireClaim: () => {
        events.push('claim');
        return { ok: true };
      },
    });

    expect(result.outcome).toBe('spawn_started');
    if (result.outcome === 'spawn_started') expect(result.workspaceRemoved).toBe(true);
    expect(events).toEqual(['claim', 'remove', 'spawn']);
  });

  it('does not spawn or remove when the claim is denied', () => {
    const adapter = new DeterministicRuntimeAdapter();
    const owned = adapter.spawnWorker({
      title: 'dead-worker',
      command: 'cursor-agent',
      workspace: '/tmp/recovery-workspace',
    });
    expect(owned.status).toBe('ok');
    if (owned.status !== 'ok') return;
    adapter.setLiveness(owned.value.identity, 'gone');
    const spawn = vi.spyOn(adapter, 'spawnWorker');
    const remove = vi.spyOn(adapter, 'removeWorkspace');
    const result = recoverRuntimeWorker({
      adapter,
      targetId: owned.value.identity.id,
      targetGeneration: owned.value.identity.generation,
      cleanupWorkspace: {
        workspacePath: '/tmp/recovery-workspace',
        expectedHeadSha: 'test-head',
      },
      cleanupAuthority: cleanupAuthority({ worker: owned.value.identity }),
      title: 'recovered-worker',
      command: 'cursor-agent',
      acquireClaim: () => ({ ok: false, reason: 'claim_busy' }),
    });
    expect(result).toEqual({ outcome: 'spawn_denied', reason: 'claim_busy' });
    expect(remove).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('refuses recovery while an exact runtime worker is live', () => {
    const adapter = new DeterministicRuntimeAdapter();
    const created = adapter.spawnWorker({
      title: 'existing',
      command: 'cursor-agent',
      workspace: '/tmp/recovery-workspace',
    });
    expect(created.status).toBe('ok');
    if (created.status !== 'ok') return;
    const claim = vi.fn(() => ({ ok: true as const }));
    const result = recoverRuntimeWorker({
      adapter,
      targetId: created.value.identity.id,
      targetGeneration: created.value.identity.generation,
      title: 'replacement',
      command: 'cursor-agent',
      acquireClaim: claim,
    });
    expect(result.outcome).toBe('skipped_live');
    expect(claim).not.toHaveBeenCalled();
  });

  it('revalidates after claim and refuses a concurrent owner', () => {
    const adapter = new DeterministicRuntimeAdapter();
    const owned = adapter.spawnWorker({
      title: 'dead-worker',
      command: 'cursor-agent',
      workspace: '/tmp/recovery-workspace',
    });
    expect(owned.status).toBe('ok');
    if (owned.status !== 'ok') return;
    adapter.setLiveness(owned.value.identity, 'gone');
    const remove = vi.spyOn(adapter, 'removeWorkspace');
    const result = recoverRuntimeWorker({
      adapter,
      targetId: owned.value.identity.id,
      targetGeneration: owned.value.identity.generation,
      cleanupWorkspace: {
        workspacePath: '/tmp/recovery-workspace',
        expectedHeadSha: 'test-head',
      },
      cleanupAuthority: cleanupAuthority({ worker: owned.value.identity }),
      title: 'replacement',
      command: 'cursor-agent',
      acquireClaim: () => {
        adapter.spawnWorker({
          title: 'concurrent',
          command: 'cursor-agent',
          workspace: '/tmp/recovery-workspace',
        });
        return { ok: true };
      },
    });
    expect(result).toEqual({ outcome: 'claim_lost', reason: 'post_claim_runtime_busy' });
    expect(remove).not.toHaveBeenCalled();
  });

  it('rejects cleanup and spawn selector reuse before runtime or claim work', () => {
    const adapter = new DeterministicRuntimeAdapter();
    const list = vi.spyOn(adapter, 'listWorkers');
    const remove = vi.spyOn(adapter, 'removeWorkspace');
    const spawn = vi.spyOn(adapter, 'spawnWorker');
    const claim = vi.fn(() => ({ ok: true as const }));
    const result = recoverRuntimeWorker({
      adapter,
      workspace: '/tmp/same-workspace',
      cleanupWorkspace: {
        workspacePath: '/tmp/same-workspace',
        expectedHeadSha: 'test-head',
      },
      title: 'replacement',
      command: 'cursor-agent',
      acquireClaim: claim,
    });
    expect(result).toEqual({
      outcome: 'skipped_ambiguous',
      reason: 'cleanup_spawn_workspace_reuse',
    });
    expect(list).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('rejects destructive cleanup when the exact identity is omitted', () => {
    const adapter = new DeterministicRuntimeAdapter();
    const list = vi.spyOn(adapter, 'listWorkers');
    const claim = vi.fn(() => ({ ok: true as const }));
    const remove = vi.spyOn(adapter, 'removeWorkspace');
    const result = recoverRuntimeWorker({
      adapter,
      cleanupWorkspace: {
        workspacePath: '/tmp/recovery-workspace',
        expectedHeadSha: 'test-head',
      },
      title: 'replacement',
      command: 'cursor-agent',
      acquireClaim: claim,
    });
    expect(result).toEqual({
      outcome: 'skipped_ambiguous',
      reason: 'cleanup_target_identity_required',
    });
    expect(list).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('rejects a gone exact worker without pre-existing pack ownership authority', () => {
    const adapter = new DeterministicRuntimeAdapter();
    const owned = adapter.spawnWorker({
      title: 'dead-worker',
      command: 'cursor-agent',
      workspace: '/tmp/recovery-workspace',
    });
    expect(owned.status).toBe('ok');
    if (owned.status !== 'ok') return;
    adapter.setLiveness(owned.value.identity, 'gone');
    const find = vi.spyOn(adapter, 'findWorkerById');
    const claim = vi.fn(() => ({ ok: true as const }));
    const remove = vi.spyOn(adapter, 'removeWorkspace');
    const result = recoverRuntimeWorker({
      adapter,
      targetId: owned.value.identity.id,
      targetGeneration: owned.value.identity.generation,
      cleanupWorkspace: {
        workspacePath: '/tmp/recovery-workspace',
        expectedHeadSha: 'test-head',
      },
      title: 'replacement',
      command: 'cursor-agent',
      acquireClaim: claim,
    });
    expect(result).toEqual({
      outcome: 'skipped_ambiguous',
      reason: 'cleanup_ownership_authority_missing',
    });
    expect(find).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('rejects a target id without its expected generation before runtime work', () => {
    const adapter = new DeterministicRuntimeAdapter();
    const find = vi.spyOn(adapter, 'findWorkerById');
    const claim = vi.fn(() => ({ ok: true as const }));
    const result = recoverRuntimeWorker({
      adapter,
      targetId: 'recycled-handle',
      title: 'replacement',
      command: 'cursor-agent',
      acquireClaim: claim,
    });
    expect(result).toEqual({
      outcome: 'skipped_ambiguous',
      reason: 'target_generation_missing',
    });
    expect(find).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
  });

  it('rejects a recycled id generation after claim before cleanup or spawn', () => {
    const adapter = new DeterministicRuntimeAdapter();
    const created = adapter.spawnWorker({
      title: 'stale',
      command: 'cursor-agent',
      workspace: '/tmp/recovery-workspace',
    });
    expect(created.status).toBe('ok');
    if (created.status !== 'ok') return;
    adapter.setLiveness(created.value.identity, 'gone');
    const remove = vi.spyOn(adapter, 'removeWorkspace');
    const spawn = vi.spyOn(adapter, 'spawnWorker');

    const result = recoverRuntimeWorker({
      adapter,
      targetId: created.value.identity.id,
      targetGeneration: created.value.identity.generation,
      cleanupWorkspace: {
        workspacePath: '/tmp/recovery-workspace',
        expectedHeadSha: 'test-head',
      },
      cleanupAuthority: cleanupAuthority({ worker: created.value.identity }),
      title: 'replacement',
      command: 'cursor-agent',
      acquireClaim: () => {
        adapter.recreateWorker(created.value.identity);
        return { ok: true };
      },
    });

    expect(result).toEqual({
      outcome: 'claim_lost',
      reason: 'post_claim_worker_identity_mismatch',
    });
    expect(remove).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('requires an expected head before any destructive recovery work', () => {
    const adapter = new DeterministicRuntimeAdapter();
    const list = vi.spyOn(adapter, 'listWorkers');
    const claim = vi.fn(() => ({ ok: true as const }));
    const remove = vi.spyOn(adapter, 'removeWorkspace');
    const result = recoverRuntimeWorker({
      adapter,
      cleanupWorkspace: {
        workspacePath: '/tmp/recovery-workspace',
        expectedHeadSha: '',
      },
      title: 'replacement',
      command: 'cursor-agent',
      acquireClaim: claim,
    });
    expect(result).toEqual({
      outcome: 'skipped_ambiguous',
      reason: 'cleanup_expected_head_missing',
    });
    expect(list).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
});
