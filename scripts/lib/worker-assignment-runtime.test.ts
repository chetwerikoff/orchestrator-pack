import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeAdapter } from '../runtime/contracts.ts';
import { DeterministicRuntimeAdapter } from '../runtime/test-adapter.ts';
import { OrcaTaskRuntimeAdapter } from '../orca-runtime/task-adapter.ts';
import type { OrcaJsonResponse } from '../orca-runtime/native.ts';
import {
  publishCurrentWorkerAssignment,
  resolveWorkerAssignmentStorePath,
  type WorkerAssignment,
} from './worker-assignment-store.ts';
import {
  resolveCurrentWorkerAssignmentBindings,
  resolveCurrentWorkerAssignmentTarget,
} from './worker-assignment-runtime.ts';

const roots: string[] = [];

function assignmentFile(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'opk-1416-runtime-'));
  roots.push(root);
  const env: NodeJS.ProcessEnv = { ...process.env, OPK_BASE_DIR: root };
  return resolveWorkerAssignmentStorePath('orchestrator-pack', env);
}

async function publish(file: string, input: {
  kind?: 'local' | 'remote';
  taskId?: string;
  provider?: string;
  bindingKey: string;
}): Promise<WorkerAssignment> {
  const result = await publishCurrentWorkerAssignment({
    file,
    repository: 'chetwerikoff/orchestrator-pack',
    issueNumber: 1416,
    taskId: input.taskId ?? 'task-1416',
    kind: input.kind ?? 'local',
    provider: input.provider ?? 'orca',
    bindingKey: input.bindingKey,
    role: 'worker',
  });
  if (!result.ok) throw new Error(result.reason);
  return result.assignment;
}

