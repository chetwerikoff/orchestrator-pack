import { randomUUID } from 'node:crypto';
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

export interface WorkerAssignment {
  readonly schema: typeof WORKER_ASSIGNMENT_SCHEMA;
  readonly projectId: string;
  readonly repository: string;
  readonly issueNumber: number;
  readonly taskId: string;
  readonly assignmentId: string;
  readonly generation: number;
  readonly kind: WorkerAssignmentKind;
  readonly provider: string;
  /** Persistence-safe provider lifecycle key. For Orca this is the Dispatch id, never a terminal/runtime id. */
  readonly bindingKey: string;
  readonly createdAtUtc: string;
}

export interface WorkerAssignmentExpectation {
  readonly assignmentId: string;
  readonly generation: number;
}

export interface WorkerAssignmentStore {
  readonly schema: typeof WORKER_ASSIGNMENT_STORE_SCHEMA;
  readonly revision: number;
  readonly assignments: Readonly<Record<string, WorkerAssignment>>;
}

type PublishWorkerAssignmentResult =
  | { readonly ok: true; readonly assignment: WorkerAssignment }
  | { readonly ok: false; readonly reason: string };

export type CurrentWorkerAssignmentFenceResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: 'assignment_stale' | 'assignment_store_busy' | 'assignment_fence_failed' };

function bounded(value: unknown, max: number): string {
  const text = String(value ?? '').trim();
  return text.length > 0 && text.length <= max ? text : '';
}

function validAssignment(value: unknown): value is WorkerAssignment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Partial<WorkerAssignment>;
  return row.schema === WORKER_ASSIGNMENT_SCHEMA
    && Boolean(bounded(row.projectId, 80))
    && Boolean(bounded(row.repository, 240))
    && Number.isInteger(row.issueNumber) && Number(row.issueNumber) > 0
    && Boolean(bounded(row.taskId, 160))
    && Boolean(bounded(row.assignmentId, 160))
    && Number.isInteger(row.generation) && Number(row.generation) > 0
    && (row.kind === 'local' || row.kind === 'remote')
    && Boolean(bounded(row.provider, 80))
    && Boolean(bounded(row.bindingKey, 240))
    && typeof row.createdAtUtc === 'string'
    && Number.isFinite(Date.parse(row.createdAtUtc));
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
  if (Buffer.byteLength(raw, 'utf8') > MAX_WORKER_ASSIGNMENT_STORE_BYTES) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const store = parsed as Partial<WorkerAssignmentStore>;
  if (store.schema !== WORKER_ASSIGNMENT_STORE_SCHEMA
    || !Number.isInteger(store.revision) || Number(store.revision) < 0
    || !store.assignments || typeof store.assignments !== 'object' || Array.isArray(store.assignments)) return null;
  const entries = Object.entries(store.assignments);
  if (entries.length > MAX_WORKER_ASSIGNMENTS) return null;
  const assignments: Record<string, WorkerAssignment> = {};
  for (const [key, value] of entries) {
    if (!/^issue-[1-9][0-9]{0,9}$/u.test(key) || !validAssignment(value)) return null;
    if (key !== `issue-${value.issueNumber}`) return null;
    assignments[key] = value;
  }
  return { schema: WORKER_ASSIGNMENT_STORE_SCHEMA, revision: Number(store.revision), assignments };
}

export function readWorkerAssignmentStore(file: string): WorkerAssignmentStore | null {
  if (!existsSync(file)) return emptyWorkerAssignmentStore();
  try { return parseWorkerAssignmentStore(readFileSync(file, 'utf8')); } catch { return null; }
}

export function currentWorkerAssignment(
  file: string,
  issueNumber: number,
): WorkerAssignment | null {
  const store = readWorkerAssignmentStore(file);
  if (!store) return null;
  return store.assignments[`issue-${issueNumber}`] ?? null;
}

export function listCurrentWorkerAssignments(file: string): readonly WorkerAssignment[] | null {
  const store = readWorkerAssignmentStore(file);
  return store ? Object.values(store.assignments) : null;
}

function atomicReplaceReadBack(file: string, store: WorkerAssignmentStore): boolean {
  const bytes = `${JSON.stringify(store, null, 2)}\n`;
  if (Buffer.byteLength(bytes, 'utf8') > MAX_WORKER_ASSIGNMENT_STORE_BYTES) return false;
  const directory = path.dirname(file);
  mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `.${randomUUID().replace(/-/g, '')}.tmp`);
  try {
    writeFileSync(temporary, bytes, { encoding: 'utf8', mode: 0o600 });
    const fd = openSync(temporary, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, file);
    const readBack = readFileSync(file, 'utf8');
    if (readBack !== bytes || !parseWorkerAssignmentStore(readBack)) return false;
    try {
      const dirFd = openSync(directory, 'r');
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    } catch {
      // Some platforms cannot fsync a directory. Exact file read-back above remains mandatory.
    }
    return true;
  } catch {
    rmSync(temporary, { force: true });
    return false;
  }
}

