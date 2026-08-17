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
import { isDeepStrictEqual } from 'node:util';
import { TURN_STATES } from '../chatgpt-browser-turn/contracts.ts';
import { PACK_REVIEW_CAPS, selectPackReviewGptSourceCardinality } from '../pack-review-state.ts';

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

export type PackReviewSourceSlotLifecycle = 'planned' | 'invocation_started' | 'terminal';

export interface PackReviewSourceSlotRecord {
  slotId: string;
  ordinal: number;
  lifecycle: PackReviewSourceSlotLifecycle;
  invocationId?: string;
  attemptOrdinal?: number;
  admissionStartedAtUtc?: string;
  terminalClass?: string;
  terminalResult?: unknown;
  payload?: unknown;
}

export interface PackReviewGptRoundRecord {
  schema: 'pack-review-gpt-round/v1';
  reviewer: 'gpt';
  tier: 'T1' | 'T2' | 'T3';
  roundOrdinal: number;
  cardinality: number;
  issueNumber: number;
  boundIssueSnapshotDigest: string;
  sourceSlots: PackReviewSourceSlotRecord[];
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
  reviewRound?: PackReviewGptRoundRecord;
  stale?: boolean;
}

export const PACK_REVIEW_STALE_FAILURE_REASON = 'runner_disappeared_stale';

export interface PackReviewStoreOptions {
  projectId?: string;
  storeRoot?: string;
  now?: Date;
}

export function hasValidPackReviewJournalOutcome(record: PackReviewRunRecord): boolean {
  const journal = record.journalOutcome;
  return Boolean(
    journal
      && (journal.state === 'persisted' || journal.state === 'journal_write_failed')
      && typeof journal.recordedAtUtc === 'string'
      && journal.recordedAtUtc.length > 0
      && typeof journal.reason === 'string'
      && journal.reason.length > 0
      && journal.idempotencyKey === `verdict:${record.id}:${record.targetSha}`
      && Number.isInteger(journal.attempts)
      && journal.attempts > 0,
  );
}

export function hasValidPackReviewDeliveryOutcome(
  outcome: unknown,
  expectedIdempotencyKey?: string,
): outcome is PackReviewDeliveryOutcome {
  if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)) return false;
  const candidate = outcome as Partial<PackReviewDeliveryOutcome>;
  return (candidate.state === 'succeeded'
      || candidate.state === 'delivered'
      || candidate.state === 'failed'
      || candidate.state === 'escalated')
    && typeof candidate.recordedAtUtc === 'string'
    && candidate.recordedAtUtc.length > 0
    && typeof candidate.reason === 'string'
    && candidate.reason.length > 0
    && typeof candidate.idempotencyKey === 'string'
    && candidate.idempotencyKey.length > 0
    && (!expectedIdempotencyKey || candidate.idempotencyKey === expectedIdempotencyKey);
}

export function hasValidPackReviewGithubReconciliation(
  value: unknown,
  expectedPhase?: GithubCommentReviewReconciliationPhase,
): value is GithubCommentReviewReconciliation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<GithubCommentReviewReconciliation>;
  return candidate.schemaVersion === 1
    && candidate.event === 'COMMENT'
    && (candidate.phase === 'prepared'
      || candidate.phase === 'comment_posted'
      || candidate.phase === 'dismissals_pending'
      || candidate.phase === 'complete')
    && (!expectedPhase || candidate.phase === expectedPhase)
    && typeof candidate.actorLogin === 'string'
    && typeof candidate.commentBody === 'string'
    && Array.isArray(candidate.pendingDismissalReviewIds)
    && Array.isArray(candidate.dismissedReviewIds)
    && typeof candidate.preparedAtUtc === 'string'
    && candidate.preparedAtUtc.length > 0
    && typeof candidate.updatedAtUtc === 'string'
    && candidate.updatedAtUtc.length > 0;
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
  legacyRepositoryBySourceRoot?: Record<string, string>;
  reviewRound?: PackReviewGptRoundRecord;
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
const PACK_REVIEW_SOURCE_SLOT_LIFECYCLE_RANK: Record<PackReviewSourceSlotLifecycle, number> = {
  planned: 0,
  invocation_started: 1,
  terminal: 2,
};
const COMPLETE_GPT_TERMINAL_CLASSES = new Set(['complete_clean', 'complete_findings']);
const HARVEST_GPT_TERMINAL_CLASSES = new Set(['harvest_failed', 'no_reply', 'forbidden_verdict_envelope']);
const GPT_BROWSER_TURN_STATES = new Set<string>(TURN_STATES);

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

function requiredJsonString(value: unknown, name: string, path = ''): string {
  if (typeof value !== 'string') {
    throw new Error(`corrupt pack review run record${path ? ` at ${path}` : ''}: invalid ${name} type`);
  }
  const text = value.trim();
  if (!text) throw new Error(`corrupt pack review run record${path ? ` at ${path}` : ''}: missing ${name}`);
  return text;
}

function requiredJsonPositiveInteger(value: unknown, name: string, path = ''): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`corrupt pack review run record${path ? ` at ${path}` : ''}: invalid ${name}`);
  }
  return value;
}

function requiredJsonNonNegativeInteger(value: unknown, name: string, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`corrupt pack review run record at ${path}: invalid ${name}`);
  }
  return value;
}

