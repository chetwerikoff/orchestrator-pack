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
  'commented',
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
  | 'commented'
  | 'changes_requested'
  | 'failed'
  | 'timed_out'
  | 'cancelled';

const PACK_REVIEW_VERDICT_TERMINAL_STATUSES = new Set<PackReviewRunStatus>([
  'up_to_date',
  'commented',
  'changes_requested',
]);

export type GithubCommentReviewReconciliationPhase =
  | 'prepared'
  | 'comment_posted'
  | 'dismissals_pending'
  | 'complete';

export interface GithubCommentReviewReconciliation {
  schemaVersion: 1;
  event: 'COMMENT';
  phase: GithubCommentReviewReconciliationPhase;
  actorLogin: string;
  commentBody: string;
  commentReviewId?: number | string;
  commentReviewUrl?: string;
  pendingDismissalReviewIds: Array<number | string>;
  dismissedReviewIds: Array<number | string>;
  preparedAtUtc: string;
  updatedAtUtc: string;
  lastError?: string;
}

export type PackReviewDeliveryChannel = 'githubComment' | 'requiredStatus' | 'workerNotification';
export type PackReviewDeliveryState = 'succeeded' | 'delivered' | 'failed' | 'escalated';

export interface PackReviewDeliveryOutcome {
  state: PackReviewDeliveryState;
  recordedAtUtc: string;
  reason: string;
  idempotencyKey: string;
}

export interface PackReviewJournalOutcome {
  state: 'persisted' | 'journal_write_failed';
  recordedAtUtc: string;
  reason: string;
  idempotencyKey: string;
  attempts: number;
}

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
  sameKeyOrder?: number;
  completedAtUtc?: string;
  exitCode?: number | null;
  failureReason?: string;
  githubReviewId?: number | string;
  githubReviewUrl?: string;
  githubReviewEvent?: 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES';
  githubReviewReconciliation?: GithubCommentReviewReconciliation;
  reviewVerdict?: 'clean' | 'findings';
  findingCount?: number;
  findings: unknown[];
  journalOutcome?: PackReviewJournalOutcome;
  deliveryOutcomes: Partial<Record<PackReviewDeliveryChannel, PackReviewDeliveryOutcome>>;
  canonicalRepository?: string;
  stale?: boolean;
}

export const PACK_REVIEW_STALE_FAILURE_REASON = 'runner_disappeared_stale';

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
  canonicalRepository?: string;
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
const RECORD_RENAME_ATTEMPTS = 4;
const RECORD_RENAME_BACKOFF_MS = 10;
const TRANSIENT_RENAME_ERROR_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);

function sleepSync(milliseconds: number): void {
  const cell = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(cell, 0, 0, milliseconds);
}

function errorCode(error: unknown): string {
  return error instanceof Error && 'code' in error
    ? String((error as NodeJS.ErrnoException).code ?? '')
    : '';
}

function renameRecordWithRetry(temp: string, path: string): void {
  // On Linux/POSIX, rename(2) atomically replaces an existing file (not a directory),
  // so readers see prior or new content without an absence window. Windows may report
  // transient contention (EPERM/EBUSY/EACCES); retry rename itself, never pre-delete.
  for (let attempt = 1; attempt <= RECORD_RENAME_ATTEMPTS; attempt += 1) {
    try {
      renameSync(temp, path);
      return;
    } catch (error) {
      const code = errorCode(error);
      if (!TRANSIENT_RENAME_ERROR_CODES.has(code)) throw error;
      if (attempt === RECORD_RENAME_ATTEMPTS) {
        throw new Error(
          `pack review run store atomic replace failed: rename_retry_exhausted code=${code} attempts=${RECORD_RENAME_ATTEMPTS} destination=${path}`,
          { cause: error },
        );
      }
      sleepSync(RECORD_RENAME_BACKOFF_MS * attempt);
    }
  }
}

export function trimPackReviewValue(value: unknown): string {
  return String(value ?? '').trim();
}

export function describePackReviewError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

export function normalizePackReviewCanonicalRepository(value: string): string {
  const slug = String(value ?? '').trim();
  if (!/^[^/\s]+\/[^/\s]+$/.test(slug)) {
    throw new Error(`invalid pack review canonical repository '${value}'`);
  }
  return slug;
}

function packReviewRunKey(
  prNumber: number,
  headSha: string,
  canonicalRepository?: string,
): string {
  void canonicalRepository;
  return `pr-${prNumber}-${headSha}`;
}

function canonicalRepositoryFromRunKey(
  key: string,
  prNumber: number,
  headSha: string,
): string | undefined {
  const match = key.match(new RegExp(`^pr-([^/\\s]+/[^/\\s]+)-${prNumber}-${headSha}$`));
  return match?.[1] ? normalizePackReviewCanonicalRepository(match[1]) : undefined;
}

