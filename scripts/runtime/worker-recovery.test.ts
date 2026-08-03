import { describe, expect, it, vi } from 'vitest';
import { DeterministicRuntimeAdapter } from './test-adapter.ts';
import { recoverRuntimeWorker } from './worker-recovery.ts';

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

  it('removes the exact workspace after claim and before spawn', () => {
    const adapter = new DeterministicRuntimeAdapter();
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
      cleanupWorkspace: {
        workspacePath: '/tmp/recovery-workspace',
        expectedHeadSha: 'test-head',
      },
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
    const spawn = vi.spyOn(adapter, 'spawnWorker');
    const remove = vi.spyOn(adapter, 'removeWorkspace');
    const result = recoverRuntimeWorker({
      adapter,
      cleanupWorkspace: { workspacePath: '/tmp/recovery-workspace' },
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
      title: 'replacement',
      command: 'cursor-agent',
      acquireClaim: claim,
    });
    expect(result.outcome).toBe('skipped_live');
    expect(claim).not.toHaveBeenCalled();
  });

  it('revalidates after claim and refuses a concurrent owner', () => {
    const adapter = new DeterministicRuntimeAdapter();
    const list = adapter.listWorkers.bind(adapter);
    let calls = 0;
    vi.spyOn(adapter, 'listWorkers').mockImplementation((...args) => {
      calls += 1;
      if (calls === 1) return { status: 'ok', value: [] };
      const created = adapter.spawnWorker({
        title: 'concurrent',
        command: 'cursor-agent',
        workspace: '/tmp/recovery-workspace',
      });
      if (created.status !== 'ok') return list(...args);
      return { status: 'ok', value: [created.value] };
    });
    const remove = vi.spyOn(adapter, 'removeWorkspace');
    const result = recoverRuntimeWorker({
      adapter,
      cleanupWorkspace: { workspacePath: '/tmp/recovery-workspace' },
      title: 'replacement',
      command: 'cursor-agent',
      acquireClaim: () => ({ ok: true }),
    });
    expect(result).toEqual({ outcome: 'claim_lost', reason: 'post_claim_runtime_busy' });
    expect(remove).not.toHaveBeenCalled();
  });
});
