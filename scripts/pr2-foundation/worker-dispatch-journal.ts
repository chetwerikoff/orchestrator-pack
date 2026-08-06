import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { reclaimStaleJournalLock } from './journal-lock.ts';
import { buildS2EpisodeKey, hashNudgeMessageContent } from './worker-nudge-gate.ts';
import {
  AO_PASTE_CHAR_THRESHOLD,
  admitDispatchJournalRecord as canonicalAdmitDispatchJournalRecord,
  classifyDeliveryPath,
  DELIVERY_PATH_PENDING_DRAFT,
  DELIVERY_PATH_SELF_SUBMITTED,
  deriveMessageShape,
  DISPATCH_OUTCOME_DISPATCHED,
  DISPATCH_OUTCOME_IN_FLIGHT,
  DISPATCH_OUTCOME_SEND_FAILED,
  DISPATCH_OUTCOME_UNKNOWN,
  DRAFT_STATE_AUTO_SUBMITTED,
  DRAFT_STATE_DRAFT_PRESENT,
  finalizeDispatchJournalRecord as canonicalFinalizeDispatchJournalRecord,
} from './terminalized/worker-message-dispatch-observe.ts';

export {
  AO_PASTE_CHAR_THRESHOLD,
  classifyDeliveryPath,
  DELIVERY_PATH_PENDING_DRAFT,
  DELIVERY_PATH_SELF_SUBMITTED,
  deriveMessageShape,
  DISPATCH_OUTCOME_DISPATCHED,
  DISPATCH_OUTCOME_IN_FLIGHT,
  DISPATCH_OUTCOME_SEND_FAILED,
  DISPATCH_OUTCOME_UNKNOWN,
  DRAFT_STATE_AUTO_SUBMITTED,
  DRAFT_STATE_DRAFT_PRESENT,
};

export const CANONICAL_DISPATCH_SOURCE_BLOB_SHA = 'ffae6481d77e47b6bfded236a7f19b1d1fa5dfc5' as const;

const FENCE_LIFECYCLE_PENDING = 'pending' as const;
const FENCE_LIFECYCLE_COMPLETED = 'completed' as const;
const FENCE_LIFECYCLE_FAILED_UNCERTAIN = 'failed-uncertain' as const;
const DISPATCH_JOURNAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MECHANICAL_TRANSPORT_ENVELOPE_BYTES = 2 * 1024 * 1024;
const MECHANICAL_STORAGE_CEILING_BYTES = Math.floor(MECHANICAL_TRANSPORT_ENVELOPE_BYTES * 0.65);
export const MECHANICAL_PERSISTED_STORE_CEILING_BYTES = Math.floor(MECHANICAL_STORAGE_CEILING_BYTES / 2);
const RESERVED_META_KEYS = new Set(['_recovery', '_bounds', '_compaction']);

export interface NotificationMessageShape {
  charLength: number;
  lineCount: number;
  multiline: boolean;
  deliveryPath: typeof DELIVERY_PATH_PENDING_DRAFT | typeof DELIVERY_PATH_SELF_SUBMITTED;
}

export interface DispatchJournalRecord extends Record<string, unknown> {
  deliveryId: string;
  sessionId: string;
  deliveredAtMs: number;
  source: string;
  sourceKey: string;
  deliveryPath: string;
  messageShape: { charLength: number; lineCount: number };
  dispatchOutcome: string;
  draftState: string;
  deterministicKey?: string;
  findingsHash?: string;
}

export type DispatchJournal = Record<string, unknown>;

type CanonicalAdmitResult =
  | { ok: true; journal: DispatchJournal; record: DispatchJournalRecord }
  | { ok: false; reason: string; journal: DispatchJournal; backpressure?: boolean };

type CanonicalFinalizeResult =
  | {
    ok: true;
    journal: DispatchJournal;
    record: DispatchJournalRecord;
    evicted: boolean;
  }
  | { ok: false; reason: string; journal: DispatchJournal };

function trimString(value: unknown): string {
  return String(value ?? '').trim();
}

function estimateSerializedUtf8Bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');
}

