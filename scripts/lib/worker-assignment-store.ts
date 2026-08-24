import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  // Assignment publication is serialized by the shared crash-recoverable lock below.
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { withCrashRecoverableFileLock } from '../pr2-foundation/journal-lock.ts';

export const WORKER_ASSIGNMENT_SCHEMA = 'orchestrator-pack/worker-assignment/v1' as const;
export const WORKER_ASSIGNMENT_STORE_SCHEMA = 'orchestrator-pack/worker-assignment-store/v1' as const;
export const MAX_WORKER_ASSIGNMENTS = 256 as const;
export const MAX_WORKER_ASSIGNMENT_STORE_BYTES = 262_144 as const;

export type WorkerAssignmentKind = 'local' | 'remote';
export type WorkerAssignmentRole = 'worker' | 'orchestrator';

export type WorkerAssignmentStoreTrustCause =
  | 'store_too_large'
  | 'json_invalid'
  | 'store_shape_invalid'
  | 'assignment_count_exceeded'
  | 'assignment_row_invalid'
  | 'legacy_identity_missing'
  | 'legacy_key_mismatch'
  | 'canonical_key_mismatch'
  | 'unknown_key_format'
  | 'migration_destination_collision'
  | 'migration_result_too_large'
  | 'migration_backup_failed'
  | 'migration_backup_conflict'
  | 'migration_write_failed'
  | 'migration_readback_failed';

export type WorkerAssignmentStoreInspectResult =
  | {
      readonly ok: true;
      readonly store: WorkerAssignmentStore;
      readonly needsMigration: boolean;
    }
  | { readonly ok: false; readonly cause: WorkerAssignmentStoreTrustCause };

export const WORKER_ASSIGNMENT_CANONICAL_KEY_PREFIX = 'task-dispatch-' as const;
export const WORKER_ASSIGNMENT_MIGRATION_BACKUP_SUFFIX = '.pre-task-dispatch-migration' as const;
const LEGACY_WORKER_ASSIGNMENT_KEY = /^issue-[1-9][0-9]{0,9}$/;
const CANONICAL_WORKER_ASSIGNMENT_KEY = /^task-dispatch-[0-9a-f]{64}$/;

interface WorkerAssignmentBase {
  readonly schema: typeof WORKER_ASSIGNMENT_SCHEMA;
  readonly projectId: string;
  readonly repository: string;
  readonly taskId: string;
  readonly assignmentId: string;
  readonly generation: number;
  readonly kind: WorkerAssignmentKind;
  readonly provider: string;
  /** Persistence-safe provider lifecycle key. For Orca this is the Dispatch id, never a terminal/runtime id. */
  readonly bindingKey: string;
  readonly createdAtUtc: string;
  /** Present only on post-cutover publications. Pre-role rows remain readable with the field absent. */
  readonly role?: WorkerAssignmentRole;
}

/** Existing Issue-scoped assignment shape retained for all numbered consumers. */
export interface WorkerAssignment extends WorkerAssignmentBase {
  readonly issueNumber: number;
}

/** Brief-only authoring shape before the GitHub Issue deliverable exists. */
export interface BriefWorkerAssignment extends WorkerAssignmentBase {
  readonly issueNumber?: undefined;
}

export type WorkerAssignmentRecord = WorkerAssignment | BriefWorkerAssignment;

export interface WorkerAssignmentExpectation {
  readonly assignmentId: string;
  readonly generation: number;
}

/** Persistence-safe PACK project-level designation; runtime identity never belongs here. */
export interface OperatorPrimaryBindingV1 {
  readonly route: 'operator-primary';
  readonly taskId: string;
  readonly bindingKey: string;
  readonly assignmentId: string;
  readonly assignmentGeneration: number;
}

export interface WorkerAssignmentStore {
  readonly schema: typeof WORKER_ASSIGNMENT_STORE_SCHEMA;
  readonly revision: number;
  readonly assignments: Readonly<Record<string, WorkerAssignmentRecord>>;
  readonly operatorPrimary?: OperatorPrimaryBindingV1;
}

type PublishWorkerAssignmentResult<T extends WorkerAssignmentRecord = WorkerAssignmentRecord> =
  | { readonly ok: true; readonly assignment: T }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly cause?: WorkerAssignmentStoreTrustCause;
    };

export type AttachWorkerAssignmentIssueResult = PublishWorkerAssignmentResult<WorkerAssignment>;

export type CurrentWorkerAssignmentFenceResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly reason: 'assignment_stale' | 'assignment_store_busy' | 'assignment_fence_failed';
      /** True only after the fenced action itself has been entered. */
      readonly actionEntered: boolean;
    };

export type OperatorPrimaryBindingReadResult =
  | {
      readonly ok: true;
      readonly status: 'binding_absent';
      readonly binding: null;
    }
  | {
      readonly ok: true;
      readonly status: 'binding_current';
      readonly binding: OperatorPrimaryBindingV1;
      readonly assignment: WorkerAssignmentRecord;
    }
  | {
      readonly ok: true;
      readonly status: 'binding_stale';
      readonly binding: OperatorPrimaryBindingV1;
    }
  | {
      readonly ok: false;
      readonly reason: 'assignment_store_untrusted';
      readonly cause: WorkerAssignmentStoreTrustCause;
    };

