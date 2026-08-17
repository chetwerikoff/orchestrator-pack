import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeAdapter, RuntimeAssignmentWorkerResolution, RuntimeWorker } from './contracts.ts';
import { DeterministicRuntimeAdapter } from './test-adapter.ts';
import {
  publishCurrentWorkerAssignment,
  resolveWorkerAssignmentStorePath,
  withCurrentWorkerAssignmentFence,
  type WorkerAssignment,
} from '../lib/worker-assignment-store.ts';
import {
  recoverRuntimeWorker,
  type WorkerRecoveryCleanupAuthority,
} from './worker-recovery.ts';

const roots: string[] = [];

function adapterWithResolution(
  adapter: DeterministicRuntimeAdapter,
  resolution: RuntimeAssignmentWorkerResolution | { readonly status: 'failed'; readonly reason: string },
): RuntimeAdapter {
  const runtime = adapter as unknown as RuntimeAdapter;
  Object.defineProperty(runtime, 'resolveAssignmentWorker', {
    configurable: true,
    value: vi.fn(() => resolution.status === 'failed'
      ? { status: 'failed' as const, operation: 'resolve_assignment_worker' as const, reason: resolution.reason }
      : { status: 'ok' as const, value: resolution }),
  });
  return runtime;
}

async function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'opk-1416-recovery-'));
  roots.push(root);
  const file = resolveWorkerAssignmentStorePath('orchestrator-pack', { ...process.env, OPK_BASE_DIR: root });
  const published = await publishCurrentWorkerAssignment({
    file,
    repository: 'chetwerikoff/orchestrator-pack',
    issueNumber: 1416,
    taskId: 'task-1416',
    kind: 'local',
    provider: 'orca',
    bindingKey: 'dispatch-1',
  });
  if (!published.ok) throw new Error(published.reason);
  return { root, file, assignment: published.assignment };
}

function authority(worker: RuntimeWorker, workspacePath = '/tmp/recovery-workspace'): WorkerRecoveryCleanupAuthority {
  return {
    source: 'pack-reservation',
    worker: worker.identity,
    workspacePath,
    expectedHeadSha: 'test-head',
  };
}

