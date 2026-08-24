// @vitest-ci-lane light
// @vitest-pre-topology-seconds 60
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  publishCurrentWorkerAssignment,
  readOperatorPrimaryBinding,
  resolveWorkerAssignmentStorePath,
} from './lib/worker-assignment-store.ts';
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

  it('retires only the exact current pointer and show then proves absence for downgrade', async () => {
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
  });

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
