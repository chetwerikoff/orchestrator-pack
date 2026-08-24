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
    role: 'worker' as const,
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

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import {
  inspectWorkerAssignmentStore,
  migrateWorkerAssignmentStoreIfNeeded,
  parseWorkerAssignmentStore,
  readWorkerAssignmentStore,
  setWorkerAssignmentAtomicReplaceTestHook,
  setWorkerAssignmentMigrationTestHook,
  workerAssignmentKey,
  workerAssignmentMigrationBackupPath,
  WORKER_ASSIGNMENT_SCHEMA,
  WORKER_ASSIGNMENT_STORE_SCHEMA,
  WORKER_ASSIGNMENT_CANONICAL_KEY_PREFIX,
  MAX_WORKER_ASSIGNMENT_STORE_BYTES,
  MAX_WORKER_ASSIGNMENTS,
} from './worker-assignment-store.ts';

function legacyRow(n: number, overrides: Record<string, unknown> = {}) {
  return {
    schema: WORKER_ASSIGNMENT_SCHEMA,
    projectId: 'orchestrator-pack',
    repository: 'chetwerikoff/orchestrator-pack',
    issueNumber: n,
    taskId: `task-${n}`,
    assignmentId: `wa-legacy-${n}`,
    generation: 1,
    kind: 'local' as const,
    provider: 'orca',
    bindingKey: `dispatch-${n}`,
    createdAtUtc: '2026-08-17T00:00:00.000Z',
    ...overrides,
  };
}

function legacyBytes(count: number, extra: Record<string, unknown> = {}): string {
  const assignments: Record<string, unknown> = { ...extra };
  for (let n = 1; n <= count; n += 1) assignments[`issue-${n}`] = legacyRow(n);
  return `${JSON.stringify({
    schema: WORKER_ASSIGNMENT_STORE_SCHEMA,
    revision: 4,
    assignments,
  }, null, 2)}\n`;
}

function writeLegacy(file: string, bytes: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, bytes);
}

