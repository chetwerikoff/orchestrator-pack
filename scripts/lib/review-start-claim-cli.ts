import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  fsyncSync,
} from 'node:fs';
import { homedir, hostname, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  classifyClaimHolderLiveness,
  evaluateHoldBudget,
  evaluateLaunchPending,
  evaluateReadinessEnvelope,
  evaluateReclaimDecision,
  evaluateSweep,
  evaluateVisibilityFence,
  findCoveringRunForKey,
  resolveClaimLifecycleConfig,
} from '../../docs/review-start-claim-lifecycle.mjs';
import {
  evaluateAutomatedLaunchClaimGate,
  resolveBindingProjectNamespace,
} from '../../docs/review-start-claim-run-binding.mjs';
import {
  beginInfraPauseSegment,
  closeInfraPauseSegment,
  getMonotonicNowMs,
} from '../../docs/review-start-envelope-external-io.mjs';

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type UnknownRecord = Record<string, unknown>;

export interface ClaimHolder extends UnknownRecord {
  surface: string;
  pid: number;
  host: string;
  generation: string;
  processGuid: string;
  startTimeTicks?: string;
  bootIdHash?: string;
}

export interface ReviewStartClaimRecord extends UnknownRecord {
  schemaVersion: number;
  key: string;
  prNumber: number;
  headSha: string;
  state: string;
  holder: ClaimHolder;
  acquiredAtUtc: string;
  startReason: string;
  projectNamespace: string;
  firstAttemptAtMonotonicMs: number;
  readinessStartMonotonicMs: number;
}

export interface ClaimResult extends UnknownRecord {
  acquired: boolean;
  reason?: string;
  recovered?: boolean;
  claim?: ReviewStartClaimRecord;
  holder?: ClaimHolder;
  path?: string;
  namespace?: string;
  key?: string;
  recoveredRecord?: ReviewStartClaimRecord;
  blocking?: boolean;
  escalation?: boolean;
  detail?: string;
}

interface MutexLease {
  lockDir: string;
  processGuid: string;
}

interface ReadRecordResult {
  ok: boolean;
  reason?: string;
  record?: ReviewStartClaimRecord;
  acquiredAtUtc?: Date;
  error?: string;
}

export const REVIEW_START_CLAIM_STORE_VERSION = 'review-start-claim-store/v1';
export const REVIEW_START_CLAIM_SCHEMA_VERSION = 1;
const FULL_SHA = /^[0-9a-f]{40}$/;
const DEFAULT_PROJECT_ID = 'orchestrator-pack';
const DEFAULT_STALE_MINUTES = 10;
const DEFAULT_MUTEX_STALE_SECONDS = 120;
const DEFAULT_TERMINAL_RETENTION = 64;
const RETRY_ELIGIBLE_TERMINALS = new Set([
  'recovered_stale',
  'recovered_orphan_liveness',
  'released_for_retry',
  'released_after_run_terminalized',
  'aborted_by_recheck',
  'hold_budget_exceeded',
  'readiness_envelope_exceeded',
  'operator_resolved_rearmed',
]);

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value == null ? [] : [value];
}

function asString(value: unknown): string {
  return String(value ?? '').trim();
}

function asNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nowIso(): string {
  return new Date().toISOString();
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function readLinuxProcessStartTicks(pid: number): string | undefined {
  if (platform() !== 'linux' || pid <= 0) return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    if (close < 0) return undefined;
    const fields = stat.slice(close + 2).split(/\s+/);
    return fields[19] || undefined;
  } catch {
    return undefined;
  }
}

function readBootIdHash(): string | undefined {
  if (platform() !== 'linux') return undefined;
  try {
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    return bootId ? sha256(bootId) : undefined;
  } catch {
    return undefined;
  }
}

function mountInfoForPath(target: string): { mount: string; fsType: string } | null {
  if (platform() !== 'linux') return null;
  try {
    const canonical = resolve(target);
    const rows = readFileSync('/proc/self/mountinfo', 'utf8').split(/\r?\n/).filter(Boolean);
    let best: { mount: string; fsType: string } | null = null;
    for (const row of rows) {
      const split = row.split(' - ');
      if (split.length !== 2) continue;
      const left = split[0]?.split(' ') ?? [];
      const right = split[1]?.split(' ') ?? [];
      const mount = (left[4] ?? '').replace(/\\040/g, ' ');
      const fsType = right[0] ?? '';
      if (!mount || !(canonical === mount || (mount === '/' ? canonical.startsWith('/') : canonical.startsWith(`${mount}/`)))) continue;
      if (!best || mount.length > best.mount.length) best = { mount, fsType };
    }
    return best;
  } catch {
    return null;
  }
}

export function assertSupportedClaimPlatform(namespace: string): void {
  if (Number(process.versions.node.split('.')[0]) !== 22) throw new Error('unsupported_node_major');
  if (platform() !== 'linux') throw new Error('unsupported_claim_platform');
  const canonical = resolve(namespace);
  if (/^\/mnt\/[a-z](?:\/|$)/i.test(canonical)) throw new Error('unsupported_windows_mounted_filesystem');
  const info = mountInfoForPath(canonical);
  if (!info) throw new Error('claim_filesystem_unverified');
  const unsupported = new Set(['9p', 'drvfs', 'cifs', 'smbfs', 'nfs', 'nfs4', 'fuseblk', 'fuse.sshfs']);
  if (unsupported.has(info.fsType.toLowerCase())) throw new Error(`unsupported_claim_filesystem:${info.fsType}`);
  if (!readLinuxProcessStartTicks(process.pid) || !readBootIdHash()) {
    throw new Error('claim_process_identity_unverified');
  }
}

export function normalizeHeadSha(headSha: string): string {
  const normalized = asString(headSha).toLowerCase();
  if (!FULL_SHA.test(normalized)) throw new Error(`ambiguous head SHA for review-start claim: '${headSha}' (expected full 40-hex SHA)`);
  return normalized;
}

export function resolveReviewStartClaimNamespace(input: { projectId?: string; namespace?: string } = {}): string {
  const explicit = asString(input.namespace);
  if (explicit) return resolve(explicit);
  const env = asString(process.env.AO_REVIEW_CLAIM_DIR);
  if (env) return resolve(env);
  const projectId = asString(input.projectId) || DEFAULT_PROJECT_ID;
  const base = asString(process.env.AO_BASE_DIR) || join(homedir(), '.agent-orchestrator');
  return resolve(base, 'projects', projectId, 'review-start-claims');
}

export function claimKey(prNumber: number, headSha: string): string {
  return `pr-${positiveInteger(prNumber, 0)}-${normalizeHeadSha(headSha)}`;
}

export function claimPath(namespace: string, prNumber: number, headSha: string): string {
  return join(resolve(namespace), `${claimKey(prNumber, headSha)}.json`);
}

export function claimLockDir(namespace: string, prNumber: number, headSha: string): string {
  return join(resolve(namespace), '.locks', claimKey(prNumber, headSha));
}

export function terminalDir(namespace: string): string {
  return join(resolve(namespace), 'terminal');
}

export function auditDir(namespace: string): string {
  return join(resolve(namespace), 'audit');
}