export type OperatorPrimaryBindingMutationResult =
  | { readonly ok: true; readonly binding: OperatorPrimaryBindingV1 | null }
  | {
      readonly ok: false;
      readonly reason:
        | 'binding_input_invalid'
        | 'binding_absent'
        | 'binding_stale'
        | 'binding_conflict'
        | 'remote_not_applicable'
        | 'assignment_store_untrusted'
        | 'binding_store_busy'
        | 'binding_write_failed';
      readonly cause?: WorkerAssignmentStoreTrustCause;
    };

export interface OperatorPrimaryLockedResult<T> {
  readonly kind: 'operator-primary-locked-result';
  readonly value: T;
}

export type CurrentOperatorPrimaryAssignmentFenceResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly reason:
        | 'binding_absent'
        | 'binding_stale'
        | 'assignment_untrusted'
        | 'remote_not_applicable'
        | 'binding_store_busy'
        | 'binding_fence_failed';
    };

function bounded(value: unknown, max: number): string {
  const text = String(value ?? '').trim();
  return text.length > 0 && text.length <= max ? text : '';
}

function optionalIssueNumber(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : Number.NaN;
}

function isNumberedAssignment(value: WorkerAssignmentRecord): value is WorkerAssignment {
  return Number.isInteger(value.issueNumber) && Number(value.issueNumber) > 0;
}

/** Canonical hard-cut key for one deliverable identity. No Issue-number alias exists. */
export function workerAssignmentKey(taskIdValue: unknown, bindingKeyValue: unknown): string {
  const taskId = bounded(taskIdValue, 160);
  const bindingKey = bounded(bindingKeyValue, 240);
  if (!taskId || !bindingKey) return '';
  const digest = createHash('sha256')
    .update(`${taskId}\u0000${bindingKey}`, 'utf8')
    .digest('hex');
  return `task-dispatch-${digest}`;
}

export function parseWorkerAssignmentRole(value: unknown): WorkerAssignmentRole | null {
  return value === 'worker' || value === 'orchestrator' ? value : null;
}

function validAssignment(value: unknown): value is WorkerAssignmentRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Partial<WorkerAssignmentRecord> & { readonly role?: unknown };
  const issueNumber = optionalIssueNumber(row.issueNumber);
  const roleValid = !('role' in row) || parseWorkerAssignmentRole(row.role) !== null;
  return row.schema === WORKER_ASSIGNMENT_SCHEMA
    && Boolean(bounded(row.projectId, 80))
    && Boolean(bounded(row.repository, 240))
    && (row.issueNumber === undefined || Number.isFinite(issueNumber))
    && Boolean(bounded(row.taskId, 160))
    && Boolean(bounded(row.assignmentId, 160))
    && Number.isInteger(row.generation) && Number(row.generation) > 0
    && (row.kind === 'local' || row.kind === 'remote')
    && Boolean(bounded(row.provider, 80))
    && Boolean(bounded(row.bindingKey, 240))
    && typeof row.createdAtUtc === 'string'
    && Number.isFinite(Date.parse(row.createdAtUtc))
    && roleValid;
}

function normalizeOperatorPrimaryBinding(value: unknown): OperatorPrimaryBindingV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const keys = Object.keys(raw).sort();
  const expectedKeys = ['assignmentGeneration', 'assignmentId', 'bindingKey', 'route', 'taskId'];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    return null;
  }
  const rawTaskId = raw.taskId;
  const rawBindingKey = raw.bindingKey;
  const rawAssignmentId = raw.assignmentId;
  const rawAssignmentGeneration = raw.assignmentGeneration;
  if (typeof rawTaskId !== 'string'
    || typeof rawBindingKey !== 'string'
    || typeof rawAssignmentId !== 'string'
    || typeof rawAssignmentGeneration !== 'number') {
    return null;
  }
  const taskId = bounded(rawTaskId, 160);
  const bindingKey = bounded(rawBindingKey, 240);
  const assignmentId = bounded(rawAssignmentId, 160);
  const assignmentGeneration = rawAssignmentGeneration;
  if (raw.route !== 'operator-primary' || !taskId || !bindingKey || !assignmentId
    || !Number.isInteger(assignmentGeneration) || assignmentGeneration <= 0) {
    return null;
  }
  return {
    route: 'operator-primary',
    taskId,
    bindingKey,
    assignmentId,
    assignmentGeneration,
  };
}

function sameOperatorPrimaryBinding(
  left: OperatorPrimaryBindingV1 | undefined,
  right: OperatorPrimaryBindingV1,
): boolean {
  return Boolean(left
    && left.route === right.route
    && left.taskId === right.taskId
    && left.bindingKey === right.bindingKey
    && left.assignmentId === right.assignmentId
    && left.assignmentGeneration === right.assignmentGeneration);
}