function samePackReviewRunIdentity(left: PackReviewRunRecord, right: PackReviewRunRecord): boolean {
  if (left.projectId !== right.projectId
    || left.prNumber !== right.prNumber
    || left.targetSha !== right.targetSha) {
    return false;
  }
  const leftRepository = left.canonicalRepository
    ?? canonicalRepositoryFromRunKey(left.key, left.prNumber, left.targetSha);
  const rightRepository = right.canonicalRepository
    ?? canonicalRepositoryFromRunKey(right.key, right.prNumber, right.targetSha);
  if (leftRepository || rightRepository) {
    return Boolean(leftRepository && rightRepository && leftRepository === rightRepository);
  }
  if (left.sourceRepoRoot && right.sourceRepoRoot) {
    return resolve(left.sourceRepoRoot) === resolve(right.sourceRepoRoot);
  }
  return false;
}

function matchesPackReviewRunInput(
  record: PackReviewRunRecord,
  projectId: string,
  prNumber: number,
  headSha: string,
  canonicalRepository?: string,
  sourceRepoRoot?: string,
): boolean {
  if (record.projectId !== projectId || record.prNumber !== prNumber || record.targetSha !== headSha) {
    return false;
  }
  const recordRepository = record.canonicalRepository
    ?? canonicalRepositoryFromRunKey(record.key, record.prNumber, record.targetSha);
  if (canonicalRepository) {
    if (recordRepository) return canonicalRepository === recordRepository;
    return Boolean(
      sourceRepoRoot
      && record.sourceRepoRoot
      && resolve(sourceRepoRoot) === resolve(record.sourceRepoRoot),
    );
  }
  if (recordRepository) return false;
  return Boolean(
    sourceRepoRoot
    && record.sourceRepoRoot
    && resolve(sourceRepoRoot) === resolve(record.sourceRepoRoot),
  );
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
  const canonicalRepository = raw.canonicalRepository === undefined
    ? undefined
    : normalizePackReviewCanonicalRepository(String(raw.canonicalRepository));
  const canonicalKeyRepository = canonicalRepositoryFromRunKey(key, prNumber, targetSha);
  if (key !== packReviewRunKey(prNumber, targetSha)
    && !(canonicalKeyRepository
      && (!canonicalRepository || canonicalRepository === canonicalKeyRepository))) {
    throw new Error(`corrupt pack review run record at ${path}: key does not match PR/head/repository`);
  }
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
    sameKeyOrder: raw.sameKeyOrder === undefined
      ? undefined
      : requiredPositiveInteger(raw.sameKeyOrder, 'sameKeyOrder', path),
    reviewVerdict: raw.reviewVerdict === 'clean' || raw.reviewVerdict === 'findings'
      ? raw.reviewVerdict
      : undefined,
    findingCount: Number.isInteger(raw.findingCount) ? Number(raw.findingCount) : undefined,
    findings: Array.isArray(raw.findings) ? [...raw.findings] : [],
    journalOutcome: raw.journalOutcome && typeof raw.journalOutcome === 'object' && !Array.isArray(raw.journalOutcome)
      ? raw.journalOutcome as unknown as PackReviewJournalOutcome
      : undefined,
    deliveryOutcomes: raw.deliveryOutcomes && typeof raw.deliveryOutcomes === 'object' && !Array.isArray(raw.deliveryOutcomes)
      ? raw.deliveryOutcomes as Partial<Record<PackReviewDeliveryChannel, PackReviewDeliveryOutcome>>
      : {},
    canonicalRepository,
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

  const activeRecords: PackReviewRunRecord[] = [];
  for (const record of records) {
    if (!PACK_REVIEW_ACTIVE_STATUSES.has(record.status) || isPackReviewRunStale(record)) continue;
    const existing = activeRecords.find((candidate) => samePackReviewRunIdentity(candidate, record));
    if (existing) throw new Error(`ambiguous pack review run store: multiple active records for ${record.key}`);
    activeRecords.push(record);
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
    failureReason: PACK_REVIEW_STALE_FAILURE_REASON,
    stale: true,
  };
}

export function isPackReviewStaleTerminalRun(record: PackReviewRunRecord): boolean {
  return record.status === 'failed' && record.failureReason === PACK_REVIEW_STALE_FAILURE_REASON;
}

export function isPackReviewUnfinishedTerminalRun(record: PackReviewRunRecord): boolean {
  return (record.status === 'failed' || record.status === 'timed_out' || record.status === 'cancelled')
    && !hasPersistedPackReviewVerdict(record);
}

export function listPackReviewRunRecordsRaw(options: PackReviewStoreOptions = {}): PackReviewRunRecord[] {
  const storeRoot = resolvePackReviewRunStoreRoot(options);
  return withStoreLock(storeRoot, () => readRecordsUnlocked(storeRoot)
    .filter((record) => !options.projectId || record.projectId === options.projectId));
}

