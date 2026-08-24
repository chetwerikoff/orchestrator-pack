// @vitest-ci-lane light
// @vitest-pre-topology-seconds 60
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeAdapter } from './runtime/contracts.ts';
import {
  currentWorkerAssignmentByDeliverable,
  publishCurrentWorkerAssignment,
  readOperatorPrimaryBinding,
  resolveWorkerAssignmentStorePath,
  workerAssignmentKey,
  WORKER_ASSIGNMENT_SCHEMA,
  WORKER_ASSIGNMENT_STORE_SCHEMA,
} from './lib/worker-assignment-store.ts';
import {
  operatorPrimarySyncResult,
  withCurrentOperatorPrimaryTarget,
} from './lib/operator-primary-target.ts';
import {
  parseOperatorPrimaryBindingArgs,
  runOperatorPrimaryBindingCommand,
} from './operator-primary-binding.ts';

const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'opk-1532-primary-cli-'));
  roots.push(root);
  const env = { ...process.env, OPK_BASE_DIR: root };
  return {
    env,
    file: resolveWorkerAssignmentStorePath('orchestrator-pack', env),
  };
}

async function publish(file: string, taskId: string, bindingKey: string, issueNumber: number) {
  const result = await publishCurrentWorkerAssignment({
    file,
    repository: 'chetwerikoff/orchestrator-pack',
    issueNumber,
    taskId,
    kind: 'local',
    provider: 'orca',
    bindingKey,
    role: 'worker',
  });
  if (!result.ok) throw new Error(result.reason);
  return result.assignment;
}

/**
 * Minimal pre-#1532 v1 parser/writer fixture. The historical writer knew only
 * schema/revision/assignments at the store level, so its rewrite deliberately
 * drops any unknown top-level field after validating the historical assignment
 * identity needed by that writer.
 */
function rewriteWithPre1532WorkerAssignmentStore(raw: string): string {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (parsed.schema !== WORKER_ASSIGNMENT_STORE_SCHEMA
    || !Number.isInteger(parsed.revision) || Number(parsed.revision) < 0
    || !parsed.assignments || typeof parsed.assignments !== 'object' || Array.isArray(parsed.assignments)) {
    throw new Error('pre-1532 store fixture rejected store shape');
  }

  const assignments = parsed.assignments as Record<string, unknown>;
  for (const [key, value] of Object.entries(assignments)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('pre-1532 store fixture rejected assignment row');
    }
    const row = value as Record<string, unknown>;
    if (row.schema !== WORKER_ASSIGNMENT_SCHEMA
      || typeof row.taskId !== 'string'
      || typeof row.bindingKey !== 'string'
      || typeof row.assignmentId !== 'string'
      || !Number.isInteger(row.generation) || Number(row.generation) <= 0
      || workerAssignmentKey(row.taskId, row.bindingKey) !== key) {
      throw new Error('pre-1532 store fixture rejected assignment identity');
    }
  }

  return `${JSON.stringify({
    schema: WORKER_ASSIGNMENT_STORE_SCHEMA,
    revision: Number(parsed.revision) + 1,
    assignments,
  }, null, 2)}\n`;
}