function interpretDispatchFenceLifecycle(record: Record<string, unknown>): string {
  const explicit = trimString(record.fenceLifecycle);
  if (explicit === FENCE_LIFECYCLE_PENDING) return FENCE_LIFECYCLE_PENDING;
  if (explicit === FENCE_LIFECYCLE_FAILED_UNCERTAIN) return FENCE_LIFECYCLE_FAILED_UNCERTAIN;
  if (explicit === FENCE_LIFECYCLE_COMPLETED) return FENCE_LIFECYCLE_COMPLETED;
  const outcome = trimString(record.dispatchOutcome);
  if (outcome === DISPATCH_OUTCOME_IN_FLIGHT
    || outcome === DISPATCH_OUTCOME_UNKNOWN
    || (outcome === DISPATCH_OUTCOME_DISPATCHED && trimString(record.draftState) === 'unknown')) {
    return FENCE_LIFECYCLE_PENDING;
  }
  return FENCE_LIFECYCLE_COMPLETED;
}

function isDispatchJournalEntryEvictable(record: Record<string, unknown>, nowMs: number): boolean {
  const deliveryId = trimString(record.deliveryId ?? record.id);
  if (!deliveryId || deliveryId.startsWith('_')) return false;
  if (interpretDispatchFenceLifecycle(record) === FENCE_LIFECYCLE_PENDING) return false;
  const deliveredAt = Number(record.deliveredAtMs ?? 0);
  if (!deliveredAt || nowMs - deliveredAt < DISPATCH_JOURNAL_RETENTION_MS) return false;
  return trimString(record.dispatchOutcome) !== DISPATCH_OUTCOME_IN_FLIGHT;
}

function compactDispatchJournal(journal: DispatchJournal, nowMs: number): {
  journal: DispatchJournal;
  evicted: string[];
} {
  const next = { ...journal };
  const evicted: string[] = [];
  for (const [key, value] of Object.entries(next)) {
    if (RESERVED_META_KEYS.has(key)) continue;
    const record = value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
    if (isDispatchJournalEntryEvictable(record, nowMs)) {
      delete next[key];
      evicted.push(key);
    }
  }
  return { journal: next, evicted };
}

function withPendingDispatchFence(record: DispatchJournalRecord): DispatchJournalRecord {
  return { ...record, fenceLifecycle: FENCE_LIFECYCLE_PENDING };
}

function advanceDispatchFenceLifecycle(
  record: Record<string, unknown>,
  dispatchOutcome: string,
): DispatchJournalRecord {
  const outcome = trimString(dispatchOutcome);
  const uncertain = outcome === DISPATCH_OUTCOME_SEND_FAILED || outcome === DISPATCH_OUTCOME_UNKNOWN;
  return {
    ...record,
    dispatchOutcome: outcome,
    fenceLifecycle: uncertain ? FENCE_LIFECYCLE_FAILED_UNCERTAIN : FENCE_LIFECYCLE_COMPLETED,
  } as unknown as DispatchJournalRecord;
}

function worstCaseDispatchJournalRecord(record: DispatchJournalRecord): DispatchJournalRecord {
  return {
    ...record,
    fenceLifecycle: FENCE_LIFECYCLE_COMPLETED,
    dispatchOutcome: DISPATCH_OUTCOME_DISPATCHED,
    draftState: DRAFT_STATE_DRAFT_PRESENT,
    messageShape: { charLength: 4096, lineCount: 64 },
    auditNote: 'x'.repeat(512),
  };
}

function evaluateDispatchJournalAdmission(
  journal: DispatchJournal,
  candidateRecord: DispatchJournalRecord,
  ceilingBytes = MECHANICAL_PERSISTED_STORE_CEILING_BYTES,
): { ok: true } | { ok: false; reason: string; backpressure?: boolean } {
  const deliveryId = trimString(candidateRecord.deliveryId);
  if (!deliveryId) return { ok: false, reason: 'invalid_delivery_id' };
  const pendingBytes = estimateSerializedUtf8Bytes({ ...journal, [deliveryId]: candidateRecord });
  const terminalBytes = estimateSerializedUtf8Bytes({
    ...journal,
    [deliveryId]: worstCaseDispatchJournalRecord(candidateRecord),
  });
  if (pendingBytes > ceilingBytes || terminalBytes > ceilingBytes) {
    return { ok: false, reason: 'over_capacity', backpressure: true };
  }
  return { ok: true };
}