function bindingForAssignment(assignment: WorkerAssignmentRecord): OperatorPrimaryBindingV1 {
  return {
    route: 'operator-primary',
    taskId: assignment.taskId,
    bindingKey: assignment.bindingKey,
    assignmentId: assignment.assignmentId,
    assignmentGeneration: assignment.generation,
  };
}

function assignmentForOperatorPrimaryBinding(
  store: WorkerAssignmentStore,
  binding: OperatorPrimaryBindingV1,
): WorkerAssignmentRecord | null {
  const key = workerAssignmentKey(binding.taskId, binding.bindingKey);
  if (!key) return null;
  const assignment = store.assignments[key];
  if (!assignment
    || assignment.assignmentId !== binding.assignmentId
    || assignment.generation !== binding.assignmentGeneration
    || assignment.taskId !== binding.taskId
    || assignment.bindingKey !== binding.bindingKey) {
    return null;
  }
  return assignment;
}

export function operatorPrimaryLockedResult<T>(value: T): OperatorPrimaryLockedResult<T> {
  return { kind: 'operator-primary-locked-result', value };
}

export function workerAssignmentMigrationBackupPath(file: string): string {
  return `${file}${WORKER_ASSIGNMENT_MIGRATION_BACKUP_SUFFIX}`;
}

let migrationTestHookAfterBackup: (() => void) | undefined;
type WorkerAssignmentAtomicReplaceTestPhase = 'before_write' | 'before_readback';
let atomicReplaceTestHook: ((phase: WorkerAssignmentAtomicReplaceTestPhase) => void) | undefined;

export function setWorkerAssignmentMigrationTestHook(afterBackupBeforeLiveReplace?: () => void): void {
  migrationTestHookAfterBackup = afterBackupBeforeLiveReplace;
}

export function setWorkerAssignmentAtomicReplaceTestHook(
  hook?: (phase: WorkerAssignmentAtomicReplaceTestPhase) => void,
): void {
  atomicReplaceTestHook = hook;
}

function classifyAssignmentKey(
  key: string,
  row: WorkerAssignmentRecord,
): { readonly ok: true; readonly dest: string; readonly legacy: boolean } | { readonly ok: false; readonly cause: WorkerAssignmentStoreTrustCause } {
  const dest = workerAssignmentKey(row.taskId, row.bindingKey);
  if (!dest) return { ok: false, cause: 'legacy_identity_missing' };
  if (key === dest) return { ok: true, dest, legacy: false };
  if (LEGACY_WORKER_ASSIGNMENT_KEY.test(key)) {
    const encoded = Number(key.slice('issue-'.length));
    if (!Number.isInteger(row.issueNumber) || Number(row.issueNumber) <= 0) {
      return { ok: false, cause: 'legacy_identity_missing' };
    }
    if (Number(row.issueNumber) !== encoded) return { ok: false, cause: 'legacy_key_mismatch' };
    return { ok: true, dest, legacy: true };
  }
  if (CANONICAL_WORKER_ASSIGNMENT_KEY.test(key)) return { ok: false, cause: 'canonical_key_mismatch' };
  return { ok: false, cause: 'unknown_key_format' };
}

export function inspectWorkerAssignmentStore(raw: string): WorkerAssignmentStoreInspectResult {
  if (Buffer.byteLength(raw, 'utf8') > MAX_WORKER_ASSIGNMENT_STORE_BYTES) {
    return { ok: false, cause: 'store_too_large' };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { ok: false, cause: 'json_invalid' }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, cause: 'store_shape_invalid' };
  }
  const store = parsed as Partial<WorkerAssignmentStore> & { readonly operatorPrimary?: unknown };
  if (store.schema !== WORKER_ASSIGNMENT_STORE_SCHEMA
    || !Number.isInteger(store.revision) || Number(store.revision) < 0
    || !store.assignments || typeof store.assignments !== 'object' || Array.isArray(store.assignments)) {
    return { ok: false, cause: 'store_shape_invalid' };
  }
  let operatorPrimary: OperatorPrimaryBindingV1 | undefined;
  if (Object.prototype.hasOwnProperty.call(store, 'operatorPrimary')) {
    const normalized = normalizeOperatorPrimaryBinding(store.operatorPrimary);
    if (!normalized) return { ok: false, cause: 'store_shape_invalid' };
    operatorPrimary = normalized;
  }
  const entries = Object.entries(store.assignments);
  if (entries.length > MAX_WORKER_ASSIGNMENTS) {
    return { ok: false, cause: 'assignment_count_exceeded' };
  }
  const assignments: Record<string, WorkerAssignmentRecord> = {};
  let needsMigration = false;
  for (const [key, value] of entries) {
    if (!validAssignment(value)) return { ok: false, cause: 'assignment_row_invalid' };
    const classified = classifyAssignmentKey(key, value);
    if (!classified.ok) return classified;
    if (classified.legacy) needsMigration = true;
    if (assignments[classified.dest]) return { ok: false, cause: 'migration_destination_collision' };
    assignments[classified.dest] = value;
  }
  return {
    ok: true,
    needsMigration,
    store: {
      schema: WORKER_ASSIGNMENT_STORE_SCHEMA,
      revision: Number(store.revision),
      assignments,
      ...(operatorPrimary ? { operatorPrimary } : {}),
    },
  };
}