describe('WorkerAssignment legacy key migration and role compatibility', () => {
  afterEach(() => {
    setWorkerAssignmentMigrationTestHook();
    setWorkerAssignmentAtomicReplaceTestHook();
  });

  it('treats missing and empty canonical stores as ordinary with no backup', async () => {
    const { file } = fixture();
    expect(readWorkerAssignmentStore(file)).toEqual({
      schema: WORKER_ASSIGNMENT_STORE_SCHEMA,
      revision: 0,
      assignments: {},
    });
    expect(existsSync(workerAssignmentMigrationBackupPath(file))).toBe(false);
    mkdirSync(path.dirname(file), { recursive: true });
    const empty = `${JSON.stringify({
      schema: WORKER_ASSIGNMENT_STORE_SCHEMA,
      revision: 0,
      assignments: {},
    }, null, 2)}\n`;
    writeFileSync(file, empty);
    const migrated = await migrateWorkerAssignmentStoreIfNeeded(file);
    expect(migrated.ok).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(empty);
    expect(existsSync(workerAssignmentMigrationBackupPath(file))).toBe(false);
  });

  it('migrates a realistic 22-row issue-keyed store losslessly and is then idempotent', async () => {
    const { file } = fixture();
    const bytes = legacyBytes(22);
    writeLegacy(file, bytes);
    const inspected = inspectWorkerAssignmentStore(bytes);
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) throw new Error(inspected.cause);
    expect(inspected.needsMigration).toBe(true);
    expect(Object.keys(inspected.store.assignments)).toHaveLength(22);
    for (let n = 1; n <= 22; n += 1) {
      const key = workerAssignmentKey(`task-${n}`, `dispatch-${n}`);
      expect(inspected.store.assignments[key]).toEqual(legacyRow(n));
      expect(Object.prototype.hasOwnProperty.call(inspected.store.assignments[key], 'role')).toBe(false);
    }
    const first = await migrateWorkerAssignmentStoreIfNeeded(file);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('migration failed');
    expect(readFileSync(workerAssignmentMigrationBackupPath(file), 'utf8')).toBe(bytes);
    const live = JSON.parse(readFileSync(file, 'utf8')) as { revision: number; assignments: Record<string, unknown> };
    expect(Object.keys(live.assignments)).toHaveLength(22);
    expect(Object.keys(live.assignments).every((key) => key.startsWith(WORKER_ASSIGNMENT_CANONICAL_KEY_PREFIX))).toBe(true);
    expect(live.revision).toBe(5);
    for (let n = 1; n <= 22; n += 1) {
      expect(live.assignments[workerAssignmentKey(`task-${n}`, `dispatch-${n}`)]).toEqual(legacyRow(n));
    }
    const revisionAfter = live.revision;
    const liveBytes = readFileSync(file, 'utf8');
    const second = await migrateWorkerAssignmentStoreIfNeeded(file);
    expect(second.ok).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(liveBytes);
    expect(JSON.parse(readFileSync(file, 'utf8')).revision).toBe(revisionAfter);
    expect(readFileSync(workerAssignmentMigrationBackupPath(file), 'utf8')).toBe(bytes);
  });

  it('preserves mixed canonical and legacy rows and refuses destination collisions', async () => {
    const { file } = fixture();
    const canonical = legacyRow(90, { taskId: 'canon', bindingKey: 'bind-c', issueNumber: 90 });
    const canonicalKey = workerAssignmentKey('canon', 'bind-c');
    const mixed = legacyBytes(2, { [canonicalKey]: canonical });
    const inspected = inspectWorkerAssignmentStore(mixed);
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) throw new Error(inspected.cause);
    expect(Object.keys(inspected.store.assignments)).toHaveLength(3);

    const collision = legacyBytes(1, { [workerAssignmentKey('task-1', 'dispatch-1')]: legacyRow(1, { assignmentId: 'wa-other' }) });
    expect(inspectWorkerAssignmentStore(collision)).toEqual({ ok: false, cause: 'migration_destination_collision' });
    writeLegacy(file, collision);
    const before = readFileSync(file, 'utf8');
    const migrated = await migrateWorkerAssignmentStoreIfNeeded(file);
    expect(migrated).toMatchObject({ ok: false, reason: 'assignment_store_untrusted', cause: 'migration_destination_collision' });
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(existsSync(workerAssignmentMigrationBackupPath(file))).toBe(false);
  });

  it('fails closed with concrete causes for unknown keys, mismatches, and corrupt input', () => {
    const row = legacyRow(5);
    expect(inspectWorkerAssignmentStore('{')).toEqual({ ok: false, cause: 'json_invalid' });
    expect(inspectWorkerAssignmentStore(JSON.stringify({ schema: 'nope', revision: 0, assignments: {} }))).toEqual({
      ok: false, cause: 'store_shape_invalid',
    });
    expect(inspectWorkerAssignmentStore(JSON.stringify({
      schema: WORKER_ASSIGNMENT_STORE_SCHEMA, revision: 1, assignments: { 'mystery-key': row },
    }))).toEqual({ ok: false, cause: 'unknown_key_format' });
    expect(inspectWorkerAssignmentStore(JSON.stringify({
      schema: WORKER_ASSIGNMENT_STORE_SCHEMA, revision: 1,
      assignments: { [`${WORKER_ASSIGNMENT_CANONICAL_KEY_PREFIX}${'0'.repeat(64)}`]: row },
    }))).toEqual({ ok: false, cause: 'canonical_key_mismatch' });
    expect(inspectWorkerAssignmentStore(JSON.stringify({
      schema: WORKER_ASSIGNMENT_STORE_SCHEMA, revision: 1,
      assignments: { 'issue-5': { ...row, issueNumber: 9 } },
    }))).toEqual({ ok: false, cause: 'legacy_key_mismatch' });
    expect(inspectWorkerAssignmentStore(JSON.stringify({
      schema: WORKER_ASSIGNMENT_STORE_SCHEMA, revision: 1,
      assignments: { 'issue-5': { ...row, issueNumber: undefined } },
    }))).toEqual({ ok: false, cause: 'legacy_identity_missing' });
    expect(inspectWorkerAssignmentStore(JSON.stringify({
      schema: WORKER_ASSIGNMENT_STORE_SCHEMA, revision: 1,
      assignments: { 'issue-5': { ...row, taskId: '' } },
    }))).toEqual({ ok: false, cause: 'assignment_row_invalid' });
    expect(inspectWorkerAssignmentStore(JSON.stringify({
      schema: WORKER_ASSIGNMENT_STORE_SCHEMA, revision: 1,
      assignments: { 'issue-5': { ...row, role: 'Worker' } },
    }))).toEqual({ ok: false, cause: 'assignment_row_invalid' });
    const parsed = parseWorkerAssignmentStore(JSON.stringify({
      schema: WORKER_ASSIGNMENT_STORE_SCHEMA, revision: 1,
      assignments: { 'issue-5': { ...row } },
    }));
    expect(parsed?.assignments[workerAssignmentKey('task-5', 'dispatch-5')]).toEqual(row);
  });

  it('enforces both size ceilings and refuses oversized canonicalization', async () => {
    const { file } = fixture();
    const oversized = 'x'.repeat(MAX_WORKER_ASSIGNMENT_STORE_BYTES + 1);
    expect(inspectWorkerAssignmentStore(oversized)).toEqual({ ok: false, cause: 'store_too_large' });
    const tooMany: Record<string, unknown> = {};
    for (let n = 1; n <= MAX_WORKER_ASSIGNMENTS + 1; n += 1) tooMany[`issue-${n}`] = legacyRow(n);
    expect(inspectWorkerAssignmentStore(JSON.stringify({
      schema: WORKER_ASSIGNMENT_STORE_SCHEMA, revision: 1, assignments: tooMany,
    }))).toEqual({ ok: false, cause: 'assignment_count_exceeded' });

    let padding = 'p'.repeat(MAX_WORKER_ASSIGNMENT_STORE_BYTES - 400);
    let tight = '';
    for (;;) {
      tight = `${JSON.stringify({
        schema: WORKER_ASSIGNMENT_STORE_SCHEMA,
        revision: 1,
        assignments: {
          'issue-1': { ...legacyRow(1), extra: padding },
        },
      })}\n`;
      const size = Buffer.byteLength(tight, 'utf8');
      if (size > MAX_WORKER_ASSIGNMENT_STORE_BYTES) {
        padding = padding.slice(0, -Math.max(1, size - MAX_WORKER_ASSIGNMENT_STORE_BYTES));
        continue;
      }
      if (size < MAX_WORKER_ASSIGNMENT_STORE_BYTES - 8) {
        padding = `${padding}${'p'.repeat(MAX_WORKER_ASSIGNMENT_STORE_BYTES - 8 - size)}`;
        continue;
      }
      break;
    }
    expect(Buffer.byteLength(tight, 'utf8')).toBeLessThanOrEqual(MAX_WORKER_ASSIGNMENT_STORE_BYTES);
    expect(inspectWorkerAssignmentStore(tight).ok).toBe(true);
    writeLegacy(file, tight);
    const migrated = await migrateWorkerAssignmentStoreIfNeeded(file);
    expect(migrated).toMatchObject({ ok: false, reason: 'assignment_store_untrusted', cause: 'migration_result_too_large' });
    expect(readFileSync(file, 'utf8')).toBe(tight);
  });

  it('recovers from backup-before-replace interruption and refuses a conflicting backup', async () => {
    const { file } = fixture();
    const bytes = legacyBytes(3);
    writeLegacy(file, bytes);
    setWorkerAssignmentMigrationTestHook(() => {
      throw new Error('injected-interrupt');
    });
    const interrupted = await migrateWorkerAssignmentStoreIfNeeded(file);
    expect(interrupted).toEqual({ ok: false, reason: 'assignment_publish_failed' });
    expect(readFileSync(file, 'utf8')).toBe(bytes);
    expect(readFileSync(workerAssignmentMigrationBackupPath(file), 'utf8')).toBe(bytes);
    setWorkerAssignmentMigrationTestHook();
    const resumed = await migrateWorkerAssignmentStoreIfNeeded(file);
    expect(resumed.ok).toBe(true);
    expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')).assignments)).toHaveLength(3);

    const { file: other } = fixture();
    writeLegacy(other, bytes);
    mkdirSync(path.dirname(other), { recursive: true });
    writeFileSync(workerAssignmentMigrationBackupPath(other), `${bytes}mismatch`);
    const conflict = await migrateWorkerAssignmentStoreIfNeeded(other);
    expect(conflict).toMatchObject({ ok: false, reason: 'assignment_store_untrusted', cause: 'migration_backup_conflict' });
    expect(readFileSync(other, 'utf8')).toBe(bytes);
  });

  it.each([
    ['before_write', 'migration_write_failed'],
    ['before_readback', 'migration_readback_failed'],
  ] as const)('classifies %s migration failure precisely and preserves the exact backup', async (phase, cause) => {
    const { file } = fixture();
    const bytes = legacyBytes(2);
    writeLegacy(file, bytes);
    setWorkerAssignmentAtomicReplaceTestHook((currentPhase) => {
      if (currentPhase === phase) throw new Error(`injected-${phase}`);
    });
    const migrated = await migrateWorkerAssignmentStoreIfNeeded(file);
    expect(migrated).toMatchObject({ ok: false, reason: 'assignment_store_untrusted', cause });
    expect(readFileSync(workerAssignmentMigrationBackupPath(file), 'utf8')).toBe(bytes);
    if (phase === 'before_write') expect(readFileSync(file, 'utf8')).toBe(bytes);
  });

  it('serializes concurrent mutations against a migration-required store', async () => {
    const { file } = fixture();
    writeLegacy(file, legacyBytes(4));
    const [left, right] = await Promise.all([
      publishCurrentWorkerAssignment({
        ...publishInput(file, 'dispatch-left'),
        taskId: 'task-left',
        issueNumber: 9001,
        role: 'worker',
      }),
      publishCurrentWorkerAssignment({
        ...publishInput(file, 'dispatch-right'),
        taskId: 'task-right',
        issueNumber: 9002,
        role: 'orchestrator',
      }),
    ]);
    expect(left.ok && right.ok).toBe(true);
    const live = readWorkerAssignmentStore(file);
    expect(Object.keys(live!.assignments)).toHaveLength(6);
    expect(live!.assignments[workerAssignmentKey('task-left', 'dispatch-left')]?.role).toBe('worker');
    expect(live!.assignments[workerAssignmentKey('task-right', 'dispatch-right')]?.role).toBe('orchestrator');
    expect(Object.prototype.hasOwnProperty.call(live!.assignments[workerAssignmentKey('task-1', 'dispatch-1')], 'role')).toBe(false);
  });

  it('requires explicit roles on new rows and never defaults absent persisted roles', async () => {
    const { file } = fixture();
    const { role: _role, ...missingRole } = publishInput(file, 'dispatch-none');
    const without = await publishCurrentWorkerAssignment(missingRole as never);
    expect(without).toEqual({ ok: false, reason: 'assignment_input_invalid' });
    const invalid = await publishCurrentWorkerAssignment({ ...publishInput(file, 'dispatch-bad'), role: 'Worker' as never });
    expect(invalid).toEqual({ ok: false, reason: 'assignment_input_invalid' });
    const withWorkerRole = await publishCurrentWorkerAssignment(publishInput(file, 'dispatch-worker'));
    expect(withWorkerRole.ok).toBe(true);
    if (!withWorkerRole.ok) throw new Error(withWorkerRole.reason);
    expect(withWorkerRole.assignment.role).toBe('worker');
    const withRole = await publishCurrentWorkerAssignment({
      ...publishInput(file, 'dispatch-role'),
      issueNumber: 1417,
      role: 'orchestrator',
    });
    expect(withRole.ok).toBe(true);
    if (!withRole.ok) throw new Error(withRole.reason);
    expect(withRole.assignment.role).toBe('orchestrator');
  });

  it('freezes current schema, canonical key derivation, optional role, and legacy migration coverage', () => {
    expect(WORKER_ASSIGNMENT_STORE_SCHEMA).toBe('orchestrator-pack/worker-assignment-store/v1');
    expect(WORKER_ASSIGNMENT_SCHEMA).toBe('orchestrator-pack/worker-assignment/v1');
    expect(workerAssignmentKey('task-a', 'bind-b')).toMatch(new RegExp(`^${WORKER_ASSIGNMENT_CANONICAL_KEY_PREFIX}[0-9a-f]{64}$`));
    const raw = JSON.stringify({
      schema: WORKER_ASSIGNMENT_STORE_SCHEMA,
      revision: 1,
      assignments: { 'issue-7': legacyRow(7) },
    });
    const inspected = inspectWorkerAssignmentStore(raw);
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) throw new Error(inspected.cause);
    expect(inspected.needsMigration).toBe(true);
    expect(inspected.store.assignments[workerAssignmentKey('task-7', 'dispatch-7')]).toEqual(legacyRow(7));
    expect(Object.prototype.hasOwnProperty.call(inspected.store.assignments[workerAssignmentKey('task-7', 'dispatch-7')], 'role')).toBe(false);
  });
});
