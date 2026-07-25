#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import fs, {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  fsyncSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { hostname, platform } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type {
  JsonPrimitive,
  JsonValue,
  JsonObject,
  UnknownRecord,
  ClaimHolder,
  ReviewStartClaimRecord,
  ClaimResult,
} from './review-start-claim-cli.ts';
import type { ClaimResult, UnknownRecord } from './review-start-claim-cli.ts';

interface MutexSnapshot {
  dev: number;
  ino: number;
  mtimeMs: number;
  owner: UnknownRecord | null;
}

const originalRmSync = fs.rmSync.bind(fs);
const originalRenameSync = fs.renameSync.bind(fs);
const originalStatSync = fs.statSync.bind(fs);
const originalReadFileSync = fs.readFileSync.bind(fs);
const originalExistsSync = fs.existsSync.bind(fs);
const originalMkdirSync = fs.mkdirSync.bind(fs);
const originalWriteFileSync = fs.writeFileSync.bind(fs);
const originalOpenSync = fs.openSync.bind(fs);
const originalCloseSync = fs.closeSync.bind(fs);
const originalFsyncSync = fs.fsyncSync.bind(fs);
const originalReaddirSync = fs.readdirSync.bind(fs);
const DEFAULT_MUTEX_STALE_SECONDS = 120;
const SUPPORTED_CLAIM_SCHEMA_VERSION = 1;
const FULL_SHA = /^[0-9a-f]{40}$/;
const CLAIM_FILE = /^pr-(\d+)-([0-9a-f]{40})\.json(?:\.|$)/;

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
function positiveInteger(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, ms));
}
function syncDirectory(path: string): void {
  const fd = originalOpenSync(path, 'r');
  try { originalFsyncSync(fd); } finally { originalCloseSync(fd); }
}
function processStartTicks(pid: number): string {
  if (platform() !== 'linux' || pid <= 0) return '';
  try {
    const raw = originalReadFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = raw.lastIndexOf(')');
    return close < 0 ? '' : raw.slice(close + 2).split(/\s+/)[19] ?? '';
  } catch { return ''; }
}
function bootIdHash(): string {
  if (platform() !== 'linux') return '';
  try {
    const value = originalReadFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    return value ? createHash('sha256').update(value).digest('hex') : '';
  } catch { return ''; }
}
function ownerPath(lockDir: string): string {
  return join(lockDir, 'owner.json');
}
function readMutexOwner(lockDir: string): UnknownRecord | null {
  try { return asRecord(JSON.parse(originalReadFileSync(ownerPath(lockDir), 'utf8'))); }
  catch { return null; }
}
function processIdentityAlive(owner: UnknownRecord): boolean {
  const pid = Math.trunc(asNumber(owner.pid));
  if (pid <= 0) return false;
  const host = asString(owner.host);
  if (host && host !== (hostname() || 'unknown-host')) return true;
  try { process.kill(pid, 0); } catch { return false; }
  const ticks = asString(owner.startTimeTicks);
  if (ticks && processStartTicks(pid) !== ticks) return false;
  const boot = asString(owner.bootIdHash);
  return !boot || bootIdHash() === boot;
}
function mutexSnapshot(lockDir: string): MutexSnapshot | null {
  try {
    const stat = originalStatSync(lockDir);
    return { dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs, owner: readMutexOwner(lockDir) };
  } catch { return null; }
}
function sameSnapshot(left: MutexSnapshot, right: MutexSnapshot): boolean {
  const leftGuid = asString(left.owner?.processGuid);
  const rightGuid = asString(right.owner?.processGuid);
  if (leftGuid || rightGuid) return Boolean(leftGuid && leftGuid === rightGuid);
  return left.dev === right.dev && left.ino === right.ino;
}
function staleSeconds(): number {
  const parsed = Number(process.env.AO_REVIEW_CLAIM_MUTEX_STALE_SECONDS ?? DEFAULT_MUTEX_STALE_SECONDS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MUTEX_STALE_SECONDS;
}
function isClaimMutexDirectory(pathValue: fs.PathLike, options?: fs.RmDirOptions | fs.RmOptions): pathValue is string {
  if (typeof pathValue !== 'string' || !options || options.recursive !== true) return false;
  return basename(dirname(pathValue)) === '.locks' && /^pr-/.test(basename(pathValue));
}
function claimIdentityFromPath(pathValue: fs.PathOrFileDescriptor): { prNumber: number; headSha: string } | null {
  if (typeof pathValue !== 'string') return null;
  const match = CLAIM_FILE.exec(basename(pathValue));
  return match ? { prNumber: Number(match[1]), headSha: match[2] ?? '' } : null;
}
function claimRecordValidationReason(value: unknown, pathValue?: fs.PathOrFileDescriptor): string | null {
  const record = asRecord(value);
  const pathIdentity = pathValue == null ? null : claimIdentityFromPath(pathValue);
  const looksLikeClaim = Boolean(pathIdentity || (record.key != null && record.prNumber != null && record.headSha != null));
  if (!looksLikeClaim) return null;
  if (record.schemaVersion !== SUPPORTED_CLAIM_SCHEMA_VERSION) return 'unsupported_schema_version';
  if (!Number.isInteger(record.prNumber) || Number(record.prNumber) <= 0) return 'bad_pr_number';
  const headSha = asString(record.headSha);
  if (!FULL_SHA.test(headSha)) return 'bad_head_sha';
  const expectedKey = `pr-${record.prNumber}-${headSha}`;
  if (asString(record.key) !== expectedKey) return 'claim_identity_mismatch';
  if (!['active', 'terminal'].includes(asString(record.state))) return 'unsupported_claim_state';
  const holder = asRecord(record.holder);
  if (!asString(holder.processGuid)) return 'missing_holder_processGuid';
  if (pathIdentity && (pathIdentity.prNumber !== record.prNumber || pathIdentity.headSha !== headSha)) {
    return 'claim_target_identity_mismatch';
  }
  return null;
}
function safeReadFileSync(pathValue: fs.PathOrFileDescriptor, options?: unknown): unknown {
  const bytes = originalReadFileSync(pathValue, options as never);
  if (typeof pathValue !== 'string') return bytes;
  const text = typeof bytes === 'string' ? bytes : Buffer.isBuffer(bytes) ? bytes.toString('utf8') : '';
  if (!text.trim()) return bytes;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return bytes; }
  const reason = claimRecordValidationReason(parsed, pathValue);
  if (reason) throw new Error(`claim_record_invalid:${reason}`);
  return bytes;
}
function withClaimReadValidation<T>(operation: () => T): T {
  const previous = fs.readFileSync;
  fs.readFileSync = safeReadFileSync as typeof fs.readFileSync;
  syncBuiltinESMExports();
  try {
    return operation();
  } finally {
    fs.readFileSync = previous;
    syncBuiltinESMExports();
  }
}
function restoreQuarantine(lockDir: string, quarantine: string): void {
  if (!originalExistsSync(quarantine) || originalExistsSync(lockDir)) return;
  originalRenameSync(quarantine, lockDir);
  syncDirectory(dirname(lockDir));
}
function waitAtStaleTakeoverBarrier(): void {
  if (process.env.OPK_VITEST_HARNESS !== '1') return;
  const barrierDir = asString(process.env.AO_REVIEW_CLAIM_TEST_STALE_BARRIER_DIR);
  if (!barrierDir) return;
  originalMkdirSync(barrierDir, { recursive: true, mode: 0o700 });
  originalWriteFileSync(join(barrierDir, `${process.pid}.observed`), 'observed\n', 'utf8');
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const observed = originalReaddirSync(barrierDir).filter((name) => name.endsWith('.observed')).length;
    if (observed >= 2 && originalExistsSync(join(barrierDir, 'go'))) return;
    sleep(10);
  }
  throw new Error('claim_stale_takeover_test_barrier_timeout');
}