function inspectWorkerAssignmentStoreFile(file: string): WorkerAssignmentStoreInspectResult & { readonly raw?: string | null } {
  if (!existsSync(file)) {
    return { ok: true, store: emptyWorkerAssignmentStore(), needsMigration: false, raw: null };
  }
  let raw: string;
  try { raw = readFileSync(file, 'utf8'); } catch { return { ok: false, cause: 'json_invalid' }; }
  const inspected = inspectWorkerAssignmentStore(raw);
  return inspected.ok ? { ...inspected, raw } : inspected;
}

export function resolveWorkerAssignmentStorePath(
  projectId = 'orchestrator-pack',
  env: NodeJS.ProcessEnv = process.env,
): string {
  const home = env.HOME ?? homedir();
  const root = env.OPK_BASE_DIR?.trim()
    ? path.resolve(env.OPK_BASE_DIR)
    : path.join(home, '.orchestrator-pack');
  return path.join(root, 'projects', projectId.trim() || 'orchestrator-pack', 'worker-assignments.json');
}

export function emptyWorkerAssignmentStore(): WorkerAssignmentStore {
  return { schema: WORKER_ASSIGNMENT_STORE_SCHEMA, revision: 0, assignments: {} };
}

export function parseWorkerAssignmentStore(raw: string): WorkerAssignmentStore | null {
  const inspected = inspectWorkerAssignmentStore(raw);
  return inspected.ok ? inspected.store : null;
}

export function readWorkerAssignmentStore(file: string): WorkerAssignmentStore | null {
  const inspected = inspectWorkerAssignmentStoreFile(file);
  return inspected.ok ? inspected.store : null;
}

function untrustedStoreResult(cause: WorkerAssignmentStoreTrustCause): {
  readonly ok: false;
  readonly reason: 'assignment_store_untrusted';
  readonly cause: WorkerAssignmentStoreTrustCause;
} {
  return { ok: false, reason: 'assignment_store_untrusted', cause };
}

export function readOperatorPrimaryBinding(file: string): OperatorPrimaryBindingReadResult {
  const inspected = inspectWorkerAssignmentStoreFile(file);
  if (!inspected.ok) return untrustedStoreResult(inspected.cause);
  const binding = inspected.store.operatorPrimary;
  if (!binding) return { ok: true, status: 'binding_absent', binding: null };
  const assignment = assignmentForOperatorPrimaryBinding(inspected.store, binding);
  if (!assignment) return { ok: true, status: 'binding_stale', binding };
  return { ok: true, status: 'binding_current', binding, assignment };
}

export function currentWorkerAssignment(
  file: string,
  issueNumber: number,
): WorkerAssignment | null {
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) return null;
  const store = readWorkerAssignmentStore(file);
  if (!store) return null;
  const matches = Object.values(store.assignments)
    .filter((assignment): assignment is WorkerAssignment =>
      isNumberedAssignment(assignment) && assignment.issueNumber === issueNumber);
  return matches.length === 1 ? matches[0]! : null;
}

export function currentWorkerAssignmentByDeliverable(
  file: string,
  taskId: string,
  bindingKey: string,
): WorkerAssignmentRecord | null {
  const store = readWorkerAssignmentStore(file);
  if (!store) return null;
  const key = workerAssignmentKey(taskId, bindingKey);
  return key ? store.assignments[key] ?? null : null;
}

/** Complete assignment census used by repository/provider/binding runtime resolution. */
export function listCurrentWorkerAssignmentRecords(file: string): readonly WorkerAssignmentRecord[] | null {
  const store = readWorkerAssignmentStore(file);
  return store ? Object.values(store.assignments) : null;
}

/** Issue-scoped projection for consumers that genuinely require a published Issue number. */
export function listCurrentWorkerAssignments(file: string): readonly WorkerAssignment[] | null {
  const assignments = listCurrentWorkerAssignmentRecords(file);
  return assignments ? assignments.filter(isNumberedAssignment) : null;
}

function serializeWorkerAssignmentStore(store: WorkerAssignmentStore): string {
  return `${JSON.stringify(store, null, 2)}\n`;
}