function validateCompleteGptPayload(payload: unknown, terminalClass: string, path: string): void {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`corrupt pack review run record at ${path}: ${terminalClass} requires a valid payload`);
  }
  const raw = payload as Record<string, unknown>;
  if (raw.verdict !== 'clean' && raw.verdict !== 'findings') {
    throw new Error(`corrupt pack review run record at ${path}: invalid complete-source payload verdict`);
  }
  const findingCount = requiredJsonNonNegativeInteger(raw.findingCount, 'payload findingCount', path);
  if (!Array.isArray(raw.findings)) {
    throw new Error(`corrupt pack review run record at ${path}: invalid complete-source payload findings`);
  }
  if (raw.findings.length !== findingCount) {
    throw new Error(`corrupt pack review run record at ${path}: payload findingCount does not match findings length`);
  }
  if (raw.findings.some((finding) => !finding || typeof finding !== 'object' || Array.isArray(finding))) {
    throw new Error(`corrupt pack review run record at ${path}: invalid complete-source finding`);
  }
  if (terminalClass === 'complete_clean'
    && (raw.verdict !== 'clean' || findingCount !== 0)) {
    throw new Error(`corrupt pack review run record at ${path}: complete_clean payload is class-inconsistent`);
  }
  if (terminalClass === 'complete_findings'
    && (raw.verdict !== 'findings' || findingCount === 0)) {
    throw new Error(`corrupt pack review run record at ${path}: complete_findings payload is class-inconsistent`);
  }
}

function isRetryableZeroSendCollisionTuple(state: string, cause: string, sendCount: number): boolean {
  return sendCount === 0 && (
    (state === 'profile_busy' && cause === 'profile_busy')
    || (state === 'ui_contract_mismatch' && cause === 'composer_unavailable')
    || (state === 'driver_error' && cause === 'state_light_new_chat_send_slot_timeout')
  );
}

function validateGptHarvestEvidence(
  result: Record<string, unknown>,
  terminalClass: string,
  state: string,
  sendCount: number,
  path: string,
): void {
  if (sendCount < 1) {
    throw new Error(`corrupt pack review run record at ${path}: ${terminalClass} requires a sent terminalResult`);
  }
  if (result.review_harvest_class !== terminalClass) {
    throw new Error(`corrupt pack review run record at ${path}: harvest class is terminalResult-inconsistent`);
  }
  if (terminalClass === 'no_reply') {
    if (state !== 'ok' && state !== 'no_reply') {
      throw new Error(`corrupt pack review run record at ${path}: no_reply requires an ok/no_reply sent terminalResult`);
    }
  } else if (state !== 'ok') {
    throw new Error(`corrupt pack review run record at ${path}: ${terminalClass} requires an ok sent terminalResult`);
  }
  if (!result.review_evidence || typeof result.review_evidence !== 'object' || Array.isArray(result.review_evidence)) {
    throw new Error(`corrupt pack review run record at ${path}: ${terminalClass} requires durable review_evidence`);
  }
  const evidence = result.review_evidence as Record<string, unknown>;
  for (const field of ['adapterPromptPath', 'terminalReplyPath', 'mappingErrorPath', 'adapterStdoutPath']) {
    requiredJsonString(evidence[field], `review_evidence ${field}`, path);
  }
}