function expectationMatches(
  current: WorkerAssignment | undefined,
  expected: WorkerAssignmentExpectation | undefined,
): boolean {
  if (!expected) return current === undefined;
  return current?.assignmentId === expected.assignmentId
    && current.generation === expected.generation;
}

/**
 * Compare-and-publish the sole current logical WorkerAssignment.
 *
 * Omitting expectedCurrent means "expect no current assignment". Any replacement
 * must name the exact current assignment id + generation. The store alone mints
 * the successor assignment id and generation while holding the publication lock.
 */
export async function publishCurrentWorkerAssignment(input: {
  readonly file: string;
  readonly projectId?: string;
  readonly repository: string;
  readonly issueNumber: number;
  readonly taskId: string;
  readonly kind: WorkerAssignmentKind;
  readonly provider: string;
  readonly bindingKey: string;
  readonly expectedCurrent?: WorkerAssignmentExpectation;
  readonly now?: () => Date;
}): Promise<PublishWorkerAssignmentResult> {
  const projectId = bounded(input.projectId ?? 'orchestrator-pack', 80);
  const repository = bounded(input.repository, 240).toLowerCase();
  const taskId = bounded(input.taskId, 160);
  const provider = bounded(input.provider, 80).toLowerCase();
  const bindingKey = bounded(input.bindingKey, 240);
  const expectedCurrent = input.expectedCurrent;
  if (!projectId || !repository || !Number.isInteger(input.issueNumber) || input.issueNumber <= 0
    || !taskId || !provider || !bindingKey
    || (expectedCurrent !== undefined
      && (!bounded(expectedCurrent.assignmentId, 160)
        || !Number.isInteger(expectedCurrent.generation)
        || expectedCurrent.generation <= 0))) {
    return { ok: false, reason: 'assignment_input_invalid' };
  }

  try {
    return await withCrashRecoverableFileLock(`${input.file}.lock`, 10, () => {
      const store = readWorkerAssignmentStore(input.file);
      if (!store) return { ok: false, reason: 'assignment_store_untrusted' } as const;
      const key = `issue-${input.issueNumber}`;
      const previous = store.assignments[key];
      if (!expectationMatches(previous, expectedCurrent)) {
        return { ok: false, reason: 'assignment_stale' } as const;
      }
      const generation = (previous?.generation ?? 0) + 1;
      const assignment: WorkerAssignment = {
        schema: WORKER_ASSIGNMENT_SCHEMA,
        projectId,
        repository,
        issueNumber: input.issueNumber,
        taskId,
        assignmentId: `wa-${randomUUID()}`,
        generation,
        kind: input.kind,
        provider,
        bindingKey,
        createdAtUtc: (input.now?.() ?? new Date()).toISOString(),
      };
      const next: WorkerAssignmentStore = {
        schema: WORKER_ASSIGNMENT_STORE_SCHEMA,
        revision: store.revision + 1,
        assignments: { ...store.assignments, [key]: assignment },
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

function sameAssignment(left: WorkerAssignment | null, right: WorkerAssignment): boolean {
  return Boolean(left
    && left.assignmentId === right.assignmentId
    && left.generation === right.generation
    && left.taskId === right.taskId
    && left.kind === right.kind
    && left.provider === right.provider
    && left.bindingKey === right.bindingKey);
}

export function assignmentStillCurrent(file: string, expected: WorkerAssignment): boolean {
  return sameAssignment(currentWorkerAssignment(file, expected.issueNumber), expected);
}

/**
 * Hold the same serialization lock used by assignment publication while an
 * exact-current assignment authorizes one bounded side effect. A concurrent
 * reassignment therefore either wins before this fence (and the effect is
 * rejected as stale) or waits until the fenced effect has completed.
 *
 * The fence never waits for a busy owner: S2 must fail closed within its phase
 * budget rather than turn assignment-lock contention into an unbounded send.
 */
export async function withCurrentWorkerAssignmentFence<T>(
  file: string,
  expected: WorkerAssignment,
  action: () => T | Promise<T>,
): Promise<CurrentWorkerAssignmentFenceResult<T>> {
  try {
    return await withCrashRecoverableFileLock(`${file}.lock`, 1, async () => {
      if (!assignmentStillCurrent(file, expected)) {
        return { ok: false, reason: 'assignment_stale' } as const;
      }
      return { ok: true, value: await action() } as const;
    });
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error && error.message === 'journal_busy'
        ? 'assignment_store_busy'
        : 'assignment_fence_failed',
    };
  }
}