function atomicReplaceReadBackDetailed(
  file: string,
  store: WorkerAssignmentStore,
): 'ok' | 'too_large' | 'write_failed' | 'readback_failed' {
  const bytes = serializeWorkerAssignmentStore(store);
  if (Buffer.byteLength(bytes, 'utf8') > MAX_WORKER_ASSIGNMENT_STORE_BYTES) return 'too_large';
  const directory = path.dirname(file);
  mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `.${randomUUID().replace(/-/g, '')}.tmp`);
  try {
    atomicReplaceTestHook?.('before_write');
    writeFileSync(temporary, bytes, { encoding: 'utf8', mode: 0o600 });
    const fd = openSync(temporary, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, file);
  } catch {
    rmSync(temporary, { force: true });
    return 'write_failed';
  }
  let readBack: string;
  try {
    atomicReplaceTestHook?.('before_readback');
    readBack = readFileSync(file, 'utf8');
  } catch {
    return 'readback_failed';
  }
  if (readBack !== bytes || !parseWorkerAssignmentStore(readBack)) return 'readback_failed';
  try {
    const dirFd = openSync(directory, 'r');
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } catch {
    // Some platforms cannot fsync a directory. Exact file read-back above remains mandatory.
  }
  return 'ok';
}

function atomicReplaceReadBack(file: string, store: WorkerAssignmentStore): boolean {
  return atomicReplaceReadBackDetailed(file, store) === 'ok';
}

