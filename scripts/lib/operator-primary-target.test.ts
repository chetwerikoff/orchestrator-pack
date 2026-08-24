// @vitest-ci-lane light
// @vitest-pre-topology-seconds 60
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withCrashRecoverableFileLock } from '../pr2-foundation/journal-lock.ts';
import type { RuntimeAdapter, RuntimeWorker } from '../runtime/contracts.ts';
import {
  attachWorkerAssignmentIssueNumber,
  bindOperatorPrimary,
  publishCurrentWorkerAssignment,
  readOperatorPrimaryBinding,
  resolveWorkerAssignmentStorePath,
  retireOperatorPrimary,
  workerAssignmentKey,
  WORKER_ASSIGNMENT_SCHEMA,
  WORKER_ASSIGNMENT_STORE_SCHEMA,
} from './worker-assignment-store.ts';
import {
  operatorPrimarySyncResult,
  withCurrentOperatorPrimaryTarget,
} from './operator-primary-target.ts';

const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'opk-1532-primary-'));
  roots.push(root);
  const env = { ...process.env, OPK_BASE_DIR: root };
  return {
    root,
    env,
    file: resolveWorkerAssignmentStorePath('orchestrator-pack', env),
  };
}

function worker(id = 'terminal-1', generation = 'incarnation-1'): RuntimeWorker {
  return {
    identity: { runtime: 'orca', id, generation },
    workspacePath: `/tmp/${id}`,
    title: null,
    provenance: 'internal',
  };
}

function runtime(input: {
  readonly resolved?: RuntimeWorker | 'gone';
  readonly found?: RuntimeWorker | null;
  readonly resolveFailure?: boolean;
  readonly findFailure?: boolean;
} = {}): RuntimeAdapter {
  const resolved = input.resolved ?? worker();
  const found = input.found === undefined ? (resolved === 'gone' ? null : resolved) : input.found;
  return {
    id: 'orca',
    readiness: () => ({ status: 'ok', value: { ready: true, workspacePath: '/tmp' } }),
    listWorkers: () => ({ status: 'ok', value: found ? [found] : [] }),
    findWorkerById: () => ({ status: 'ok', value: found }),
    findWorker: vi.fn(() => input.findFailure
      ? { status: 'failed', operation: 'find_worker', reason: 'unavailable' }
      : { status: 'ok', value: found }),
    resolveAssignmentWorker: vi.fn(() => input.resolveFailure
      ? { status: 'failed', operation: 'resolve_assignment_worker', reason: 'unavailable' }
      : {
          status: 'ok',
          value: resolved === 'gone' ? { kind: 'gone' } : { kind: 'resolved', worker: resolved },
        }),
    spawnWorker: () => ({ status: 'ok', value: worker('spawned') }),
    dispatchInput: () => ({ status: 'dispatched' }),
    readBoundedOutput: () => ({
      status: 'ok',
      value: {
        worker: worker().identity,
        lines: [],
        observationToken: { opaque: 'token' },
        changed: false,
        terminalState: 'running',
      },
    }),
    liveness: () => ({ status: 'idle', worker: worker().identity }),
    stopWorker: () => ({ status: 'ok', value: { stopped: true } }),
  };
}