/** Typed facade over the terminalized canonical admission implementation. */
export function admitDispatchJournalRecord(
  journal: DispatchJournal,
  record: DispatchJournalRecord,
  nowMs = Date.now(),
): CanonicalAdmitResult {
  return canonicalAdmitDispatchJournalRecord(journal, record, nowMs) as CanonicalAdmitResult;
}

/** Typed facade over the terminalized canonical finalization implementation. */
export function finalizeDispatchJournalRecord(
  journal: DispatchJournal,
  deliveryId: string,
  dispatchOutcome: string,
  nowMs = Date.now(),
  draftState = '',
): CanonicalFinalizeResult {
  return canonicalFinalizeDispatchJournalRecord(
    journal,
    deliveryId,
    dispatchOutcome,
    nowMs,
    draftState,
  ) as CanonicalFinalizeResult;
}

export interface S2FleetNudgeJournalEpisode {
  readonly projectId: string;
  readonly issueNumber: number;
  readonly schedulerGeneration: string;
  readonly tickSequence: number;
  readonly transitionIdentity: string;
  readonly unitRef: string;
  readonly eligibleClass: 'idle' | 'livelock';
  readonly intentClass: 'task-continuation';
  readonly policyTag: 's2-one-shot-v1';
}

export interface S2FleetNudgeJournalHandle {
  readonly journalPath: string;
  readonly deliveryId: string;
}

export type S2FleetNudgeJournalOutcome = 'dispatched' | 'send_failed' | 'dispatch_unknown';

interface S2CanonicalDispatchRecord extends DispatchJournalRecord {
  policyTag: 's2-one-shot-v1';
  projectId: string;
  issueNumber: number;
  schedulerGeneration: string;
  tickSequence: number;
  transitionIdentity: string;
  unitRef: string;
  eligibleClass: 'idle' | 'livelock';
  intentClass: 'task-continuation';
  messageContentHash: string;
}

interface CanonicalJournalLockOwner {
  schemaVersion: 1;
  pid: number;
  nonce: string;
  acquiredAtMs: number;
}

function assertJournalDeadline(deadlineMs: number): void {
  if (!Number.isFinite(deadlineMs) || Date.now() >= deadlineMs) {
    throw new Error('journal_deadline_expired');
  }
}

function parseLockOwner(file: string): CanonicalJournalLockOwner | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    if (parsed.schemaVersion !== 1
      || !Number.isInteger(parsed.pid)
      || typeof parsed.nonce !== 'string'
      || !Number.isFinite(parsed.acquiredAtMs)) return null;
    return parsed as unknown as CanonicalJournalLockOwner;
  } catch {
    return null;
  }
}

async function delayUntil(deadlineMs: number, milliseconds: number): Promise<void> {
  const remaining = deadlineMs - Date.now();
  if (remaining <= 0) throw new Error('journal_deadline_expired');
  await new Promise<void>((resolvePromise) =>
    setTimeout(resolvePromise, Math.min(milliseconds, remaining)));
}

async function withCanonicalJournalDeadlineLock<T>(
  journalPath: string,
  deadlineMs: number,
  action: () => T | Promise<T>,
): Promise<T> {
  const lockPath = `${journalPath}.lock`;
  mkdirSync(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; Date.now() < deadlineMs; attempt += 1) {
    const owner: CanonicalJournalLockOwner = {
      schemaVersion: 1,
      pid: process.pid,
      nonce: randomUUID().replace(/-/g, ''),
      acquiredAtMs: Date.now(),
    };
    let descriptor: number | null = null;
    try {
      assertJournalDeadline(deadlineMs);
      descriptor = openSync(lockPath, 'wx', 0o600);
      writeFileSync(descriptor, `${JSON.stringify(owner)}\n`, 'utf8');
      assertJournalDeadline(deadlineMs);
      const value = await action();
      assertJournalDeadline(deadlineMs);
      return value;
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code ?? '')
        : '';
      if (code !== 'EEXIST') throw error;
      if (reclaimStaleJournalLock(lockPath)) continue;
      await delayUntil(deadlineMs, Math.min(10 * (attempt + 1), 50));
    } finally {
      if (descriptor !== null) {
        closeSync(descriptor);
        const observed = parseLockOwner(lockPath);
        if (observed?.nonce === owner.nonce) {
          try {
            unlinkSync(lockPath);
          } catch {
            // Already removed after ownership verification.
          }
        }
      }
    }
  }
  throw new Error('journal_deadline_expired');
}