function writeExactMigrationBackup(backupFile: string, exactBytes: string): 'ok' | 'conflict' | 'failed' {
  try {
    if (existsSync(backupFile)) {
      return readFileSync(backupFile, 'utf8') === exactBytes ? 'ok' : 'conflict';
    }
    mkdirSync(path.dirname(backupFile), { recursive: true });
    writeFileSync(backupFile, exactBytes, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    const fd = openSync(backupFile, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    return readFileSync(backupFile, 'utf8') === exactBytes ? 'ok' : 'failed';
  } catch {
    return 'failed';
  }
}

type MigratedStoreResult =
  | { readonly ok: true; readonly store: WorkerAssignmentStore }
  | {
      readonly ok: false;
      readonly reason: 'assignment_store_untrusted';
      readonly cause: WorkerAssignmentStoreTrustCause;
    };

function migrateWorkerAssignmentStoreLocked(file: string): MigratedStoreResult {
  const inspected = inspectWorkerAssignmentStoreFile(file);
  if (!inspected.ok) return untrustedStoreResult(inspected.cause);
  if (!inspected.needsMigration || inspected.raw == null) return { ok: true, store: inspected.store };
  const backup = writeExactMigrationBackup(workerAssignmentMigrationBackupPath(file), inspected.raw);
  if (backup === 'conflict') return untrustedStoreResult('migration_backup_conflict');
  if (backup !== 'ok') return untrustedStoreResult('migration_backup_failed');
  migrationTestHookAfterBackup?.();
  const next: WorkerAssignmentStore = {
    schema: WORKER_ASSIGNMENT_STORE_SCHEMA,
    revision: inspected.store.revision + 1,
    assignments: inspected.store.assignments,
    ...(inspected.store.operatorPrimary ? { operatorPrimary: inspected.store.operatorPrimary } : {}),
  };
  if (Buffer.byteLength(serializeWorkerAssignmentStore(next), 'utf8') > MAX_WORKER_ASSIGNMENT_STORE_BYTES) {
    return untrustedStoreResult('migration_result_too_large');
  }
  const replaced = atomicReplaceReadBackDetailed(file, next);
  if (replaced === 'too_large') return untrustedStoreResult('migration_result_too_large');
  if (replaced === 'write_failed') return untrustedStoreResult('migration_write_failed');
  if (replaced === 'readback_failed') return untrustedStoreResult('migration_readback_failed');
  return { ok: true, store: next };
}

export async function migrateWorkerAssignmentStoreIfNeeded(file: string): Promise<
  | MigratedStoreResult
  | { readonly ok: false; readonly reason: 'assignment_store_busy' | 'assignment_publish_failed' }
> {
  try {
    return await withCrashRecoverableFileLock(`${file}.lock`, 10, () => migrateWorkerAssignmentStoreLocked(file));
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error && error.message === 'journal_busy'
        ? 'assignment_store_busy'
        : 'assignment_publish_failed',
    };
  }
}

function expectationMatches(
  current: WorkerAssignmentRecord | undefined,
  expected: WorkerAssignmentExpectation | undefined,
): boolean {
  if (!expected) return current === undefined;
  return current?.assignmentId === expected.assignmentId
    && current.generation === expected.generation;
}

function expectedEntry(
  store: WorkerAssignmentStore,
  expected: WorkerAssignmentExpectation,
): { readonly key: string; readonly assignment: WorkerAssignmentRecord } | null {
  const matches = Object.entries(store.assignments)
    .filter(([, assignment]) => expectationMatches(assignment, expected));
  return matches.length === 1
    ? { key: matches[0]![0], assignment: matches[0]![1] }
    : null;
}

function validExpectation(expected: WorkerAssignmentExpectation | undefined): boolean {
  return expected === undefined || (
    Boolean(bounded(expected.assignmentId, 160))
    && Number.isInteger(expected.generation)
    && expected.generation > 0
  );
}

interface PublishWorkerAssignmentInputBase {
  readonly file: string;
  readonly projectId?: string;
  readonly repository: string;
  readonly taskId: string;
  readonly kind: WorkerAssignmentKind;
  readonly provider: string;
  readonly bindingKey: string;
  readonly expectedCurrent?: WorkerAssignmentExpectation;
  readonly now?: () => Date;
  readonly role: WorkerAssignmentRole;
}

export function publishCurrentWorkerAssignment(
  input: PublishWorkerAssignmentInputBase & { readonly issueNumber: number },
): Promise<PublishWorkerAssignmentResult<WorkerAssignment>>;
export function publishCurrentWorkerAssignment(
  input: PublishWorkerAssignmentInputBase & { readonly issueNumber?: undefined },
): Promise<PublishWorkerAssignmentResult<BriefWorkerAssignment>>;
/**
 * Compare-and-publish one logical WorkerAssignment under its canonical
 * `(taskId, bindingKey)` deliverable key.
 *
 * `issueNumber` is optional metadata. Omitting expectedCurrent means "expect no
 * assignment for this deliverable" (and, when issueNumber is present, no other
 * assignment already claiming that Issue). A normal explicit replacement may
 * change deliverable identity; the old canonical key is removed while holding
 * the same publication lock. Recognized pre-cutover `issue-<N>` stores are
 * backed up and re-keyed to canonical `task-dispatch-*` keys once before the
 * compare-and-publish write. Unknown or corrupt stores still fail closed.
 */
export async function publishCurrentWorkerAssignment(
  input: PublishWorkerAssignmentInputBase & { readonly issueNumber?: number },
): Promise<PublishWorkerAssignmentResult> {
  const projectId = bounded(input.projectId ?? 'orchestrator-pack', 80);
  const repository = bounded(input.repository, 240).toLowerCase();
  const taskId = bounded(input.taskId, 160);
  const provider = bounded(input.provider, 80).toLowerCase();
  const bindingKey = bounded(input.bindingKey, 240);
  const key = workerAssignmentKey(taskId, bindingKey);
  const issueNumber = optionalIssueNumber(input.issueNumber);
  const expectedCurrent = input.expectedCurrent;
  const role = parseWorkerAssignmentRole(input.role);
  if (!projectId || !repository || !taskId || !provider || !bindingKey || !key
    || (input.issueNumber !== undefined && !Number.isFinite(issueNumber))
    || !validExpectation(expectedCurrent)
    || role === null) {
    return { ok: false, reason: 'assignment_input_invalid' };
  }

  try {
    return await withCrashRecoverableFileLock(`${input.file}.lock`, 10, () => {
      const migrated = migrateWorkerAssignmentStoreLocked(input.file);
      if (!migrated.ok) return migrated;
      const store = migrated.store;

      const replacement = expectedCurrent ? expectedEntry(store, expectedCurrent) : null;
      if (expectedCurrent && !replacement) {
        return { ok: false, reason: 'assignment_stale' } as const;
      }
      const previousAtKey = store.assignments[key];
      if (!expectedCurrent && previousAtKey) {
        return { ok: false, reason: 'assignment_stale' } as const;
      }
      if (!expectedCurrent && issueNumber !== undefined
        && Object.values(store.assignments).some((assignment) => assignment.issueNumber === issueNumber)) {
        return { ok: false, reason: 'assignment_stale' } as const;
      }

      const previous = replacement?.assignment;
      const generation = (previous?.generation ?? 0) + 1;
      const assignment: WorkerAssignmentRecord = issueNumber === undefined
        ? {
            schema: WORKER_ASSIGNMENT_SCHEMA,
            projectId,
            repository,
            taskId,
            assignmentId: `wa-${randomUUID()}`,
            generation,
            kind: input.kind,
            provider,
            bindingKey,
            createdAtUtc: (input.now?.() ?? new Date()).toISOString(),
            role,
          }
        : {
            schema: WORKER_ASSIGNMENT_SCHEMA,
            projectId,
            repository,
            issueNumber,
            taskId,
            assignmentId: `wa-${randomUUID()}`,
            generation,
            kind: input.kind,
            provider,
            bindingKey,
            createdAtUtc: (input.now?.() ?? new Date()).toISOString(),
            role,
          };
      const assignments: Record<string, WorkerAssignmentRecord> = { ...store.assignments };
      if (replacement && replacement.key !== key) delete assignments[replacement.key];
      assignments[key] = assignment;
      const next: WorkerAssignmentStore = {
        schema: WORKER_ASSIGNMENT_STORE_SCHEMA,
        revision: store.revision + 1,
        assignments,
        ...(store.operatorPrimary ? { operatorPrimary: store.operatorPrimary } : {}),
      };
      return atomicReplaceReadBack(input.file, next)
        ? { ok: true, assignment } as const
        : { ok: false, reason: 'assignment_publish_readback_failed' } as const;
    });
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error && error.message === 'journal_busy'
        ? 'assignment_store_busy'
        : 'assignment_publish_failed',
    };
  }
}

