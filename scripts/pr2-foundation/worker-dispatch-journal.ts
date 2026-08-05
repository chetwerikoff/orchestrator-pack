import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
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

interface S2JournalRecord extends Record<string, unknown> {
  schemaVersion: 1;
  deliveryId: string;
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
  state: 'ADMITTED' | 'FINAL';
  outcome?: S2FleetNudgeJournalOutcome;
  admittedAtUtc: string;
  finalizedAtUtc?: string;
}

function assertJournalDeadline(deadlineMs: number): void {
  if (!Number.isFinite(deadlineMs) || Date.now() >= deadlineMs) {
    throw new Error('journal_deadline_expired');
  }
}

function readS2Journal(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('journal_untrusted');
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && error.message === 'journal_untrusted') throw error;
    throw new Error('journal_untrusted');
  }
}

function asS2JournalRecord(value: unknown): S2JournalRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1
    || record.policyTag !== 's2-one-shot-v1'
    || typeof record.deliveryId !== 'string'
    || typeof record.projectId !== 'string'
    || !Number.isInteger(record.issueNumber)
    || typeof record.schedulerGeneration !== 'string'
    || !Number.isInteger(record.tickSequence)
    || typeof record.transitionIdentity !== 'string'
    || typeof record.unitRef !== 'string'
    || !['idle', 'livelock'].includes(String(record.eligibleClass))
    || record.intentClass !== 'task-continuation'
    || typeof record.messageContentHash !== 'string'
    || !['ADMITTED', 'FINAL'].includes(String(record.state))) return null;
  return record as S2JournalRecord;
}

function writeS2JournalAtomic(
  file: string,
  journal: Record<string, unknown>,
  deadlineMs: number,
): void {
  assertJournalDeadline(deadlineMs);
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${randomUUID().replace(/-/g, '')}.tmp`);
  try {
    assertJournalDeadline(deadlineMs);
    writeFileSync(temporary, `${JSON.stringify(journal, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    assertJournalDeadline(deadlineMs);
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function delayUntil(deadlineMs: number, milliseconds: number): Promise<void> {
  const remaining = deadlineMs - Date.now();
  if (remaining <= 0) throw new Error('journal_deadline_expired');
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, Math.min(milliseconds, remaining)));
}

async function withS2JournalMutex<T>(
  journalPath: string,
  deadlineMs: number,
  action: () => T | Promise<T>,
): Promise<T> {
  const directory = `${journalPath}.s2-lock`;
  for (let attempt = 0; Date.now() < deadlineMs; attempt += 1) {
    try {
      assertJournalDeadline(deadlineMs);
      mkdirSync(directory, { recursive: false });
      const ownerPath = path.join(directory, 'owner.json');
      const descriptor = openSync(ownerPath, 'wx', 0o600);
      try {
        writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid })}\n`, 'utf8');
      } finally {
        closeSync(descriptor);
      }
      try {
        assertJournalDeadline(deadlineMs);
        return await action();
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code ?? '')
        : '';
      if (code !== 'EEXIST') throw error;
      let ownerPid = 0;
      try {
        const owner = JSON.parse(readFileSync(path.join(directory, 'owner.json'), 'utf8')) as Record<string, unknown>;
        ownerPid = Number(owner.pid ?? 0);
      } catch {
        ownerPid = 0;
      }
      if (ownerPid > 0 && !processAlive(ownerPid)) {
        assertJournalDeadline(deadlineMs);
        rmSync(directory, { recursive: true, force: true });
        continue;
      }
      await delayUntil(deadlineMs, Math.min(10 * (attempt + 1), 50));
    }
  }
  throw new Error('journal_deadline_expired');
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
  let deliveryId: string;
  let messageContentHash: string;
  try {
    deliveryId = buildS2EpisodeKey(input.episode);
    messageContentHash = hashNudgeMessageContent(input.message);
    if (!messageContentHash) throw new Error('journal_untrusted');
    return await withS2JournalMutex(input.journalPath, input.deadlineMs, () => {
      const journal = readS2Journal(input.journalPath);
      const existing = journal[deliveryId];
      if (existing !== undefined) {
        const record = asS2JournalRecord(existing);
        if (!record
          || record.deliveryId !== deliveryId
          || record.messageContentHash !== messageContentHash
          || record.projectId !== input.episode.projectId
          || record.issueNumber !== input.episode.issueNumber
          || record.schedulerGeneration !== input.episode.schedulerGeneration
          || record.tickSequence !== input.episode.tickSequence
          || record.transitionIdentity !== input.episode.transitionIdentity
          || record.unitRef !== input.episode.unitRef
          || record.eligibleClass !== input.episode.eligibleClass) {
          return { status: 'claim_untrusted' as const };
        }
        return {
          status: 'admitted' as const,
          handle: { journalPath: input.journalPath, deliveryId },
        };
      }
      const record: S2JournalRecord = {
        schemaVersion: 1,
        deliveryId,
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
        state: 'ADMITTED',
        admittedAtUtc: new Date().toISOString(),
      };
      writeS2JournalAtomic(input.journalPath, { ...journal, [deliveryId]: record }, input.deadlineMs);
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
    return await withS2JournalMutex(handle.journalPath, options.deadlineMs, () => {
      const journal = readS2Journal(handle.journalPath);
      const current = asS2JournalRecord(journal[handle.deliveryId]);
      if (!current || current.deliveryId !== handle.deliveryId) return { ok: false };
      if (current.state === 'FINAL') return { ok: current.outcome === outcome };
      const next: S2JournalRecord = {
        ...current,
        state: 'FINAL',
        outcome,
        finalizedAtUtc: new Date().toISOString(),
      };
      writeS2JournalAtomic(
        handle.journalPath,
        { ...journal, [handle.deliveryId]: next },
        options.deadlineMs,
      );
      return { ok: true };
    });
  } catch {
    return { ok: false };
  }
}