function validateGptTerminalEvidence(slot: PackReviewSourceSlotRecord, path: string): void {
  if (slot.lifecycle !== 'terminal') {
    if (slot.terminalClass !== undefined || slot.terminalResult !== undefined || slot.payload !== undefined) {
      throw new Error(`corrupt pack review run record at ${path}: terminal evidence requires terminal lifecycle`);
    }
    return;
  }

  const terminalClass = typeof slot.terminalClass === 'string' ? slot.terminalClass.trim() : '';
  if (!terminalClass) {
    throw new Error(`corrupt pack review run record at ${path}: terminal source slot lacks terminal outcome`);
  }
  if (!slot.terminalResult || typeof slot.terminalResult !== 'object' || Array.isArray(slot.terminalResult)) {
    throw new Error(`corrupt pack review run record at ${path}: terminal source slot lacks valid terminalResult`);
  }
  const result = slot.terminalResult as Record<string, unknown>;
  const complete = COMPLETE_GPT_TERMINAL_CLASSES.has(terminalClass);

  if (result.schema === 'turn-result/v1') {
    const state = requiredJsonString(result.state, 'terminalResult state', path);
    if (!GPT_BROWSER_TURN_STATES.has(state)) {
      throw new Error(`corrupt pack review run record at ${path}: unsupported terminalResult state`);
    }
    requiredJsonString(result.scope, 'terminalResult scope', path);
    const cause = requiredJsonString(result.cause, 'terminalResult cause', path);
    const invocationId = requiredJsonString(result.invocation_id, 'terminalResult invocation_id', path);
    const sendCount = requiredJsonNonNegativeInteger(result.send_count, 'terminalResult send_count', path);
    if (slot.invocationId !== invocationId) {
      throw new Error(`corrupt pack review run record at ${path}: terminalResult invocation_id is not bound to slot`);
    }

    if (complete) {
      if (state !== 'ok' || sendCount < 1) {
        throw new Error(`corrupt pack review run record at ${path}: ${terminalClass} requires successful sent terminalResult`);
      }
      validateCompleteGptPayload(slot.payload, terminalClass, path);
      return;
    }
    if (slot.payload !== undefined) {
      throw new Error(`corrupt pack review run record at ${path}: non-complete terminal class cannot carry payload`);
    }
    if (HARVEST_GPT_TERMINAL_CLASSES.has(terminalClass)) {
      validateGptHarvestEvidence(result, terminalClass, state, sendCount, path);
      return;
    }
    if (terminalClass === 'reviewer_output_malformed') {
      if (state !== 'ok' || sendCount < 1) {
        throw new Error(`corrupt pack review run record at ${path}: reviewer_output_malformed requires a successful sent terminalResult`);
      }
      return;
    }
    if (terminalClass === 'possible_delivery') {
      if (sendCount < 1 || state === 'ok') {
        throw new Error(`corrupt pack review run record at ${path}: possible_delivery requires a non-ok sent terminalResult`);
      }
      return;
    }
    if (terminalClass === 'explicit_refusal:zero_send_collision_exhausted') {
      if (slot.attemptOrdinal !== 2 || !isRetryableZeroSendCollisionTuple(state, cause, sendCount)) {
        throw new Error(`corrupt pack review run record at ${path}: exhausted collision class is terminalResult-inconsistent`);
      }
      return;
    }
    if (sendCount === 0 && state !== 'ok') {
      if (isRetryableZeroSendCollisionTuple(state, cause, sendCount)) {
        throw new Error(`corrupt pack review run record at ${path}: retryable zero-send collision requires exhausted-attempt refusal evidence`);
      }
      if (terminalClass !== `${state}:${cause}`) {
        throw new Error(`corrupt pack review run record at ${path}: zero-send terminal class is terminalResult-inconsistent`);
      }
      return;
    }
    throw new Error(`corrupt pack review run record at ${path}: unsupported terminal class for turn-result/v1`);
  }

  if (typeof result.kind === 'string' && result.kind.trim()) {
    if (slot.payload !== undefined) {
      throw new Error(`corrupt pack review run record at ${path}: non-complete terminal class cannot carry payload`);
    }
    const expectedKind = terminalClass === 'possible_delivery/missing_result'
      ? 'missing_terminal_result'
      : terminalClass === 'pre_launch_interrupted'
        ? 'stale_pre_launch_interruption'
        : '';
    if (!expectedKind || result.kind.trim() !== expectedKind || result.noResend !== true) {
      throw new Error(`corrupt pack review run record at ${path}: stale terminal evidence is class-inconsistent`);
    }
    return;
  }

  const hasExitCode = Object.prototype.hasOwnProperty.call(result, 'exitCode');
  const hasStderr = Object.prototype.hasOwnProperty.call(result, 'stderr');
  if (!hasExitCode && !hasStderr) {
    throw new Error(`corrupt pack review run record at ${path}: unsupported terminalResult evidence`);
  }
  if (hasExitCode && result.exitCode !== null && !Number.isInteger(result.exitCode)) {
    throw new Error(`corrupt pack review run record at ${path}: invalid terminalResult exitCode`);
  }
  if (hasStderr && typeof result.stderr !== 'string') {
    throw new Error(`corrupt pack review run record at ${path}: invalid terminalResult stderr`);
  }
  if (complete) {
    throw new Error(`corrupt pack review run record at ${path}: ${terminalClass} requires turn-result/v1 evidence`);
  }
  if (slot.payload !== undefined) {
    throw new Error(`corrupt pack review run record at ${path}: non-complete terminal class cannot carry payload`);
  }
  if (terminalClass !== 'reviewer_output_malformed'
    && terminalClass !== 'possible_delivery/missing_result') {
    throw new Error(`corrupt pack review run record at ${path}: process terminal evidence is class-inconsistent`);
  }
}

