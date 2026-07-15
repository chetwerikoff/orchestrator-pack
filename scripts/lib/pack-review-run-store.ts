import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export const PACK_REVIEW_RUN_STORE_SCHEMA_VERSION = 1;
export const PACK_REVIEW_ACTIVE_STATUSES = new Set(['queued', 'preparing', 'running', 'reviewing']);
export const PACK_REVIEW_TERMINAL_STATUSES = new Set([
  'up_to_date',
  'changes_requested',
  'failed',
  'timed_out',
  'cancelled',
]);

export type PackReviewRunStatus =
  | 'queued'
  | 'preparing'
  | 'running'
  | 'reviewing'
  | 'up_to_date'
  | 'changes_requested'
  | 'failed'
  | 'timed_out'
  | 'cancelled';

export interface PackReviewRunRecord {
  schemaVersion: 1;
  id: string;
  runId: string;
  projectId: string;
  key: string;
  prNumber: number;
  targetSha: string;
  headSha: string;
  status: PackReviewRunStatus;
  latestRunStatus: PackReviewRunStatus;
  linkedSessionId: string;
  startReason: string;
  surface: string;
  trustedPackRoot: string;
  sourceRepoRoot: string;
  reviewTargetRoot?: string;
  runnerPid: number;
  createdAt: string;
  updatedAt: string;
  heartbeatAtUtc: string;
  completedAtUtc?: string;
  exitCode?: number | null;
  failureReason?: string;
  githubReviewId?: number | string;
  githubReviewUrl?: string;
  stale?: boolean;
}

export interface PackReviewStoreOptions {
  projectId?: string;
  storeRoot?: string;
  now?: Date;
}

export interface CreatePackReviewRunInput extends PackReviewStoreOptions {
  prNumber: number;
  headSha: string;
  linkedSessionId?: string;
  startReason?: string;
  surface?: string;
  trustedPackRoot: string;
  sourceRepoRoot: string;
}

interface LockHandle {
  lockDir: string;
}

const DEFAULT_PROJECT_ID = 'orchestrator-pack';
const DEFAULT_STALE_MINUTES = 10;
const SAFE_STALE_FLOOR_MINUTES = 2;
const LOCK_WAIT_ATTEMPTS = 400;
const LOCK_WAIT_MS = 25;
const LOCK_UNREADABLE_STALE_MS = 30_000;

function sleepSync(milliseconds: number): void {
  const cell = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(cell, 0, 0, milliseconds);
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('pack review run record must be a JSON object');
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string, path = ''): string {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`corrupt pack review run record${path ? ` at ${path}` : ''}: missing ${name}`);
  return text;
}

function requiredPositiveInteger(value: unknown, name: string, path = ''): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`corrupt pack review run record${path ? ` at ${path}` : ''}: invalid ${name}`);
  }
  return number;
}

export function normalizePackReviewHeadSha(value: string): string {
  const sha = String(value ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`pack review run store requires a full 40-hex head SHA; got '${value}'`);
  }
  return sha;
}

export function normalizePackReviewProjectId(value = DEFAULT_PROJECT_ID): string {
  const project = String(value ?? '').trim() || DEFAULT_PROJECT_ID;
  const slug = project.toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  if (!slug) throw new Error(`invalid pack review project id '${value}'`);
  return slug;
}

export function resolvePackReviewRunStoreRoot(options: PackReviewStoreOptions = {}): string {
  if (options.storeRoot) return resolve(options.storeRoot);
  const explicit = process.env.PACK_REVIEW_RUN_STORE_ROOT?.trim();
  if (explicit) return resolve(explicit);
  const stateRoot = process.env.ORCHESTRATOR_PACK_STATE_ROOT?.trim() || join(homedir(), '.orchestrator-pack');
  return join(stateRoot, 'review-runs', normalizePackReviewProjectId(options.projectId));
}

export function packReviewRunStaleMinutes(): number {
  const parsed = Number(process.env.PACK_REVIEW_RUN_STALE_MINUTES ?? DEFAULT_STALE_MINUTES);
  if (!Number.isFinite(parsed)) return DEFAULT_STALE_MINUTES;
  return Math.max(SAFE_STALE_FLOOR_MINUTES, Math.floor(parsed));
}

function recordsDir(storeRoot: string): string {
  return join(storeRoot, 'runs');
}

