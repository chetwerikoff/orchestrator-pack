import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  attachWorkerAssignmentIssueNumber,
  parseWorkerAssignmentStore,
  readWorkerAssignmentStore,
  resolveWorkerAssignmentStorePath,
  workerAssignmentKey,
} from '../lib/worker-assignment-store.ts';
import { runSupervisedWorkerStart } from './supervised-worker-start.ts';

function placementInspect() {
  return vi.fn(async (args: readonly string[]) => {
    const operation = `${args[0] ?? ''} ${args[1] ?? ''}`;
    if (operation === 'terminal show') {
      return {
        ok: true,
        stdout: JSON.stringify({
          ok: true,
          result: { terminal: { handle: 'terminal-1441', worktreeId: 'worktree-1441' } },
        }),
      };
    }
    if (operation === 'worktree show') {
      return {
        ok: true,
        stdout: JSON.stringify({ ok: true, result: { worktree: { id: 'worktree-1441' } } }),
      };
    }
    return { ok: false, stdout: '' };
  });
}

function successEnvelope(taskId = 'brief-task', dispatchId = 'dispatch-1441') {
  return {
    ok: true,
    stdout: JSON.stringify({
      ok: true,
      result: {
        state: 'ready',
        taskId,
        dispatchId,
        effects: [
          { kind: 'worktree', id: 'worktree-1441', action: 'reused' },
          { kind: 'terminal', role: 'agent', id: 'terminal-1441', action: 'reused' },
          { kind: 'dispatch_input', role: 'agent', id: 'terminal-1441' },
        ],
      },
    }),
  };
}

function rootEnv(root: string): NodeJS.ProcessEnv {
  return { ...process.env, HOME: root, OPK_BASE_DIR: root };
}

function startInput(root: string) {
  return {
    repository: 'chetwerikoff/orchestrator-pack',
    env: rootEnv(root),
    orcaArgs: [
      '--task', 'brief-task',
      '--terminal', 'terminal-1441',
      '--worktree', 'worktree-1441',
    ],
    inspect: placementInspect(),
  } as const;
}

describe('Issue #1441 supervised-start authority', () => {
  it('preserves an exact Orca error code instead of laundering it into invalid receipt', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-1441-error-'));
    try {
      const result = await runSupervisedWorkerStart({
        ...startInput(root),
        execute: async () => ({
          ok: false,
          stdout: JSON.stringify({
            ok: false,
            error: { code: 'agent_unconfigured', message: 'agent is not configured' },
          }),
        }),
      });
      expect(result).toEqual({
        ok: false,
        reason: 'supervised_start_envelope_error',
        errorCode: 'agent_unconfigured',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps malformed and code-less error envelopes on the generic invalid path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-1441-invalid-'));
    try {
      const malformed = await runSupervisedWorkerStart({
        ...startInput(root),
        execute: async () => ({ ok: false, stdout: '{not-json' }),
      });
      expect(malformed).toEqual({ ok: false, reason: 'supervised_start_receipt_invalid' });

      const codeLess = await runSupervisedWorkerStart({
        ...startInput(root),
        execute: async () => ({
          ok: false,
          stdout: JSON.stringify({ ok: false, error: { message: 'missing code' } }),
        }),
      });
      expect(codeLess).toEqual({ ok: false, reason: 'supervised_start_receipt_invalid' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('publishes a brief-only successful start under the sole taskId+dispatchId key', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-1441-brief-'));
    try {
      const result = await runSupervisedWorkerStart({
        ...startInput(root),
        execute: async () => successEnvelope(),
      });
      expect(result.ok).toBe(true);
      if (!result.ok || !result.assignment) throw new Error('expected assignment');
      expect(result.reason).toBe('ready_and_assignment_bound');
      expect(result.assignment.issueNumber).toBeUndefined();
      expect(result.assignment.taskId).toBe('brief-task');
      expect(result.assignment.bindingKey).toBe('dispatch-1441');

      const file = resolveWorkerAssignmentStorePath(undefined, rootEnv(root));
      const store = readWorkerAssignmentStore(file);
      expect(store).not.toBeNull();
      const key = workerAssignmentKey('brief-task', 'dispatch-1441');
      expect(Object.keys(store!.assignments)).toEqual([key]);
      expect(store!.assignments[key]).toEqual(result.assignment);

      const attached = await attachWorkerAssignmentIssueNumber({
        file,
        expected: result.assignment,
        issueNumber: 1441,
      });
      expect(attached.ok).toBe(true);
      if (!attached.ok) throw new Error(attached.reason);
      expect(attached.assignment.assignmentId).toBe(result.assignment.assignmentId);
      expect(attached.assignment.generation).toBe(result.assignment.generation);
      expect(attached.assignment.issueNumber).toBe(1441);
      const after = readWorkerAssignmentStore(file)!;
      expect(Object.keys(after.assignments)).toEqual([key]);
      expect(after.assignments[key]?.issueNumber).toBe(1441);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed on a previously valid issue-N v1 store and never converts it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-1441-hard-cut-'));
    try {
      const file = resolveWorkerAssignmentStorePath(undefined, rootEnv(root));
      mkdirSync(dirname(file), { recursive: true });
      const oldAssignment = {
        schema: 'orchestrator-pack/worker-assignment/v1',
        projectId: 'orchestrator-pack',
        repository: 'chetwerikoff/orchestrator-pack',
        issueNumber: 1441,
        taskId: 'old-task',
        assignmentId: 'wa-old',
        generation: 1,
        kind: 'local',
        provider: 'orca',
        bindingKey: 'dispatch-old',
        createdAtUtc: '2026-08-17T00:00:00.000Z',
      };
      const oldBytes = `${JSON.stringify({
        schema: 'orchestrator-pack/worker-assignment-store/v1',
        revision: 1,
        assignments: { 'issue-1441': oldAssignment },
      }, null, 2)}\n`;
      writeFileSync(file, oldBytes);
      expect(parseWorkerAssignmentStore(oldBytes)).toBeNull();

      const result = await runSupervisedWorkerStart({
        ...startInput(root),
        execute: async () => successEnvelope(),
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('assignment_store_untrusted');
      expect(readFileSync(file, 'utf8')).toBe(oldBytes);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