function normalizePackReviewGptRoundRecord(value: unknown, path = ''): PackReviewGptRoundRecord {
  const raw = asObject(value);
  if (raw.schema !== 'pack-review-gpt-round/v1') {
    throw new Error(`corrupt pack review run record${path ? ` at ${path}` : ''}: invalid reviewRound schema`);
  }
  if (raw.reviewer !== 'gpt') {
    throw new Error(`corrupt pack review run record${path ? ` at ${path}` : ''}: invalid reviewRound reviewer`);
  }
  if (raw.tier !== 'T1' && raw.tier !== 'T2' && raw.tier !== 'T3') {
    throw new Error(`corrupt pack review run record${path ? ` at ${path}` : ''}: invalid reviewRound tier`);
  }
  const tier = raw.tier;
  const roundOrdinal = requiredJsonPositiveInteger(raw.roundOrdinal, 'reviewRound roundOrdinal', path);
  const cardinality = requiredJsonPositiveInteger(raw.cardinality, 'reviewRound cardinality', path);
  if (roundOrdinal > PACK_REVIEW_CAPS[tier]) {
    throw new Error(`corrupt pack review run record${path ? ` at ${path}` : ''}: reviewRound ordinal exceeds tier cap`);
  }
  const expectedCardinality = selectPackReviewGptSourceCardinality({
    reviewer: 'gpt',
    tier,
    roundOrdinal,
  });
  if (cardinality !== expectedCardinality) {
    throw new Error(`corrupt pack review run record${path ? ` at ${path}` : ''}: reviewRound cardinality violates tier/round policy`);
  }
  const issueNumber = requiredJsonPositiveInteger(raw.issueNumber, 'reviewRound issueNumber', path);
  const boundIssueSnapshotDigest = requiredJsonString(
    raw.boundIssueSnapshotDigest,
    'reviewRound boundIssueSnapshotDigest',
    path,
  );
  if (!Array.isArray(raw.sourceSlots)) {
    throw new Error(`corrupt pack review run record${path ? ` at ${path}` : ''}: missing reviewRound sourceSlots`);
  }
  if (raw.sourceSlots.length !== cardinality) {
    throw new Error(
      `corrupt pack review run record${path ? ` at ${path}` : ''}: reviewRound sourceSlots cardinality mismatch`,
    );
  }

  const slotIds = new Set<string>();
  const ordinals = new Set<number>();
  const invocationIds = new Set<string>();
  const sourceSlots = raw.sourceSlots.map((value, index): PackReviewSourceSlotRecord => {
    const slotPath = `${path || '<record>'}.reviewRound.sourceSlots[${index}]`;
    const slot = asObject(value);
    const slotId = requiredJsonString(slot.slotId, 'slotId', slotPath);
    const ordinal = requiredJsonPositiveInteger(slot.ordinal, 'ordinal', slotPath);
    if (ordinal > cardinality) {
      throw new Error(`corrupt pack review run record at ${slotPath}: ordinal exceeds cardinality`);
    }
    const expectedSlotId = `source-${String(ordinal).padStart(2, '0')}`;
    if (slotId !== expectedSlotId) {
      throw new Error(
        `corrupt pack review run record at ${slotPath}: slotId '${slotId}' is not bound to ordinal ${ordinal}`,
      );
    }
    if (slotIds.has(slotId)) {
      throw new Error(`corrupt pack review run record at ${slotPath}: duplicate slotId '${slotId}'`);
    }
    if (ordinals.has(ordinal)) {
      throw new Error(`corrupt pack review run record at ${slotPath}: duplicate ordinal ${ordinal}`);
    }
    slotIds.add(slotId);
    ordinals.add(ordinal);

    const lifecycle = requiredJsonString(slot.lifecycle, 'lifecycle', slotPath) as PackReviewSourceSlotLifecycle;
    if (lifecycle !== 'planned' && lifecycle !== 'invocation_started' && lifecycle !== 'terminal') {
      throw new Error(`corrupt pack review run record at ${slotPath}: invalid lifecycle '${lifecycle}'`);
    }

    let invocationId: string | undefined;
    if (slot.invocationId !== undefined) {
      invocationId = requiredJsonString(slot.invocationId, 'invocationId', slotPath);
      if (invocationIds.has(invocationId)) {
        throw new Error(`corrupt pack review run record at ${slotPath}: duplicate invocationId '${invocationId}'`);
      }
      invocationIds.add(invocationId);
    }

    let attemptOrdinal: number | undefined;
    if (slot.attemptOrdinal !== undefined) {
      attemptOrdinal = requiredJsonPositiveInteger(slot.attemptOrdinal, 'attemptOrdinal', slotPath);
    }

    let admissionStartedAtUtc: string | undefined;
    if (slot.admissionStartedAtUtc !== undefined) {
      admissionStartedAtUtc = requiredJsonString(slot.admissionStartedAtUtc, 'admissionStartedAtUtc', slotPath);
    }

    let terminalClass: string | undefined;
    if (slot.terminalClass !== undefined) {
      terminalClass = requiredJsonString(slot.terminalClass, 'terminalClass', slotPath);
    }

    const normalizedSlot: PackReviewSourceSlotRecord = {
      ...(slot as unknown as PackReviewSourceSlotRecord),
      slotId,
      ordinal,
      lifecycle,
      ...(invocationId === undefined ? {} : { invocationId }),
      ...(attemptOrdinal === undefined ? {} : { attemptOrdinal }),
      ...(admissionStartedAtUtc === undefined ? {} : { admissionStartedAtUtc }),
      ...(terminalClass === undefined ? {} : { terminalClass }),
    };
    validateGptTerminalEvidence(normalizedSlot, slotPath);
    return normalizedSlot;
  });

  for (let ordinal = 1; ordinal <= cardinality; ordinal += 1) {
    if (!ordinals.has(ordinal)) {
      throw new Error(
        `corrupt pack review run record${path ? ` at ${path}` : ''}: missing source slot ordinal ${ordinal}`,
      );
    }
  }

  return {
    ...(raw as unknown as PackReviewGptRoundRecord),
    schema: 'pack-review-gpt-round/v1',
    reviewer: 'gpt',
    tier,
    roundOrdinal,
    cardinality,
    issueNumber,
    boundIssueSnapshotDigest,
    sourceSlots,
  };
}

