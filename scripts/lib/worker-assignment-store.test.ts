// @vitest-ci-lane light
// @vitest-pre-topology-seconds 60
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withCrashRecoverableFileLock } from '../pr2-foundation/journal-lock.ts';
import {
  assignmentStillCurrent,
  currentWorkerAssignment,
  publishCurrentWorkerAssignment,
  resolveWorkerAssignmentStorePath,
  withCurrentWorkerAssignmentFence,
} from './worker-assignment-store.ts';

const roots: string[] = [];

function fixture(): { readonly root: string; readonly file: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'opk-1416-assignment-'));
  roots.push(root);
  return {
    root,
    file: resolveWorkerAssignmentStorePath('orchestrator-pack', {
      ...process.env,
      OPK_BASE_DIR: root,
    }),
  };
}

function publishInput(file: string, bindingKey: string) {
  return {
    file,
    repository: 'chetwerikoff/orchestrator-pack',
    issueNumber: 1416,
    taskId: 'task-1416',
    kind: 'local' as const,
    provider: 'orca',
    bindingKey,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('WorkerAssignment compare-and-publish', () => {
  it('mints identity and monotonically advances only from the exact expected current assignment', async () => {
    const { file } = fixture();
    const first = await publishCurrentWorkerAssignment(publishInput(file, 'dispatch-1'));
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.reason);
    expect(first.assignment).toMatchObject({
      assignmentId: expect.stringMatching(/^wa-/u),
      generation: 1,
      bindingKey: 'dispatch-1',
    });

    const replacement = await publishCurrentWorkerAssignment({
      ...publishInput(file, 'dispatch-2'),
      expectedCurrent: {
        assignmentId: first.assignment.assignmentId,
        generation: first.assignment.generation,
      },
    });
    expect(replacement.ok).toBe(true);
    if (!replacement.ok) throw new Error(replacement.reason);
    expect(replacement.assignment.generation).toBe(2);
    expect(replacement.assignment.assignmentId).not.toBe(first.assignment.assignmentId);
    expect(replacement.assignment.bindingKey).toBe('dispatch-2');
    expect(assignmentStillCurrent(file, replacement.assignment)).toBe(true);
  });

  it('treats a missing expectation as expect-none and rejects overwrite of an existing row', async () => {
    const { file } = fixture();
    const first = await publishCurrentWorkerAssignment(publishInput(file, 'dispatch-1'));
    if (!first.ok) throw new Error(first.reason);

    const stale = await publishCurrentWorkerAssignment(publishInput(file, 'dispatch-unconditional'));
    expect(stale).toEqual({ ok: false, reason: 'assignment_stale' });
    expect(assignmentStillCurrent(file, first.assignment)).toBe(true);
  });

  it('rejects a stale exact expectation without mutating the current row', async () => {
    const { file } = fixture();
    const first = await publishCurrentWorkerAssignment(publishInput(file, 'dispatch-1'));
    if (!first.ok) throw new Error(first.reason);

    const stale = await publishCurrentWorkerAssignment({
      ...publishInput(file, 'dispatch-stale'),
      expectedCurrent: {
        assignmentId: first.assignment.assignmentId,
        generation: first.assignment.generation + 1,
      },
    });
    expect(stale).toEqual({ ok: false, reason: 'assignment_stale' });
    expect(currentWorkerAssignment(file, 1416)).toEqual(first.assignment);
  });

  it('allows only one publisher to win when two replacements name the same current assignment', async () => {
    const { file } = fixture();
    const first = await publishCurrentWorkerAssignment(publishInput(file, 'dispatch-1'));
    if (!first.ok) throw new Error(first.reason);
    const expectedCurrent = {
      assignmentId: first.assignment.assignmentId,
      generation: first.assignment.generation,
    };

    const [left, right] = await Promise.all([
      publishCurrentWorkerAssignment({ ...publishInput(file, 'dispatch-left'), expectedCurrent }),
      publishCurrentWorkerAssignment({ ...publishInput(file, 'dispatch-right'), expectedCurrent }),
    ]);
    const winners = [left, right].filter((result) => result.ok);
    const losers = [left, right].filter((result) => !result.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]).toEqual({ ok: false, reason: 'assignment_stale' });
    if (!winners[0]?.ok) throw new Error('expected one publication winner');
    expect(currentWorkerAssignment(file, 1416)).toEqual(winners[0].assignment);
  });

  it('reports assignment_store_busy as a proven pre-action failure with zero action', async () => {
    const { file } = fixture();
    const first = await publishCurrentWorkerAssignment(publishInput(file, 'dispatch-1'));
    if (!first.ok) throw new Error(first.reason);

    let release!: () => void;
    const held = withCrashRecoverableFileLock(`${file}.lock`, 1, async () => {
      await new Promise<void>((resolve) => { release = resolve; });
    });
    while (!release) await new Promise((resolve) => setTimeout(resolve, 1));

    let effects = 0;
    const fenced = await withCurrentWorkerAssignmentFence(file, first.assignment, () => {
      effects += 1;
    });
    expect(fenced).toEqual({ ok: false, reason: 'assignment_store_busy', actionEntered: false });
    expect(effects).toBe(0);
    release();
    await held;
    expect(assignmentStillCurrent(file, first.assignment)).toBe(true);
  });

  it('marks generic fence failure as post-entry when the action has already begun', async () => {
    const { file } = fixture();
    const first = await publishCurrentWorkerAssignment(publishInput(file, 'dispatch-1'));
    if (!first.ok) throw new Error(first.reason);

    let effects = 0;
    const fenced = await withCurrentWorkerAssignmentFence(file, first.assignment, () => {
      effects += 1;
      throw new Error('post-reservation-failure');
    });
    expect(fenced).toEqual({ ok: false, reason: 'assignment_fence_failed', actionEntered: true });
    expect(effects).toBe(1);
    expect(assignmentStillCurrent(file, first.assignment)).toBe(true);
  });
});