const malformedPointerOverrides: ReadonlyArray<readonly [string, Readonly<Record<string, unknown>>]> = [
  ['string assignment generation', { assignmentGeneration: '1' }],
  ['boolean assignment generation', { assignmentGeneration: true }],
  ['non-string task id', { taskId: 1532 }],
  ['non-string binding key', { bindingKey: ['dispatch-1532'] }],
  ['non-string assignment id', { assignmentId: { value: 'wa-1' } }],
];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('operator-primary binding CLI', () => {
  it('requires explicit operator attestation for mutation commands', () => {
    expect(() => parseOperatorPrimaryBindingArgs(['bind', '--task-id', 'task-1', '--binding-key', 'dispatch-1']))
      .toThrow('mutations require --operator-attested');
    expect(() => parseOperatorPrimaryBindingArgs(['retire',
      '--expected-task-id', 'task-1',
      '--expected-binding-key', 'dispatch-1',
      '--expected-assignment-id', 'wa-1',
      '--expected-assignment-generation', '1',
    ])).toThrow('mutations require --operator-attested');
  });

  it('binds and shows only persistence-safe logical binding facts', async () => {
    const { env, file } = fixture();
    const assignment = await publish(file, 'task-1532', 'dispatch-1532', 1532);
    const bind = parseOperatorPrimaryBindingArgs([
      'bind', '--task-id', assignment.taskId, '--binding-key', assignment.bindingKey, '--operator-attested',
    ]);
    expect(await runOperatorPrimaryBindingCommand(bind, env)).toEqual({
      ok: true,
      binding: {
        route: 'operator-primary',
        taskId: assignment.taskId,
        bindingKey: assignment.bindingKey,
        assignmentId: assignment.assignmentId,
        assignmentGeneration: assignment.generation,
      },
    });

    const shown = await runOperatorPrimaryBindingCommand(parseOperatorPrimaryBindingArgs(['show']), env);
    expect(shown).toEqual({
      ok: true,
      status: 'binding_current',
      binding: {
        route: 'operator-primary',
        taskId: assignment.taskId,
        bindingKey: assignment.bindingKey,
        assignmentId: assignment.assignmentId,
        assignmentGeneration: assignment.generation,
      },
    });
    const serialized = JSON.stringify(shown);
    expect(serialized).not.toContain('runtime');
    expect(serialized).not.toContain('generation":"incarnation');
    expect(serialized).not.toContain('workspace');
    expect(serialized).not.toContain('title');
    expect(serialized).not.toContain('pid');
  });

  it('replaces only from the exact observed pointer and never blind-overwrites', async () => {
    const { env, file } = fixture();
    const first = await publish(file, 'task-first', 'dispatch-first', 1532);
    const second = await publish(file, 'task-second', 'dispatch-second', 1533);
    await runOperatorPrimaryBindingCommand(parseOperatorPrimaryBindingArgs([
      'bind', '--task-id', first.taskId, '--binding-key', first.bindingKey, '--operator-attested',
    ]), env);
    const current = readOperatorPrimaryBinding(file);
    if (!current.ok || current.status !== 'binding_current') throw new Error('expected current binding');

    const stale = parseOperatorPrimaryBindingArgs([
      'replace', '--task-id', second.taskId, '--binding-key', second.bindingKey,
      '--expected-task-id', current.binding.taskId,
      '--expected-binding-key', current.binding.bindingKey,
      '--expected-assignment-id', current.binding.assignmentId,
      '--expected-assignment-generation', String(current.binding.assignmentGeneration + 1),
      '--operator-attested',
    ]);
    expect(await runOperatorPrimaryBindingCommand(stale, env)).toEqual({ ok: false, reason: 'binding_conflict' });

    const exact = parseOperatorPrimaryBindingArgs([
      'replace', '--task-id', second.taskId, '--binding-key', second.bindingKey,
      '--expected-task-id', current.binding.taskId,
      '--expected-binding-key', current.binding.bindingKey,
      '--expected-assignment-id', current.binding.assignmentId,
      '--expected-assignment-generation', String(current.binding.assignmentGeneration),
      '--operator-attested',
    ]);
    const replaced = await runOperatorPrimaryBindingCommand(exact, env);
    expect(replaced).toMatchObject({ ok: true, binding: { taskId: second.taskId, bindingKey: second.bindingKey } });
  });

  it('preserves the exact pointer across an unrelated WorkerAssignment replacement', async () => {
    const { env, file } = fixture();
    const primary = await publish(file, 'task-primary', 'dispatch-primary', 1532);
    await runOperatorPrimaryBindingCommand(parseOperatorPrimaryBindingArgs([
      'bind', '--task-id', primary.taskId, '--binding-key', primary.bindingKey, '--operator-attested',
    ]), env);
    const before = readOperatorPrimaryBinding(file);
    if (!before.ok || before.status !== 'binding_current') throw new Error('expected current binding');

    const unrelated = await publish(file, 'task-unrelated', 'dispatch-unrelated', 1533);
    const replacement = await publishCurrentWorkerAssignment({
      file,
      repository: 'chetwerikoff/orchestrator-pack',
      issueNumber: 1533,
      taskId: 'task-unrelated',
      kind: 'local',
      provider: 'orca',
      bindingKey: 'dispatch-unrelated-v2',
      role: 'worker',
      expectedCurrent: {
        assignmentId: unrelated.assignmentId,
        generation: unrelated.generation,
      },
    });
    expect(replacement.ok).toBe(true);
    expect(readOperatorPrimaryBinding(file)).toMatchObject({
      ok: true,
      status: 'binding_current',
      binding: before.binding,
    });
  });

  it('retires the exact pointer and proves the post-retire store through a pre-#1532 writer', async () => {
    const { env, file } = fixture();
    const assignment = await publish(file, 'task-1532', 'dispatch-1532', 1532);
    await runOperatorPrimaryBindingCommand(parseOperatorPrimaryBindingArgs([
      'bind', '--task-id', assignment.taskId, '--binding-key', assignment.bindingKey, '--operator-attested',
    ]), env);
    const current = readOperatorPrimaryBinding(file);
    if (!current.ok || current.status !== 'binding_current') throw new Error('expected current binding');

    const retire = parseOperatorPrimaryBindingArgs([
      'retire',
      '--expected-task-id', current.binding.taskId,
      '--expected-binding-key', current.binding.bindingKey,
      '--expected-assignment-id', current.binding.assignmentId,
      '--expected-assignment-generation', String(current.binding.assignmentGeneration),
      '--operator-attested',
    ]);
    expect(await runOperatorPrimaryBindingCommand(retire, env)).toEqual({ ok: true, binding: null });
    expect(await runOperatorPrimaryBindingCommand(parseOperatorPrimaryBindingArgs(['show']), env))
      .toEqual({ ok: true, status: 'binding_absent', binding: null });

    const postRetireBytes = readFileSync(file, 'utf8');
    const historicalRewrite = rewriteWithPre1532WorkerAssignmentStore(postRetireBytes);
    writeFileSync(file, historicalRewrite);

    expect(readOperatorPrimaryBinding(file)).toEqual({ ok: true, status: 'binding_absent', binding: null });
    expect(currentWorkerAssignmentByDeliverable(file, assignment.taskId, assignment.bindingKey)).toEqual(assignment);
    expect(JSON.parse(readFileSync(file, 'utf8'))).not.toHaveProperty('operatorPrimary');
  });

  it.each(malformedPointerOverrides)(
    'fails closed on persisted operator-primary with %s',
    async (_label, override) => {
      const { file } = fixture();
      const assignment = await publish(file, 'task-1532', 'dispatch-1532', 1532);
      const store = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      store.operatorPrimary = {
        route: 'operator-primary',
        taskId: assignment.taskId,
        bindingKey: assignment.bindingKey,
        assignmentId: assignment.assignmentId,
        assignmentGeneration: assignment.generation,
        ...override,
      };
      writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`);

      let calls = 0;
      const result = await withCurrentOperatorPrimaryTarget(
        { file, adapter: {} as RuntimeAdapter, timeoutMs: 250 },
        () => {
          calls += 1;
          return operatorPrimarySyncResult('unexpected');
        },
      );
      expect(result).toEqual({ ok: false, actionEntered: false, reason: 'assignment_untrusted' });
      expect(calls).toBe(0);
      expect(readOperatorPrimaryBinding(file)).toEqual({
        ok: false,
        reason: 'assignment_store_untrusted',
        cause: 'store_shape_invalid',
      });
    },
  );

  it('rejects malformed/duplicate CLI flags instead of guessing', () => {
    expect(() => parseOperatorPrimaryBindingArgs(['show', '--project-id']))
      .toThrow('missing value for --project-id');
    expect(() => parseOperatorPrimaryBindingArgs([
      'bind', '--task-id', 'task-1', '--task-id', 'task-2', '--binding-key', 'dispatch', '--operator-attested',
    ])).toThrow('duplicate argument: --task-id');
    expect(() => parseOperatorPrimaryBindingArgs(['unknown']))
      .toThrow('command must be show, bind, replace, or retire');
  });
});