/** Attach a published Issue number as metadata without changing deliverable key or assignment identity. */
export async function attachWorkerAssignmentIssueNumber(input: {
  readonly file: string;
  readonly expected: WorkerAssignmentRecord;
  readonly issueNumber: number;
}): Promise<AttachWorkerAssignmentIssueResult> {
  if (!Number.isInteger(input.issueNumber) || input.issueNumber <= 0) {
    return { ok: false, reason: 'assignment_input_invalid' };
  }
  const key = workerAssignmentKey(input.expected.taskId, input.expected.bindingKey);
  if (!key) return { ok: false, reason: 'assignment_input_invalid' };
  try {
    return await withCrashRecoverableFileLock(`${input.file}.lock`, 10, () => {
      const migrated = migrateWorkerAssignmentStoreLocked(input.file);
      if (!migrated.ok) return migrated;
      const store = migrated.store;
      const current = store.assignments[key];
      if (!sameAssignment(current ?? null, input.expected)) {
        return { ok: false, reason: 'assignment_stale' } as const;
      }
      const conflicting = Object.entries(store.assignments).some(([candidateKey, assignment]) =>
        candidateKey !== key && assignment.issueNumber === input.issueNumber);
      if (conflicting) return { ok: false, reason: 'assignment_stale' } as const;
      if (current!.issueNumber === input.issueNumber) {
        return { ok: true, assignment: current! as WorkerAssignment } as const;
      }
      if (current!.issueNumber !== undefined) {
        return { ok: false, reason: 'assignment_stale' } as const;
      }
      const assignment: WorkerAssignment = { ...current!, issueNumber: input.issueNumber };
      const next: WorkerAssignmentStore = {
        schema: WORKER_ASSIGNMENT_STORE_SCHEMA,
        revision: store.revision + 1,
        assignments: { ...store.assignments, [key]: assignment },
        ...(store.operatorPrimary ? { operatorPrimary: store.operatorPrimary } : {}),
      };
      return atomicReplaceReadBack(input.file, next)
        ? { ok: true, assignment } as const
        : { ok: false, reason: 'assignment_publish_readback_failed' } as const;
    });
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error && error.message === 'journal_busy'
        ? 'assignment_store_busy'
        : 'assignment_publish_failed',
    };
  }
}

function sameAssignment(left: WorkerAssignmentRecord | null, right: WorkerAssignmentRecord): boolean {
  return Boolean(left
    && left.assignmentId === right.assignmentId
    && left.generation === right.generation
    && left.taskId === right.taskId
    && left.kind === right.kind
    && left.provider === right.provider
    && left.bindingKey === right.bindingKey);
}

export function assignmentStillCurrent(file: string, expected: WorkerAssignmentRecord): boolean {
  const key = workerAssignmentKey(expected.taskId, expected.bindingKey);
  if (!key) return false;
  const store = readWorkerAssignmentStore(file);
  return Boolean(store && sameAssignment(store.assignments[key] ?? null, expected));
}

/**
 * Hold the same serialization lock used by assignment publication while an
 * exact-current assignment authorizes one bounded side effect. A concurrent
 * reassignment therefore either wins before this fence (and the effect is
 * rejected as stale) or waits until the fenced effect has completed.
 *
 * The fence never waits for a busy owner: S2 must fail closed within its phase
 * budget rather than turn assignment-lock contention into an unbounded send.
 * `actionEntered` distinguishes a proven pre-action no-op from an exception
 * thrown after the caller has begun a side effect; callers must not flatten the
 * latter into a zero-attempt outcome.
 */
export async function withCurrentWorkerAssignmentFence<T>(
  file: string,
  expected: WorkerAssignmentRecord,
  action: () => T | Promise<T>,
): Promise<CurrentWorkerAssignmentFenceResult<T>> {
  let actionEntered = false;
  try {
    return await withCrashRecoverableFileLock(`${file}.lock`, 1, async () => {
      if (!assignmentStillCurrent(file, expected)) {
        return { ok: false, reason: 'assignment_stale', actionEntered: false } as const;
      }
      actionEntered = true;
      return { ok: true, value: await action() } as const;
    });
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error && error.message === 'journal_busy'
        ? 'assignment_store_busy'
        : 'assignment_fence_failed',
      actionEntered,
    };
  }
}

function validBindingMutationInput(taskIdValue: unknown, bindingKeyValue: unknown): {
  readonly taskId: string;
  readonly bindingKey: string;
  readonly key: string;
} | null {
  const taskId = bounded(taskIdValue, 160);
  const bindingKey = bounded(bindingKeyValue, 240);
  const key = workerAssignmentKey(taskId, bindingKey);
  return taskId && bindingKey && key ? { taskId, bindingKey, key } : null;
}