function assertFrozenGptRoundIdentity(
  existing: PackReviewGptRoundRecord,
  incoming: PackReviewGptRoundRecord,
  path: string,
): void {
  const immutableFields: Array<keyof Pick<
    PackReviewGptRoundRecord,
    'schema' | 'reviewer' | 'tier' | 'roundOrdinal' | 'cardinality' | 'issueNumber' | 'boundIssueSnapshotDigest'
  >> = [
    'schema',
    'reviewer',
    'tier',
    'roundOrdinal',
    'cardinality',
    'issueNumber',
    'boundIssueSnapshotDigest',
  ];
  for (const field of immutableFields) {
    if (existing[field] !== incoming[field]) {
      throw new Error(`corrupt pack review run record at ${path}: frozen reviewRound ${field} cannot change`);
    }
  }
  if (existing.sourceSlots.length !== incoming.sourceSlots.length) {
    throw new Error(`corrupt pack review run record at ${path}: frozen reviewRound source census cannot change`);
  }
  for (const existingSlot of existing.sourceSlots) {
    const incomingSlot = incoming.sourceSlots.find((slot) => slot.ordinal === existingSlot.ordinal);
    if (!incomingSlot || incomingSlot.slotId !== existingSlot.slotId) {
      throw new Error(
        `corrupt pack review run record at ${path}: frozen reviewRound source slot ${existingSlot.slotId} cannot change`,
      );
    }
  }
}

function mergeFrozenGptSlot(
  existing: PackReviewSourceSlotRecord,
  incoming: PackReviewSourceSlotRecord,
  path: string,
): PackReviewSourceSlotRecord {
  const existingAttempt = existing.attemptOrdinal;
  const incomingAttempt = incoming.attemptOrdinal;
  if (existing.lifecycle === 'terminal'
    && incomingAttempt !== undefined
    && incomingAttempt > (existingAttempt ?? 0)) {
    throw new Error(`corrupt pack review run record at ${path}: terminal source slot attempt cannot advance`);
  }

  const legalRetryIdentityRotation = existing.lifecycle !== 'terminal'
    && existingAttempt === 1
    && incomingAttempt === 2
    && existing.invocationId !== undefined
    && incoming.invocationId !== undefined
    && existing.invocationId !== incoming.invocationId;
  let invocationId = legalRetryIdentityRotation
    ? incoming.invocationId
    : existing.invocationId ?? incoming.invocationId;
  if (existing.invocationId !== undefined
    && incoming.invocationId !== undefined
    && existing.invocationId !== incoming.invocationId
    && !legalRetryIdentityRotation) {
    throw new Error(`corrupt pack review run record at ${path}: invocationId cannot change outside the one retry transition`);
  }

  const attemptOrdinal = existingAttempt === undefined
    ? incomingAttempt
    : incomingAttempt === undefined
      ? existingAttempt
      : Math.max(existingAttempt, incomingAttempt);

  let admissionStartedAtUtc = existing.admissionStartedAtUtc ?? incoming.admissionStartedAtUtc;
  if (existing.admissionStartedAtUtc !== undefined
    && incoming.admissionStartedAtUtc !== undefined
    && existing.admissionStartedAtUtc !== incoming.admissionStartedAtUtc) {
    if ((incomingAttempt ?? 0) > (existingAttempt ?? 0)) {
      admissionStartedAtUtc = incoming.admissionStartedAtUtc;
    } else if ((incomingAttempt ?? 0) < (existingAttempt ?? 0)) {
      admissionStartedAtUtc = existing.admissionStartedAtUtc;
    } else {
      throw new Error(`corrupt pack review run record at ${path}: admissionStartedAtUtc changed without a new attempt`);
    }
  }

  const mergeEvidence = (name: 'terminalClass' | 'terminalResult' | 'payload'): unknown => {
    const existingValue = existing[name];
    const incomingValue = incoming[name];
    if (existingValue !== undefined
      && incomingValue !== undefined
      && !isDeepStrictEqual(existingValue, incomingValue)) {
      throw new Error(`corrupt pack review run record at ${path}: ${name} cannot change`);
    }
    return existingValue ?? incomingValue;
  };

  const terminalClass = mergeEvidence('terminalClass') as string | undefined;
  const terminalResult = mergeEvidence('terminalResult');
  const payload = mergeEvidence('payload');
  const lifecycle = PACK_REVIEW_SOURCE_SLOT_LIFECYCLE_RANK[existing.lifecycle]
    >= PACK_REVIEW_SOURCE_SLOT_LIFECYCLE_RANK[incoming.lifecycle]
    ? existing.lifecycle
    : incoming.lifecycle;

  invocationId = invocationId?.trim() || undefined;
  return {
    ...existing,
    ...incoming,
    slotId: existing.slotId,
    ordinal: existing.ordinal,
    lifecycle,
    ...(invocationId === undefined ? { invocationId: undefined } : { invocationId }),
    ...(attemptOrdinal === undefined ? { attemptOrdinal: undefined } : { attemptOrdinal }),
    ...(admissionStartedAtUtc === undefined
      ? { admissionStartedAtUtc: undefined }
      : { admissionStartedAtUtc }),
    ...(terminalClass === undefined ? { terminalClass: undefined } : { terminalClass }),
    ...(terminalResult === undefined ? { terminalResult: undefined } : { terminalResult }),
    ...(payload === undefined ? { payload: undefined } : { payload }),
  };
}

