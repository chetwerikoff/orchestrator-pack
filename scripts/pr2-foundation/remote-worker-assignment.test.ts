import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeAdapter, RuntimeWorker } from '../runtime/contracts.ts';
import {
  currentWorkerAssignment,
  publishCurrentWorkerAssignment,
  resolveWorkerAssignmentStorePath,
} from '../lib/worker-assignment-store.ts';
import {
  publishOperatorRemoteWorkerAssignment,
  type RemoteWorkerAssignmentExpectation,
} from './remote-worker-assignment.ts';

const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'opk-1416-remote-'));
  roots.push(root);
  const env = { ...process.env, OPK_BASE_DIR: root };
  return {
    root,
    env,
    file: resolveWorkerAssignmentStorePath('orchestrator-pack', env),
  };
}

const worker: RuntimeWorker = {
  identity: { runtime: 'orca', id: 'terminal-1', generation: 'incarnation-1' },
  workspacePath: '/tmp/worktree-1416',
  title: 'worker-1416',
  provenance: 'internal',
};

function runtime(
  resolution: ReturnType<NonNullable<RuntimeAdapter['resolveAssignmentWorker']>>,
  liveness: 'busy' | 'idle' | 'gone' | 'unknown' = 'idle',
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
    liveness: () => ({ status: liveness, worker: worker.identity }),
    stopWorker: () => ({ status: 'ok', value: { stopped: true } }),
  };
}

function remoteInput(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly expectation: RemoteWorkerAssignmentExpectation;
  readonly adapter?: RuntimeAdapter;
  readonly operatorAttested?: boolean;
}) {
  return {
    repository: 'chetwerikoff/orchestrator-pack',
    issueNumber: 1416,
    taskId: 'task-1416',
    provider: 'browser-gpt',
    bindingKey: 'browser-task-1',
    expectation: input.expectation,
    operatorAttested: input.operatorAttested ?? true,
    env: input.env,
    ...(input.adapter ? { adapter: input.adapter } : {}),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('direct operator remote WorkerAssignment admission', () => {
  it('publishes an initial remote logical assignment without fabricating runtime identity', async () => {
    const { env, file } = fixture();
    const result = await publishOperatorRemoteWorkerAssignment(remoteInput({
      env,
      expectation: { kind: 'none' },
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.assignment).toMatchObject({
      kind: 'remote',
      provider: 'browser-gpt',
      bindingKey: 'browser-task-1',
      generation: 1,
    });
    const persisted = JSON.stringify(currentWorkerAssignment(file, 1416));
    expect(persisted).not.toContain('terminal');
    expect(persisted).not.toContain('workspace');
  });

  it('refuses mutation without explicit direct-operator attestation', async () => {
    const { env, file } = fixture();
    const result = await publishOperatorRemoteWorkerAssignment(remoteInput({
      env,
      expectation: { kind: 'none' },
      operatorAttested: false,
    }));
    expect(result).toEqual({ ok: false, reason: 'operator_attestation_required' });
    expect(currentWorkerAssignment(file, 1416)).toBeNull();
  });

  it('advances remote ownership only from the exact expected current generation', async () => {
    const { env, file } = fixture();
    const first = await publishOperatorRemoteWorkerAssignment(remoteInput({
      env,
      expectation: { kind: 'none' },
    }));
    if (!first.ok) throw new Error(first.reason);
    const second = await publishOperatorRemoteWorkerAssignment({
      ...remoteInput({
        env,
        expectation: {
          kind: 'exact',
          assignmentId: first.assignment.assignmentId,
          generation: first.assignment.generation,
        },
      }),
      bindingKey: 'browser-task-2',
    });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error(second.reason);
    expect(second.assignment.generation).toBe(2);
    expect(second.assignment.bindingKey).toBe('browser-task-2');
    expect(currentWorkerAssignment(file, 1416)).toEqual(second.assignment);
  });

  it('permits local-to-remote replacement only with affirmative exact-target gone evidence', async () => {
    const { env, file } = fixture();
    const local = await publishCurrentWorkerAssignment({
      file,
      repository: 'chetwerikoff/orchestrator-pack',
      issueNumber: 1416,
      taskId: 'task-1416',
      kind: 'local',
      provider: 'orca',
      bindingKey: 'dispatch-old',
    });
    if (!local.ok) throw new Error(local.reason);
    const result = await publishOperatorRemoteWorkerAssignment(remoteInput({
      env,
      expectation: {
        kind: 'exact',
        assignmentId: local.assignment.assignmentId,
        generation: local.assignment.generation,
      },
      adapter: runtime({ status: 'ok', value: { kind: 'gone' } }),
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.assignment).toMatchObject({ kind: 'remote', generation: 2 });
  });

  it.each(['busy', 'idle'] as const)('blocks replacement while the exact local target is %s', async (liveness) => {
    const { env, file } = fixture();
    const local = await publishCurrentWorkerAssignment({
      file,
      repository: 'chetwerikoff/orchestrator-pack',
      issueNumber: 1416,
      taskId: 'task-1416',
      kind: 'local',
      provider: 'orca',
      bindingKey: 'dispatch-live',
    });
    if (!local.ok) throw new Error(local.reason);
    const result = await publishOperatorRemoteWorkerAssignment(remoteInput({
      env,
      expectation: {
        kind: 'exact',
        assignmentId: local.assignment.assignmentId,
        generation: local.assignment.generation,
      },
      adapter: runtime({ status: 'ok', value: { kind: 'resolved', worker } }, liveness),
    }));
    expect(result).toEqual({ ok: false, reason: 'skipped_live' });
    expect(currentWorkerAssignment(file, 1416)).toEqual(local.assignment);
  });

  it('does not reinterpret unresolved current-local runtime state as gone', async () => {
    const { env, file } = fixture();
    const local = await publishCurrentWorkerAssignment({
      file,
      repository: 'chetwerikoff/orchestrator-pack',
      issueNumber: 1416,
      taskId: 'task-1416',
      kind: 'local',
      provider: 'orca',
      bindingKey: 'dispatch-unknown',
    });
    if (!local.ok) throw new Error(local.reason);
    const result = await publishOperatorRemoteWorkerAssignment(remoteInput({
      env,
      expectation: {
        kind: 'exact',
        assignmentId: local.assignment.assignmentId,
        generation: local.assignment.generation,
      },
      adapter: runtime({
        status: 'failed',
        operation: 'resolve_assignment_worker',
        reason: 'assignment_target_unresolved',
      }),
    }));
    expect(result).toEqual({ ok: false, reason: 'target_unresolved' });
    expect(currentWorkerAssignment(file, 1416)).toEqual(local.assignment);
  });

  it('rejects stale operator expectations without mutating the winner', async () => {
    const { env, file } = fixture();
    const first = await publishOperatorRemoteWorkerAssignment(remoteInput({
      env,
      expectation: { kind: 'none' },
    }));
    if (!first.ok) throw new Error(first.reason);
    const result = await publishOperatorRemoteWorkerAssignment(remoteInput({
      env,
      expectation: {
        kind: 'exact',
        assignmentId: first.assignment.assignmentId,
        generation: first.assignment.generation + 1,
      },
    }));
    expect(result).toEqual({ ok: false, reason: 'assignment_stale' });
    expect(currentWorkerAssignment(file, 1416)).toEqual(first.assignment);
  });
});