/**
 * Owner-bound removal for the canonical persisted mutex.
 * The legacy implementation calls rmSync after a separate stale check; this hook
 * re-reads the owner, atomically moves the exact observed directory, verifies the
 * moved identity, and only then deletes the quarantine. A replacement live lease
 * is therefore never removed by an earlier stale decision.
 */
function safeRmSync(pathValue: fs.PathLike, options?: fs.RmDirOptions | fs.RmOptions): void {
  if (!isClaimMutexDirectory(pathValue, options)) {
    originalRmSync(pathValue, options as fs.RmOptions);
    return;
  }

  const lockDir = pathValue;
  const observed = mutexSnapshot(lockDir);
  if (!observed) return;
  const owner = observed.owner;
  if (owner && processIdentityAlive(owner)) {
    if (positiveInteger(owner.pid) === process.pid) {
      originalRmSync(lockDir, options as fs.RmOptions);
      syncDirectory(dirname(lockDir));
    }
    return;
  }
  if (!owner && (Date.now() - observed.mtimeMs) / 1000 < staleSeconds()) return;

  waitAtStaleTakeoverBarrier();
  const quarantine = `${lockDir}.stale-${process.pid}-${randomUUID()}`;
  try {
    originalRenameSync(lockDir, quarantine);
    syncDirectory(dirname(lockDir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }

  const moved = mutexSnapshot(quarantine);
  if (!moved || !sameSnapshot(observed, moved) || (moved.owner && processIdentityAlive(moved.owner))) {
    restoreQuarantine(lockDir, quarantine);
    return;
  }
  originalRmSync(quarantine, { recursive: true, force: true });
  syncDirectory(dirname(lockDir));
}

fs.rmSync = safeRmSync as typeof fs.rmSync;
syncBuiltinESMExports();
const impl = await import('./review-start-claim-cli.ts');

export const REVIEW_START_CLAIM_STORE_VERSION = impl.REVIEW_START_CLAIM_STORE_VERSION;
export const REVIEW_START_CLAIM_SCHEMA_VERSION = impl.REVIEW_START_CLAIM_SCHEMA_VERSION;
export function assertSupportedClaimPlatform(namespace: string): void {
  return withClaimReadValidation(() => impl.assertSupportedClaimPlatform(namespace));
}
export const normalizeHeadSha = impl.normalizeHeadSha;
export const resolveReviewStartClaimNamespace = impl.resolveReviewStartClaimNamespace;
export const claimKey = impl.claimKey;
export const claimPath = impl.claimPath;
export const claimLockDir = impl.claimLockDir;
export const terminalDir = impl.terminalDir;
export const auditDir = impl.auditDir;
export function initializeNamespace(namespace: string): void {
  return withClaimReadValidation(() => impl.initializeNamespace(namespace));
}
export const atomicWriteJson = impl.atomicWriteJson;
export function readClaimRecord(path: string): ReturnType<typeof impl.readClaimRecord> {
  return withClaimReadValidation(() => impl.readClaimRecord(path));
}
export function acquireReviewStartClaim(input: Parameters<typeof impl.acquireReviewStartClaim>[0]): ReturnType<typeof impl.acquireReviewStartClaim> {
  return withClaimReadValidation(() => impl.acquireReviewStartClaim(input));
}
export function testReviewStartClaimOwnership(input: ClaimResult): boolean {
  return withClaimReadValidation(() => impl.testReviewStartClaimOwnership(input));
}
export function updateReviewStartClaimRecordFields(input: ClaimResult, fields: UnknownRecord, clearFields: string[] = []): UnknownRecord {
  return withClaimReadValidation(() => impl.updateReviewStartClaimRecordFields(input, fields, clearFields));
}
export function bindReviewStartClaimToVisibleRun(input: ClaimResult, reviewRuns: unknown[] = []): UnknownRecord {
  return withClaimReadValidation(() => impl.bindReviewStartClaimToVisibleRun(input, reviewRuns));
}
export function completeReviewStartClaim(input: ClaimResult, outcome: string, reviewRuns: unknown[] = [], extra: UnknownRecord = {}): UnknownRecord {
  return withClaimReadValidation(() => impl.completeReviewStartClaim(input, outcome, reviewRuns, extra));
}
export function releaseAfterRunFailure(input: ClaimResult, reviewRuns: unknown[] = [], failure = ''): UnknownRecord {
  return withClaimReadValidation(() => impl.releaseAfterRunFailure(input, reviewRuns, failure));
}
export function confirmReviewStartClaimLaunchGate(input: ClaimResult, reviewRuns: unknown[] = [], decisionSource = 'hold_budget'): UnknownRecord {
  return withClaimReadValidation(() => impl.confirmReviewStartClaimLaunchGate(input, reviewRuns, decisionSource));
}
export function getActiveRecords(namespace: string): ReturnType<typeof impl.getActiveRecords> {
  return withClaimReadValidation(() => impl.getActiveRecords(namespace));
}
export function reaperSweep(input: Parameters<typeof impl.reaperSweep>[0]): UnknownRecord {
  return withClaimReadValidation(() => impl.reaperSweep(input));
}
export function startInfraPause(input: ClaimResult, supervisedGhPid = 0): UnknownRecord {
  return withClaimReadValidation(() => impl.startInfraPause(input, supervisedGhPid));
}
export function completeInfraPause(input: ClaimResult, options: Parameters<typeof impl.completeInfraPause>[1] = {}): UnknownRecord {
  return withClaimReadValidation(() => impl.completeInfraPause(input, options));
}
export const evaluateLifecycle = impl.evaluateLifecycle;

function completeAfterRunInvokeOnce(input: ClaimResult, reviewRuns: unknown[] = []): UnknownRecord {
  return withClaimReadValidation(() => {
    if (!input?.acquired || !input.claim || !input.path || !input.namespace) return { ok: false, reason: 'no_claim' };
    impl.bindReviewStartClaimToVisibleRun(input, reviewRuns);
    let complete = asRecord(impl.completeReviewStartClaim(input, 'run_started', reviewRuns));
    if (complete.ok === true || asString(complete.reason) !== 'run_not_visible') return complete;

    const pendingAt = asString(input.claim.visibilityPendingAtUtc) || new Date().toISOString();
    const updated = asRecord(impl.updateReviewStartClaimRecordFields(input, {
      invokeCompletedAtUtc: new Date().toISOString(),
      visibilityPendingAtUtc: pendingAt,
    }, ['launchPending']));
    if (updated.ok !== true) return updated;

    const read = impl.readClaimRecord(input.path);
    if (!read.ok || !read.record) return { ok: false, reason: 'ambiguous_claim', detail: read.reason };
    input.claim = read.record;
    impl.bindReviewStartClaimToVisibleRun(input, reviewRuns);
    complete = asRecord(impl.completeReviewStartClaim(input, 'run_started', reviewRuns));
    if (complete.ok === true || asString(complete.reason) !== 'run_not_visible') return complete;

    const fence = asRecord(impl.evaluateLifecycle('visibility-fence', { claim: read.record, reviewRuns }));
    const envelope = asRecord(impl.evaluateLifecycle('readiness-envelope', { claim: read.record }));
    if (fence.shouldFence === true || envelope.exceeded === true) {
      const reason = fence.shouldFence === true ? asString(fence.reason) : 'readiness_envelope_exceeded';
      const terminal = asRecord(impl.completeReviewStartClaim(input, 'run_not_visible_fenced', [], {
        decisionReason: reason,
        decisionSource: 'post_run_visibility',
        visibility: fence,
        envelope,
      }));
      return terminal.ok === true
        ? { ...terminal, reason: 'run_not_visible_fenced', fenced: true, fence, envelope }
        : terminal;
    }

    const configResult = asRecord(impl.evaluateLifecycle('validate-config', {}));
    const config = asRecord(configResult.config);
    const visibilityBudgetMs = positiveInteger(config.visibilityBudgetMs, 15_000);
    const pendingMs = Date.parse(asString(read.record.visibilityPendingAtUtc));
    const visibilityAgeMs = Number.isFinite(pendingMs) ? Math.max(0, Date.now() - pendingMs) : visibilityBudgetMs;
    const envelopeRemaining = asNumber(envelope.remainingMs, visibilityBudgetMs);
    const remaining = Math.min(envelopeRemaining, Math.max(0, visibilityBudgetMs - visibilityAgeMs));
    return {
      ok: false,
      reason: 'visibility_pending',
      waitMs: Math.max(1, Math.min(250, remaining || 1)),
      claimResult: input,
    };
  });
}

export function completeAfterRunInvoke(input: ClaimResult, reviewRuns: unknown[] = []): UnknownRecord {
  while (true) {
    const result = completeAfterRunInvokeOnce(input, reviewRuns);
    if (asString(result.reason) !== 'visibility_pending') return result;
    sleep(positiveInteger(result.waitMs, 1));
  }
}

export function dispatchReviewStartClaimOperation(operation: string, payload: UnknownRecord): unknown {
  if (operation === 'Complete-ReviewStartClaimAfterRunInvoke') {
    const claim = asRecord(payload.claimResult ?? payload.ClaimResult) as ClaimResult;
    const runs = asArray(payload.reviewRuns ?? payload.ReviewRuns);
    return payload.pollOnce ?? payload.PollOnce
      ? completeAfterRunInvokeOnce(claim, runs)
      : completeAfterRunInvoke(claim, runs);
  }
  if (operation === 'Invoke-ReviewStartClaimReclaimOrphan') {
    const reason = claimRecordValidationReason(payload.record ?? payload.Record);
    if (reason) return { reclaimed: false, blocking: true, reason: 'ambiguous_claim', detail: reason };
  }
  return withClaimReadValidation(() => impl.dispatchReviewStartClaimOperation(operation, payload));
}

function readPayload(): UnknownRecord {
  const raw = readFileSync(0, 'utf8');
  if (!raw.trim()) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('claim_cli_payload_must_be_object');
  return parsed as UnknownRecord;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    if (platform() !== 'linux') throw new Error('unsupported_claim_platform');
    const operation = asString(process.argv[2]);
    if (!operation) throw new Error('claim_cli_operation_required');
    process.stdout.write(`${JSON.stringify(dispatchReviewStartClaimOperation(operation, readPayload()))}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
