import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeAdapter, RuntimeWorker } from '../runtime/contracts.ts';
import {
  publishCurrentWorkerAssignment,
  resolveWorkerAssignmentStorePath,
} from './worker-assignment-store.ts';
import {
  resolveCurrentWorkerAssignmentBindings,
  resolveCurrentWorkerAssignmentTarget,
} from './worker-assignment-runtime.ts';

const roots: string[] = [];

function fixture(): { readonly file: string; readonly root: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'opk-1416-runtime-'));
  roots.push(root);
  return {
    root,
    file: resolveWorkerAssignmentStorePath('orchestrator-pack', {
      ...process.env,
      OPK_BASE_DIR: root,
    }),
  };
}

const worker: RuntimeWorker = {
  identity: { runtime: 'orca', id: 'terminal-1', generation: 'incarnation-1' },
  workspacePath: '/tmp/worktree-1416',
  title: 'worker-1416',
  provenance: 'internal',
};

function adapter(
  resolution: ReturnType<NonNullable<RuntimeAdapter['resolveAssignmentWorker']>>,
): RuntimeAdapter {
  return {
    id: 'orca',
    readiness: () => ({ status: 'ok', value: { ready: true, workspacePath: worker.workspacePath } }),
    listWorkers: () => ({ status: 'ok', value: [worker] }),
    findWorkerById: () => ({ status: 'ok', value: worker }),
    findWorker: () => ({ status: 'ok', value: worker }),
    resolveAssignmentWorker: vi.fn(() => resolution),
    spawnWorker: () => ({ status: 'ok', value: worker }),
    dispatchInput: () => ({ status: 'dispatched' }),
    readBoundedOutput: () => ({
      status: 'ok',
      value: {
        worker: worker.identity,
        lines: [],
        observationToken: { opaque: 'token-1' },
        changed: false,
        terminalState: 'running',
      },
    }),
    liveness: () => ({ status: 'idle', worker: worker.identity }),
    stopWorker: () => ({ status: 'ok', value: { stopped: true } }),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('WorkerAssignment runtime target truth', () => {
  it('preserves an exact resolved RuntimeWorker only while the logical assignment is current', async () => {
    const { file } = fixture();
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

    expect(resolveCurrentWorkerAssignmentTarget({
      file,
      expected: published.assignment,
      adapter: adapter({ status: 'ok', value: { kind: 'resolved', worker } }),
    })).toEqual({ status: 'resolved', assignment: published.assignment, worker });
  });

  it('preserves affirmative exact-target gone evidence instead of collapsing it to unresolved', async () => {
    const { file } = fixture();
    const published = await publishCurrentWorkerAssignment({
      file,
      repository: 'chetwerikoff/orchestrator-pack',
      issueNumber: 1416,
      taskId: 'task-1416',
      kind: 'local',
      provider: 'orca',
      bindingKey: 'dispatch-gone',
    });
    if (!published.ok) throw new Error(published.reason);
    const runtime = adapter({ status: 'ok', value: { kind: 'gone' } });

    expect(resolveCurrentWorkerAssignmentTarget({
      file,
      expected: published.assignment,
      adapter: runtime,
    })).toEqual({ status: 'gone', assignment: published.assignment });

    expect(resolveCurrentWorkerAssignmentBindings({
      file,
      repository: 'chetwerikoff/orchestrator-pack',
      adapter: runtime,
    })).toEqual({
      status: 'ok',
      bindings: [],
      reconciliations: [{ assignment: published.assignment, reason: 'target_gone' }],
    });
  });

  it('keeps runtime failure and generic unresolved evidence fail-closed', async () => {
    const { file } = fixture();
    const published = await publishCurrentWorkerAssignment({
      file,
      repository: 'chetwerikoff/orchestrator-pack',
      issueNumber: 1416,
      taskId: 'task-1416',
      kind: 'local',
      provider: 'orca',
      bindingKey: 'dispatch-unresolved',
    });
    if (!published.ok) throw new Error(published.reason);
    const runtime = adapter({
      status: 'failed',
      operation: 'resolve_assignment_worker',
      reason: 'assignment_target_unresolved',
    });

    expect(resolveCurrentWorkerAssignmentTarget({
      file,
      expected: published.assignment,
      adapter: runtime,
    })).toEqual({ status: 'target_unresolved' });

    expect(resolveCurrentWorkerAssignmentBindings({
      file,
      repository: 'chetwerikoff/orchestrator-pack',
      adapter: runtime,
    })).toEqual({
      status: 'ok',
      bindings: [],
      reconciliations: [{ assignment: published.assignment, reason: 'target_unresolved' }],
    });
  });

  it('treats remote ownership as not_applicable without consulting local runtime', async () => {
    const { file } = fixture();
    const published = await publishCurrentWorkerAssignment({
      file,
      repository: 'chetwerikoff/orchestrator-pack',
      issueNumber: 1416,
      taskId: 'task-remote',
      kind: 'remote',
      provider: 'browser-gpt',
      bindingKey: 'remote-task-1',
    });
    if (!published.ok) throw new Error(published.reason);
    const runtime = adapter({ status: 'ok', value: { kind: 'resolved', worker } });

    expect(resolveCurrentWorkerAssignmentTarget({
      file,
      expected: published.assignment,
      adapter: runtime,
    })).toEqual({ status: 'remote_not_applicable', assignment: published.assignment });
    expect(runtime.resolveAssignmentWorker).not.toHaveBeenCalled();
  });
});