export function packReviewWorktreesDir(storeRoot: string): string {
  return join(storeRoot, 'worktrees');
}

export function packReviewLogsDir(storeRoot: string): string {
  return join(storeRoot, 'logs');
}

function lockDir(storeRoot: string): string {
  return join(storeRoot, '.store-lock');
}

export function initializePackReviewRunStore(storeRoot: string): void {
  for (const path of [storeRoot, recordsDir(storeRoot), packReviewWorktreesDir(storeRoot), packReviewLogsDir(storeRoot)]) {
    mkdirSync(path, { recursive: true });
  }
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String((error as NodeJS.ErrnoException).code) : '';
    return code === 'EPERM';
  }
}

function lockIsAbandoned(path: string): boolean {
  if (!existsSync(path)) return false;
  const ownerPath = join(path, 'owner.json');
  try {
    const owner = asObject(JSON.parse(readFileSync(ownerPath, 'utf8')));
    const pid = Number(owner.pid);
    if (Number.isInteger(pid) && pid > 0) return !processAlive(pid);
  } catch {
    // A creator can exist briefly before owner.json is visible. Age-gate cleanup.
  }
  try {
    return Date.now() - statSync(path).mtimeMs >= LOCK_UNREADABLE_STALE_MS;
  } catch {
    return false;
  }
}

function acquireStoreLock(storeRoot: string): LockHandle {
  initializePackReviewRunStore(storeRoot);
  const path = lockDir(storeRoot);
  for (let attempt = 0; attempt < LOCK_WAIT_ATTEMPTS; attempt += 1) {
    try {
      mkdirSync(path);
      writeFileSync(
        join(path, 'owner.json'),
        `${JSON.stringify({ pid: process.pid, processGuid: randomUUID(), acquiredAtUtc: new Date().toISOString() })}\n`,
        'utf8',
      );
      return { lockDir: path };
    } catch {
      if (lockIsAbandoned(path)) {
        rmSync(path, { recursive: true, force: true });
        continue;
      }
      sleepSync(LOCK_WAIT_MS);
    }
  }
  throw new Error('pack review run store unavailable: store_lock_timeout');
}

function releaseStoreLock(handle: LockHandle): void {
  rmSync(handle.lockDir, { recursive: true, force: true });
}

function withStoreLock<T>(storeRoot: string, action: () => T): T {
  const handle = acquireStoreLock(storeRoot);
  try {
    return action();
  } finally {
    releaseStoreLock(handle);
  }
}

function recordPath(storeRoot: string, runId: string): string {
  if (!/^prr-[a-zA-Z0-9._-]+$/.test(runId)) throw new Error(`invalid pack review run id '${runId}'`);
  return join(recordsDir(storeRoot), `${runId}.json`);
}

function parseRecord(value: unknown, path = ''): PackReviewRunRecord {
  const raw = asObject(value);
  const schemaVersion = Number(raw.schemaVersion);
  if (schemaVersion !== PACK_REVIEW_RUN_STORE_SCHEMA_VERSION) {
    throw new Error(`unsupported pack review run schema${path ? ` at ${path}` : ''}: ${String(raw.schemaVersion)}`);
  }
  const id = requiredString(raw.id, 'id', path);
  if (!/^prr-[a-zA-Z0-9._-]+$/.test(id)) throw new Error(`corrupt pack review run record at ${path}: invalid id`);
  const projectId = requiredString(raw.projectId, 'projectId', path);
  const prNumber = requiredPositiveInteger(raw.prNumber, 'prNumber', path);
  const targetSha = normalizePackReviewHeadSha(requiredString(raw.targetSha, 'targetSha', path));
  const key = requiredString(raw.key, 'key', path);
  if (key !== `pr-${prNumber}-${targetSha}`) throw new Error(`corrupt pack review run record at ${path}: key does not match PR/head`);
  const status = requiredString(raw.status, 'status', path) as PackReviewRunStatus;
  if (!PACK_REVIEW_ACTIVE_STATUSES.has(status) && !PACK_REVIEW_TERMINAL_STATUSES.has(status)) {
    throw new Error(`corrupt pack review run record at ${path}: unknown status '${status}'`);
  }
  const createdAt = requiredString(raw.createdAt, 'createdAt', path);
  const updatedAt = requiredString(raw.updatedAt, 'updatedAt', path);
  return {
    ...(raw as unknown as PackReviewRunRecord),
    schemaVersion: 1,
    id,
    runId: requiredString(raw.runId ?? raw.id, 'runId', path),
    projectId,
    key,
    prNumber,
    targetSha,
    headSha: normalizePackReviewHeadSha(requiredString(raw.headSha ?? raw.targetSha, 'headSha', path)),
    status,
    latestRunStatus: String(raw.latestRunStatus ?? status) as PackReviewRunStatus,
    linkedSessionId: String(raw.linkedSessionId ?? ''),
    startReason: String(raw.startReason ?? ''),
    surface: String(raw.surface ?? ''),
    trustedPackRoot: String(raw.trustedPackRoot ?? ''),
    sourceRepoRoot: String(raw.sourceRepoRoot ?? ''),
    runnerPid: Number(raw.runnerPid ?? 0),
    createdAt,
    updatedAt,
    heartbeatAtUtc: String(raw.heartbeatAtUtc ?? updatedAt),
  };
}