function mergeFrozenGptRound(
  existing: PackReviewGptRoundRecord,
  incoming: PackReviewGptRoundRecord,
  path: string,
): PackReviewGptRoundRecord {
  assertFrozenGptRoundIdentity(existing, incoming, path);
  return {
    ...existing,
    sourceSlots: existing.sourceSlots.map((existingSlot) => {
      const incomingSlot = incoming.sourceSlots.find((slot) => slot.ordinal === existingSlot.ordinal)!;
      return mergeFrozenGptSlot(
        existingSlot,
        incomingSlot,
        `${path}.reviewRound.sourceSlots[${existingSlot.ordinal - 1}]`,
      );
    }),
  };
}

function assertCompleteGptRound(round: PackReviewGptRoundRecord, path: string): void {
  for (const slot of round.sourceSlots) {
    if (slot.lifecycle !== 'terminal') {
      throw new Error(
        `corrupt pack review run record at ${path}: mandatory source slot ${slot.slotId} is not terminal`,
      );
    }
    validateGptTerminalEvidence(
      slot,
      `${path}.reviewRound.sourceSlots[${slot.ordinal - 1}]`,
    );
  }
}

export interface PackReviewGptAggregate {
  reviewVerdict: 'clean' | 'findings';
  findingCount: number;
  findings: unknown[];
}

function deriveCompleteGptRoundAggregate(
  round: PackReviewGptRoundRecord,
  path: string,
): PackReviewGptAggregate {
  assertCompleteGptRound(round, path);
  const findings: unknown[] = [];
  for (const slot of round.sourceSlots) {
    if (!COMPLETE_GPT_TERMINAL_CLASSES.has(slot.terminalClass ?? '')) continue;
    const payload = slot.payload as { findings: Array<Record<string, unknown>> };
    findings.push(...payload.findings.map((finding) => ({
      ...finding,
      sourceSlotId: slot.slotId,
    })));
  }
  return {
    reviewVerdict: findings.length > 0 ? 'findings' : 'clean',
    findingCount: findings.length,
    findings,
  };
}

function hasNonHarvestIncompleteGptSource(round: PackReviewGptRoundRecord): boolean {
  return round.sourceSlots.some((slot) => {
    const terminalClass = slot.terminalClass ?? '';
    return slot.lifecycle === 'terminal'
      && !COMPLETE_GPT_TERMINAL_CLASSES.has(terminalClass)
      && !HARVEST_GPT_TERMINAL_CLASSES.has(terminalClass);
  });
}

function assertGptRoundAggregate(
  round: PackReviewGptRoundRecord,
  aggregate: {
    reviewVerdict: unknown;
    findingCount: unknown;
    findings: unknown;
  },
  path: string,
): void {
  const expected = deriveCompleteGptRoundAggregate(round, path);
  if (aggregate.reviewVerdict !== expected.reviewVerdict) {
    throw new Error(
      `corrupt pack review run record at ${path}: reviewVerdict does not match terminal source census`,
    );
  }
  const findingCount = requiredJsonNonNegativeInteger(
    aggregate.findingCount,
    'findingCount',
    path,
  );
  if (findingCount !== expected.findingCount) {
    throw new Error(
      `corrupt pack review run record at ${path}: findingCount does not match terminal source census`,
    );
  }
  if (!Array.isArray(aggregate.findings)) {
    throw new Error(`corrupt pack review run record at ${path}: invalid findings`);
  }
  if (!isDeepStrictEqual(aggregate.findings, expected.findings)) {
    throw new Error(
      `corrupt pack review run record at ${path}: findings do not match terminal source census`,
    );
  }
}