function syncDirectory(path: string): void {
  try {
    const fd = openSync(path, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch (error) {
    throw new Error(`claim_directory_fsync_failed:${error instanceof Error ? error.message : String(error)}`);
  }
}

function probeClaimFilesystem(namespace: string): void {
  const canonical = resolve(namespace);
  mkdirSync(canonical, { recursive: true, mode: 0o700 });
  const probe = join(canonical, `.opk-claim-preflight-${process.pid}-${randomUUID()}`);
  mkdirSync(probe, { recursive: false, mode: 0o700 });
  try {
    if (typeof process.getuid === 'function' && statSync(probe).uid !== process.getuid()) {
      throw new Error('claim_filesystem_ownership_unverified');
    }
    let exclusionEstablished = false;
    try {
      mkdirSync(probe, { recursive: false, mode: 0o700 });
    } catch (error) {
      exclusionEstablished = (error as NodeJS.ErrnoException).code === 'EEXIST';
    }
    if (!exclusionEstablished) throw new Error('claim_directory_exclusion_unverified');

    const source = join(probe, 'rename-source');
    const destination = join(probe, 'rename-destination');
    const payload = `claim-preflight:${randomUUID()}`;
    const fd = openSync(source, 'wx', 0o600);
    try {
      writeFileSync(fd, payload, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(source, destination);
    syncDirectory(probe);
    if (readFileSync(destination, 'utf8') !== payload || existsSync(source)) {
      throw new Error('claim_atomic_rename_unverified');
    }
  } finally {
    rmSync(probe, { recursive: true, force: true });
    syncDirectory(canonical);
  }
}

export function initializeNamespace(namespace: string): void {
  if (!asString(namespace)) throw new Error('review-start claim namespace is empty');
  assertSupportedClaimPlatform(namespace);
  probeClaimFilesystem(namespace);
  for (const target of [resolve(namespace), join(resolve(namespace), '.locks'), terminalDir(namespace), auditDir(namespace)]) {
    mkdirSync(target, { recursive: true, mode: 0o700 });
  }
}

export function atomicWriteJson(path: string, record: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(record)}\n`, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  syncDirectory(dirname(path));
}

function validateRecord(value: unknown): ReadRecordResult {
  const record = asRecord(value) as ReviewStartClaimRecord;
  for (const required of ['schemaVersion', 'key', 'prNumber', 'headSha', 'holder', 'acquiredAtUtc', 'state'] as const) {
    if (record[required] == null || asString(record[required]) === '') return { ok: false, reason: `missing_${required}` };
  }
  try {
    if (record.headSha !== normalizeHeadSha(record.headSha)) return { ok: false, reason: 'bad_head_sha' };
  } catch {
    return { ok: false, reason: 'bad_head_sha' };
  }
  const acquiredMs = Date.parse(record.acquiredAtUtc);
  if (!Number.isFinite(acquiredMs)) return { ok: false, reason: 'bad_timestamp' };
  if (acquiredMs > Date.now() + 60_000) return { ok: false, reason: 'future_timestamp' };
  const holder = asRecord(record.holder);
  if (!asString(holder.processGuid)) return { ok: false, reason: 'missing_holder_processGuid' };
  return { ok: true, record, acquiredAtUtc: new Date(acquiredMs) };
}

export function readClaimRecord(path: string): ReadRecordResult {
  try {
    if (!existsSync(path)) return { ok: false, reason: 'missing' };
    const raw = readFileSync(path, 'utf8');
    if (!raw.trim()) return { ok: false, reason: 'empty' };
    return validateRecord(JSON.parse(raw));
  } catch (error) {
    return { ok: false, reason: 'unreadable', error: error instanceof Error ? error.message : String(error) };
  }
}

function newHolder(surface: string, context: UnknownRecord = {}): ClaimHolder {
  const holderPid = positiveInteger(context.pid, process.pid);
  const holder: ClaimHolder = {
    surface: asString(surface),
    pid: holderPid,
    host: asString(context.host) || hostname() || 'unknown-host',
    generation: asString(context.generation) || asString(process.env.AO_CHILD_GENERATION || process.env.AO_SESSION_ID),
    processGuid: asString(context.processGuid) || randomUUID().replace(/-/g, ''),
  };
  const startTimeTicks = readLinuxProcessStartTicks(holderPid);
  const bootIdHash = readBootIdHash();
  if (startTimeTicks) holder.startTimeTicks = startTimeTicks;
  if (bootIdHash) holder.bootIdHash = bootIdHash;
  return holder;
}

function ownerPath(lockDir: string): string {
  return join(lockDir, 'owner.json');
}

function processIdentityAlive(owner: UnknownRecord): boolean {
  const pid = Math.trunc(asNumber(owner.pid));
  if (pid <= 0) return false;
  if (asString(owner.host) && asString(owner.host) !== hostname()) return true;
  try { process.kill(pid, 0); } catch { return false; }
  const expectedTicks = asString(owner.startTimeTicks);
  if (expectedTicks && readLinuxProcessStartTicks(pid) !== expectedTicks) return false;
  const expectedBoot = asString(owner.bootIdHash);
  if (expectedBoot && readBootIdHash() !== expectedBoot) return false;
  return true;
}

function readMutexOwner(lockDir: string): UnknownRecord | null {
  try {
    const value = JSON.parse(readFileSync(ownerPath(lockDir), 'utf8'));
    return asRecord(value);
  } catch {
    return null;
  }
}

function mutexAbandoned(lockDir: string): boolean {
  if (!existsSync(lockDir)) return false;
  const owner = readMutexOwner(lockDir);
  if (owner) return !processIdentityAlive(owner);
  try {
    const ageSeconds = (Date.now() - statSync(lockDir).mtimeMs) / 1000;
    return ageSeconds >= positiveInteger(process.env.AO_REVIEW_CLAIM_MUTEX_STALE_SECONDS, DEFAULT_MUTEX_STALE_SECONDS);
  } catch {
    return false;
  }
}

function enterMutex(lockDir: string, maxAttempts = 120, sleepMs = 25): MutexLease | null {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const processGuid = randomUUID().replace(/-/g, '');
    try {
      mkdirSync(lockDir, { recursive: false, mode: 0o700 });
      const owner: UnknownRecord = {
        pid: process.pid,
        host: hostname() || 'unknown-host',
        processGuid,
        acquiredAtUtc: nowIso(),
        lockDir,
      };
      const startTimeTicks = readLinuxProcessStartTicks(process.pid);
      const bootIdHash = readBootIdHash();
      if (startTimeTicks) owner.startTimeTicks = startTimeTicks;
      if (bootIdHash) owner.bootIdHash = bootIdHash;
      atomicWriteJson(ownerPath(lockDir), owner);
      return { lockDir, processGuid };
    } catch {
      if (mutexAbandoned(lockDir)) {
        rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      if (attempt + 1 < maxAttempts) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sleepMs);
    }
  }
  return null;
}

function exitMutex(lease: MutexLease | null): void {
  if (!lease || !existsSync(lease.lockDir)) return;
  const owner = readMutexOwner(lease.lockDir);
  if (owner && asString(owner.processGuid) !== lease.processGuid) return;
  rmSync(lease.lockDir, { recursive: true, force: true });
  syncDirectory(dirname(lease.lockDir));
}

function withMutex<T>(lockDir: string, operation: () => T, attempts = 120): T | { ok: false; reason: 'busy' } {
  const lease = enterMutex(lockDir, attempts);
  if (!lease) return { ok: false, reason: 'busy' };
  try { return operation(); } finally { exitMutex(lease); }
}

function monotonicNow(): number {
  return Math.trunc(getMonotonicNowMs(process.env));
}

function staleMinutes(): number {
  const raw = asString(process.env.AO_REVIEW_CLAIM_STALE_MINUTES || process.env.AO_REVIEW_START_CLAIM_STALE_MINUTES);
  const parsed = raw ? Number(raw) : DEFAULT_STALE_MINUTES;
  const resolved = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STALE_MINUTES;
  return Math.max(2, resolved);
}

function priorFirstAttempt(record: UnknownRecord | null | undefined): number {
  const first = asNumber(record?.firstAttemptAtMonotonicMs || record?.readinessStartMonotonicMs);
  return first > 0 ? Math.trunc(first) : 0;
}

function readPriorFirstAttempt(namespace: string, key: string): number {
  if (!existsSync(terminalDir(namespace))) return 0;
  let bestAt = 0;
  let bestMono = 0;
  for (const name of readdirSync(terminalDir(namespace))) {
    if (!name.endsWith('.json')) continue;
    const read = readClaimRecord(join(terminalDir(namespace), name));
    if (!read.ok || !read.record || read.record.key !== key || !RETRY_ELIGIBLE_TERMINALS.has(asString(read.record.outcome))) continue;
    const mono = priorFirstAttempt(read.record);
    const at = Date.parse(asString(read.record.terminalAtUtc));
    if (mono > 0 && (at > bestAt || (at === bestAt && mono > bestMono))) {
      bestAt = Number.isFinite(at) ? at : 0;
      bestMono = mono;
    }
  }
  return bestMono;
}

function newActiveRecord(input: {
  prNumber: number;
  headSha: string;
  surface: string;
  startReason?: string;
  projectId?: string;
  recoveredFrom?: unknown;
  priorFirstAttemptMonotonicMs?: number;
  holderContext?: UnknownRecord;
}): ReviewStartClaimRecord {
  const normalized = normalizeHeadSha(input.headSha);
  const mono = monotonicNow();
  const firstAttempt = input.priorFirstAttemptMonotonicMs && input.priorFirstAttemptMonotonicMs > 0
    ? Math.trunc(input.priorFirstAttemptMonotonicMs)
    : mono;
  const record: ReviewStartClaimRecord = {
    schemaVersion: REVIEW_START_CLAIM_SCHEMA_VERSION,
    key: claimKey(input.prNumber, normalized),
    prNumber: input.prNumber,
    headSha: normalized,
    state: 'active',
    holder: newHolder(input.surface, input.holderContext),
    acquiredAtUtc: nowIso(),
    startReason: asString(input.startReason),
    projectNamespace: asString(input.projectId) || DEFAULT_PROJECT_ID,
    firstAttemptAtMonotonicMs: firstAttempt,
    readinessStartMonotonicMs: firstAttempt,
  };
  if (input.recoveredFrom != null) record.recoveredFrom = input.recoveredFrom;
  return record;
}

function formatHolder(holder: unknown): string {
  const value = asRecord(holder);
  return `surface=${asString(value.surface)} pid=${asString(value.pid)} host=${asString(value.host)} generation=${asString(value.generation)} processGuid=${asString(value.processGuid)}`;
}

function pruneTerminal(namespace: string): void {
  const keep = positiveInteger(process.env.AO_REVIEW_CLAIM_TERMINAL_COUNT || process.env.AO_REVIEW_CLAIM_TERMINAL_RETENTION, DEFAULT_TERMINAL_RETENTION);
  if (!existsSync(terminalDir(namespace))) return;
  const files = readdirSync(terminalDir(namespace))
    .filter((name) => name.endsWith('.json'))
    .map((name) => ({ name, mtime: statSync(join(terminalDir(namespace), name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const file of files.slice(keep)) rmSync(join(terminalDir(namespace), file.name), { force: true });
}

function writeAudit(namespace: string, prior: ReviewStartClaimRecord, outcome: string, decisionSource: string, extra: UnknownRecord = {}, newState = 'terminal'): string {
  mkdirSync(auditDir(namespace), { recursive: true, mode: 0o700 });
  const path = join(auditDir(namespace), `${randomUUID().replace(/-/g, '')}.json`);
  atomicWriteJson(path, {
    kind: 'claim_transition',
    key: prior.key,
    prNumber: prior.prNumber,
    headSha: prior.headSha,
    priorState: prior.state,
    newState,
    outcome,
    decisionSource,
    atUtc: nowIso(),
    ...extra,
  });
  return path;
}

function moveToTerminal(namespace: string, activePath: string, record: ReviewStartClaimRecord, outcome: string, extra: UnknownRecord = {}): string {
  const terminal: UnknownRecord = { ...record, state: 'terminal', outcome, terminalAtUtc: nowIso(), ...extra };
  const target = join(terminalDir(namespace), `${activePath.split('/').pop()}.${outcome}.${Date.now()}.json`);
  atomicWriteJson(target, terminal);
  rmSync(activePath, { force: true });
  syncDirectory(dirname(activePath));
  pruneTerminal(namespace);
  return target;
}

function holderLiveness(record: ReviewStartClaimRecord): UnknownRecord {
  const holder = asRecord(record.holder);
  const localHost = hostname() || 'unknown-host';
  return asRecord(classifyClaimHolderLiveness(holder, {
    localHost,
    processExists: (pid: number) => processIdentityAlive({ ...holder, pid }),
    currentBootIdHash: readBootIdHash(),
    resolveProcessStartTicks: (pid: number) => readLinuxProcessStartTicks(pid),
  }));
}

function visibleRun(reviewRuns: unknown[], prNumber: number, headSha: string, projectId?: string): UnknownRecord | null {
  void projectId;
  const match = findCoveringRunForKey(reviewRuns, prNumber, headSha);
  return match ? asRecord(match) : null;
}

function sameGeneration(record: ReviewStartClaimRecord, expected: ReviewStartClaimRecord): boolean {
  return record.key === expected.key
    && asString(record.holder?.processGuid) === asString(expected.holder?.processGuid)
    && asString(record.holder?.generation) === asString(expected.holder?.generation);
}

function terminalizeDecision(input: {
  namespace: string;
  path: string;
  expected: ReviewStartClaimRecord;
  decision: UnknownRecord;
  decisionSource: string;
  reviewRuns?: unknown[];
  mutexAlreadyHeld?: boolean;
}): UnknownRecord {
  const execute = (): UnknownRecord => {
    const read = readClaimRecord(input.path);
    if (!read.ok || !read.record) return { ok: false, reason: 'ambiguous_claim', detail: read.reason };
    if (read.record.state !== 'active') return { ok: false, reason: 'not_active' };
    if (!sameGeneration(read.record, input.expected)) return { ok: false, reason: 'lost_ownership' };
    const outcome = asString(input.decision.outcome);
    if (!outcome) return { ok: false, reason: 'missing_outcome' };
    const extra: UnknownRecord = {
      decisionReason: asString(input.decision.reason),
      decisionSource: input.decisionSource,
      runStoreEvidence: {
        inFlightCount: asArray(input.reviewRuns).filter((run) => {
          const value = asRecord(run);
          return Number(value.prNumber) === read.record?.prNumber && asString(value.targetSha).toLowerCase() === read.record?.headSha;
        }).length,
      },
    };
    for (const key of ['warn', 'coveredRunId', 'liveness', 'hold', 'launch', 'visibility', 'envelope', 'ceiling', 'binding']) {
      if (input.decision[key] != null) extra[key] = input.decision[key];
    }
    const terminalPath = moveToTerminal(input.namespace, input.path, read.record, outcome, extra);
    const auditPath = writeAudit(input.namespace, read.record, outcome, input.decisionSource, extra);
    return { ok: true, outcome, terminalPath, auditPath };
  };
  if (input.mutexAlreadyHeld) return execute();
  const lock = claimLockDir(input.namespace, input.expected.prNumber, input.expected.headSha);
  return withMutex(lock, execute) as UnknownRecord;
}

function resolveExisting(input: {
  namespace: string;
  path: string;
  prNumber: number;
  headSha: string;
  surface: string;
  startReason: string;
  projectId: string;
  reviewRuns: unknown[];
  existing: ReviewStartClaimRecord;
  holderContext?: UnknownRecord;
}): ClaimResult {
  const covering = visibleRun(input.reviewRuns, input.prNumber, input.headSha, input.projectId);
  if (covering) {
    const terminalPath = input.existing.state === 'active'
      ? moveToTerminal(input.namespace, input.path, input.existing, 'run_started', { coverage: 'covered_by_run', coveredBy: 'claim_skip' })
      : input.path;
    return { acquired: false, reason: 'covered_by_run', holder: input.existing.holder, claim: input.existing, path: terminalPath, namespace: input.namespace, key: input.existing.key };
  }
  if (input.existing.manualResolutionRequired) {
    return { acquired: false, reason: 'foreign_holder_manual', holder: input.existing.holder, claim: input.existing, path: input.path, namespace: input.namespace, key: input.existing.key, blocking: true };
  }
  const config = resolveClaimLifecycleConfig({}, process.env);
  const decision = asRecord(evaluateReclaimDecision({
    claim: input.existing,
    holderLiveness: holderLiveness(input.existing),
    reviewRuns: input.reviewRuns,
    nowMs: Date.now(),
    nowMonotonicMs: monotonicNow(),
    config,
    projectNamespace: input.projectId,
  }));
  if (decision.action === 'mark_manual') {
    const updated = { ...input.existing, manualResolutionRequired: true, manualResolutionReason: asString(decision.reason), manualResolutionAtUtc: nowIso() };
    atomicWriteJson(input.path, updated);
    return { acquired: false, reason: 'foreign_holder_manual', holder: updated.holder, claim: updated, path: input.path, namespace: input.namespace, key: updated.key, blocking: true };
  }
  if (decision.action === 'block') {
    return { acquired: false, reason: 'ambiguous_claim', holder: input.existing.holder, claim: input.existing, path: input.path, namespace: input.namespace, key: input.existing.key, blocking: true, detail: asString(decision.reason) };
  }
  let terminalPath: string | null = null;
  let outcome = '';
  if (decision.action === 'terminalize') {
    outcome = asString(decision.outcome) || 'recovered_orphan_liveness';
    terminalPath = moveToTerminal(input.namespace, input.path, input.existing, outcome, { decisionReason: asString(decision.reason), decisionSource: 'acquire_sync' });
    writeAudit(input.namespace, input.existing, outcome, 'acquire_sync', { decisionReason: asString(decision.reason) });
  } else {
    const ageMinutes = (Date.now() - Date.parse(input.existing.acquiredAtUtc)) / 60_000;
    if (ageMinutes >= staleMinutes()) {
      outcome = 'recovered_stale';
      terminalPath = moveToTerminal(input.namespace, input.path, input.existing, outcome, { recoveredBy: newHolder(input.surface) });
      writeAudit(input.namespace, input.existing, outcome, 'stale_timeout');
    } else {
      return { acquired: false, reason: 'claimed', holder: input.existing.holder, claim: input.existing, path: input.path, namespace: input.namespace, key: input.existing.key };
    }
  }
  const record = newActiveRecord({
    prNumber: input.prNumber,
    headSha: input.headSha,
    surface: input.surface,
    startReason: input.startReason,
    projectId: input.projectId,
    recoveredFrom: { path: terminalPath, holder: input.existing.holder, acquiredAtUtc: input.existing.acquiredAtUtc, outcome },
    priorFirstAttemptMonotonicMs: priorFirstAttempt(input.existing),
    holderContext: input.holderContext,
  });
  atomicWriteJson(input.path, record);
  const verify = readClaimRecord(input.path);
  if (!verify.ok || !verify.record || !sameGeneration(verify.record, record)) {
    return { acquired: false, reason: 'ambiguous_claim', escalation: true, detail: 'lost_race_without_active_record', path: input.path, namespace: input.namespace, key: record.key };
  }
  return { acquired: true, recovered: true, claim: record, path: input.path, namespace: input.namespace, key: record.key, recoveredRecord: input.existing };
}

export function acquireReviewStartClaim(input: {
  prNumber: number;
  headSha: string;
  surface: string;
  reviewRuns?: unknown[];
  namespace?: string;
  projectId?: string;
  startReason?: string;
  holderContext?: UnknownRecord;
}): ClaimResult {
  const projectId = asString(input.projectId) || DEFAULT_PROJECT_ID;
  const namespace = resolveReviewStartClaimNamespace({ projectId, namespace: input.namespace });
  try {
    initializeNamespace(namespace);
    const headSha = normalizeHeadSha(input.headSha);
    const path = claimPath(namespace, input.prNumber, headSha);
    const key = claimKey(input.prNumber, headSha);
    const lock = claimLockDir(namespace, input.prNumber, headSha);
    const lease = enterMutex(lock);
    if (!lease) {
      const existing = readClaimRecord(path);
      return existing.ok && existing.record
        ? { acquired: false, reason: 'claimed', holder: existing.record.holder, claim: existing.record, path, namespace, key: existing.record.key }
        : { acquired: false, reason: 'claimed', path, namespace, key };
    }
    try {
      const existing = readClaimRecord(path);
      if (existing.ok && existing.record) {
        return resolveExisting({
          namespace,
          path,
          prNumber: input.prNumber,
          headSha,
          surface: input.surface,
          startReason: asString(input.startReason),
          projectId,
          reviewRuns: asArray(input.reviewRuns),
          existing: existing.record,
          holderContext: input.holderContext,
        });
      }
      if (existing.reason !== 'missing') {
        return { acquired: false, reason: 'ambiguous_claim', escalation: true, detail: existing.reason, path, namespace, key };
      }
      const record = newActiveRecord({
        prNumber: input.prNumber,
        headSha,
        surface: input.surface,
        startReason: input.startReason,
        projectId,
        priorFirstAttemptMonotonicMs: readPriorFirstAttempt(namespace, key),
        holderContext: input.holderContext,
      });
      atomicWriteJson(path, record);
      const verify = readClaimRecord(path);
      if (!verify.ok || !verify.record || !sameGeneration(verify.record, record)) {
        return { acquired: false, reason: 'ambiguous_claim', escalation: true, detail: 'lost_race_without_active_record', path, namespace, key };
      }
      return { acquired: true, recovered: false, claim: record, path, namespace, key };
    } finally {
      exitMutex(lease);
    }
  } catch (error) {
    return { acquired: false, reason: 'storage_failure', escalation: true, detail: error instanceof Error ? error.message : String(error), namespace };
  }
}

function requireClaim(input: ClaimResult): { ok: true; claim: ReviewStartClaimRecord; path: string; namespace: string } | { ok: false; result: UnknownRecord } {
  if (!input?.acquired || !input.claim || !input.path || !input.namespace) return { ok: false, result: { ok: false, reason: 'no_claim' } };
  return { ok: true, claim: input.claim, path: input.path, namespace: input.namespace };
}

export function testReviewStartClaimOwnership(input: ClaimResult): boolean {
  const required = requireClaim(input);
  if (!required.ok) return false;
  const read = readClaimRecord(required.path);
  return Boolean(read.ok && read.record && sameGeneration(read.record, required.claim));
}

export function updateReviewStartClaimRecordFields(input: ClaimResult, fields: UnknownRecord, clearFields: string[] = []): UnknownRecord {
  const required = requireClaim(input);
  if (!required.ok) return required.result;
  const lock = claimLockDir(required.namespace, required.claim.prNumber, required.claim.headSha);
  return withMutex(lock, () => {
    const read = readClaimRecord(required.path);
    if (!read.ok || !read.record) return { ok: false, reason: 'ambiguous_claim', detail: read.reason };
    if (!sameGeneration(read.record, required.claim)) return { ok: false, reason: 'lost_ownership', holder: read.record.holder };
    const record: ReviewStartClaimRecord = { ...read.record, ...fields };
    for (const key of clearFields) delete record[key];
    atomicWriteJson(required.path, record);
    input.claim = record;
    return { ok: true, record, claimResult: input };
  }) as UnknownRecord;
}

export function bindReviewStartClaimToVisibleRun(input: ClaimResult, reviewRuns: unknown[] = []): UnknownRecord {
  const required = requireClaim(input);
  if (!required.ok) return required.result;
  const covering = visibleRun(reviewRuns, required.claim.prNumber, required.claim.headSha, required.claim.projectNamespace);
  const runId = asString(covering?.runId);
  if (!runId) return { ok: false, reason: 'no_visible_run' };
  const current = asString(required.claim.boundRunId);
  if (current && current !== runId) return { ok: false, reason: 'bound_to_other_run', boundRunId: current };
  const updated = updateReviewStartClaimRecordFields(input, { boundRunId: runId });
  return updated.ok ? { ok: true, boundRunId: runId, claimResult: input } : updated;
}

export function completeReviewStartClaim(input: ClaimResult, outcome: string, reviewRuns: unknown[] = [], extra: UnknownRecord = {}): UnknownRecord {
  const required = requireClaim(input);
  if (!required.ok) return required.result;
  const lock = claimLockDir(required.namespace, required.claim.prNumber, required.claim.headSha);
  return withMutex(lock, () => {
    const read = readClaimRecord(required.path);
    if (!read.ok || !read.record) return { ok: false, reason: 'ambiguous_claim', detail: read.reason };
    if (!sameGeneration(read.record, required.claim)) return { ok: false, reason: 'lost_ownership', holder: read.record.holder };
    if (outcome === 'run_started' && !visibleRun(reviewRuns, read.record.prNumber, read.record.headSha, read.record.projectNamespace)) {
      return { ok: false, reason: 'run_not_visible' };
    }
    const target = moveToTerminal(required.namespace, required.path, read.record, outcome, extra);
    const auditPath = writeAudit(required.namespace, read.record, outcome, 'completion', extra);
    return { ok: true, terminalPath: target, outcome, auditPath };
  }) as UnknownRecord;
}

export function releaseAfterRunFailure(input: ClaimResult, reviewRuns: unknown[] = [], failure = ''): UnknownRecord {
  const required = requireClaim(input);
  if (!required.ok) return required.result;
  if (!visibleRun(reviewRuns, required.claim.prNumber, required.claim.headSha, required.claim.projectNamespace)) {
    return completeReviewStartClaim(input, 'released_for_retry', reviewRuns, { failure });
  }
  return completeReviewStartClaim(input, 'escalated_ambiguous', [], { failure, reason: 'post_exit_state_ambiguous' });
}

export function confirmReviewStartClaimLaunchGate(input: ClaimResult, reviewRuns: unknown[] = [], decisionSource = 'hold_budget'): UnknownRecord {
  const required = requireClaim(input);
  if (!required.ok) return required.result;
  const projectNamespace = resolveBindingProjectNamespace({ claim: required.claim, projectNamespace: required.claim.projectNamespace });
  const gate = asRecord(evaluateAutomatedLaunchClaimGate({
    claim: required.claim,
    prNumber: required.claim.prNumber,
    headSha: required.claim.headSha,
    projectNamespace,
    surface: required.claim.holder.surface,
    startReason: required.claim.startReason,
  }));
  if (gate.ok === false) return { ok: false, reason: asString(gate.reason), bindingGate: gate.gate };
  const holdStartedAtUtc = nowIso();
  let update = updateReviewStartClaimRecordFields(input, { holdStartedAtUtc });
  if (!update.ok) return { ok: false, reason: update.reason === 'lost_ownership' ? 'claim_ownership_lost' : update.reason };
  const hold = asRecord(evaluateHoldBudget({ claim: input.claim, nowMs: Date.now(), nowMonotonicMs: monotonicNow(), config: resolveClaimLifecycleConfig({}, process.env) }));
  if (hold.exceeded) {
    const decision = { action: 'terminalize', outcome: 'hold_budget_exceeded', reason: 'hold_budget_exceeded', hold };
    const terminal = terminalizeDecision({ namespace: required.namespace, path: required.path, expected: input.claim as ReviewStartClaimRecord, decision, decisionSource, reviewRuns });
    return { ok: false, reason: 'hold_budget_exceeded', terminal };
  }
  if (!testReviewStartClaimOwnership(input)) return { ok: false, reason: 'claim_ownership_lost' };
  const config = resolveClaimLifecycleConfig({}, process.env);
  const now = nowIso();
  update = updateReviewStartClaimRecordFields(input, {
    launchPending: { atUtc: now, budgetMs: config.launchPendingBudgetMs },
    launchPendingInvokedAtUtc: now,
  });
  return update.ok ? { ok: true, claimResult: input } : { ok: false, reason: update.reason === 'lost_ownership' ? 'claim_ownership_lost' : update.reason };
}

export function completeAfterRunInvoke(input: ClaimResult, reviewRuns: unknown[] = []): UnknownRecord {
  const required = requireClaim(input);
  if (!required.ok) return required.result;
  bindReviewStartClaimToVisibleRun(input, reviewRuns);
  const complete = completeReviewStartClaim(input, 'run_started', reviewRuns);
  if (complete.ok) return complete;
  if (complete.reason !== 'run_not_visible') return complete;

  const pendingAt = input.claim?.visibilityPendingAtUtc ? asString(input.claim.visibilityPendingAtUtc) : nowIso();
  const updated = updateReviewStartClaimRecordFields(input, {
    invokeCompletedAtUtc: nowIso(),
    visibilityPendingAtUtc: pendingAt,
  }, ['launchPending']);
  if (!updated.ok) return updated;

  const config = asRecord(resolveClaimLifecycleConfig({}, process.env));
  while (true) {
    const read = readClaimRecord(required.path);
    if (!read.ok || !read.record) return { ok: false, reason: 'ambiguous_claim', detail: read.reason };
    if (!sameGeneration(read.record, required.claim)) return { ok: false, reason: 'lost_ownership', holder: read.record.holder };
    input.claim = read.record;

    bindReviewStartClaimToVisibleRun(input, reviewRuns);
    const retry = completeReviewStartClaim(input, 'run_started', reviewRuns);
    if (retry.ok) return retry;
    if (retry.reason !== 'run_not_visible') return retry;

    const nowMs = Date.now();
    const fence = asRecord(evaluateVisibilityFence({
      claim: read.record,
      reviewRuns,
      nowMs,
      nowMonotonicMs: monotonicNow(),
      config,
    }));
    if (fence.shouldFence) {
      const terminal = terminalizeDecision({
        namespace: required.namespace,
        path: required.path,
        expected: read.record,
        decision: { action: 'terminalize', outcome: 'run_not_visible_fenced', reason: asString(fence.reason), visibility: fence },
        decisionSource: 'post_run_visibility',
        reviewRuns,
      });
      return terminal.ok
        ? { ...terminal, reason: 'run_not_visible_fenced', fenced: true, fence }
        : terminal;
    }

    const envelope = asRecord(evaluateReadinessEnvelope({
      claim: read.record,
      nowMs,
      nowMonotonicMs: monotonicNow(),
      config,
    }));
    if (envelope.exceeded) {
      const terminal = terminalizeDecision({
        namespace: required.namespace,
        path: required.path,
        expected: read.record,
        decision: {
          action: 'terminalize',
          outcome: 'run_not_visible_fenced',
          reason: 'readiness_envelope_exceeded',
          visibility: fence,
          envelope,
        },
        decisionSource: 'post_run_visibility',
        reviewRuns,
      });
      return terminal.ok
        ? { ...terminal, reason: 'run_not_visible_fenced', fenced: true, envelope }
        : terminal;
    }

    const visibilityBudgetMs = positiveInteger(config.visibilityBudgetMs, 15_000);
    const pendingMs = Date.parse(asString(read.record.visibilityPendingAtUtc));
    const visibilityAgeMs = Number.isFinite(pendingMs) ? Math.max(0, nowMs - pendingMs) : visibilityBudgetMs;
    const remaining = Math.min(asNumber(envelope.remainingMs, visibilityBudgetMs), Math.max(0, visibilityBudgetMs - visibilityAgeMs));
    if (remaining <= 0) continue;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(250, remaining));
  }
}

export function getActiveRecords(namespace: string): ReviewStartClaimRecord[] {
  initializeNamespace(namespace);
  return readdirSync(namespace)
    .filter((name) => /^pr-.*\.json$/.test(name))
    .map((name) => readClaimRecord(join(namespace, name)))
    .filter((read): read is ReadRecordResult & { record: ReviewStartClaimRecord } => Boolean(read.ok && read.record?.state === 'active'))
    .map((read) => read.record);
}

export function reaperSweep(input: { projectId?: string; namespace?: string; reviewRuns?: unknown[]; reviewerEvidence?: unknown[] }): UnknownRecord {
  const namespace = resolveReviewStartClaimNamespace(input);
  initializeNamespace(namespace);
  const records = getActiveRecords(namespace);
  const reviewRuns = asArray(input.reviewRuns);
  const sweep = asRecord(evaluateSweep({
    activeClaims: records,
    reviewRuns,
    nowMs: Date.now(),
    nowMonotonicMs: monotonicNow(),
    localHost: hostname() || 'unknown-host',
    config: resolveClaimLifecycleConfig({}, process.env),
    projectNamespace: asString(input.projectId) || DEFAULT_PROJECT_ID,
  }));
  const actions = asArray(sweep.actions).map(asRecord);
  const results: UnknownRecord[] = [];
  for (const actionRow of actions) {
    const key = asString(actionRow.key);
    const record = records.find((candidate) => candidate.key === key);
    if (!record) continue;
    const path = claimPath(namespace, record.prNumber, record.headSha);
    const decision = asRecord(actionRow.decision);
    if (decision.action === 'terminalize') {
      const result = terminalizeDecision({
        namespace,
        path,
        expected: record,
        decision,
        decisionSource: 'reaper',
        reviewRuns,
      });
      results.push({ key, action: decision.action, outcome: decision.outcome, reclaimed: result.ok === true, result });
    } else if (decision.action === 'reconcile') {
      const claimResult: ClaimResult = { acquired: true, claim: record, namespace, path, key };
      const result = completeReviewStartClaim(claimResult, asString(decision.outcome), reviewRuns, {
        reason: asString(decision.reason),
        boundRunId: decision.runId,
        binding: decision.binding,
      });
      results.push({ key, action: decision.action, outcome: decision.outcome, reclaimed: false, result });
    } else if (decision.action === 'mark_manual') {
      const claimResult: ClaimResult = { acquired: true, claim: record, namespace, path, key };
      const result = updateReviewStartClaimRecordFields(claimResult, {
        manualResolutionRequired: true,
        manualResolutionReason: asString(decision.reason),
        manualResolutionAtUtc: nowIso(),
      });
      results.push({ key, action: decision.action, reason: decision.reason, manual: true, blocking: true, result });
    } else {
      results.push({ key, action: decision.action, reason: decision.reason });
    }
  }
  return {
    ok: true,
    namespace,
    scanned: records.length,
    results,
    batchReads: asNumber(sweep.runStoreBatchReads, 1),
  };
}

export function startInfraPause(input: ClaimResult, supervisedGhPid = 0): UnknownRecord {
  const begin = asRecord(beginInfraPauseSegment({ nowMonotonicMs: monotonicNow(), supervisedGhPid: supervisedGhPid > 0 ? supervisedGhPid : null }));
  return updateReviewStartClaimRecordFields(input, { activeInfraPause: begin.activeInfraPause });
}

export function completeInfraPause(input: ClaimResult, options: { stderr?: string; timedOut?: boolean; classification?: UnknownRecord } = {}): UnknownRecord {
  const required = requireClaim(input);
  if (!required.ok) return required.result;
  const read = readClaimRecord(required.path);
  if (!read.ok || !read.record) return { ok: false, reason: 'unreadable' };
  const closed = asRecord(closeInfraPauseSegment({
    claim: read.record,
    nowMonotonicMs: monotonicNow(),
    stderr: asString(options.stderr),
    timedOut: options.timedOut === true,
    classification: options.classification,
  }));
  if (!closed.closed) return { ok: false, reason: asString(closed.reason) };
  const update = updateReviewStartClaimRecordFields(input, { infraPauseSegments: asArray(closed.infraPauseSegments) }, closed.clearActiveInfraPause ? ['activeInfraPause'] : []);
  const classification = asRecord(closed.classification);
  return { ok: update.ok === true, classification, failureClass: asString(classification.failureClass), claimResult: input };
}

export function evaluateLifecycle(subcommand: string, payload: UnknownRecord): UnknownRecord {
  const config = resolveClaimLifecycleConfig(asRecord(payload.config), process.env);
  switch (subcommand) {
    case 'validate-config': return { ok: true, config };
    case 'classify-holder': return asRecord(classifyClaimHolderLiveness(asRecord(payload.holder), asRecord(payload.options ?? payload)));
    case 'hold-budget': return asRecord(evaluateHoldBudget({ ...payload, nowMs: payload.nowMs ?? Date.now(), nowMonotonicMs: payload.nowMonotonicMs ?? monotonicNow(), config }));
    case 'launch-pending': return asRecord(evaluateLaunchPending({ ...payload, nowMs: payload.nowMs ?? Date.now(), nowMonotonicMs: payload.nowMonotonicMs ?? monotonicNow(), config }));
    case 'readiness-envelope': return asRecord(evaluateReadinessEnvelope({ ...payload, nowMs: payload.nowMs ?? Date.now(), nowMonotonicMs: payload.nowMonotonicMs ?? monotonicNow(), config }));
    case 'visibility-fence': return asRecord(evaluateVisibilityFence({ ...payload, nowMs: payload.nowMs ?? Date.now(), nowMonotonicMs: payload.nowMonotonicMs ?? monotonicNow(), config }));
    case 'reclaim-decision': return asRecord(evaluateReclaimDecision({ ...payload, nowMs: payload.nowMs ?? Date.now(), nowMonotonicMs: payload.nowMonotonicMs ?? monotonicNow(), config }));
    case 'sweep': return asRecord(evaluateSweep({ ...payload, nowMs: payload.nowMs ?? Date.now(), nowMonotonicMs: payload.nowMonotonicMs ?? monotonicNow(), config }));
    default: throw new Error(`unsupported_lifecycle_subcommand:${subcommand}`);
  }
}


function transportFailure(input: unknown): UnknownRecord | null {
  const value = asRecord(input);
  if (!Object.keys(value).length || value.ok === true) return null;
  const classification = asRecord(value.classification);
  const failureClass = asString(value.failureClass || classification.failureClass);
  const reason = asString(value.reason);
  const infraReason = /^(structured_output_polluted|gh_command_failed|empty_child_output|malformed_child_output|scoped_gh_read_infrastructure_failure|preflight_transient_exhausted|preflight_timeout|claim_ownership_lost)$/.test(reason);
  if (failureClass !== 'infra_transport' && !infraReason) return null;
  return { failureClass: 'infra_transport', transportFailure: value };
}

function targetStateRecheckDenial(snapshot: unknown): UnknownRecord | null {
  const denial = asRecord(asRecord(snapshot).targetStateDenial);
  const reason = asString(denial.reason);
  if (!Object.keys(denial).length || denial.ok === true || !reason) return null;
  return { emitReviewRun: false, reason, targetStateDenial: denial };
}

function infraTransportRecheckDenial(snapshot: unknown): UnknownRecord | null {
  const snap = asRecord(snapshot);
  const infra = transportFailure(snap.transportFailure);
  if (!infra) return null;
  return {
    emitReviewRun: false,
    reason: 'supervised_gh_transport_failure',
    supervisedGhInfraTransport: true,
    transportFailure: infra.transportFailure,
  };
}

function annotateWorktreeConsumed(namespace: string, path: string, expectedValue: unknown, canonicalPath: string): UnknownRecord {
  const expected = asRecord(expectedValue) as ReviewStartClaimRecord;
  if (!namespace || !path || !expected.key || !canonicalPath) return { ok: false, reason: 'claim_consume_invalid' };
  const lock = claimLockDir(namespace, expected.prNumber, expected.headSha);
  return withMutex(lock, () => {
    const read = readClaimRecord(path);
    if (!read.ok || !read.record) return { ok: false, reason: 'ambiguous_claim', detail: read.reason };
    if (read.record.state !== 'active') return { ok: false, reason: 'not_active' };
    if (read.record.headSha !== expected.headSha) return { ok: false, reason: 'claim_head_mismatch' };
    if (!sameGeneration(read.record, expected)) return { ok: false, reason: 'claim_lost' };
    if (read.record.worktreeAllowConsumed) return { ok: false, reason: 'claim_already_consumed' };
    const liveness = holderLiveness(read.record);
    if (liveness.outcome !== 'alive') return { ok: false, reason: 'claim_holder_not_live', detail: asString(liveness.outcome) };
    const gateHolder = newHolder('autonomous-review-worktree-gate');
    const annotation = {
      atUtc: nowIso(),
      worktreeCanonicalPath: canonicalPath,
      consumedBy: 'autonomous-review-worktree-gate',
      annotatedByProcessGuid: gateHolder.processGuid,
    };
    const updated = { ...read.record, worktreeAllowConsumed: annotation };
    atomicWriteJson(path, updated);
    const auditPath = writeAudit(namespace, read.record, 'worktree_allow_consumed', 'worktree_gate', {
      worktreeCanonicalPath: canonicalPath,
      consumedBy: 'autonomous-review-worktree-gate',
      holderProcessGuid: read.record.holder.processGuid,
      foreignWriter: true,
    }, 'active');
    return { ok: true, reason: 'worktree_allow_consumed', auditPath };
  }) as UnknownRecord;
}

function markForeignHolder(namespace: string, path: string, expectedValue: unknown, decisionValue: unknown, decisionSource: string): UnknownRecord {
  const expected = asRecord(expectedValue) as ReviewStartClaimRecord;
  const decision = asRecord(decisionValue);
  const lock = claimLockDir(namespace, expected.prNumber, expected.headSha);
  return withMutex(lock, () => {
    const read = readClaimRecord(path);
    if (!read.ok || !read.record) return { ok: false, reason: 'ambiguous_claim', detail: read.reason };
    if (read.record.state !== 'active') return { ok: false, reason: 'not_active' };
    if (!sameGeneration(read.record, expected)) return { ok: false, reason: 'lost_ownership' };
    if (read.record.manualResolutionRequired) return { ok: true, skipped: true, blocking: true, outcome: asString(asRecord(read.record.manualResolutionRequired).outcome) };
    const manual = { outcome: asString(decision.outcome), reason: asString(decision.reason), decisionSource, atUtc: nowIso() };
    const updated = { ...read.record, manualResolutionRequired: manual };
    atomicWriteJson(path, updated);
    const auditPath = writeAudit(namespace, read.record, asString(decision.outcome), decisionSource, { decisionReason: asString(decision.reason), decisionSource, blocking: true }, 'active');
    return { ok: true, auditPath, blocking: true, outcome: asString(decision.outcome) };
  }) as UnknownRecord;
}

function reclaimOrphan(input: { namespace: string; path: string; record: unknown; reviewRuns?: unknown[]; decisionSource?: string; projectId?: string }): UnknownRecord {
  const record = asRecord(input.record) as ReviewStartClaimRecord;
  const decision = asRecord(evaluateReclaimDecision({
    claim: record,
    holderLiveness: holderLiveness(record),
    reviewRuns: asArray(input.reviewRuns),
    nowMs: Date.now(),
    nowMonotonicMs: monotonicNow(),
    config: resolveClaimLifecycleConfig({}, process.env),
    projectNamespace: asString(input.projectId) || record.projectNamespace,
  }));
  if (decision.action === 'skip' || decision.action === 'block') return { reclaimed: false, decision };
  if (decision.action === 'mark_manual') {
    const result = markForeignHolder(input.namespace, input.path, record, decision, asString(input.decisionSource) || 'reclaim');
    return { reclaimed: false, manual: true, blocking: true, result, decision };
  }
  if (decision.action === 'reconcile') {
    const claimResult: ClaimResult = { acquired: true, namespace: input.namespace, path: input.path, claim: record, key: record.key };
    const extra: UnknownRecord = { reason: asString(decision.reason) };
    if (decision.runId) extra.boundRunId = decision.runId;
    if (decision.binding) extra.binding = decision.binding;
    const result = completeReviewStartClaim(claimResult, asString(decision.outcome), asArray(input.reviewRuns), extra);
    return { action: 'reconcile', outcome: decision.outcome, reason: decision.reason, result };
  }
  if (decision.action === 'terminalize') {
    const result = terminalizeDecision({ namespace: input.namespace, path: input.path, expected: record, decision, decisionSource: asString(input.decisionSource) || 'reclaim', reviewRuns: asArray(input.reviewRuns) });
    return { reclaimed: result.ok === true, result, decision };
  }
  return { reclaimed: false, decision };
}

function releaseForTerminalizedRun(payload: UnknownRecord): UnknownRecord {
  const runId = asString(payload.runId ?? payload.RunId);
  if (!runId) return { ok: false, reason: 'missing_run_id' };
  const projectId = asString(payload.projectId ?? payload.ProjectId) || DEFAULT_PROJECT_ID;
  const namespace = resolveReviewStartClaimNamespace({ projectId, namespace: asString(payload.namespace ?? payload.Namespace) });
  initializeNamespace(namespace);
  const prNumber = positiveInteger(payload.prNumber ?? payload.PrNumber, 0);
  const headSha = normalizeHeadSha(asString(payload.headSha ?? payload.HeadSha));
  const path = claimPath(namespace, prNumber, headSha);
  const lock = claimLockDir(namespace, prNumber, headSha);
  return withMutex(lock, () => {
    const read = readClaimRecord(path);
    if (!read.ok || !read.record) return { ok: false, reason: 'no_active_claim', detail: read.reason };
    if (read.record.state !== 'active') return { ok: false, reason: 'not_active' };
    const bound = asString(read.record.boundRunId);
    if (bound && bound !== runId) return { ok: false, reason: 'superseded_claim', boundRunId: bound, holder: read.record.holder };
    if (!bound && visibleRun(asArray(payload.reviewRuns ?? payload.ReviewRuns), prNumber, headSha, projectId)) {
      return terminalizeDecision({ namespace, path, expected: read.record, decision: { action: 'terminalize', outcome: 'orphan_covered_run_unbound', reason: 'recovery_unbound_covering_run', warn: true, coveredRunId: runId }, decisionSource: 'run_recovery', reviewRuns: asArray(payload.reviewRuns ?? payload.ReviewRuns), mutexAlreadyHeld: true });
    }
    if (!bound) return { ok: false, reason: 'superseded_claim', boundRunId: '', holder: read.record.holder };
    const terminalPath = moveToTerminal(namespace, path, read.record, 'released_after_run_terminalized', { runId });
    return { ok: true, terminalPath, key: read.record.key };
  }) as UnknownRecord;
}

function resolveEscalation(payload: UnknownRecord): UnknownRecord {
  const projectId = asString(payload.projectId ?? payload.ProjectId) || DEFAULT_PROJECT_ID;
  const namespace = resolveReviewStartClaimNamespace({ projectId, namespace: asString(payload.namespace ?? payload.Namespace) });
  initializeNamespace(namespace);
  const prNumber = positiveInteger(payload.prNumber ?? payload.PrNumber, 0);
  const headSha = normalizeHeadSha(asString(payload.headSha ?? payload.HeadSha));
  const path = claimPath(namespace, prNumber, headSha);
  const outcome = visibleRun(asArray(payload.reviewRuns ?? payload.ReviewRuns), prNumber, headSha, projectId) ? 'operator_resolved_covered' : 'operator_resolved_rearmed';
  const lock = claimLockDir(namespace, prNumber, headSha);
  return withMutex(lock, () => {
    const read = readClaimRecord(path);
    if (!read.ok || !read.record) {
      if (!existsSync(path)) return { ok: true, outcome, auditPath: '' };
      const target = join(terminalDir(namespace), `${path.split('/').pop()}.operator_resolved_ambiguous.${Date.now()}.json`);
      renameSync(path, target);
      syncDirectory(dirname(path));
      return { ok: true, outcome, auditPath: target };
    }
    const target = moveToTerminal(namespace, path, read.record, outcome, { resolvedBy: newHolder('operator-resolution') });
    const auditPath = writeAudit(namespace, read.record, outcome, 'operator-resolution', { terminalPath: target });
    return { ok: true, outcome, auditPath };
  }) as UnknownRecord;
}

function stopChild(pid: number): UnknownRecord {
  if (pid <= 0) return { stopped: false, reason: 'no_pid' };
  try { process.kill(pid, 'SIGKILL'); return { stopped: true }; } catch { return { stopped: false, reason: 'not_running' }; }
}

export function dispatchReviewStartClaimOperation(operation: string, payload: UnknownRecord): unknown {
  const claim = asRecord(payload.claimResult ?? payload.ClaimResult) as ClaimResult;
  switch (operation) {
    case 'Acquire-ReviewStartClaim':
    case 'acquire': return acquireReviewStartClaim({
      prNumber: positiveInteger(payload.prNumber ?? payload.PrNumber, 0),
      headSha: asString(payload.headSha ?? payload.HeadSha),
      surface: asString(payload.surface ?? payload.Surface),
      reviewRuns: asArray(payload.reviewRuns ?? payload.ReviewRuns),
      namespace: asString(payload.namespace ?? payload.Namespace),
      projectId: asString(payload.projectId ?? payload.ProjectId),
      startReason: asString(payload.startReason ?? payload.StartReason),
      holderContext: asRecord(payload.holderContext ?? payload.HolderContext),
    });
    case 'Resolve-ReviewStartClaimNamespace': return resolveReviewStartClaimNamespace({ projectId: asString(payload.projectId ?? payload.ProjectId), namespace: asString(payload.namespace ?? payload.Namespace) });
    case 'Get-ReviewStartClaimProjectNamespace': return resolveReviewStartClaimNamespace({ projectId: asString(payload.projectId ?? payload.ProjectId) });
    case 'Get-ReviewStartClaimPath': return claimPath(asString(payload.namespace ?? payload.Namespace), positiveInteger(payload.prNumber ?? payload.PrNumber, 0), asString(payload.headSha ?? payload.HeadSha));
    case 'Get-ReviewStartClaimLockDir': return claimLockDir(asString(payload.namespace ?? payload.Namespace), positiveInteger(payload.prNumber ?? payload.PrNumber, 0), asString(payload.headSha ?? payload.HeadSha));
    case 'Get-ReviewStartClaimTerminalDir': return terminalDir(asString(payload.namespace ?? payload.Namespace));
    case 'Get-ReviewStartClaimAuditDir': return auditDir(asString(payload.namespace ?? payload.Namespace));
    case 'Initialize-ReviewStartClaimNamespace': initializeNamespace(asString(payload.namespace ?? payload.Namespace)); return null;
    case 'Read-ReviewStartClaimRecord': return readClaimRecord(asString(payload.path ?? payload.Path));
    case 'Write-ReviewStartClaimAtomic': atomicWriteJson(asString(payload.path ?? payload.Path), payload.record ?? payload.Record); return null;
    case 'New-ReviewStartClaimHolder': return newHolder(asString(payload.surface ?? payload.Surface), asRecord(payload.holderContext ?? payload.HolderContext));
    case 'New-ReviewStartClaimActiveRecord': return newActiveRecord({
      prNumber: positiveInteger(payload.prNumber ?? payload.PrNumber, 0),
      headSha: asString(payload.headSha ?? payload.HeadSha),
      surface: asString(payload.surface ?? payload.Surface),
      startReason: asString(payload.reason ?? payload.Reason),
      recoveredFrom: payload.recoveredFrom ?? payload.RecoveredFrom,
      priorFirstAttemptMonotonicMs: positiveInteger(payload.priorFirstAttemptMonotonicMs ?? payload.PriorFirstAttemptMonotonicMs, 0),
      projectId: asString(payload.projectId ?? payload.ProjectId),
      holderContext: asRecord(payload.holderContext ?? payload.HolderContext),
    });
    case 'Get-ReviewStartClaimVisibleRunId': return asString(visibleRun(asArray(payload.reviewRuns ?? payload.ReviewRuns), positiveInteger(payload.prNumber ?? payload.PrNumber, 0), asString(payload.headSha ?? payload.HeadSha), asString(payload.projectId ?? payload.ProjectId))?.runId);
    case 'Format-ReviewStartClaimHolder': return formatHolder(payload.holder ?? payload.Holder);
    case 'Get-ReviewStartClaimStaleMinutes': {
      const value = staleMinutes();
      const raw = asString(process.env.AO_REVIEW_CLAIM_STALE_MINUTES || process.env.AO_REVIEW_START_CLAIM_STALE_MINUTES);
      const warnings = raw && Number(raw) < 2 ? [`review-start-claim: WARN stale interval ${raw}m below safe floor 2m; clamped`] : [];
      return payload.includeDiagnostics ?? payload.IncludeDiagnostics ? { value, warnings } : value;
    }
    case 'Prune-ReviewStartClaimTerminalRecords': pruneTerminal(asString(payload.namespace ?? payload.Namespace)); return null;
    case 'Test-ReviewStartClaimRunVisible': return Boolean(visibleRun(asArray(payload.reviewRuns ?? payload.ReviewRuns), positiveInteger(payload.prNumber ?? payload.PrNumber, 0), asString(payload.headSha ?? payload.HeadSha), asString(payload.projectId ?? payload.ProjectId)));
    case 'Test-ReviewStartClaimRetryEligible': return !visibleRun(asArray(payload.reviewRuns ?? payload.ReviewRuns), positiveInteger(payload.prNumber ?? payload.PrNumber, 0), asString(payload.headSha ?? payload.HeadSha), asString(payload.projectId ?? payload.ProjectId));
    case 'Test-ReviewStartClaimOwnership': return testReviewStartClaimOwnership(claim);
    case 'Update-ReviewStartClaimRecordFields': return updateReviewStartClaimRecordFields(claim, asRecord(payload.fields ?? payload.Fields), asArray(payload.clearFields ?? payload.ClearFields).map(asString));
    case 'Bind-ReviewStartClaimToVisibleRun': return bindReviewStartClaimToVisibleRun(claim, asArray(payload.reviewRuns ?? payload.ReviewRuns));
    case 'Complete-ReviewStartClaim': return completeReviewStartClaim(claim, asString(payload.outcome ?? payload.Outcome), asArray(payload.reviewRuns ?? payload.ReviewRuns), asRecord(payload.extra ?? payload.Extra));
    case 'Release-ReviewStartClaimAfterRunFailure': return releaseAfterRunFailure(claim, asArray(payload.reviewRuns ?? payload.ReviewRuns), asString(payload.failure ?? payload.Failure));
    case 'Complete-ReviewStartClaimPreRunRecheckDenied': {
      const recheck = asRecord(payload.recheck ?? payload.Recheck);
      const outcome = recheck.supervisedGhInfraTransport ? 'released_for_retry' : 'aborted_by_recheck';
      if (!(payload.dryRun ?? payload.DryRun)) completeReviewStartClaim(claim, outcome, asArray(payload.reviewRuns ?? payload.ReviewRuns), { reason: asString(recheck.reason), failureClass: recheck.supervisedGhInfraTransport ? 'infra_transport' : undefined, transportFailure: recheck.transportFailure });
      return { outcome, reason: asString(recheck.reason) };
    }
    case 'Release-ReviewStartClaimAfterRecheckException': return (payload.dryRun ?? payload.DryRun) ? null : completeReviewStartClaim(claim, 'released_for_retry', [], { reason: 'pre_run_recheck_exception', error: asString(payload.errorRecord ?? payload.ErrorRecord) });
    case 'Confirm-ReviewStartClaimLaunchGate': return confirmReviewStartClaimLaunchGate(claim, asArray(payload.reviewRuns ?? payload.ReviewRuns), asString(payload.decisionSource ?? payload.DecisionSource) || 'hold_budget');
    case 'Set-ReviewStartClaimHoldStarted': return updateReviewStartClaimRecordFields(claim, { holdStartedAtUtc: nowIso() });
    case 'Set-ReviewStartClaimLaunchPending': {
      const config = resolveClaimLifecycleConfig({}, process.env);
      const now = nowIso();
      const budget = positiveInteger(payload.budgetMs ?? payload.BudgetMs, config.launchPendingBudgetMs);
      return updateReviewStartClaimRecordFields(claim, { launchPending: { atUtc: now, budgetMs: budget }, launchPendingInvokedAtUtc: now });
    }
    case 'Get-ReviewStartClaimActiveRecords': return getActiveRecords(asString(payload.namespace ?? payload.Namespace));
    case 'Invoke-ReviewStartClaimReaperSweep': return reaperSweep({ projectId: asString(payload.projectId ?? payload.ProjectId), namespace: asString(payload.namespace ?? payload.Namespace), reviewRuns: asArray(payload.reviewRuns ?? payload.ReviewRuns), reviewerEvidence: asArray(payload.reviewerEvidence ?? payload.ReviewerEvidence) });
    case 'Complete-ReviewStartClaimAfterRunInvoke': return completeAfterRunInvoke(claim, asArray(payload.reviewRuns ?? payload.ReviewRuns));
    case 'Start-ReviewStartClaimInfraPause': return startInfraPause(claim, positiveInteger(payload.supervisedGhPid ?? payload.SupervisedGhPid, 0));
    case 'Complete-ReviewStartClaimInfraPause': return completeInfraPause(claim, { stderr: asString(payload.stderr ?? payload.Stderr), timedOut: Boolean(payload.timedOut ?? payload.TimedOut), classification: asRecord(payload.classification ?? payload.Classification) });
    case 'Get-ReviewStartClaimLifecycleConfig': return { ok: true, config: resolveClaimLifecycleConfig({}, process.env) };
    case 'Invoke-ReviewStartClaimLifecycleCli': return evaluateLifecycle(asString(payload.subcommand ?? payload.Subcommand), asRecord(payload.payload ?? payload.Payload));
    case 'Test-ReviewStartClaimHoldBudgetExceeded': {
      const required = requireClaim(claim);
      if (!required.ok) return { exceeded: false, reason: 'no_claim' };
      const read = readClaimRecord(required.path);
      if (!read.ok || !read.record) return { exceeded: false, reason: 'unreadable' };
      return evaluateLifecycle('hold-budget', { claim: read.record });
    }
    case 'Get-ReviewStartClaimLocalHostName': return hostname() || 'unknown-host';
    case 'Get-ReviewStartTargetStateRecheckDenial': return targetStateRecheckDenial(payload.snapshot ?? payload.Snapshot);
    case 'Get-ReviewStartSupervisedGhInfraTransportFailure': return transportFailure(payload.transportFailure ?? payload.TransportFailure);
    case 'Get-ReviewStartSupervisedGhInfraTransportRecheckDenial': return infraTransportRecheckDenial(payload.snapshot ?? payload.Snapshot);
    case 'Annotate-ReviewStartClaimWorktreeAllowConsumed': return annotateWorktreeConsumed(asString(payload.namespace ?? payload.Namespace), asString(payload.path ?? payload.Path), payload.record ?? payload.Record, asString(payload.canonicalPath ?? payload.CanonicalPath));
    case 'Mark-ReviewStartClaimForeignHolderBlocking': return markForeignHolder(asString(payload.namespace ?? payload.Namespace), asString(payload.path ?? payload.Path), payload.record ?? payload.Record, payload.decision ?? payload.Decision, asString(payload.decisionSource ?? payload.DecisionSource));
    case 'Invoke-ReviewStartClaimReclaimOrphan': return reclaimOrphan({ namespace: asString(payload.namespace ?? payload.Namespace), path: asString(payload.path ?? payload.Path), record: payload.record ?? payload.Record, reviewRuns: asArray(payload.reviewRuns ?? payload.ReviewRuns), decisionSource: asString(payload.decisionSource ?? payload.DecisionSource), projectId: asString(payload.projectId ?? payload.ProjectId) });
    case 'Release-ReviewStartClaimForTerminalizedRun': return releaseForTerminalizedRun(payload);
    case 'Resolve-ReviewStartClaimEscalation': return resolveEscalation(payload);
    case 'Stop-ReviewStartSupervisedGhChild': return stopChild(positiveInteger(payload.processId ?? payload.ProcessId, 0));
    case 'Invoke-ReviewStartClaimOwnershipLossCleanup': {
      const active = asRecord(asRecord(claim.claim).activeInfraPause);
      const pid = positiveInteger(active.supervisedGhPid, 0);
      return pid > 0 ? stopChild(pid) : { stopped: false, reason: 'no_pid' };
    }
    default: throw new Error(`unsupported_claim_operation:${operation}`);
  }
}