export async function bindOperatorPrimary(input: {
  readonly file: string;
  readonly taskId: string;
  readonly bindingKey: string;
  /** Omit for initial bind; provide the exact observed pointer for CAS replacement. */
  readonly expectedCurrent?: OperatorPrimaryBindingV1;
}): Promise<OperatorPrimaryBindingMutationResult> {
  const selected = validBindingMutationInput(input.taskId, input.bindingKey);
  const expectedCurrent = input.expectedCurrent === undefined
    ? undefined
    : normalizeOperatorPrimaryBinding(input.expectedCurrent);
  if (!selected || expectedCurrent === null) {
    return { ok: false, reason: 'binding_input_invalid' };
  }
  try {
    return await withCrashRecoverableFileLock(`${input.file}.lock`, 10, () => {
      const migrated = migrateWorkerAssignmentStoreLocked(input.file);
      if (!migrated.ok) {
        return { ok: false, reason: 'assignment_store_untrusted', cause: migrated.cause } as const;
      }
      const store = migrated.store;
      if (expectedCurrent === undefined) {
        if (store.operatorPrimary) return { ok: false, reason: 'binding_conflict' } as const;
      } else if (!sameOperatorPrimaryBinding(store.operatorPrimary, expectedCurrent)) {
        return { ok: false, reason: store.operatorPrimary ? 'binding_conflict' : 'binding_absent' } as const;
      }
      const assignment = store.assignments[selected.key];
      if (!assignment) return { ok: false, reason: 'binding_stale' } as const;
      if (assignment.kind !== 'local') return { ok: false, reason: 'remote_not_applicable' } as const;
      const binding = bindingForAssignment(assignment);
      if (store.operatorPrimary && sameOperatorPrimaryBinding(store.operatorPrimary, binding)) {
        return { ok: true, binding } as const;
      }
      const next: WorkerAssignmentStore = {
        schema: WORKER_ASSIGNMENT_STORE_SCHEMA,
        revision: store.revision + 1,
        assignments: store.assignments,
        operatorPrimary: binding,
      };
      return atomicReplaceReadBack(input.file, next)
        ? { ok: true, binding } as const
        : { ok: false, reason: 'binding_write_failed' } as const;
    });
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error && error.message === 'journal_busy'
        ? 'binding_store_busy'
        : 'binding_write_failed',
    };
  }
}

export async function retireOperatorPrimary(input: {
  readonly file: string;
  readonly expectedCurrent: OperatorPrimaryBindingV1;
}): Promise<OperatorPrimaryBindingMutationResult> {
  const expectedCurrent = normalizeOperatorPrimaryBinding(input.expectedCurrent);
  if (!expectedCurrent) return { ok: false, reason: 'binding_input_invalid' };
  try {
    return await withCrashRecoverableFileLock(`${input.file}.lock`, 10, () => {
      const migrated = migrateWorkerAssignmentStoreLocked(input.file);
      if (!migrated.ok) {
        return { ok: false, reason: 'assignment_store_untrusted', cause: migrated.cause } as const;
      }
      const store = migrated.store;
      if (!store.operatorPrimary) return { ok: false, reason: 'binding_absent' } as const;
      if (!sameOperatorPrimaryBinding(store.operatorPrimary, expectedCurrent)) {
        return { ok: false, reason: 'binding_conflict' } as const;
      }
      const next: WorkerAssignmentStore = {
        schema: WORKER_ASSIGNMENT_STORE_SCHEMA,
        revision: store.revision + 1,
        assignments: store.assignments,
      };
      return atomicReplaceReadBack(input.file, next)
        ? { ok: true, binding: null } as const
        : { ok: false, reason: 'binding_write_failed' } as const;
    });
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error && error.message === 'journal_busy'
        ? 'binding_store_busy'
        : 'binding_write_failed',
    };
  }
}

/**
 * Hold the assignment-store serialization lock while the exact current PACK
 * operator-primary assignment is used by one structurally synchronous caller.
 * This fences PACK logical mutation only; it makes no provider remap claim.
 */
export async function withCurrentOperatorPrimaryAssignment<T>(
  file: string,
  action: (assignment: WorkerAssignmentRecord) => OperatorPrimaryLockedResult<T>,
): Promise<CurrentOperatorPrimaryAssignmentFenceResult<T>> {
  try {
    return await withCrashRecoverableFileLock(`${file}.lock`, 1, () => {
      const inspected = inspectWorkerAssignmentStoreFile(file);
      if (!inspected.ok) return { ok: false, reason: 'assignment_untrusted' } as const;
      const binding = inspected.store.operatorPrimary;
      if (!binding) return { ok: false, reason: 'binding_absent' } as const;
      const assignment = assignmentForOperatorPrimaryBinding(inspected.store, binding);
      if (!assignment) return { ok: false, reason: 'binding_stale' } as const;
      if (assignment.kind !== 'local') return { ok: false, reason: 'remote_not_applicable' } as const;
      const result = action(assignment);
      if (!result || result.kind !== 'operator-primary-locked-result') {
        throw new Error('operator_primary_locked_result_invalid');
      }
      return { ok: true, value: result.value } as const;
    });
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error && error.message === 'journal_busy'
        ? 'binding_store_busy'
        : 'binding_fence_failed',
    };
  }
}