export function terminalizePackReviewStaleRun(
  runId: string,
  options: PackReviewStoreOptions = {},
): { changed: boolean; run: PackReviewRunRecord } {
  const storeRoot = resolvePackReviewRunStoreRoot(options);
  const recordPathValue = recordPath(storeRoot, runId);
  if (!existsSync(recordPathValue)) throw new Error(`pack review run not found: ${runId}`);
  const existing = parseRecord(JSON.parse(readFileSync(recordPathValue, 'utf8')), recordPathValue);
  if (isPackReviewStaleTerminalRun(existing)) {
    return { changed: false, run: existing };
  }
  if (!isPackReviewRunStale(existing, options.now)) {
    return { changed: false, run: existing };
  }
  const run = setPackReviewRunTerminal(runId, 'failed', {
    failureReason: PACK_REVIEW_STALE_FAILURE_REASON,
    stale: true,
    exitCode: 1,
  }, options);
  return { changed: true, run };
}

export type PackReviewRunOrderResolution =
  | { kind: 'newer'; run: PackReviewRunRecord }
  | { kind: 'none' }
  | { kind: 'ambiguous'; reason: 'legacy_order_ambiguous' };

function compareSameKeyRuns(left: PackReviewRunRecord, right: PackReviewRunRecord): number | null {
  if (left.sameKeyOrder !== undefined && right.sameKeyOrder !== undefined) {
    if (left.sameKeyOrder === right.sameKeyOrder) return null;
    return left.sameKeyOrder > right.sameKeyOrder ? 1 : -1;
  }
  if (left.sameKeyOrder !== undefined) return 1;
  if (right.sameKeyOrder !== undefined) return -1;
  const leftCreatedAt = Date.parse(left.createdAt);
  const rightCreatedAt = Date.parse(right.createdAt);
  if (!Number.isFinite(leftCreatedAt) || !Number.isFinite(rightCreatedAt)) return null;
  if (leftCreatedAt === rightCreatedAt) return null;
  return leftCreatedAt > rightCreatedAt ? 1 : -1;
}

function hasLegacyOrderAmbiguity(
  records: readonly PackReviewRunRecord[],
  run: PackReviewRunRecord,
): boolean {
  const legacy = records.filter((record) => samePackReviewRunIdentity(record, run) && record.sameKeyOrder === undefined);
  for (let index = 0; index < legacy.length; index += 1) {
    for (let next = index + 1; next < legacy.length; next += 1) {
      if (Date.parse(legacy[index]!.createdAt) === Date.parse(legacy[next]!.createdAt)) return true;
    }
  }
  return false;
}

export function resolvePackReviewRunOrder(
  records: readonly PackReviewRunRecord[],
  run: PackReviewRunRecord,
): PackReviewRunOrderResolution {
  if (hasLegacyOrderAmbiguity(records, run)) {
    return { kind: 'ambiguous', reason: 'legacy_order_ambiguous' };
  }
  let newer: PackReviewRunRecord | undefined;
  for (const candidate of records) {
    if (!samePackReviewRunIdentity(candidate, run) || candidate.id === run.id) continue;
    const comparison = compareSameKeyRuns(candidate, run);
    if (comparison === null) return { kind: 'ambiguous', reason: 'legacy_order_ambiguous' };
    if (comparison <= 0) continue;
    if (!newer) {
      newer = candidate;
      continue;
    }
    const latestComparison = compareSameKeyRuns(candidate, newer);
    if (latestComparison === null) return { kind: 'ambiguous', reason: 'legacy_order_ambiguous' };
    if (latestComparison > 0) newer = candidate;
  }
  return newer ? { kind: 'newer', run: newer } : { kind: 'none' };
}

function selectLatestSameKeyRun(
  records: readonly PackReviewRunRecord[],
  candidates: readonly PackReviewRunRecord[],
): PackReviewRunRecord | null {
  if (candidates.length === 0) return null;
  const reference = candidates[0]!;
  if (hasLegacyOrderAmbiguity(records, reference)) {
    throw new Error(`ambiguous pack review run order for ${reference.key}: legacy_order_ambiguous`);
  }
  let latest = candidates[0]!;
  for (const candidate of candidates.slice(1)) {
    const comparison = compareSameKeyRuns(candidate, latest);
    if (comparison === null) {
      throw new Error(`ambiguous pack review run order for ${reference.key}: legacy_order_ambiguous`);
    }
    if (comparison > 0) latest = candidate;
  }
  return latest;
}

export function hasNewerPackReviewRunForKey(
  records: readonly PackReviewRunRecord[],
  run: PackReviewRunRecord,
): boolean {
  return resolvePackReviewRunOrder(records, run).kind === 'newer';
}

