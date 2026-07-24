#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync,
  rmSync, statSync, writeFileSync, fsyncSync,
} from 'node:fs';
import { hostname, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as impl from './review-start-claim-cli.ts';
import type { ClaimResult, ReviewStartClaimRecord, UnknownRecord } from './review-start-claim-cli.ts';

export * from './review-start-claim-cli.ts';

interface GuardSnapshot { owner: UnknownRecord | null; dev: number; ino: number; mtimeMs: number }
interface GuardLease { path: string; processGuid: string }
const GUARD_SUFFIX = '.takeover';

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : {};
}
function asArray(value: unknown): unknown[] { return Array.isArray(value) ? value : value == null ? [] : [value]; }
function asString(value: unknown): string { return String(value ?? '').trim(); }
function positiveInteger(value: unknown, fallback = 0): number {
  const parsed = Number(value); return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
function sleep(ms: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, ms)); }
function syncDirectory(path: string): void {
  const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
}
function processStartTicks(pid: number): string {
  if (platform() !== 'linux' || pid <= 0) return '';
  try {
    const value = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = value.lastIndexOf(')');
    return close < 0 ? '' : value.slice(close + 2).split(/\s+/)[19] ?? '';
  } catch { return ''; }
}
function bootIdHash(): string {
  if (platform() !== 'linux') return '';
  try {
    const value = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    return value ? createHash('sha256').update(value).digest('hex') : '';
  } catch { return ''; }
}
function ownerPath(path: string): string { return join(path, 'owner.json'); }
function readOwner(path: string): UnknownRecord | null {
  try { return asRecord(JSON.parse(readFileSync(ownerPath(path), 'utf8'))); } catch { return null; }
}
function processAlive(owner: UnknownRecord): boolean {
  const pid = positiveInteger(owner.pid);
  if (!pid) return false;
  const host = asString(owner.host);
  if (host && host !== (hostname() || 'unknown-host')) return true;
  try { process.kill(pid, 0); } catch { return false; }
  const ticks = asString(owner.startTimeTicks);
  if (ticks && processStartTicks(pid) !== ticks) return false;
  const boot = asString(owner.bootIdHash);
  return !boot || bootIdHash() === boot;
}
function snapshot(path: string): GuardSnapshot | null {
  try {
    const stat = statSync(path);
    return { owner: readOwner(path), dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs };
  } catch { return null; }
}
function sameSnapshot(left: GuardSnapshot, right: GuardSnapshot): boolean {
  const leftGuid = asString(left.owner?.processGuid);
  const rightGuid = asString(right.owner?.processGuid);
  return leftGuid || rightGuid ? Boolean(leftGuid && leftGuid === rightGuid) : left.dev === right.dev && left.ino === right.ino;
}
function guardStaleSeconds(): number {
  const value = Number(process.env.AO_REVIEW_CLAIM_MUTEX_STALE_SECONDS ?? 120);
  return Number.isFinite(value) && value > 0 ? value : 120;
}
function restore(path: string, quarantine: string): void {
  if (!existsSync(quarantine)) return;
  if (existsSync(path)) throw new Error('claim_takeover_restore_conflict');
  renameSync(quarantine, path); syncDirectory(dirname(path));
}
function reapObservedStale(path: string): boolean {
  const observed = snapshot(path);
  if (!observed) return true;
  const abandoned = observed.owner
    ? !processAlive(observed.owner)
    : (Date.now() - observed.mtimeMs) / 1000 >= guardStaleSeconds();
  if (!abandoned) return false;
  const quarantine = `${path}.stale-${process.pid}-${randomUUID()}`;
  try { renameSync(path, quarantine); syncDirectory(dirname(path)); }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
  const moved = snapshot(quarantine);
  if (!moved || !sameSnapshot(observed, moved) || (moved.owner && processAlive(moved.owner))) {
    restore(path, quarantine); return false;
  }
  rmSync(quarantine, { recursive: true, force: true }); syncDirectory(dirname(path));
  return true;
}
function writeOwner(path: string, processGuid: string): void {
  const fd = openSync(ownerPath(path), 'wx', 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify({
      pid: process.pid, host: hostname() || 'unknown-host', processGuid,
      acquiredAtUtc: new Date().toISOString(), startTimeTicks: processStartTicks(process.pid), bootIdHash: bootIdHash(),
    })}\n`, 'utf8');
    fsyncSync(fd);
  } finally { closeSync(fd); }
  syncDirectory(path);
}
function enterGuard(path: string): GuardLease | null {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const processGuid = randomUUID().replaceAll('-', '');
    try {
      mkdirSync(path, { recursive: false, mode: 0o700 });
      writeOwner(path, processGuid);
      return { path, processGuid };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' && asString(readOwner(path)?.processGuid) === processGuid) {
        rmSync(path, { recursive: true, force: true });
      }
      if (reapObservedStale(path)) continue;
      if (attempt < 239) sleep(25);
    }
  }
  return null;
}
function exitGuard(lease: GuardLease): void {
  const quarantine = `${lease.path}.release-${process.pid}-${randomUUID()}`;
  renameSync(lease.path, quarantine); syncDirectory(dirname(lease.path));
  if (asString(readOwner(quarantine)?.processGuid) !== lease.processGuid) {
    restore(lease.path, quarantine); throw new Error('claim_takeover_release_owner_mismatch');
  }
  rmSync(quarantine, { recursive: true, force: true }); syncDirectory(dirname(lease.path));
}
function withGuard<T>(path: string, operation: () => T): T {
  const lease = enterGuard(path);
  if (!lease) throw new Error('claim_takeover_busy');
  let failed = false;
  try { return operation(); }
  catch (error) { failed = true; throw error; }
  finally { try { exitGuard(lease); } catch (error) { if (!failed) throw error; } }
}
function claimNamespace(claim: ClaimResult): string {
  return asString(claim.namespace) || impl.resolveReviewStartClaimNamespace({ projectId: asString(claim.claim?.projectNamespace) });
}
function guardPath(namespace: string, prNumber: number, headSha: string): string {
  impl.initializeNamespace(namespace);
  return `${impl.claimLockDir(namespace, prNumber, headSha)}${GUARD_SUFFIX}`;
}
function withClaimGuard<T>(claim: ClaimResult, operation: () => T): T {
  return claim.claim ? withGuard(guardPath(claimNamespace(claim), claim.claim.prNumber, claim.claim.headSha), operation) : operation();
}
function withCoordinatesGuard<T>(namespace: string, prNumber: number, headSha: string, operation: () => T): T {
  return withGuard(guardPath(namespace, prNumber, headSha), operation);
}

export function acquireReviewStartClaim(input: Parameters<typeof impl.acquireReviewStartClaim>[0]): ReturnType<typeof impl.acquireReviewStartClaim> {
  const namespace = impl.resolveReviewStartClaimNamespace({ projectId: input.projectId, namespace: input.namespace });
  return withCoordinatesGuard(namespace, input.prNumber, input.headSha, () => impl.acquireReviewStartClaim(input));
}
export function updateReviewStartClaimRecordFields(...args: Parameters<typeof impl.updateReviewStartClaimRecordFields>): ReturnType<typeof impl.updateReviewStartClaimRecordFields> {
  return withClaimGuard(args[0], () => impl.updateReviewStartClaimRecordFields(...args));
}
export function bindReviewStartClaimToVisibleRun(...args: Parameters<typeof impl.bindReviewStartClaimToVisibleRun>): ReturnType<typeof impl.bindReviewStartClaimToVisibleRun> {
  return withClaimGuard(args[0], () => impl.bindReviewStartClaimToVisibleRun(...args));
}
export function completeReviewStartClaim(...args: Parameters<typeof impl.completeReviewStartClaim>): ReturnType<typeof impl.completeReviewStartClaim> {
  return withClaimGuard(args[0], () => impl.completeReviewStartClaim(...args));
}
export function releaseAfterRunFailure(...args: Parameters<typeof impl.releaseAfterRunFailure>): ReturnType<typeof impl.releaseAfterRunFailure> {
  return withClaimGuard(args[0], () => impl.releaseAfterRunFailure(...args));
}
export function confirmReviewStartClaimLaunchGate(...args: Parameters<typeof impl.confirmReviewStartClaimLaunchGate>): ReturnType<typeof impl.confirmReviewStartClaimLaunchGate> {
  return withClaimGuard(args[0], () => impl.confirmReviewStartClaimLaunchGate(...args));
}
export function startInfraPause(...args: Parameters<typeof impl.startInfraPause>): ReturnType<typeof impl.startInfraPause> {
  return withClaimGuard(args[0], () => impl.startInfraPause(...args));
}
export function completeInfraPause(...args: Parameters<typeof impl.completeInfraPause>): ReturnType<typeof impl.completeInfraPause> {
  return withClaimGuard(args[0], () => impl.completeInfraPause(...args));
}

function completeAfterRunInvokeOnce(claim: ClaimResult, reviewRuns: unknown[]): UnknownRecord {
  return withClaimGuard(claim, () => {
    if (!claim.acquired || !claim.claim || !claim.path) return { ok: false, reason: 'no_claim' };
    impl.bindReviewStartClaimToVisibleRun(claim, reviewRuns);
    let completion = asRecord(impl.completeReviewStartClaim(claim, 'run_started', reviewRuns));
    if (completion.ok === true || asString(completion.reason) !== 'run_not_visible') return completion;

    const read = impl.readClaimRecord(claim.path);
    if (!read.ok || !read.record) return { ok: false, reason: 'ambiguous_claim', detail: read.reason };
    claim.claim = read.record;
    const now = new Date().toISOString();
    const fields: UnknownRecord = {};
    if (!asString(read.record.invokeCompletedAtUtc)) fields.invokeCompletedAtUtc = now;
    if (!asString(read.record.visibilityPendingAtUtc)) fields.visibilityPendingAtUtc = now;
    const updated = asRecord(impl.updateReviewStartClaimRecordFields(claim, fields, ['launchPending']));
    if (updated.ok !== true) return updated;

    const current = impl.readClaimRecord(claim.path);
    if (!current.ok || !current.record) return { ok: false, reason: 'ambiguous_claim', detail: current.reason };
    claim.claim = current.record;
    impl.bindReviewStartClaimToVisibleRun(claim, reviewRuns);
    completion = asRecord(impl.completeReviewStartClaim(claim, 'run_started', reviewRuns));
    if (completion.ok === true || asString(completion.reason) !== 'run_not_visible') return completion;

    const fence = asRecord(impl.evaluateLifecycle('visibility-fence', { claim: current.record, reviewRuns }));
    const envelope = asRecord(impl.evaluateLifecycle('readiness-envelope', { claim: current.record }));
    if (fence.shouldFence === true || envelope.exceeded === true) {
      const reason = fence.shouldFence === true ? asString(fence.reason) : 'readiness_envelope_exceeded';
      return asRecord(impl.completeReviewStartClaim(claim, 'run_not_visible_fenced', [], {
        decisionReason: reason, decisionSource: 'post_run_visibility', visibility: fence, envelope,
      }));
    }
    const config = asRecord(asRecord(impl.evaluateLifecycle('validate-config', {})).config);
    const budget = positiveInteger(config.visibilityBudgetMs, 15_000);
    const pending = Date.parse(asString(current.record.visibilityPendingAtUtc));
    const age = Number.isFinite(pending) ? Math.max(0, Date.now() - pending) : budget;
    const envelopeRemaining = Number(envelope.remainingMs);
    const remaining = Math.min(Number.isFinite(envelopeRemaining) ? Math.max(0, envelopeRemaining) : budget, Math.max(0, budget - age));
    return { ok: false, reason: 'visibility_pending', waitMs: Math.max(1, Math.min(250, remaining || 1)), claimResult: claim };
  });
}
export function completeAfterRunInvoke(claim: ClaimResult, reviewRuns: unknown[] = []): UnknownRecord {
  while (true) {
    const result = completeAfterRunInvokeOnce(claim, reviewRuns);
    if (asString(result.reason) !== 'visibility_pending') return result;
    sleep(positiveInteger(result.waitMs, 1));
  }
}
export function reaperSweep(input: Parameters<typeof impl.reaperSweep>[0]): ReturnType<typeof impl.reaperSweep> {
  const namespace = impl.resolveReviewStartClaimNamespace(input);
  const records = impl.getActiveRecords(namespace).sort((a, b) => a.key.localeCompare(b.key));
  const run = (index: number): ReturnType<typeof impl.reaperSweep> => index >= records.length
    ? impl.reaperSweep(input)
    : withGuard(guardPath(namespace, records[index]!.prNumber, records[index]!.headSha), () => run(index + 1));
  return run(0);
}

function coordinates(payload: UnknownRecord): { namespace: string; prNumber: number; headSha: string } | null {
  const claim = asRecord(payload.claimResult ?? payload.ClaimResult) as ClaimResult;
  if (claim.claim) return { namespace: claimNamespace(claim), prNumber: claim.claim.prNumber, headSha: claim.claim.headSha };
  const record = asRecord(payload.record ?? payload.Record) as ReviewStartClaimRecord;
  const prNumber = positiveInteger(payload.prNumber ?? payload.PrNumber ?? record.prNumber);
  const headSha = asString(payload.headSha ?? payload.HeadSha ?? record.headSha);
  if (!prNumber || !headSha) return null;
  return {
    namespace: impl.resolveReviewStartClaimNamespace({
      projectId: asString(payload.projectId ?? payload.ProjectId ?? record.projectNamespace),
      namespace: asString(payload.namespace ?? payload.Namespace) || undefined,
    }),
    prNumber,
    headSha,
  };
}
const MUTATIONS = new Set([
  'Write-ReviewStartClaimAtomic', 'Update-ReviewStartClaimRecordFields', 'Bind-ReviewStartClaimToVisibleRun',
  'Complete-ReviewStartClaim', 'Release-ReviewStartClaimAfterRunFailure', 'Complete-ReviewStartClaimPreRunRecheckDenied',
  'Release-ReviewStartClaimAfterRecheckException', 'Confirm-ReviewStartClaimLaunchGate', 'Set-ReviewStartClaimHoldStarted',
  'Set-ReviewStartClaimLaunchPending', 'Start-ReviewStartClaimInfraPause', 'Complete-ReviewStartClaimInfraPause',
  'Annotate-ReviewStartClaimWorktreeAllowConsumed', 'Mark-ReviewStartClaimForeignHolderBlocking',
  'Invoke-ReviewStartClaimReclaimOrphan', 'Release-ReviewStartClaimForTerminalizedRun', 'Resolve-ReviewStartClaimEscalation',
]);
export function dispatchReviewStartClaimOperation(operation: string, payload: UnknownRecord): unknown {
  if (operation === 'Acquire-ReviewStartClaim' || operation === 'acquire') {
    return acquireReviewStartClaim({
      prNumber: positiveInteger(payload.prNumber ?? payload.PrNumber), headSha: asString(payload.headSha ?? payload.HeadSha),
      surface: asString(payload.surface ?? payload.Surface), reviewRuns: asArray(payload.reviewRuns ?? payload.ReviewRuns),
      namespace: asString(payload.namespace ?? payload.Namespace), projectId: asString(payload.projectId ?? payload.ProjectId),
      startReason: asString(payload.startReason ?? payload.StartReason), holderContext: asRecord(payload.holderContext ?? payload.HolderContext),
    });
  }
  if (operation === 'Complete-ReviewStartClaimAfterRunInvoke') {
    const claim = asRecord(payload.claimResult ?? payload.ClaimResult) as ClaimResult;
    const runs = asArray(payload.reviewRuns ?? payload.ReviewRuns);
    return payload.pollOnce ?? payload.PollOnce ? completeAfterRunInvokeOnce(claim, runs) : completeAfterRunInvoke(claim, runs);
  }
  if (operation === 'Invoke-ReviewStartClaimReaperSweep') return reaperSweep({
    projectId: asString(payload.projectId ?? payload.ProjectId), namespace: asString(payload.namespace ?? payload.Namespace),
    reviewRuns: asArray(payload.reviewRuns ?? payload.ReviewRuns), reviewerEvidence: asArray(payload.reviewerEvidence ?? payload.ReviewerEvidence),
  });
  if (operation === 'Prune-ReviewStartClaimTerminalRecords') {
    const namespace = impl.resolveReviewStartClaimNamespace({ namespace: asString(payload.namespace ?? payload.Namespace) });
    impl.initializeNamespace(namespace);
    return withGuard(join(namespace, '.locks', `.terminal-prune${GUARD_SUFFIX}`), () => impl.dispatchReviewStartClaimOperation(operation, payload));
  }
  if (MUTATIONS.has(operation)) {
    const target = coordinates(payload);
    return target
      ? withCoordinatesGuard(target.namespace, target.prNumber, target.headSha, () => impl.dispatchReviewStartClaimOperation(operation, payload))
      : impl.dispatchReviewStartClaimOperation(operation, payload);
  }
  return impl.dispatchReviewStartClaimOperation(operation, payload);
}
function readPayload(): UnknownRecord {
  const raw = readFileSync(0, 'utf8');
  if (!raw.trim()) return {};
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('claim_cli_payload_must_be_object');
  return value as UnknownRecord;
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
