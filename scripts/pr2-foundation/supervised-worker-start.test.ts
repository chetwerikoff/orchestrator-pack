import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runSupervisedWorkerStart } from './supervised-worker-start.ts';
import { createProductionFleetNudgeEffects } from './fleet-nudge-production.ts';
import { buildFleetAssignmentBindings } from './fleet-assignment-binding.ts';
import type { RuntimeAdapter, RuntimeWorker } from '../runtime/contracts.ts';
import {
  assignmentStillCurrent,
  currentWorkerAssignment,
  listCurrentWorkerAssignments,
  publishCurrentWorkerAssignment,
  resolveWorkerAssignmentStorePath,
  withCurrentWorkerAssignmentFence,
} from '../lib/worker-assignment-store.ts';

const roots: string[] = [];
function root(): string {
  const value = mkdtempSync(path.join(tmpdir(), 'opk-1420-start-'));
  roots.push(value);
  return value;
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe('supervised worker start binding', () => {
  it('publishes only a persistence-safe dispatch binding after ready', async () => {
    const base = root();
    const env = { ...process.env, OPK_BASE_DIR: base };
    const result = await runSupervisedWorkerStart({
      issueNumber: 1420,
      repository: 'chetwerikoff/orchestrator-pack',
      env,
      orcaArgs: ['--task', 'task_1', '--agent', 'codex'],
      execute: async () => ({
        ok: true,
        stdout: JSON.stringify({
          runId: 'run_1', taskId: 'task_1', dispatchId: 'ctx_1', state: 'ready',
          effects: [{ kind: 'terminal', id: 'term_secret_runtime_id' }],
        }),
      }),
    });
    expect(result.ok).toBe(true);
    const file = resolveWorkerAssignmentStorePath('orchestrator-pack', env);
    const assignment = currentWorkerAssignment(file, 1420);
    expect(assignment).toMatchObject({
      issueNumber: 1420,
      taskId: 'task_1',
      kind: 'local',
      provider: 'orca',
      bindingKey: 'ctx_1',
      generation: 1,
    });
    const persisted = readFileSync(file, 'utf8');
    expect(persisted).not.toContain('term_secret_runtime_id');
  });

  it('does not publish an assignment for unknown or failed start', async () => {
    const base = root();
    const env = { ...process.env, OPK_BASE_DIR: base };
    const result = await runSupervisedWorkerStart({
      issueNumber: 1420,
      repository: 'chetwerikoff/orchestrator-pack',
      env,
      orcaArgs: ['--task', 'task_1', '--agent', 'codex'],
      execute: async () => ({
        ok: false,
        stdout: JSON.stringify({ taskId: 'task_1', dispatchId: 'ctx_1', state: 'outcome_unknown' }),
      }),
    });
    expect(result.ok).toBe(false);
    expect(currentWorkerAssignment(resolveWorkerAssignmentStorePath('orchestrator-pack', env), 1420)).toBeNull();
  });

  it('rejects a ready receipt for a different task without publishing an assignment', async () => {
    const base = root();
    const env = { ...process.env, OPK_BASE_DIR: base };
    const result = await runSupervisedWorkerStart({
      issueNumber: 1420,
      repository: 'chetwerikoff/orchestrator-pack',
      env,
      orcaArgs: ['--task', 'task_expected', '--agent', 'codex'],
      execute: async () => ({
        ok: true,
        stdout: JSON.stringify({ taskId: 'task_other', dispatchId: 'ctx_other', state: 'ready' }),
      }),
    });
    expect(result).toMatchObject({ ok: false, reason: 'supervised_start_task_mismatch' });
    expect(currentWorkerAssignment(resolveWorkerAssignmentStorePath('orchestrator-pack', env), 1420)).toBeNull();
  });

  it('advances generation on reassignment and makes the prior assignment stale', async () => {
    const base = root();
    const env = { ...process.env, OPK_BASE_DIR: base };
    const invoke = (dispatchId: string) => runSupervisedWorkerStart({
      issueNumber: 1420,
      repository: 'chetwerikoff/orchestrator-pack',
      env,
      orcaArgs: ['--task', 'task_1', '--agent', 'codex'],
      execute: async () => ({
        ok: true,
        stdout: JSON.stringify({ taskId: 'task_1', dispatchId, state: 'ready' }),
      }),
    });
    const first = await invoke('ctx_1');
    const second = await invoke('ctx_2');
    expect(first.assignment?.generation).toBe(1);
    expect(second.assignment?.generation).toBe(2);
    expect(second.assignment?.assignmentId).not.toBe(first.assignment?.assignmentId);
  });

  it('rejects a fenced effect when its assignment generation was already superseded', async () => {
    const base = root();
    const env = { ...process.env, OPK_BASE_DIR: base };
    const file = resolveWorkerAssignmentStorePath('orchestrator-pack', env);
    const first = await publishCurrentWorkerAssignment({
      file,
      repository: 'chetwerikoff/orchestrator-pack',
      issueNumber: 1420,
      taskId: 'task_1',
      kind: 'local',
      provider: 'orca',
      bindingKey: 'ctx_1',
    });
    const second = await publishCurrentWorkerAssignment({
      file,
      repository: 'chetwerikoff/orchestrator-pack',
      issueNumber: 1420,
      taskId: 'task_2',
      kind: 'local',
      provider: 'orca',
      bindingKey: 'ctx_2',
    });
    if (!first.ok || !second.ok) throw new Error('fixture publication failed');
    let effects = 0;
    const fenced = await withCurrentWorkerAssignmentFence(file, first.assignment, () => {
      effects += 1;
      return 'sent';
    });
    expect(fenced).toEqual({ ok: false, reason: 'assignment_stale' });
    expect(effects).toBe(0);
    expect(assignmentStillCurrent(file, second.assignment)).toBe(true);
  });

  it('blocks stale S2 dispatch when reassignment lands after initial revalidation', async () => {
    const base = root();
    const env = { ...process.env, OPK_BASE_DIR: base };
    const file = resolveWorkerAssignmentStorePath('orchestrator-pack', env);
    const first = await publishCurrentWorkerAssignment({
      file,
      repository: 'chetwerikoff/orchestrator-pack',
      issueNumber: 1420,
      taskId: 'task_1',
      kind: 'local',
      provider: 'orca',
      bindingKey: 'ctx_1',
    });
    if (!first.ok) throw new Error(first.reason);

    const worker: RuntimeWorker = {
      identity: { runtime: 'orca', id: 'worker-1', generation: 'generation-1' },
      workspacePath: base,
      title: 'worker-1',
      provenance: 'internal',
    };
    let sends = 0;
    const adapter: RuntimeAdapter = {
      id: 'orca',
      readiness: () => ({ status: 'ok', value: { ready: true, workspacePath: base } }),
      listWorkers: () => ({ status: 'ok', value: [worker] }),
      findWorkerById: () => ({ status: 'ok', value: worker }),
      findWorker: () => ({ status: 'ok', value: worker }),
      resolveAssignmentWorker: ({ bindingKey }) => ({
        status: 'ok',
        value: bindingKey === 'ctx_1' ? worker : null,
      }),
      spawnWorker: () => ({ status: 'ok', value: worker }),
      dispatchInput: () => {
        sends += 1;
        return { status: 'dispatched' };
      },
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
      liveness: () => ({ status: 'busy', worker: worker.identity }),
      stopWorker: () => ({ status: 'ok', value: { stopped: true } }),
    };
    const resolvedAssignments = [{ assignment: first.assignment, worker }];
    const fleetBindings = buildFleetAssignmentBindings(resolvedAssignments);
    if (!fleetBindings || fleetBindings.length !== 1) throw new Error('fixture fleet binding failed');
    const fleetBinding = fleetBindings[0]!;
    const effects = createProductionFleetNudgeEffects({
      projectId: 'orchestrator-pack',
      assignmentStorePath: file,
      adapter,
      resolvedAssignments,
      fleetBindings,
      assertEpoch: () => {},
      env,
    });
    const target = await effects.resolveTarget({
      projectId: 'orchestrator-pack',
      schedulerGeneration: 'scheduler-generation-1',
      tickSequence: 1,
      transitionIdentity: 'transition-1',
      unitRef: fleetBinding.unitRef,
      eligibleClass: 'idle',
      intentClass: 'task-continuation',
      policyTag: 's2-one-shot-v1',
    }, { deadlineMs: Date.now() + 5_000 });
    expect(target.status).toBe('resolved');
    if (target.status !== 'resolved') throw new Error(target.status);
    expect(await effects.revalidate(target.binding, { deadlineMs: Date.now() + 5_000 })).toEqual({ status: 'valid' });

    const second = await publishCurrentWorkerAssignment({
      file,
      repository: 'chetwerikoff/orchestrator-pack',
      issueNumber: 1420,
      taskId: 'task_2',
      kind: 'local',
      provider: 'orca',
      bindingKey: 'ctx_2',
    });
    if (!second.ok) throw new Error(second.reason);
    const dispatch = await effects.dispatch(target.binding, 'continue', { deadlineMs: Date.now() + 5_000 });
    expect(dispatch).toMatchObject({ status: 'send_failed' });
    expect(sends).toBe(0);
    expect(assignmentStillCurrent(file, second.assignment)).toBe(true);
  });

  it('serializes reassignment against the final fenced effect boundary', async () => {
    const base = root();
    const env = { ...process.env, OPK_BASE_DIR: base };
    const file = resolveWorkerAssignmentStorePath('orchestrator-pack', env);
    const first = await publishCurrentWorkerAssignment({
      file,
      repository: 'chetwerikoff/orchestrator-pack',
      issueNumber: 1420,
      taskId: 'task_1',
      kind: 'local',
      provider: 'orca',
      bindingKey: 'ctx_1',
    });
    if (!first.ok) throw new Error(first.reason);

    let enterFence!: () => void;
    const entered = new Promise<void>((resolve) => { enterFence = resolve; });
    let releaseFence!: () => void;
    const release = new Promise<void>((resolve) => { releaseFence = resolve; });
    const fenced = withCurrentWorkerAssignmentFence(file, first.assignment, async () => {
      enterFence();
      await release;
      return 'sent';
    });
    await entered;

    const reassignment = publishCurrentWorkerAssignment({
      file,
      repository: 'chetwerikoff/orchestrator-pack',
      issueNumber: 1420,
      taskId: 'task_2',
      kind: 'local',
      provider: 'orca',
      bindingKey: 'ctx_2',
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(assignmentStillCurrent(file, first.assignment)).toBe(true);
    releaseFence();

    expect(await fenced).toEqual({ ok: true, value: 'sent' });
    const second = await reassignment;
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error(second.reason);
    expect(second.assignment.generation).toBe(2);
    expect(assignmentStillCurrent(file, second.assignment)).toBe(true);
  });

  it('serializes concurrent ready publications without losing either issue assignment', async () => {
    const base = root();
    const env = { ...process.env, OPK_BASE_DIR: base };
    const invoke = (issueNumber: number, taskId: string, dispatchId: string) => runSupervisedWorkerStart({
      issueNumber,
      repository: 'chetwerikoff/orchestrator-pack',
      env,
      orcaArgs: ['--task', taskId, '--agent', 'codex'],
      execute: async () => ({
        ok: true,
        stdout: JSON.stringify({ taskId, dispatchId, state: 'ready' }),
      }),
    });
    const [first, second] = await Promise.all([
      invoke(1420, 'task_1420', 'ctx_1420'),
      invoke(1421, 'task_1421', 'ctx_1421'),
    ]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    const assignments = listCurrentWorkerAssignments(resolveWorkerAssignmentStorePath('orchestrator-pack', env));
    expect(assignments?.map((assignment) => assignment.issueNumber).sort((a, b) => a - b)).toEqual([1420, 1421]);
  });
});