function hasRecordedGptRoundLifecycleOrEvidence(record: PackReviewRunRecord): boolean {
  return record.reviewRound?.sourceSlots.some((slot) => slot.lifecycle !== 'planned'
    || slot.invocationId !== undefined
    || slot.attemptOrdinal !== undefined
    || slot.admissionStartedAtUtc !== undefined
    || slot.terminalClass !== undefined
    || slot.terminalResult !== undefined
    || slot.payload !== undefined) ?? false;
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
  if (leftRepository && rightRepository) {
    return leftRepository === rightRepository;
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
  if (canonicalRepository && recordRepository) return canonicalRepository === recordRepository;
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

function parseRecord(
  value: unknown,
  path = '',
): PackReviewRunRecord {
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
  const reviewRound = raw.reviewRound === undefined || raw.reviewRound === null
    ? undefined
    : normalizePackReviewGptRoundRecord(raw.reviewRound, path);
  const reviewVerdict = raw.reviewVerdict === 'clean' || raw.reviewVerdict === 'findings'
    ? raw.reviewVerdict
    : undefined;
  const findingCount = Number.isInteger(raw.findingCount) ? Number(raw.findingCount) : undefined;
  const findings = Array.isArray(raw.findings) ? [...raw.findings] : [];
  const journalOutcome = raw.journalOutcome && typeof raw.journalOutcome === 'object' && !Array.isArray(raw.journalOutcome)
    ? raw.journalOutcome as unknown as PackReviewJournalOutcome
    : undefined;
  const deliveryOutcomes = raw.deliveryOutcomes && typeof raw.deliveryOutcomes === 'object' && !Array.isArray(raw.deliveryOutcomes)
    ? raw.deliveryOutcomes as Partial<Record<PackReviewDeliveryChannel, PackReviewDeliveryOutcome>>
    : {};
  let authoritativeReviewVerdict: PackReviewRunRecord['reviewVerdict'] = reviewVerdict;
  let authoritativeFindingCount = findingCount;
  let authoritativeFindings = findings;
  if (reviewRound && (PACK_REVIEW_VERDICT_TERMINAL_STATUSES.has(status)
    || reviewVerdict !== undefined
    || journalOutcome?.state === 'persisted')) {
    const aggregate = {
      reviewVerdict: raw.reviewVerdict,
      findingCount: raw.findingCount,
      findings: raw.findings,
    };
    if (hasNonHarvestIncompleteGptSource(reviewRound)) {
      throw new Error(
        `corrupt pack review run record at ${path || '<record>'}: reviewVerdict does not match terminal source census`,
      );
    }
    assertGptRoundAggregate(reviewRound, aggregate, path || '<record>');
  }
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
    reviewRound,
    runnerPid: Number(raw.runnerPid ?? 0),
    createdAt,
    updatedAt,
    heartbeatAtUtc: String(raw.heartbeatAtUtc ?? updatedAt),
    sameKeyOrder: raw.sameKeyOrder === undefined
      ? undefined
      : requiredPositiveInteger(raw.sameKeyOrder, 'sameKeyOrder', path),
    reviewVerdict: authoritativeReviewVerdict,
    findingCount: authoritativeFindingCount,
    findings: authoritativeFindings,
    journalOutcome,
    deliveryOutcomes,
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
  let recoveredRound = existing.reviewRound;
  if (existing.reviewRound?.sourceSlots.some((slot) => slot.lifecycle !== 'terminal')) {
    const reviewRound = {
      ...existing.reviewRound,
      sourceSlots: existing.reviewRound.sourceSlots.map((slot) => {
        if (slot.lifecycle === 'terminal') return slot;
        if (slot.lifecycle === 'invocation_started') {
          return {
            ...slot,
            lifecycle: 'terminal' as const,
            terminalClass: 'possible_delivery/missing_result',
            terminalResult: { kind: 'missing_terminal_result', noResend: true },
          };
        }
        return {
          ...slot,
          lifecycle: 'terminal' as const,
          terminalClass: 'pre_launch_interrupted',
          terminalResult: { kind: 'stale_pre_launch_interruption', noResend: true },
        };
      }),
    };
    recoveredRound = updatePackReviewRun(runId, { reviewRound }, options).reviewRound;
  }
  const run = setPackReviewRunTerminal(runId, 'failed', {
    failureReason: PACK_REVIEW_STALE_FAILURE_REASON,
    stale: true,
    exitCode: 1,
    ...(recoveredRound ? { reviewRound: recoveredRound } : {}),
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
  const sameKeyRecords = records.filter((record) => samePackReviewRunIdentity(record, run));
  if (sameKeyRecords.some((record) => record.sameKeyOrder !== undefined)) return false;
  const legacy = sameKeyRecords.filter((record) => record.sameKeyOrder === undefined);
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
  const orderedCandidates = candidates.filter((candidate) => candidate.sameKeyOrder !== undefined);
  if (orderedCandidates.length > 0) {
    let latest = orderedCandidates[0]!;
    for (const candidate of orderedCandidates.slice(1)) {
      const comparison = compareSameKeyRuns(candidate, latest);
      if (comparison === null) {
        throw new Error(`ambiguous pack review run order for ${latest.key}: legacy_order_ambiguous`);
      }
      if (comparison > 0) latest = candidate;
    }
    return latest;
  }
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
  return hasValidPackReviewJournalOutcome(record)
    && record.journalOutcome?.state === 'persisted'
    && (record.reviewVerdict === 'clean' || record.reviewVerdict === 'findings')
    && Number.isInteger(record.findingCount)
    && Number(record.findingCount) >= 0
    && record.findings.length === Number(record.findingCount);
}

function writeRecordUnlocked(storeRoot: string, record: PackReviewRunRecord, createOnly = false): void {
  const path = recordPath(storeRoot, record.id);
  if (createOnly && existsSync(path)) throw new Error(`pack review run already exists: ${record.id}`);
  const validated = parseRecord(record, path);
  mkdirSync(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${randomUUID()}.tmp`);
  writeFileSync(temp, `${JSON.stringify(validated)}\n`, 'utf8');
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

export function validatePersistedPackReviewGptAggregate(
  runId: string,
  aggregate: {
    reviewVerdict: unknown;
    findingCount: unknown;
    findings: unknown;
  },
  options: PackReviewStoreOptions = {},
): PackReviewGptAggregate {
  const storeRoot = resolvePackReviewRunStoreRoot(options);
  return withStoreLock(storeRoot, () => {
    const path = recordPath(storeRoot, runId);
    if (!existsSync(path)) throw new Error(`pack review run not found: ${runId}`);
    const record = parseRecord(JSON.parse(readFileSync(path, 'utf8')), path);
    if (!record.reviewRound) {
      throw new Error(`pack review run ${runId} has no persisted GPT round`);
    }
    assertGptRoundAggregate(record.reviewRound, aggregate, path);
    return deriveCompleteGptRoundAggregate(record.reviewRound, path);
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
    const legacyRepositoryBindings = new Map(
      Object.entries(input.legacyRepositoryBySourceRoot ?? {}).map(([sourceRoot, repository]) => [
        resolve(sourceRoot),
        normalizePackReviewCanonicalRepository(repository),
      ]),
    );
    const boundRecords = records.map((record) => {
      if (record.canonicalRepository) return record;
      const repository = canonicalRepositoryFromRunKey(record.key, record.prNumber, record.targetSha)
        ?? legacyRepositoryBindings.get(resolve(record.sourceRepoRoot));
      return repository ? { ...record, canonicalRepository: repository } : record;
    });
    const canonicalRepository = input.canonicalRepository
      ? normalizePackReviewCanonicalRepository(input.canonicalRepository)
      : undefined;
    const key = packReviewRunKey(input.prNumber, headSha, canonicalRepository);
    const matchesInput = (record: PackReviewRunRecord) => matchesPackReviewRunInput(
      record,
      projectId,
      input.prNumber,
      headSha,
      canonicalRepository,
      input.sourceRepoRoot,
    );
    const active = boundRecords.filter((record) => matchesInput(record)
      && PACK_REVIEW_ACTIVE_STATUSES.has(record.status)
      && !isPackReviewRunStale(record));
    if (active.length > 1) throw new Error(`ambiguous pack review run store: multiple active records for ${key}`);
    if (active.length === 1) {
      return { created: false, reused: true, reason: 'active_run_exists', run: consumerRow(active[0]!), storeRoot };
    }

    const completed = boundRecords
      .filter((record) => matchesInput(record)
        && PACK_REVIEW_VERDICT_TERMINAL_STATUSES.has(record.status)
        && hasPersistedPackReviewVerdict(record));
    const latestCompleted = selectLatestSameKeyRun(boundRecords, completed);
    if (latestCompleted) {
      return { created: false, reused: true, reason: 'terminal_run_exists', run: consumerRow(latestCompleted), storeRoot };
    }

    const uncertain = boundRecords.filter((record) => matchesInput(record)
      && record.reviewRound?.sourceSlots.some((slot) => slot.terminalClass === 'possible_delivery/missing_result'));
    const latestUncertain = selectLatestSameKeyRun(boundRecords, uncertain);
    if (latestUncertain) {
      return {
        created: false,
        reused: true,
        reason: 'possible_delivery_requires_settlement',
        run: consumerRow(latestUncertain),
        storeRoot,
      };
    }

    const persistedGptRounds = boundRecords.filter((record) => matchesInput(record)
      && hasRecordedGptRoundLifecycleOrEvidence(record));
    const latestPersistedGptRound = selectLatestSameKeyRun(boundRecords, persistedGptRounds);
    if (latestPersistedGptRound) {
      return {
        created: false,
        reused: true,
        reason: 'gpt_round_requires_settlement',
        run: consumerRow(latestPersistedGptRound),
        storeRoot,
      };
    }

    const now = (input.now ?? new Date()).toISOString();
    const sameKeyOrders = boundRecords
      .filter((record) => matchesInput(record) && record.sameKeyOrder !== undefined)
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
      ...(input.reviewRound ? { reviewRound: input.reviewRound } : {}),
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

function buildUpdatedPackReviewRun(
  existing: PackReviewRunRecord,
  fields: Partial<PackReviewRunRecord>,
  path: string,
  updatedAt: string,
): PackReviewRunRecord {
  const candidate: Record<string, unknown> = {
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
  };
  if (existing.reviewRound) {
    if (candidate.reviewRound === undefined || candidate.reviewRound === null) {
      throw new Error(`corrupt pack review run record at ${path}: frozen reviewRound cannot be removed`);
    }
    candidate.reviewRound = mergeFrozenGptRound(
      existing.reviewRound,
      normalizePackReviewGptRoundRecord(candidate.reviewRound, path),
      path,
    );
  } else if (candidate.reviewRound !== undefined && candidate.reviewRound !== null) {
    candidate.reviewRound = normalizePackReviewGptRoundRecord(candidate.reviewRound, path);
  }
  return parseRecord(candidate, path);
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
    const next = buildUpdatedPackReviewRun(existing, fields, path, updatedAt);
    writeRecordUnlocked(storeRoot, next);
    return next;
  });
}

export function updatePackReviewRunIf(
  runId: string,
  predicate: (records: readonly PackReviewRunRecord[]) => boolean,
  fields: Partial<PackReviewRunRecord> | ((existing: PackReviewRunRecord) => Partial<PackReviewRunRecord>),
  options: PackReviewStoreOptions = {},
): PackReviewRunRecord | null {
  const storeRoot = resolvePackReviewRunStoreRoot(options);
  return withStoreLock(storeRoot, () => {
    const records = readRecordsUnlocked(storeRoot);
    if (!predicate(records)) return null;
    const path = recordPath(storeRoot, runId);
    if (!existsSync(path)) throw new Error(`pack review run not found: ${runId}`);
    const existing = parseRecord(JSON.parse(readFileSync(path, 'utf8')), path);
    const updatedAt = (options.now ?? new Date()).toISOString();
    const nextFields = typeof fields === 'function' ? fields(existing) : fields;
    const next = buildUpdatedPackReviewRun(existing, nextFields, path, updatedAt);
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