async function boundFixture() {
  const data = fixture();
  const published = await publishCurrentWorkerAssignment({
    file: data.file,
    repository: 'chetwerikoff/orchestrator-pack',
    issueNumber: 1532,
    taskId: 'task-1532',
    kind: 'local',
    provider: 'orca',
    bindingKey: 'dispatch-1532',
    role: 'worker',
  });
  if (!published.ok) throw new Error(published.reason);
  const bound = await bindOperatorPrimary({
    file: data.file,
    taskId: published.assignment.taskId,
    bindingKey: published.assignment.bindingKey,
  });
  if (!bound.ok || !bound.binding) throw new Error(bound.ok ? 'binding missing' : bound.reason);
  return { ...data, assignment: published.assignment, binding: bound.binding };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('operator-primary binding authority', () => {
  it('reads a historical v1 store with no pointer and fails closed as binding_absent', async () => {
    const { file } = fixture();
    let calls = 0;
    const result = await withCurrentOperatorPrimaryTarget(
      { file, adapter: runtime(), timeoutMs: 100 },
      () => {
        calls += 1;
        return operatorPrimarySyncResult('unexpected');
      },
    );
    expect(result).toEqual({ ok: false, actionEntered: false, reason: 'binding_absent' });
    expect(calls).toBe(0);
  });

  it('binds exactly one current local assignment and persists only logical identity', async () => {
    const { file } = fixture();
    const published = await publishCurrentWorkerAssignment({
      file,
      repository: 'chetwerikoff/orchestrator-pack',
      issueNumber: 1532,
      taskId: 'task-1532',
      kind: 'local',
      provider: 'orca',
      bindingKey: 'dispatch-1532',
      role: 'worker',
    });
    if (!published.ok) throw new Error(published.reason);
    const bound = await bindOperatorPrimary({
      file,
      taskId: published.assignment.taskId,
      bindingKey: published.assignment.bindingKey,
    });
    expect(bound.ok).toBe(true);
    if (!bound.ok) throw new Error(bound.reason);
    expect(bound.binding).toEqual({
      route: 'operator-primary',
      taskId: 'task-1532',
      bindingKey: 'dispatch-1532',
      assignmentId: published.assignment.assignmentId,
      assignmentGeneration: published.assignment.generation,
    });
    const bytes = readFileSync(file, 'utf8');
    expect(bytes).not.toContain('terminal-');
    expect(bytes).not.toContain('incarnation-');
    expect(bytes).not.toContain('workspacePath');
  });

  it('preserves the exact pointer across issue attachment and unrelated assignment publication', async () => {
    const { file } = fixture();
    const brief = await publishCurrentWorkerAssignment({
      file,
      repository: 'chetwerikoff/orchestrator-pack',
      taskId: 'task-primary',
      kind: 'local',
      provider: 'orca',
      bindingKey: 'dispatch-primary',
      role: 'worker',
    });
    if (!brief.ok) throw new Error(brief.reason);
    const bound = await bindOperatorPrimary({ file, taskId: 'task-primary', bindingKey: 'dispatch-primary' });
    if (!bound.ok || !bound.binding) throw new Error(bound.ok ? 'binding missing' : bound.reason);
    const expected = bound.binding;

    const attached = await attachWorkerAssignmentIssueNumber({ file, expected: brief.assignment, issueNumber: 1532 });
    expect(attached.ok).toBe(true);
    expect(readOperatorPrimaryBinding(file)).toMatchObject({ ok: true, status: 'binding_current', binding: expected });

    const unrelated = await publishCurrentWorkerAssignment({
      file,
      repository: 'chetwerikoff/orchestrator-pack',
      issueNumber: 999,
      taskId: 'task-unrelated',
      kind: 'local',
      provider: 'orca',
      bindingKey: 'dispatch-unrelated',
      role: 'worker',
    });
    expect(unrelated.ok).toBe(true);
    expect(readOperatorPrimaryBinding(file)).toMatchObject({ ok: true, status: 'binding_current', binding: expected });
  });

  it('keeps the old pointer stale when the designated assignment is explicitly replaced', async () => {
    const { file, assignment, binding } = await boundFixture();
    const replacement = await publishCurrentWorkerAssignment({
      file,
      repository: 'chetwerikoff/orchestrator-pack',
      issueNumber: 1532,
      taskId: 'task-1532',
      kind: 'local',
      provider: 'orca',
      bindingKey: 'dispatch-replacement',
      role: 'worker',
      expectedCurrent: { assignmentId: assignment.assignmentId, generation: assignment.generation },
    });
    expect(replacement.ok).toBe(true);
    expect(readOperatorPrimaryBinding(file)).toEqual({ ok: true, status: 'binding_stale', binding });
    let calls = 0;
    const result = await withCurrentOperatorPrimaryTarget({ file, adapter: runtime(), timeoutMs: 100 }, () => {
      calls += 1;
      return operatorPrimarySyncResult('unexpected');
    });
    expect(result).toEqual({ ok: false, actionEntered: false, reason: 'binding_stale' });
    expect(calls).toBe(0);
  });

  it('rejects blind replace and remote designation, and retires only the exact current pointer', async () => {
    const { file, binding } = await boundFixture();
    const blind = await bindOperatorPrimary({ file, taskId: 'task-1532', bindingKey: 'dispatch-1532' });
    expect(blind).toEqual({ ok: false, reason: 'binding_conflict' });

    const retired = await retireOperatorPrimary({ file, expectedCurrent: binding });
    expect(retired).toEqual({ ok: true, binding: null });
    expect(readOperatorPrimaryBinding(file)).toEqual({ ok: true, status: 'binding_absent', binding: null });

    const remote = await publishCurrentWorkerAssignment({
      file,
      repository: 'chetwerikoff/orchestrator-pack',
      issueNumber: 42,
      taskId: 'task-remote',
      kind: 'remote',
      provider: 'browser-gpt',
      bindingKey: 'remote-binding',
      role: 'worker',
    });
    if (!remote.ok) throw new Error(remote.reason);
    expect(await bindOperatorPrimary({ file, taskId: 'task-remote', bindingKey: 'remote-binding' }))
      .toEqual({ ok: false, reason: 'remote_not_applicable' });
  });
});

describe('operator-primary runtime snapshot fence', () => {
  it('resolves, exact-revalidates, and enters one synchronous action with the exact snapshot', async () => {
    const { file } = await boundFixture();
    const exact = worker('terminal-exact', 'incarnation-exact');
    const adapter = runtime({ resolved: exact, found: exact });
    const seen: string[] = [];
    const result = await withCurrentOperatorPrimaryTarget(
      { file, adapter, timeoutMs: 250 },
      (target) => {
        seen.push(`${target.runtime}:${target.id}:${target.generation}`);
        return operatorPrimarySyncResult({ submitted: true });
      },
    );
    expect(result).toEqual({ ok: true, actionEntered: true, value: { submitted: true } });
    expect(seen).toEqual(['orca:terminal-exact:incarnation-exact']);
    expect(adapter.resolveAssignmentWorker).toHaveBeenCalledTimes(1);
    expect(adapter.findWorker).toHaveBeenCalledTimes(1);
  });

  it('returns remote_not_applicable for a structurally valid persisted remote designation', async () => {
    const { file } = fixture();
    const remote = await publishCurrentWorkerAssignment({
      file,
      repository: 'chetwerikoff/orchestrator-pack',
      issueNumber: 42,
      taskId: 'task-remote',
      kind: 'remote',
      provider: 'browser-gpt',
      bindingKey: 'remote-binding',
      role: 'worker',
    });
    if (!remote.ok) throw new Error(remote.reason);
    const store = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    store.operatorPrimary = {
      route: 'operator-primary',
      taskId: remote.assignment.taskId,
      bindingKey: remote.assignment.bindingKey,
      assignmentId: remote.assignment.assignmentId,
      assignmentGeneration: remote.assignment.generation,
    };
    writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`);

    let calls = 0;
    const result = await withCurrentOperatorPrimaryTarget({ file, adapter: runtime(), timeoutMs: 250 }, () => {
      calls += 1;
      return operatorPrimarySyncResult('unexpected');
    });
    expect(result).toEqual({ ok: false, actionEntered: false, reason: 'remote_not_applicable' });
    expect(calls).toBe(0);
  });

  it('returns runtime_unavailable when the registered adapter omits assignment resolution', async () => {
    const { file } = await boundFixture();
    const { resolveAssignmentWorker: _omitted, ...adapter } = runtime();
    let calls = 0;
    const result = await withCurrentOperatorPrimaryTarget({ file, adapter, timeoutMs: 250 }, () => {
      calls += 1;
      return operatorPrimarySyncResult('unexpected');
    });
    expect(result).toEqual({ ok: false, actionEntered: false, reason: 'runtime_unavailable' });
    expect(calls).toBe(0);
  });

  it('returns target_unresolved for a resolved worker with malformed composite identity', async () => {
    const { file } = await boundFixture();
    const malformed: RuntimeWorker = {
      ...worker('terminal-malformed', 'incarnation-malformed'),
      identity: { runtime: 'orca', id: '', generation: 'incarnation-malformed' },
    };
    const adapter = runtime({ resolved: malformed, found: malformed });
    let calls = 0;
    const result = await withCurrentOperatorPrimaryTarget({ file, adapter, timeoutMs: 250 }, () => {
      calls += 1;
      return operatorPrimarySyncResult('unexpected');
    });
    expect(result).toEqual({ ok: false, actionEntered: false, reason: 'target_unresolved' });
    expect(adapter.findWorker).not.toHaveBeenCalled();
    expect(calls).toBe(0);
  });

  it.each([
    ['runtime_unavailable', runtime({ resolveFailure: true })],
    ['target_not_current', runtime({ resolved: 'gone' })],
    ['runtime_unavailable', runtime({ findFailure: true })],
    ['target_not_current', runtime({ resolved: worker('same', 'old'), found: worker('same', 'new') })],
  ] as const)('returns %s before action and exposes no target', async (reason, adapter) => {
    const { file } = await boundFixture();
    let calls = 0;
    const result = await withCurrentOperatorPrimaryTarget({ file, adapter, timeoutMs: 250 }, () => {
      calls += 1;
      return operatorPrimarySyncResult('unexpected');
    });
    expect(result).toEqual({ ok: false, actionEntered: false, reason });
    expect(calls).toBe(0);
  });

  it('maps an unexpected pre-action logical-fence fault to binding_fence_failed', async () => {
    const { file } = await boundFixture();
    const adapter = runtime();
    Object.defineProperty(adapter, 'resolveAssignmentWorker', {
      configurable: true,
      get() {
        throw new Error('injected capability access fault');
      },
    });
    let calls = 0;
    const result = await withCurrentOperatorPrimaryTarget({ file, adapter, timeoutMs: 250 }, () => {
      calls += 1;
      return operatorPrimarySyncResult('unexpected');
    });
    expect(result).toEqual({ ok: false, actionEntered: false, reason: 'binding_fence_failed' });
    expect(calls).toBe(0);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 5_001])(
    'rejects invalid timeout %s before runtime or action',
    async (timeoutMs) => {
      const { file } = await boundFixture();
      const adapter = runtime();
      let calls = 0;
      const result = await withCurrentOperatorPrimaryTarget({ file, adapter, timeoutMs }, () => {
        calls += 1;
        return operatorPrimarySyncResult('unexpected');
      });
      expect(result).toEqual({ ok: false, actionEntered: false, reason: 'deadline_invalid' });
      expect(adapter.resolveAssignmentWorker).not.toHaveBeenCalled();
      expect(adapter.findWorker).not.toHaveBeenCalled();
      expect(calls).toBe(0);
    },
  );

  it('does not start findWorker after the wrapper-observed outer budget is exhausted', async () => {
    const { file } = await boundFixture();
    const exact = worker();
    const adapter = runtime({ resolved: exact, found: exact });
    const resolve = vi.mocked(adapter.resolveAssignmentWorker!);
    resolve.mockImplementation(() => {
      const start = performance.now();
      while (performance.now() - start < 25) { /* consume the outer boundary budget */ }
      return { status: 'ok', value: { kind: 'resolved', worker: exact } };
    });
    const result = await withCurrentOperatorPrimaryTarget(
      { file, adapter, timeoutMs: 20 },
      () => operatorPrimarySyncResult('unexpected'),
    );
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(adapter.findWorker).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, actionEntered: false, reason: 'deadline_exhausted' });
  });

  it('fails closed on assignment-store lock contention with zero action', async () => {
    const { file } = await boundFixture();
    let release!: () => void;
    const held = withCrashRecoverableFileLock(`${file}.lock`, 1, async () => {
      await new Promise<void>((resolve) => { release = resolve; });
    });
    while (!release) await new Promise((resolve) => setTimeout(resolve, 1));

    let calls = 0;
    const result = await withCurrentOperatorPrimaryTarget({ file, adapter: runtime(), timeoutMs: 250 }, () => {
      calls += 1;
      return operatorPrimarySyncResult('unexpected');
    });
    expect(result).toEqual({ ok: false, actionEntered: false, reason: 'binding_store_busy' });
    expect(calls).toBe(0);
    release();
    await held;
  });

  it('preserves actionEntered=true when the synchronous caller throws', async () => {
    const { file } = await boundFixture();
    const result = await withCurrentOperatorPrimaryTarget({ file, adapter: runtime(), timeoutMs: 250 }, () => {
      throw new Error('submit truth unknown');
    });
    expect(result).toEqual({
      ok: false,
      actionEntered: true,
      reason: 'action_failed',
      detail: 'submit truth unknown',
    });
  });

  it('authorizes a fresh snapshot on each invocation and never persists runtime identity', async () => {
    const { file } = await boundFixture();
    const first = worker('terminal-a', 'incarnation-a');
    const second = worker('terminal-b', 'incarnation-b');
    const seen: string[] = [];
    await withCurrentOperatorPrimaryTarget({ file, adapter: runtime({ resolved: first, found: first }), timeoutMs: 250 }, (target) => {
      seen.push(target.id);
      return operatorPrimarySyncResult('first');
    });
    await withCurrentOperatorPrimaryTarget({ file, adapter: runtime({ resolved: second, found: second }), timeoutMs: 250 }, (target) => {
      seen.push(target.id);
      return operatorPrimarySyncResult('second');
    });
    expect(seen).toEqual(['terminal-a', 'terminal-b']);
    const bytes = readFileSync(file, 'utf8');
    expect(bytes).not.toContain('terminal-a');
    expect(bytes).not.toContain('terminal-b');
    expect(bytes).not.toContain('incarnation-a');
    expect(bytes).not.toContain('incarnation-b');
  });

  it('uses the already-authorized snapshot without claiming a provider remap fence', async () => {
    const { file } = await boundFixture();
    const snapshot = worker('terminal-a', 'incarnation-a');
    const replacement = worker('terminal-b', 'incarnation-b');
    let providerCurrent = snapshot;
    const adapter = runtime({ resolved: snapshot, found: snapshot });
    const result = await withCurrentOperatorPrimaryTarget({ file, adapter, timeoutMs: 250 }, (target) => {
      providerCurrent = replacement;
      expect(target).toEqual(snapshot.identity);
      return operatorPrimarySyncResult(providerCurrent.identity.id);
    });
    expect(result).toEqual({ ok: true, actionEntered: true, value: 'terminal-b' });
    expect(adapter.resolveAssignmentWorker).toHaveBeenCalledTimes(1);
    expect(adapter.findWorker).toHaveBeenCalledTimes(1);
  });

  it('treats a structurally malformed durable pointer as assignment_untrusted', async () => {
    const { file } = fixture();
    const row = {
      schema: WORKER_ASSIGNMENT_SCHEMA,
      projectId: 'orchestrator-pack',
      repository: 'chetwerikoff/orchestrator-pack',
      issueNumber: 1532,
      taskId: 'task-1532',
      assignmentId: 'wa-1',
      generation: 1,
      kind: 'local',
      provider: 'orca',
      bindingKey: 'dispatch-1532',
      createdAtUtc: '2026-08-24T00:00:00.000Z',
      role: 'worker',
    };
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({
      schema: WORKER_ASSIGNMENT_STORE_SCHEMA,
      revision: 1,
      assignments: { [workerAssignmentKey(row.taskId, row.bindingKey)]: row },
      operatorPrimary: {
        route: 'operator-primary',
        taskId: row.taskId,
        bindingKey: row.bindingKey,
        assignmentId: row.assignmentId,
        assignmentGeneration: row.generation,
        runtimeId: 'forbidden-persisted-runtime-id',
      },
    }, null, 2)}\n`);
    const result = await withCurrentOperatorPrimaryTarget(
      { file, adapter: runtime(), timeoutMs: 250 },
      () => operatorPrimarySyncResult('unexpected'),
    );
    expect(result).toEqual({ ok: false, actionEntered: false, reason: 'assignment_untrusted' });
  });
});

// Compile-negative contract proof: Promise/thenable actions are not assignable.
if (false) {
  const input = { file: '/tmp/never', adapter: {} as RuntimeAdapter, timeoutMs: 100 };
  // @ts-expect-error async callbacks are outside the synchronous fence contract.
  void withCurrentOperatorPrimaryTarget(input, async () => operatorPrimarySyncResult('async'));
  // @ts-expect-error Promise-returning callbacks are outside the synchronous fence contract.
  void withCurrentOperatorPrimaryTarget(input, () => Promise.resolve(operatorPrimarySyncResult('promise')));
  // @ts-expect-error thenable-returning callbacks are outside the synchronous fence contract.
  void withCurrentOperatorPrimaryTarget(input, () => ({ then: () => undefined }));
}