function runtimeWith(
  resolution: ReturnType<NonNullable<RuntimeAdapter['resolveAssignmentWorker']>>,
) {
  const base = new DeterministicRuntimeAdapter();
  const spawned = base.spawnWorker({
    title: 'worker-1416',
    command: 'cursor-agent',
    workspace: '/tmp/worktree-1416',
  });
  if (spawned.status !== 'ok') throw new Error('test worker spawn failed');
  const adapter = base as unknown as RuntimeAdapter;
  Object.defineProperty(adapter, 'resolveAssignmentWorker', {
    configurable: true,
    value: vi.fn(() => resolution),
  });
  return { adapter, worker: spawned.value };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('WorkerAssignment runtime target truth', () => {
  it('preserves an exact resolved RuntimeWorker only while the logical assignment is current', async () => {
    const file = assignmentFile();
    const assignment = await publish(file, { bindingKey: 'dispatch-1' });
    const runtime = runtimeWith({ status: 'ok', value: { kind: 'gone' } });
    Object.defineProperty(runtime.adapter, 'resolveAssignmentWorker', {
      configurable: true,
      value: vi.fn(() => ({ status: 'ok', value: { kind: 'resolved', worker: runtime.worker } })),
    });

    expect(resolveCurrentWorkerAssignmentTarget({
      file,
      expected: assignment,
      adapter: runtime.adapter,
    })).toEqual({ status: 'resolved', assignment, worker: runtime.worker });
  });

  it('preserves affirmative exact-target gone evidence without widening fleet handoff vocabulary', async () => {
    const file = assignmentFile();
    const assignment = await publish(file, { bindingKey: 'dispatch-gone' });
    const { adapter } = runtimeWith({ status: 'ok', value: { kind: 'gone' } });

    expect(resolveCurrentWorkerAssignmentTarget({ file, expected: assignment, adapter }))
      .toEqual({ status: 'gone', assignment });
    expect(resolveCurrentWorkerAssignmentBindings({
      file,
      repository: 'chetwerikoff/orchestrator-pack',
      adapter,
    })).toEqual({
      status: 'ok',
      bindings: [],
      reconciliations: [{ assignment, reason: 'target_unresolved' }],
    });
  });

  it('keeps runtime failure and generic unresolved evidence fail-closed', async () => {
    const file = assignmentFile();
    const assignment = await publish(file, { bindingKey: 'dispatch-unresolved' });
    const { adapter } = runtimeWith({
      status: 'failed',
      operation: 'resolve_assignment_worker',
      reason: 'assignment_target_unresolved',
    });

    expect(resolveCurrentWorkerAssignmentTarget({ file, expected: assignment, adapter }))
      .toEqual({ status: 'target_unresolved' });
    expect(resolveCurrentWorkerAssignmentBindings({
      file,
      repository: 'chetwerikoff/orchestrator-pack',
      adapter,
    })).toEqual({
      status: 'ok',
      bindings: [],
      reconciliations: [{ assignment, reason: 'target_unresolved' }],
    });
  });

  it('treats remote ownership as not_applicable without consulting local runtime', async () => {
    const file = assignmentFile();
    const assignment = await publish(file, {
      kind: 'remote',
      taskId: 'task-remote',
      provider: 'browser-gpt',
      bindingKey: 'remote-task-1',
    });
    const runtime = runtimeWith({ status: 'ok', value: { kind: 'gone' } });

    expect(resolveCurrentWorkerAssignmentTarget({
      file,
      expected: assignment,
      adapter: runtime.adapter,
    })).toEqual({ status: 'remote_not_applicable', assignment });
    expect(runtime.adapter.resolveAssignmentWorker).not.toHaveBeenCalled();
  });
});

describe('real Orca assignment target resolution', () => {
  it('preserves exact gone and its producer-backed Dispatch-owned terminal handle', async () => {
    const file = assignmentFile();
    const assignment = await publish(file, { bindingKey: 'dispatch-exact-gone' });
    const runJson = vi.fn((args: readonly string[]): OrcaJsonResponse => {
      expect(args).toEqual(['orchestration', 'worker-show', '--dispatch', 'dispatch-exact-gone']);
      return {
        ok: true,
        result: {
          worker: { agent_terminal_handle: 'term-owned' },
          terminal: null,
          observation: { exactWorker: true, status: 'gone' },
          terminalResource: {
            terminalHandle: 'term-owned',
            worktreeId: 'repo::worktree',
            originDispatchId: 'dispatch-exact-gone',
            ownerDispatchId: 'dispatch-exact-gone',
          },
        },
      };
    });
    const adapter = new OrcaTaskRuntimeAdapter({ runJson: runJson as never });

    expect(resolveCurrentWorkerAssignmentTarget({ file, expected: assignment, adapter }))
      .toEqual({ status: 'gone', assignment, workerId: 'term-owned' });
  });

  it.each([false, undefined] as const)(
    'does not upgrade gone to exact absence when exactWorker=%s',
    async (exactWorker) => {
      const file = assignmentFile();
      const assignment = await publish(file, { bindingKey: `dispatch-not-exact-${String(exactWorker)}` });
      const runJson = vi.fn((): OrcaJsonResponse => ({
        ok: true,
        result: {
          worker: { agent_terminal_handle: 'term-owned' },
          observation: { ...(exactWorker === undefined ? {} : { exactWorker }), status: 'gone' },
        },
      }));
      const adapter = new OrcaTaskRuntimeAdapter({ runJson: runJson as never });
      expect(resolveCurrentWorkerAssignmentTarget({ file, expected: assignment, adapter }))
        .toEqual({ status: 'target_unresolved' });
    },
  );

  it.each([undefined, '', 'unknown', 'unverifiable'])(
    'fails closed on missing or ambiguous exact observation status %s',
    async (status) => {
      const file = assignmentFile();
      const assignment = await publish(file, { bindingKey: `dispatch-status-${String(status)}` });
      const runJson = vi.fn((): OrcaJsonResponse => ({
        ok: true,
        result: {
          worker: { agent_terminal_handle: 'term-owned' },
          terminal: { handle: 'term-owned' },
          observation: { exactWorker: true, ...(status === undefined ? {} : { status }) },
        },
      }));
      const adapter = new OrcaTaskRuntimeAdapter({ runJson: runJson as never });
      expect(resolveCurrentWorkerAssignmentTarget({ file, expected: assignment, adapter }))
        .toEqual({ status: 'target_unresolved' });
    },
  );

  it('requires a terminal handle for an exact live target', async () => {
    const file = assignmentFile();
    const assignment = await publish(file, { bindingKey: 'dispatch-live-no-terminal' });
    const runJson = vi.fn((): OrcaJsonResponse => ({
      ok: true,
      result: {
        worker: { agent_terminal_handle: null },
        terminal: null,
        observation: { exactWorker: true, status: 'live' },
      },
    }));
    const adapter = new OrcaTaskRuntimeAdapter({ runJson: runJson as never });
    expect(resolveCurrentWorkerAssignmentTarget({ file, expected: assignment, adapter }))
      .toEqual({ status: 'target_unresolved' });
  });

  it('keeps worker-show transport failure unresolved rather than treating it as gone', async () => {
    const file = assignmentFile();
    const assignment = await publish(file, { bindingKey: 'dispatch-runtime-failure' });
    const runJson = vi.fn((): OrcaJsonResponse => ({
      ok: false,
      outcomeCategory: 'empty_stdout',
      error: { code: 'empty_stdout', message: 'no receipt' },
    }));
    const adapter = new OrcaTaskRuntimeAdapter({ runJson: runJson as never });
    expect(resolveCurrentWorkerAssignmentTarget({ file, expected: assignment, adapter }))
      .toEqual({ status: 'target_unresolved' });
  });
});
