import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeAdapter, RuntimeAssignmentWorkerResolution, RuntimeWorker } from './contracts.ts';
import { DeterministicRuntimeAdapter } from './test-adapter.ts';
import { publishCurrentWorkerAssignment, resolveWorkerAssignmentStorePath, type WorkerAssignment } from '../lib/worker-assignment-store.ts';
import { recoverRuntimeWorker, type WorkerRecoveryCleanupAuthority } from './worker-recovery.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

type ResolutionWithTarget = RuntimeAssignmentWorkerResolution & { readonly workerId?: string };

function runtime(base: DeterministicRuntimeAdapter, resolution: ResolutionWithTarget | { status: 'failed'; reason: string }): RuntimeAdapter {
  const adapter = base as unknown as RuntimeAdapter;
  Object.defineProperty(adapter, 'resolveAssignmentWorker', {
    configurable: true,
    value: vi.fn(() => resolution.status === 'failed'
      ? { status: 'failed' as const, operation: 'resolve_assignment_worker' as const, reason: resolution.reason }
      : { status: 'ok' as const, value: resolution }),
  });
  return adapter;
}

async function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'opk-1416-recovery-'));
  roots.push(root);
  const file = resolveWorkerAssignmentStorePath('orchestrator-pack', { ...process.env, OPK_BASE_DIR: root });
  const published = await publishCurrentWorkerAssignment({
    file, repository: 'chetwerikoff/orchestrator-pack', issueNumber: 1416, taskId: 'task-1416',
    kind: 'local', provider: 'orca', bindingKey: 'dispatch-1',
  });
  if (!published.ok) throw new Error(published.reason);
  const base = new DeterministicRuntimeAdapter();
  const created = base.spawnWorker({ title: 'old', command: 'cursor-agent', workspace: '/tmp/recovery-workspace' });
  if (created.status !== 'ok') throw new Error('spawn failed');
  return { file, assignment: published.assignment, base, worker: created.value };
}

function authority(worker: RuntimeWorker): WorkerRecoveryCleanupAuthority {
  return { source: 'pack-reservation', worker: worker.identity, workspacePath: '/tmp/recovery-workspace', expectedHeadSha: 'test-head' };
}
function input(file: string, assignment: WorkerAssignment, adapter: RuntimeAdapter, cleanupAuthority: WorkerRecoveryCleanupAuthority) {
  return {
    assignmentStorePath: file, expectedAssignment: assignment, adapter,
    cleanupWorkspace: { workspacePath: '/tmp/recovery-workspace', expectedHeadSha: 'test-head' },
    cleanupAuthority, acquireClaim: vi.fn(() => ({ ok: true as const })),
  };
}

describe('assignment-fenced cleanup-only worker recovery', () => {
  it.each(['busy', 'idle'] as const)('skips exact live %s target with zero destructive/start effect', async (liveness) => {
    const f = await fixture();
    f.base.setLiveness(f.worker.identity, liveness);
    const stop = vi.spyOn(f.base, 'stopWorker');
    const remove = vi.spyOn(f.base, 'removeWorkspace');
    const spawn = vi.spyOn(f.base, 'spawnWorker');
    const request = input(f.file, f.assignment, runtime(f.base, { kind: 'resolved', worker: f.worker }), authority(f.worker));
    const result = await recoverRuntimeWorker(request);
    expect(result).toMatchObject({ outcome: 'skipped_live', reason: `runtime_${liveness}` });
    expect(request.acquireClaim).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('fails closed on unresolved target with zero effect', async () => {
    const f = await fixture();
    const remove = vi.spyOn(f.base, 'removeWorkspace');
    const spawn = vi.spyOn(f.base, 'spawnWorker');
    const request = input(f.file, f.assignment, runtime(f.base, { status: 'failed', reason: 'assignment_target_unresolved' }), authority(f.worker));
    expect(await recoverRuntimeWorker(request)).toEqual({ outcome: 'skipped_ambiguous', reason: 'target_unresolved' });
    expect(request.acquireClaim).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('cleans only an affirmative gone target associated with the same pack-owned worker', async () => {
    const f = await fixture();
    const cleanupAuthority = authority(f.worker);
    expect(f.base.stopWorker(f.worker.identity).status).toBe('ok');
    const remove = vi.spyOn(f.base, 'removeWorkspace');
    const spawn = vi.spyOn(f.base, 'spawnWorker');
    const request = input(
      f.file,
      f.assignment,
      runtime(f.base, { kind: 'gone', workerId: f.worker.identity.id }),
      cleanupAuthority,
    );
    expect(await recoverRuntimeWorker(request)).toEqual({ outcome: 'cleanup_completed', workspaceRemoved: true, reason: 'gone_target_cleanup_completed' });
    expect(request.acquireClaim).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('rejects gone evidence that names a different worker than cleanup authority', async () => {
    const f = await fixture();
    expect(f.base.stopWorker(f.worker.identity).status).toBe('ok');
    const remove = vi.spyOn(f.base, 'removeWorkspace');
    const request = input(
      f.file,
      f.assignment,
      runtime(f.base, { kind: 'gone', workerId: 'foreign-terminal' }),
      authority(f.worker),
    );
    expect(await recoverRuntimeWorker(request)).toEqual({
      outcome: 'skipped_ambiguous',
      reason: 'cleanup_ownership_authority_target_mismatch',
    });
    expect(request.acquireClaim).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('rejects bare gone evidence without a producer-backed target association', async () => {
    const f = await fixture();
    expect(f.base.stopWorker(f.worker.identity).status).toBe('ok');
    const remove = vi.spyOn(f.base, 'removeWorkspace');
    const request = input(f.file, f.assignment, runtime(f.base, { kind: 'gone' }), authority(f.worker));
    expect(await recoverRuntimeWorker(request)).toEqual({
      outcome: 'skipped_ambiguous',
      reason: 'cleanup_target_identity_unavailable',
    });
    expect(request.acquireClaim).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('returns assignment_store_busy with zero effect', async () => {
    const f = await fixture();
    const cleanupAuthority = authority(f.worker);
    expect(f.base.stopWorker(f.worker.identity).status).toBe('ok');
    const lockPath = `${f.file}.lock`;
    writeFileSync(lockPath, `${JSON.stringify({ schemaVersion: 1, pid: process.pid, nonce: 'live-test-lock', acquiredAtMs: Date.now() })}\n`, 'utf8');
    const remove = vi.spyOn(f.base, 'removeWorkspace');
    const spawn = vi.spyOn(f.base, 'spawnWorker');
    const request = input(
      f.file,
      f.assignment,
      runtime(f.base, { kind: 'gone', workerId: f.worker.identity.id }),
      cleanupAuthority,
    );
    expect(await recoverRuntimeWorker(request)).toEqual({ outcome: 'assignment_store_busy', reason: 'assignment_store_busy' });
    expect(request.acquireClaim).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    rmSync(lockPath, { force: true });
  });
});