export function hasPersistedPackReviewVerdict(record: PackReviewRunRecord): boolean {
  return record.journalOutcome?.state === 'persisted'
    && (record.reviewVerdict === 'clean' || record.reviewVerdict === 'findings')
    && Number.isInteger(record.findingCount)
    && Number(record.findingCount) >= 0
    && record.findings.length === Number(record.findingCount);
}

function writeRecordUnlocked(storeRoot: string, record: PackReviewRunRecord, createOnly = false): void {
  const path = recordPath(storeRoot, record.id);
  if (createOnly && existsSync(path)) throw new Error(`pack review run already exists: ${record.id}`);
  mkdirSync(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${randomUUID()}.tmp`);
  writeFileSync(temp, `${JSON.stringify(record)}\n`, 'utf8');
  try {
    renameRecordWithRetry(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

export function listPackReviewRuns(options: PackReviewStoreOptions = {}): PackReviewRunRecord[] {
  const storeRoot = resolvePackReviewRunStoreRoot(options);
  const now = options.now ?? new Date();
  return withStoreLock(storeRoot, () => readRecordsUnlocked(storeRoot)
    .filter((record) => !options.projectId || record.projectId === options.projectId)
    .sort((left, right) => {
      if (!samePackReviewRunIdentity(left, right)) return Date.parse(right.createdAt) - Date.parse(left.createdAt);
      const comparison = compareSameKeyRuns(right, left);
      if (comparison === null) return left.id.localeCompare(right.id);
      return comparison;
    })
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
    const canonicalRepository = input.canonicalRepository
      ? normalizePackReviewCanonicalRepository(input.canonicalRepository)
      : undefined;
    const key = packReviewRunKey(input.prNumber, headSha, canonicalRepository);
    const active = records.filter((record) => matchesPackReviewRunInput(
      record,
      projectId,
      input.prNumber,
      headSha,
      canonicalRepository,
      input.sourceRepoRoot,
    )
      && PACK_REVIEW_ACTIVE_STATUSES.has(record.status)
      && !isPackReviewRunStale(record));
    if (active.length > 1) throw new Error(`ambiguous pack review run store: multiple active records for ${key}`);
    if (active.length === 1) {
      return { created: false, reused: true, reason: 'active_run_exists', run: consumerRow(active[0]!), storeRoot };
    }

    const completed = records
      .filter((record) => matchesPackReviewRunInput(
        record,
        projectId,
        input.prNumber,
        headSha,
        canonicalRepository,
        input.sourceRepoRoot,
      )
        && PACK_REVIEW_VERDICT_TERMINAL_STATUSES.has(record.status)
        && hasPersistedPackReviewVerdict(record));
    const latestCompleted = selectLatestSameKeyRun(records, completed);
    if (latestCompleted) {
      return { created: false, reused: true, reason: 'terminal_run_exists', run: consumerRow(latestCompleted), storeRoot };
    }

    const now = (input.now ?? new Date()).toISOString();
    const sameKeyOrders = records
      .filter((record) => matchesPackReviewRunInput(
        record,
        projectId,
        input.prNumber,
        headSha,
        canonicalRepository,
        input.sourceRepoRoot,
      ) && record.sameKeyOrder !== undefined)
      .map((record) => record.sameKeyOrder!);
    const sameKeyOrder = (sameKeyOrders.length > 0 ? Math.max(...sameKeyOrders) : 0) + 1;
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
      canonicalRepository,
      runnerPid: process.pid,
      createdAt: now,
      updatedAt: now,
      heartbeatAtUtc: now,
      sameKeyOrder,
      findings: [],
      deliveryOutcomes: {},
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
      sameKeyOrder: existing.sameKeyOrder,
      id: existing.id,
      runId: existing.runId,
      key: existing.key,
      prNumber: existing.prNumber,
      targetSha: existing.targetSha,
      headSha: existing.headSha,
      canonicalRepository: existing.canonicalRepository ?? fields.canonicalRepository,
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
  status: Extract<PackReviewRunStatus, 'up_to_date' | 'commented' | 'changes_requested' | 'failed' | 'timed_out' | 'cancelled'>,
  fields: Partial<PackReviewRunRecord> = {},
  options: PackReviewStoreOptions = {},
): PackReviewRunRecord {
  if (!PACK_REVIEW_TERMINAL_STATUSES.has(status)) throw new Error(`invalid terminal review status '${status}'`);
  const verdictTerminal = PACK_REVIEW_VERDICT_TERMINAL_STATUSES.has(status);
  return updatePackReviewRun(runId, {
    ...fields,
    ...(verdictTerminal ? { failureReason: undefined, stale: undefined } : {}),
    status,
    latestRunStatus: status,
    completedAtUtc: (options.now ?? new Date()).toISOString(),
  }, options);
}
