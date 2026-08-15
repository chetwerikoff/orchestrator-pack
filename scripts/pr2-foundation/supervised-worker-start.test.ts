import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runSupervisedWorkerStart } from './supervised-worker-start.ts';
import {
  currentWorkerAssignment,
  resolveWorkerAssignmentStorePath,
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
});