function recoveryInput(input: {
  file: string;
  assignment: WorkerAssignment;
  adapter: RuntimeAdapter;
  cleanupAuthority: WorkerRecoveryCleanupAuthority;
  acquireClaim?: () => { readonly ok: true } | { readonly ok: false; readonly reason: string };
}) {
  return {
    assignmentStorePath: input.file,
    expectedAssignment: input.assignment,
    adapter: input.adapter,
    cleanupWorkspace: { workspacePath: '/tmp/recovery-workspace', expectedHeadSha: 'test-head' },
    cleanupAuthority: input.cleanupAuthority,
    acquireClaim: input.acquireClaim ?? (() => ({ ok: true as const })),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('assignment-fenced cleanup-only worker recovery', () => {
  it.each(['busy', 'idle'] as const)('returns skipped_live for an exact %s target with zero destructive/start effect', async (liveness) => {
    const f = await fixture();
    const base = new DeterministicRuntimeAdapter();
    const created = base.spawnWorker({ title: 'live', command: 'cursor-agent', workspace: '/tmp/recovery-workspace' });
    if (created.status !== 'ok') throw new Error('spawn failed');
    base.setLiveness(created.value.identity, liveness);
    const runtime = adapterWithResolution(base, { kind: 'resolved', worker: created.value });
    const stop = vi.spyOn(base, 'stopWorker');
    const remove = vi.spyOn(base, 'removeWorkspace');
    const spawn = vi.spyOn(base, 'spawnWorker');
    const claim = vi.fn(() => ({ ok: true as const }));

    const result = await recoverRuntimeWorker(recoveryInput({
      file: f.file, assignment: f.assignment, adapter: runtime,
      cleanupAuthority: authority(created.value), acquireClaim: claim,
    }));
    expect(result).toMatchObject({ outcome: 'skipped_live', reason: `runtime_${liveness}` });
    expect(claim).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('fails closed on generic unresolved target evidence with zero effect', async () => {
    const f = await fixture();
    const base = new DeterministicRuntimeAdapter();
    const created = base.spawnWorker({ title: 'old', command: 'cursor-agent', workspace: '/tmp/recovery-workspace' });
    if (created.status !== 'ok') throw new Error('spawn failed');
    const runtime = adapterWithResolution(base, { status: 'failed', reason: 'assignment_target_unresolved' });
    const remove = vi.spyOn(base, 'removeWorkspace');
    const spawn = vi.spyOn(base, 'spawnWorker');
    const claim = vi.fn(() => ({ ok: true as const }));

    const result = await recoverRuntimeWorker(recoveryInput({
      file: f.file, assignment: f.assignment, adapter: runtime,
      cleanupAuthority: authority(created.value), acquireClaim: claim,
    }));
    expect(result).toEqual({ outcome: 'skipped_ambiguous', reason: 'target_unresolved' });
    expect(claim).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('cleans an affirmatively gone target under the exact assignment fence and never spawns a successor', async () => {
    const f = await fixture();
    const base = new DeterministicRuntimeAdapter();
    const created = base.spawnWorker({ title: 'old', command: 'cursor-agent', workspace: '/tmp/recovery-workspace' });
    if (created.status !== 'ok') throw new Error('spawn failed');
    const cleanupAuthority = authority(created.value);
    expect(base.stopWorker(created.value.identity).status).toBe('ok');
    const runtime = adapterWithResolution(base, { kind: 'gone' });
    const remove = vi.spyOn(base, 'removeWorkspace');
    const spawn = vi.spyOn(base, 'spawnWorker');
    const claim = vi.fn(() => ({ ok: true as const }));

    const result = await recoverRuntimeWorker(recoveryInput({
      file: f.file, assignment: f.assignment, adapter: runtime, cleanupAuthority, acquireClaim: claim,
    }));
    expect(result).toEqual({ outcome: 'cleanup_completed', workspaceRemoved: true, reason: 'gone_target_cleanup_completed' });
    expect(claim).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(spawn).not.toHaveBeenCalled();
    expect(base.workspaceWasRemoved('/tmp/recovery-workspace')).toBe(true);
  });

  it('rejects stale expected assignment before claim/cleanup/start effect', async () => {
    const f = await fixture();
    const base = new DeterministicRuntimeAdapter();
    const created = base.spawnWorker({ title: 'old', command: 'cursor-agent', workspace: '/tmp/recovery-workspace' });
    if (created.status !== 'ok') throw new Error('spawn failed');
    const cleanupAuthority = authority(created.value);
    expect(base.stopWorker(created.value.identity).status).toBe('ok');
    const runtime = adapterWithResolution(base, { kind: 'gone' });
    const winner = await publishCurrentWorkerAssignment({
      file: f.file,
      repository: f.assignment.repository,
      issueNumber: f.assignment.issueNumber,
      taskId: f.assignment.taskId,
      kind: 'remote',
      provider: 'browser-gpt',
      bindingKey: 'remote-2',
      expectedCurrent: { assignmentId: f.assignment.assignmentId, generation: f.assignment.generation },
    });
    if (!winner.ok) throw new Error(winner.reason);
    const claim = vi.fn(() => ({ ok: true as const }));
    const remove = vi.spyOn(base, 'removeWorkspace');
    const spawn = vi.spyOn(base, 'spawnWorker');

    const result = await recoverRuntimeWorker(recoveryInput({
      file: f.file, assignment: f.assignment, adapter: runtime, cleanupAuthority, acquireClaim: claim,
    }));
    expect(result).toEqual({ outcome: 'assignment_stale', reason: 'assignment_stale' });
    expect(claim).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('returns assignment_store_busy distinctly with zero effect', async () => {
    const f = await fixture();
    const base = new DeterministicRuntimeAdapter();
    const created = base.spawnWorker({ title: 'old', command: 'cursor-agent', workspace: '/tmp/recovery-workspace' });
    if (created.status !== 'ok') throw new Error('spawn failed');
    const cleanupAuthority = authority(created.value);
    expect(base.stopWorker(created.value.identity).status).toBe('ok');
    const runtime = adapterWithResolution(base, { kind: 'gone' });
    let release!: () => void;
    const held = withCurrentWorkerAssignmentFence(f.file, f.assignment, async () => {
      await new Promise<void>((resolvePromise) => { release = resolvePromise; });
    });
    while (!release) await new Promise((resolvePromise) => setTimeout(resolvePromise, 1));
    const claim = vi.fn(() => ({ ok: true as const }));
    const remove = vi.spyOn(base, 'removeWorkspace');
    const spawn = vi.spyOn(base, 'spawnWorker');

    const result = await recoverRuntimeWorker(recoveryInput({
      file: f.file, assignment: f.assignment, adapter: runtime, cleanupAuthority, acquireClaim: claim,
    }));
    expect(result).toEqual({ outcome: 'assignment_store_busy', reason: 'assignment_store_busy' });
    expect(claim).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    release();
    await held;
  });

  it('denies gone cleanup when the pre-existing cleanup authority does not match workspace/head/runtime', async () => {
    const f = await fixture();
    const base = new DeterministicRuntimeAdapter();
    const created = base.spawnWorker({ title: 'old', command: 'cursor-agent', workspace: '/tmp/recovery-workspace' });
    if (created.status !== 'ok') throw new Error('spawn failed');
    const runtime = adapterWithResolution(base, { kind: 'gone' });
    const claim = vi.fn(() => ({ ok: true as const }));
    const remove = vi.spyOn(base, 'removeWorkspace');
    const result = await recoverRuntimeWorker(recoveryInput({
      file: f.file,
      assignment: f.assignment,
      adapter: runtime,
      cleanupAuthority: { ...authority(created.value), expectedHeadSha: 'other-head' },
      acquireClaim: claim,
    }));
    expect(result).toEqual({ outcome: 'skipped_ambiguous', reason: 'cleanup_ownership_authority_mismatch' });
    expect(claim).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
});