function readCanonicalJournal(file: string, deadlineMs: number): DispatchJournal {
  assertJournalDeadline(deadlineMs);
  if (!existsSync(file)) return {};
  const size = statSync(file).size;
  if (size > MECHANICAL_PERSISTED_STORE_CEILING_BYTES) throw new Error('journal_untrusted');
  assertJournalDeadline(deadlineMs);
  const bytes = readFileSync(file, 'utf8');
  assertJournalDeadline(deadlineMs);
  try {
    const parsed = JSON.parse(bytes) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('journal_untrusted');
    return parsed as DispatchJournal;
  } catch (error) {
    if (error instanceof Error && error.message === 'journal_untrusted') throw error;
    throw new Error('journal_untrusted');
  }
}

function writeCanonicalJournal(file: string, journal: DispatchJournal, deadlineMs: number): void {
  assertJournalDeadline(deadlineMs);
  const bytes = `${JSON.stringify(journal, null, 2)}\n`;
  if (Buffer.byteLength(bytes, 'utf8') > MECHANICAL_PERSISTED_STORE_CEILING_BYTES) {
    throw new Error('journal_untrusted');
  }
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${randomUUID().replace(/-/g, '')}.tmp`);
  try {
    assertJournalDeadline(deadlineMs);
    writeFileSync(temporary, bytes, { encoding: 'utf8', mode: 0o600 });
    assertJournalDeadline(deadlineMs);
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function asS2CanonicalRecord(value: unknown): S2CanonicalDispatchRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.policyTag !== 's2-one-shot-v1'
    || typeof record.deliveryId !== 'string'
    || typeof record.sessionId !== 'string'
    || !Number.isFinite(record.deliveredAtMs)
    || record.source !== 's2-fleet-nudge'
    || typeof record.sourceKey !== 'string'
    || typeof record.deliveryPath !== 'string'
    || !record.messageShape
    || typeof record.dispatchOutcome !== 'string'
    || typeof record.draftState !== 'string'
    || typeof record.projectId !== 'string'
    || !Number.isInteger(record.issueNumber)
    || typeof record.schedulerGeneration !== 'string'
    || !Number.isInteger(record.tickSequence)
    || typeof record.transitionIdentity !== 'string'
    || typeof record.unitRef !== 'string'
    || !['idle', 'livelock'].includes(String(record.eligibleClass))
    || record.intentClass !== 'task-continuation'
    || typeof record.messageContentHash !== 'string') return null;
  return record as unknown as S2CanonicalDispatchRecord;
}

function exactS2Record(
  record: S2CanonicalDispatchRecord,
  episode: S2FleetNudgeJournalEpisode,
  deliveryId: string,
  messageContentHash: string,
): boolean {
  return record.deliveryId === deliveryId
    && record.deterministicKey === deliveryId
    && record.messageContentHash === messageContentHash
    && record.projectId === episode.projectId
    && record.issueNumber === episode.issueNumber
    && record.schedulerGeneration === episode.schedulerGeneration
    && record.tickSequence === episode.tickSequence
    && record.transitionIdentity === episode.transitionIdentity
    && record.unitRef === episode.unitRef
    && record.eligibleClass === episode.eligibleClass
    && record.intentClass === 'task-continuation';
}

function dispatchOutcomeForS2(outcome: S2FleetNudgeJournalOutcome): string {
  return outcome === 'dispatched'
    ? DISPATCH_OUTCOME_DISPATCHED
    : outcome === 'send_failed'
      ? DISPATCH_OUTCOME_SEND_FAILED
      : DISPATCH_OUTCOME_UNKNOWN;
}

export async function admitS2FleetNudgeJournal(input: {
  readonly journalPath: string;
  readonly episode: S2FleetNudgeJournalEpisode;
  readonly message: string;
  readonly deadlineMs: number;
}): Promise<
  | { readonly status: 'admitted'; readonly handle: S2FleetNudgeJournalHandle }
  | { readonly status: 'claim_untrusted' }
> {
  try {
    const deliveryId = buildS2EpisodeKey(input.episode);
    const messageContentHash = hashNudgeMessageContent(input.message);
    if (!messageContentHash) throw new Error('journal_untrusted');
    return await withCanonicalJournalDeadlineLock(input.journalPath, input.deadlineMs, () => {
      const nowMs = Date.now();
      const compacted = compactDispatchJournal(
        readCanonicalJournal(input.journalPath, input.deadlineMs),
        nowMs,
      ).journal;
      const existing = compacted[deliveryId];
      if (existing !== undefined) {
        const record = asS2CanonicalRecord(existing);
        if (!record || !exactS2Record(record, input.episode, deliveryId, messageContentHash)) {
          return { status: 'claim_untrusted' as const };
        }
        return {
          status: 'admitted' as const,
          handle: { journalPath: input.journalPath, deliveryId },
        };
      }

      const shape = deriveMessageShape(input.message);
      const record = withPendingDispatchFence({
        deliveryId,
        sessionId: `${input.episode.schedulerGeneration}:${input.episode.unitRef}`,
        deliveredAtMs: nowMs,
        source: 's2-fleet-nudge',
        sourceKey: deliveryId,
        deliveryPath: shape.deliveryPath,
        messageShape: { charLength: shape.charLength, lineCount: shape.lineCount },
        dispatchOutcome: DISPATCH_OUTCOME_IN_FLIGHT,
        draftState: shape.deliveryPath === DELIVERY_PATH_SELF_SUBMITTED
          ? DRAFT_STATE_AUTO_SUBMITTED
          : DRAFT_STATE_DRAFT_PRESENT,
        deterministicKey: deliveryId,
        policyTag: 's2-one-shot-v1',
        projectId: input.episode.projectId,
        issueNumber: input.episode.issueNumber,
        schedulerGeneration: input.episode.schedulerGeneration,
        tickSequence: input.episode.tickSequence,
        transitionIdentity: input.episode.transitionIdentity,
        unitRef: input.episode.unitRef,
        eligibleClass: input.episode.eligibleClass,
        intentClass: 'task-continuation',
        messageContentHash,
      } as S2CanonicalDispatchRecord);
      const capacity = evaluateDispatchJournalAdmission(compacted, record);
      if (!capacity.ok) return { status: 'claim_untrusted' as const };
      const admitted = admitDispatchJournalRecord(compacted, record, nowMs);
      if (!admitted.ok) return { status: 'claim_untrusted' as const };
      writeCanonicalJournal(input.journalPath, admitted.journal, input.deadlineMs);
      return {
        status: 'admitted' as const,
        handle: { journalPath: input.journalPath, deliveryId },
      };
    });
  } catch {
    return { status: 'claim_untrusted' };
  }
}

export async function finalizeS2FleetNudgeJournal(
  handle: S2FleetNudgeJournalHandle,
  outcome: S2FleetNudgeJournalOutcome,
  options: { readonly deadlineMs: number },
): Promise<{ readonly ok: boolean }> {
  try {
    return await withCanonicalJournalDeadlineLock(handle.journalPath, options.deadlineMs, () => {
      const journal = readCanonicalJournal(handle.journalPath, options.deadlineMs);
      const current = asS2CanonicalRecord(journal[handle.deliveryId]);
      if (!current || current.deliveryId !== handle.deliveryId) return { ok: false };
      const canonicalOutcome = dispatchOutcomeForS2(outcome);
      if (current.dispatchOutcome !== DISPATCH_OUTCOME_IN_FLIGHT) {
        return { ok: current.dispatchOutcome === canonicalOutcome };
      }
      const finalized = finalizeDispatchJournalRecord(
        journal,
        handle.deliveryId,
        canonicalOutcome,
        Date.now(),
        current.draftState,
      );
      if (!finalized.ok) return { ok: false };
      const nextRecord = advanceDispatchFenceLifecycle(
        finalized.record,
        canonicalOutcome,
      );
      writeCanonicalJournal(
        handle.journalPath,
        { ...finalized.journal, [handle.deliveryId]: nextRecord },
        options.deadlineMs,
      );
      return { ok: true };
    });
  } catch {
    return { ok: false };
  }
}