function readRecordsUnlocked(storeRoot: string): PackReviewRunRecord[] {
  const records: PackReviewRunRecord[] = [];
  const ids = new Set<string>();
  for (const name of readdirSync(recordsDir(storeRoot))) {
    if (!name.endsWith('.json')) continue;
    const path = join(recordsDir(storeRoot), name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      throw new Error(`corrupt pack review run record at ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const record = parseRecord(parsed, path);
    if (basename(path, '.json') !== record.id) throw new Error(`corrupt pack review run record at ${path}: filename/id mismatch`);
    if (ids.has(record.id)) throw new Error(`ambiguous pack review run store: duplicate run id '${record.id}'`);
    ids.add(record.id);
    records.push(record);
  }

  const activeByKey = new Map<string, string>();
  for (const record of records) {
    if (!PACK_REVIEW_ACTIVE_STATUSES.has(record.status) || isPackReviewRunStale(record)) continue;
    const existing = activeByKey.get(record.key);
    if (existing) throw new Error(`ambiguous pack review run store: multiple active records for ${record.key}`);
    activeByKey.set(record.key, record.id);
  }
  return records;
}

export function isPackReviewRunStale(record: PackReviewRunRecord, now = new Date()): boolean {
  if (!PACK_REVIEW_ACTIVE_STATUSES.has(record.status)) return false;
  const heartbeatMs = Date.parse(record.heartbeatAtUtc || record.updatedAt);
  if (!Number.isFinite(heartbeatMs)) return true;
  const ageMs = now.getTime() - heartbeatMs;
  if (ageMs < packReviewRunStaleMinutes() * 60_000) return false;
  return !processAlive(Number(record.runnerPid));
}

function consumerRow(record: PackReviewRunRecord, now = new Date()): PackReviewRunRecord {
  if (!isPackReviewRunStale(record, now)) return { ...record };
  return {
    ...record,
    status: 'failed',
    latestRunStatus: 'failed',
    failureReason: 'runner_disappeared_stale',
    stale: true,
  };
}

function writeRecordUnlocked(storeRoot: string, record: PackReviewRunRecord, createOnly = false): void {
  const path = recordPath(storeRoot, record.id);
  if (createOnly && existsSync(path)) throw new Error(`pack review run already exists: ${record.id}`);
  mkdirSync(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${randomUUID()}.tmp`);
  writeFileSync(temp, `${JSON.stringify(record)}\n`, 'utf8');
  try {
    if (existsSync(path)) rmSync(path, { force: true });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

export function listPackReviewRuns(options: PackReviewStoreOptions = {}): PackReviewRunRecord[] {
  const storeRoot = resolvePackReviewRunStoreRoot(options);
  const now = options.now ?? new Date();
  return withStoreLock(storeRoot, () => readRecordsUnlocked(storeRoot)
    .filter((record) => !options.projectId || record.projectId === options.projectId)
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    .map((record) => consumerRow(record, now)));
}

export function getPackReviewRun(runId: string, options: PackReviewStoreOptions = {}): PackReviewRunRecord | null {
  const storeRoot = resolvePackReviewRunStoreRoot(options);
  return withStoreLock(storeRoot, () => {
    const path = recordPath(storeRoot, runId);
    if (!existsSync(path)) return null;
    return parseRecord(JSON.parse(readFileSync(path, 'utf8')), path);
  });
}

export function createPackReviewRun(input: CreatePackReviewRunInput): {
  created: boolean;
  reused: boolean;
  reason: string;
  run: PackReviewRunRecord;
  storeRoot: string;
} {
  const projectId = input.projectId?.trim() || DEFAULT_PROJECT_ID;
  if (!Number.isInteger(input.prNumber) || input.prNumber <= 0) throw new Error('pack review runner requires a positive PR number');
  const headSha = normalizePackReviewHeadSha(input.headSha);
  const storeRoot = resolvePackReviewRunStoreRoot(input);
  return withStoreLock(storeRoot, () => {
    const records = readRecordsUnlocked(storeRoot);
    const key = `pr-${input.prNumber}-${headSha}`;
    const active = records.filter((record) => record.key === key
      && PACK_REVIEW_ACTIVE_STATUSES.has(record.status)
      && !isPackReviewRunStale(record));
    if (active.length > 1) throw new Error(`ambiguous pack review run store: multiple active records for ${key}`);
    if (active.length === 1) {
      return { created: false, reused: true, reason: 'active_run_exists', run: consumerRow(active[0]!), storeRoot };
    }

    const now = (input.now ?? new Date()).toISOString();
    const runId = `prr-${randomUUID().replaceAll('-', '')}`;
    const record: PackReviewRunRecord = {
      schemaVersion: 1,
      id: runId,
      runId,
      projectId,
      key,
      prNumber: input.prNumber,
      targetSha: headSha,
      headSha,
      status: 'queued',
      latestRunStatus: 'queued',
      linkedSessionId: input.linkedSessionId?.trim() || '',
      startReason: input.startReason?.trim() || '',
      surface: input.surface?.trim() || 'pack-review-runner',
      trustedPackRoot: resolve(input.trustedPackRoot),
      sourceRepoRoot: resolve(input.sourceRepoRoot),
      runnerPid: process.pid,
      createdAt: now,
      updatedAt: now,
      heartbeatAtUtc: now,
    };
    writeRecordUnlocked(storeRoot, record, true);
    return { created: true, reused: false, reason: 'created', run: record, storeRoot };
  });
}

export function updatePackReviewRun(
  runId: string,
  fields: Partial<PackReviewRunRecord>,
  options: PackReviewStoreOptions = {},
): PackReviewRunRecord {
  const storeRoot = resolvePackReviewRunStoreRoot(options);
  return withStoreLock(storeRoot, () => {
    const path = recordPath(storeRoot, runId);
    if (!existsSync(path)) throw new Error(`pack review run not found: ${runId}`);
    const existing = parseRecord(JSON.parse(readFileSync(path, 'utf8')), path);
    const updatedAt = (options.now ?? new Date()).toISOString();
    const next = parseRecord({
      ...existing,
      ...fields,
      id: existing.id,
      runId: existing.runId,
      key: existing.key,
      prNumber: existing.prNumber,
      targetSha: existing.targetSha,
      headSha: existing.headSha,
      schemaVersion: 1,
      updatedAt,
      heartbeatAtUtc: PACK_REVIEW_ACTIVE_STATUSES.has(String(fields.status ?? existing.status))
        ? updatedAt
        : String(fields.heartbeatAtUtc ?? existing.heartbeatAtUtc),
    }, path);
    writeRecordUnlocked(storeRoot, next);
    return next;
  });
}

export function heartbeatPackReviewRun(runId: string, options: PackReviewStoreOptions = {}): PackReviewRunRecord {
  return updatePackReviewRun(runId, { runnerPid: process.pid }, options);
}

export function setPackReviewRunTerminal(
  runId: string,
  status: Extract<PackReviewRunStatus, 'up_to_date' | 'changes_requested' | 'failed' | 'timed_out' | 'cancelled'>,
  fields: Partial<PackReviewRunRecord> = {},
  options: PackReviewStoreOptions = {},
): PackReviewRunRecord {
  if (!PACK_REVIEW_TERMINAL_STATUSES.has(status)) throw new Error(`invalid terminal review status '${status}'`);
  return updatePackReviewRun(runId, {
    ...fields,
    status,
    latestRunStatus: status,
    completedAtUtc: (options.now ?? new Date()).toISOString(),
  }, options);
}
