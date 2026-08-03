/**
 * Stage-completeness guard core.
 *
 * Legacy capture-directory validation remains read-compatible only for the
 * explicit historical allowlist. Fresh review episodes use source-preserving
 * stage receipts. Stage receipts are the only persisted authority; episode
 * state is recomputed for every guard invocation against an independently
 * supplied canonical receipt inventory and producer evidence.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseComplexityTierFence } from './tier-gate-core.ts';
import { resolveReviewArtifacts } from './tier-gate-floor.ts';
import {
  findLegacyReceiptPaths,
  resolveCanonicalReviewDirectory as resolveCanonicalReviewDirectoryShared,
} from './canonical-review-directory.ts';
export { findLegacyReceiptPaths } from './canonical-review-directory.ts';
import { isReviewLaneEvidence, isReviewLaneRouting, sameReviewLaneRouting } from './review-lane-record.ts';
import type { ReviewLaneEvidence } from './create-issue-stage-record-types.ts';
import { REVIEW_LANE_ROUTING_POLICY_VERSION, normalizeMaterialVerdict, type ReviewLaneRouting } from './review-lane-routing.ts';

export const GRANDFATHERED_REVIEW_DIR_BASENAMES = new Set([
  '206-ao-010-session-status-readers-migration',
]);

export const COMPETITIVE_WAIVER_FILENAME = 'competitive-stage-waiver.json';
export const ARCHITECT_LENS_WAIVER_FILENAME = 'architect-lens-stage-waiver.json';
export const STAGE_COMPLETENESS_RECEIPT_SCHEMA = 'stage-completeness-receipt/v1' as const;
export const REVIEWER_INVOCATION_ENVELOPE_SCHEMA = 'reviewer-invocation-envelope/v1' as const;
export const CLAUDE_PRODUCER_EVIDENCE_SCHEMA = 'claude-producer-evidence/v1' as const;
export const TRIPLE_SOURCE_POLICY_VERSION = 'triple-source/v1' as const;
export const SINGLE_SOURCE_POLICY_VERSION = 'single-source/v1' as const;
export const REVIEWER_CARDINALITY_CONTROL_ENV = 'OPK_GPT_REVIEWER_CARDINALITY';

const REVIEWER_SOURCE_POLICY_RE = /^([^#\s]+)#capture=(final-node\/v1|issue-comment-api-harvest\/v1|direct-publication\/v1)$/;
const BARE_REVIEWER_SOURCE_POLICY_RE = /^(?:final-node|issue-comment-api-harvest|direct-publication)\/v[0-9]+$/;
export function parseReviewerSourcePolicy(value: string): { independentSourceId: string; capturePolicy: 'final-node/v1' | 'issue-comment-api-harvest/v1' | 'direct-publication/v1' } | null {
  const match = REVIEWER_SOURCE_POLICY_RE.exec(value);
  return match
    ? { independentSourceId: match[1]!, capturePolicy: match[2]! as 'final-node/v1' | 'issue-comment-api-harvest/v1' | 'direct-publication/v1' }
    : null;
}

export type ReviewTier = 'T1' | 'T2' | 'T3';
export type ReviewStage = 'competitive' | 'architectural-review' | 'architectural-lens' | 'architectural';
export type ReviewerSlot = string;
export type StageOutcome = 'complete' | 'partial' | 'blocked' | 'incident';
export type RetryState = 'none' | 'eligible' | 'exhausted' | 'abandoned';
export type TerminalClassification =
  | 'complete'
  | 'quota'
  | 'composer-refusal'
  | 'fill-timeout'
  | 'post-send-failure'
  | 'output-conflict'
  | 'incident';
export type RetryClass = 'none' | 'eligible-zero-send' | 'retry' | 'retry-forbidden';

const COUNTED_STAGE_TOKENS = new Set<ReviewStage>([
  'competitive',
  'architectural-review',
  'architectural-lens',
  'architectural',
]);
const LEGACY_CAPTURE_FILENAME_RE =
  /^pass-(\d+)-(competitive|architectural-review|architectural-lens|architectural-final|architectural)\.capture\.txt$/i;
const SOURCE_CAPTURE_FILENAME_RE =
  /^pass-(\d+)-(competitive|architectural-review)-(\d{2})\.capture\.txt$/i;
const COUNTED_STAGE_FILENAME_TOKEN_RE =
  /competitive|architectural-review|architectural-lens|architectural-final|architectural/i;
const SHA256_RE = /^[a-f0-9]{64}$/;
const REVIEWER_SLOT_RE = /^\d{2}$/;
const MAX_REVIEWER_CARDINALITY = 99;
const PARSEABLE_WAIVER_REASONS = new Set(['codex-substitution', 'operator-waiver']);
const PARSEABLE_LENS_WAIVER_REASONS = new Set(['claude-unavailable']);
const CREDITED_LENS_UNAVAILABILITY_KINDS = new Set([
  'quota',
  'rate-limit',
  'provider-unavailable',
  'cli-unavailable',
]);
const ZERO_SEND_RETRYABLE = new Set<TerminalClassification>([
  'quota',
  'composer-refusal',
  'fill-timeout',
]);

export interface ParsedCapture {
  passIndex: number;
  stage: string;
  fileName: string;
  reviewerSlot: ReviewerSlot | null;
  sourceSuffixed: boolean;
}
export interface CaptureIdentityV1 {
  captureIdentity: string;
  name: string;
  byteLength: number;
  sha256: string;
  rawFindingCount: number;
}
export interface ReviewerInvocationEnvelopeV1 {
  schema: typeof REVIEWER_INVOCATION_ENVELOPE_SCHEMA;
  reviewEpisodeId: string;
  stageAttemptId: string;
  policyVersion: typeof TRIPLE_SOURCE_POLICY_VERSION | typeof SINGLE_SOURCE_POLICY_VERSION | typeof REVIEW_LANE_ROUTING_POLICY_VERSION;
  reviewerCardinality: number;
  cardinalityConfigIdentity: string;
  stage: Exclude<ReviewStage, 'architectural-lens'>;
  sourceRevision: string;
  invocationId: string;
  terminalResultIdentity: string;
  reviewerSource: string;
  reviewerSlot: ReviewerSlot;
  reviewerOrdinal: number;
  attemptOrdinal: 1 | 2;
  retryAttempt: boolean;
  terminal: boolean;
  terminalClassification: TerminalClassification;
  sendCount: number;
  retryClass: RetryClass;
  revisionCheck: 'matched';
  capacityOutcome: 'admitted' | 'rejected-after-local-wait';
  capacityWaitMs: number;
  capture?: CaptureIdentityV1;
  reviewLaneRouting?: ReviewLaneRouting;
}
export interface ClaudeCaptureBranchV1 {
  kind: 'capture';
  provider: 'claude-cli';
  invocationId: string;
  producingRunIdentity: string;
  terminalResultIdentity: string;
  producerEvidenceIdentity: string;
  terminal: true;
  terminalClassification: 'complete';
  exitCode: 0;
  capture: CaptureIdentityV1;
  m3Status: 'recorded';
}
export interface ClaudeWaiverBranchV1 {
  kind: 'waiver';
  waiver: {
    reason: 'claude-unavailable';
    unavailability: 'quota' | 'rate-limit' | 'provider-unavailable' | 'cli-unavailable';
    evidenceIdentity: string;
  };
}
export interface ClaudeProducerEvidenceV1 {
  schema: typeof CLAUDE_PRODUCER_EVIDENCE_SCHEMA;
  evidenceIdentity: string;
  reviewEpisodeId: string;
  stageAttemptId: string;
  sourceRevision: string;
  invocationId: string;
  producingRunIdentity: string;
  terminalResultIdentity: string;
  terminal: true;
  terminalClassification: 'complete';
  exitCode: 0;
  capture: CaptureIdentityV1;
  m3Status: 'recorded';
}
export interface StageReceiptInventoryAuthorityV1 {
  source: 'canonical-review-directory';
  taskIdentity: string;
  episodeFirstRevision: string;
  reviewEpisodeId: string;
  stageReceiptIds: string[];
}
export interface StageCompletenessReceiptV1 {
  schema: typeof STAGE_COMPLETENESS_RECEIPT_SCHEMA;
  tier: ReviewTier;
  taskIdentity: string;
  episodeFirstRevision: string;
  reviewEpisodeId: string;
  stageReceiptId: string;
  previousStageReceiptId: string | null;
  receiptCensus: string[];
  stageAttemptId: string;
  stageSequence: number;
  stage: ReviewStage;
  policyVersion: typeof TRIPLE_SOURCE_POLICY_VERSION | typeof SINGLE_SOURCE_POLICY_VERSION | typeof REVIEW_LANE_ROUTING_POLICY_VERSION;
  reviewerCardinality: number;
  cardinalityConfigIdentity: string;
  sourceRevision: string;
  outcome: StageOutcome;
  revisionChecks: { attemptCreation: 'matched'; beforeLaunch: 'matched'; settlement: 'matched' };
  settlement: { allLaunchedTerminal: boolean; retryState: RetryState; finalRevisionMatched: boolean };
  invocations?: ReviewerInvocationEnvelopeV1[];
  claude?: ClaudeCaptureBranchV1 | ClaudeWaiverBranchV1;
  credentialingCaptures: CaptureIdentityV1[];
  relayEligibleCaptures: CaptureIdentityV1[];
  reviewLane?: ReviewLaneEvidence;
}
export interface VerifiedRelayPartV1 {
  part: number;
  of: number;
  sourceLabel: string;
  embeddedByteLength: number;
  embeddedSha256: string;
  verified: true;
}
export interface VerifiedRelayEvidenceV1 {
  relayAttemptId: string;
  captureIdentity: string;
  sourceLabel: string;
  name: string;
  byteLength: number;
  sha256: string;
  verified: boolean;
  supersedes?: string;
  parts?: VerifiedRelayPartV1[];
}
export interface TierIntakeAuthorityV1 {
  schema: 'tier-intake/v1';
  producer: string;
  taskIdentity: string;
  kind: 'fresh' | 'compatibility';
  priorTier: ReviewTier;
  firstRevision: string;
}
export interface ReviewEpisodeDerivationAuthorityV1 {
  tierIntake: TierIntakeAuthorityV1;
  receiptInventory: StageReceiptInventoryAuthorityV1;
  claudeProducerEvidence?: readonly unknown[];
}

export interface CanonicalReviewDirectoryV1 {
  stateRoot: string;
  issueNumber: string;
  directory: string;
  intakePath: string;
}

export function resolveCanonicalReviewDirectory(
  intake: Pick<TierIntakeAuthorityV1, 'taskIdentity'>,
  stateRootOverride?: string,
): CanonicalReviewDirectoryV1 {
  return resolveCanonicalReviewDirectoryShared(intake, stateRootOverride);
}
export interface ReviewEpisodeStateV1 {
  reviewEpisodeId: string | null;
  taskIdentity: string | null;
  episodeFirstRevision: string | null;
  tier: ReviewTier | null;
  receipts: StageCompletenessReceiptV1[];
  receiptsByStage: Record<ReviewStage, StageCompletenessReceiptV1[]>;
  credentialingReceiptsByStage: Partial<Record<ReviewStage, StageCompletenessReceiptV1>>;
  credentialingCapturesByStage: Record<ReviewStage, CaptureIdentityV1[]>;
  governedCaptures: CaptureIdentityV1[];
  relayedCaptures: CaptureIdentityV1[];
  governedCaptureUnion: string[];
  relayedCaptureUnion: string[];
  rawFindingCountByStage: Record<ReviewStage, number>;
  rawFindingCount: number;
  logicalRoundIds: string[];
  relayComplete: boolean;
  activationReady: boolean;
  errors: string[];
}
export interface CompetitiveWaiver { reason: string; recordedAt: string; afterPass: number; }
export interface ArchitectLensWaiver { reason: string; recordedAt: string; afterPass: number; unavailability: string; }
export interface StageCompletenessGuardOptions {
  repoRoot?: string;
  draftPath?: string;
  stageReceipts?: unknown[];
  verifiedRelayEvidence?: unknown[];
  episodeAuthority?: ReviewEpisodeDerivationAuthorityV1;
  phase?: 'pre-lens' | 'final-acceptance';
}
export type LegacyStageCompletenessReceipt = {
  tier: string;
  competitiveAnchor: number;
  architecturalReviewPass: number;
  lensMax: number | null;
  lensSkipAnchor: number | null;
  terminalPass: number;
};
export type ReceiptBackedStageCompletenessReceipt = {
  tier: ReviewTier;
  reviewEpisodeId: string;
  policyVersion: typeof TRIPLE_SOURCE_POLICY_VERSION | typeof SINGLE_SOURCE_POLICY_VERSION | typeof REVIEW_LANE_ROUTING_POLICY_VERSION;
  logicalRoundIds: string[];
  governedCaptureUnion: string[];
  relayedCaptureUnion: string[];
  rawFindingCount: number;
  activationReady: boolean;
};
export interface StageCompletenessGuardResult {
  ok: boolean;
  errors: string[];
  noop: boolean;
  receipt: LegacyStageCompletenessReceipt | ReceiptBackedStageCompletenessReceipt | null;
  episodeState?: ReviewEpisodeStateV1;
}
export interface ActiveAcceptanceSegment { boundaryPass: number; captures: ParsedCapture[]; }

const ISO_8601_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
function isStrictIso8601Timestamp(value: string): boolean { return ISO_8601_TIMESTAMP_RE.test(value) && Number.isFinite(Date.parse(value)); }
function parseAfterPassAnchor(value: unknown): number | null {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null;
  return value;
}
function nonEmpty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
export function deriveReviewEpisodeId(taskIdentity: string, episodeFirstRevision: string): string {
  return `${taskIdentity}@${episodeFirstRevision}`;
}
export function deriveStageReceiptId(reviewEpisodeId: string, stageSequence: number): string {
  return `${reviewEpisodeId}:stage-receipt:${String(stageSequence).padStart(4, '0')}`;
}
function canonicalEpisodeId(taskIdentity: string, episodeFirstRevision: string): string {
  return deriveReviewEpisodeId(taskIdentity, episodeFirstRevision);
}
function canonicalStageReceiptId(reviewEpisodeId: string, stageSequence: number): string {
  return deriveStageReceiptId(reviewEpisodeId, stageSequence);
}
function canonicalSourceLabel(capture: CaptureIdentityV1): string { return `${capture.name}|${capture.captureIdentity}`; }
function validCardinality(value: unknown): value is number { return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= MAX_REVIEWER_CARDINALITY; }
function slotForOrdinal(ordinal: number): ReviewerSlot { return String(ordinal).padStart(2, '0'); }
function expectedSlots(cardinality: number): ReviewerSlot[] { return Array.from({ length: cardinality }, (_, index) => slotForOrdinal(index + 1)); }

export function parseReviewerCardinalityControl(raw: string | undefined): Record<ReviewTier, number> {
  const defaults: Record<ReviewTier, number> = { T1: 1, T2: 1, T3: 3 };
  if (!raw?.trim()) return defaults;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    const cardinality = Number(trimmed);
    if (!validCardinality(cardinality)) throw new Error(`${REVIEWER_CARDINALITY_CONTROL_ENV} must be 1..99`);
    return { ...defaults, T3: cardinality };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(trimmed) as unknown; }
  catch { throw new Error(`${REVIEWER_CARDINALITY_CONTROL_ENV} must be an integer or JSON tier map`); }
  if (!isRecord(parsed)) throw new Error(`${REVIEWER_CARDINALITY_CONTROL_ENV} JSON must be an object`);
  const result = { ...defaults };
  for (const tier of ['T1', 'T2', 'T3'] as const) {
    const value = parsed[tier];
    if (value === undefined) continue;
    if (!validCardinality(value)) throw new Error(`${REVIEWER_CARDINALITY_CONTROL_ENV}.${tier} must be 1..99`);
    result[tier] = Number(value);
  }
  if (result.T1 !== 1 || result.T2 !== 1) throw new Error(`${REVIEWER_CARDINALITY_CONTROL_ENV} must keep T1 and T2 singular`);
  return result;
}
function sameCapture(left: CaptureIdentityV1, right: CaptureIdentityV1): boolean {
  return left.captureIdentity === right.captureIdentity
    && left.name === right.name
    && left.byteLength === right.byteLength
    && left.sha256 === right.sha256
    && left.rawFindingCount === right.rawFindingCount;
}
function captureSet(captures: readonly CaptureIdentityV1[]): Map<string, CaptureIdentityV1> { return new Map(captures.map((capture) => [capture.captureIdentity, capture])); }
function exactIdentitySet(left: readonly CaptureIdentityV1[], right: readonly CaptureIdentityV1[]): boolean {
  const a = captureSet(left); const b = captureSet(right);
  if (a.size !== b.size) return false;
  for (const [identity, capture] of a) { const other = b.get(identity); if (!other || !sameCapture(capture, other)) return false; }
  return true;
}
function validateCaptureIdentity(value: unknown, label: string, errors: string[]): CaptureIdentityV1 | null {
  if (!isRecord(value)) { errors.push(`${label} must be an object`); return null; }
  const captureIdentity = nonEmpty(value.captureIdentity) ? value.captureIdentity.trim() : '';
  const name = nonEmpty(value.name) ? value.name.trim() : '';
  const byteLength = value.byteLength;
  const sha256 = nonEmpty(value.sha256) ? value.sha256.trim().toLowerCase() : '';
  const rawFindingCount = value.rawFindingCount;
  if (!captureIdentity) errors.push(`${label} missing captureIdentity`);
  if (!name) errors.push(`${label} missing name`);
  if (!Number.isInteger(byteLength) || Number(byteLength) <= 0) errors.push(`${label} byteLength must be a positive integer`);
  if (!SHA256_RE.test(sha256)) errors.push(`${label} sha256 must be lowercase hex SHA-256`);
  if (!Number.isInteger(rawFindingCount) || Number(rawFindingCount) < 0) errors.push(`${label} rawFindingCount must be a non-negative integer`);
  if (!captureIdentity || !name || !Number.isInteger(byteLength) || Number(byteLength) <= 0 || !SHA256_RE.test(sha256) || !Number.isInteger(rawFindingCount) || Number(rawFindingCount) < 0) return null;
  return { captureIdentity, name, byteLength: Number(byteLength), sha256, rawFindingCount: Number(rawFindingCount) };
}
function validateCaptureArray(value: unknown, label: string, errors: string[]): CaptureIdentityV1[] {
  if (!Array.isArray(value)) { errors.push(`${label} must be an array`); return []; }
  const captures = value.map((item, index) => validateCaptureIdentity(item, `${label}[${index}]`, errors)).filter((item): item is CaptureIdentityV1 => Boolean(item));
  const identities = new Set<string>(); const names = new Set<string>();
  for (const capture of captures) {
    if (identities.has(capture.captureIdentity)) errors.push(`${label} repeats capture identity ${capture.captureIdentity}`);
    identities.add(capture.captureIdentity);
    if (names.has(capture.name)) errors.push(`${label} repeats capture name ${capture.name}`);
    names.add(capture.name);
  }
  return captures;
}
function sourceCapturePass(capture: CaptureIdentityV1): number | null {
  const match = SOURCE_CAPTURE_FILENAME_RE.exec(capture.name);
  if (!match?.[1]) return null;
  const pass = Number.parseInt(match[1], 10);
  return Number.isInteger(pass) && pass >= 0 ? pass : null;
}
function expectedCaptureName(stage: ReviewStage, capture: CaptureIdentityV1, slot?: ReviewerSlot): boolean {
  if (stage === 'competitive' || stage === 'architectural-review') {
    const match = SOURCE_CAPTURE_FILENAME_RE.exec(capture.name);
    return Boolean(match && match[2]?.toLowerCase() === stage && match[3] === slot);
  }
  if (stage === 'architectural-lens') return /^pass-\d+-architectural-lens\.capture\.txt$/i.test(capture.name);
  return /^pass-\d+-architectural\.capture\.txt$/i.test(capture.name);
}
function parseInvocation(
  value: unknown,
  receipt: Pick<StageCompletenessReceiptV1, 'reviewEpisodeId' | 'stageAttemptId' | 'policyVersion' | 'reviewerCardinality' | 'cardinalityConfigIdentity' | 'stage' | 'sourceRevision' | 'reviewLane'>,
  index: number,
  errors: string[],
): ReviewerInvocationEnvelopeV1 | null {
  const label = `stage ${receipt.stage} invocation[${index}]`;
  if (!isRecord(value)) { errors.push(`${label} must be an object`); return null; }
  const stage = value.stage;
  const invocationId = nonEmpty(value.invocationId) ? value.invocationId.trim() : '';
  const terminalResultIdentity = nonEmpty(value.terminalResultIdentity) ? value.terminalResultIdentity.trim() : '';
  const reviewerSource = nonEmpty(value.reviewerSource) ? value.reviewerSource.trim() : '';
  if (
    (reviewerSource.includes('#capture=') && !parseReviewerSourcePolicy(reviewerSource))
    || BARE_REVIEWER_SOURCE_POLICY_RE.test(reviewerSource)
  ) {
    errors.push(`${label} reviewerSource has an unknown or malformed capture policy`);
  }
  const slot = nonEmpty(value.reviewerSlot) ? value.reviewerSlot.trim() : '';
  const attemptOrdinal = value.attemptOrdinal;
  const reviewerOrdinal = value.reviewerOrdinal;
  const terminalClassification = value.terminalClassification;
  const retryClass = value.retryClass;
  const sendCount = value.sendCount;
  if (value.schema !== REVIEWER_INVOCATION_ENVELOPE_SCHEMA) errors.push(`${label} has unknown schema`);
  if (!invocationId) errors.push(`${label} missing invocationId`);
  if (!terminalResultIdentity) errors.push(`${label} missing terminalResultIdentity`);
  if (!reviewerSource) errors.push(`${label} missing reviewerSource`);
  if (value.reviewEpisodeId !== receipt.reviewEpisodeId) errors.push(`${label} reviewEpisodeId mismatch`);
  if (value.stageAttemptId !== receipt.stageAttemptId) errors.push(`${label} stageAttemptId mismatch`);
  if (value.policyVersion !== receipt.policyVersion) errors.push(`${label} policyVersion mismatch`);
  if (value.reviewerCardinality !== receipt.reviewerCardinality) errors.push(`${label} reviewerCardinality mismatch`);
  if (value.cardinalityConfigIdentity !== receipt.cardinalityConfigIdentity) errors.push(`${label} cardinalityConfigIdentity mismatch`);
  if (stage !== receipt.stage) errors.push(`${label} stage mismatch`);
  if (value.sourceRevision !== receipt.sourceRevision) errors.push(`${label} sourceRevision mismatch`);
  if (receipt.reviewLane !== undefined) {
    if (!isReviewLaneRouting(value.reviewLaneRouting)) errors.push(`${label} is missing immutable reviewLaneRouting evidence`);
    else if (!sameReviewLaneRouting(receipt.reviewLane.routing, value.reviewLaneRouting)) errors.push(`${label} reviewLaneRouting disagrees with the full stage evidence`);
  } else if (value.reviewLaneRouting !== undefined) {
    errors.push(`${label} carries reviewLaneRouting without a routed stage attempt`);
  }
  if (!REVIEWER_SLOT_RE.test(slot) || !expectedSlots(receipt.reviewerCardinality).includes(slot)) errors.push(`${label} reviewerSlot must be within configured 01..${slotForOrdinal(receipt.reviewerCardinality)}`);
  if (attemptOrdinal !== 1 && attemptOrdinal !== 2) errors.push(`${label} attemptOrdinal must be 1 or 2`);
  if (value.retryAttempt !== true && value.retryAttempt !== false) errors.push(`${label} retryAttempt must be boolean`);
  if (attemptOrdinal === 1 && value.retryAttempt !== false) errors.push(`${label} first invocation cannot be marked retryAttempt`);
  if (attemptOrdinal === 2 && value.retryAttempt !== true) errors.push(`${label} second invocation must be marked retryAttempt`);
  if (!Number.isInteger(reviewerOrdinal) || Number(reviewerOrdinal) < 1) errors.push(`${label} reviewerOrdinal must be positive`);
  if (REVIEWER_SLOT_RE.test(slot) && Number(slot) !== Number(reviewerOrdinal)) errors.push(`${label} reviewerOrdinal must match reviewerSlot`);
  if (value.terminal !== true && value.terminal !== false) errors.push(`${label} terminal must be boolean`);
  if (!['complete', 'quota', 'composer-refusal', 'fill-timeout', 'post-send-failure', 'output-conflict', 'incident'].includes(String(terminalClassification))) errors.push(`${label} has unknown terminalClassification`);
  if (!['none', 'eligible-zero-send', 'retry', 'retry-forbidden'].includes(String(retryClass))) errors.push(`${label} has unknown retryClass`);
  if (!Number.isInteger(sendCount) || Number(sendCount) < 0 || Number(sendCount) > 1) errors.push(`${label} sendCount must be 0 or 1`);
  if (value.revisionCheck !== 'matched') errors.push(`${label} launch revisionCheck must be matched`);
  if (value.capacityOutcome !== 'admitted' && value.capacityOutcome !== 'rejected-after-local-wait') errors.push(`${label} has unknown capacityOutcome`);
  if (!Number.isInteger(value.capacityWaitMs) || Number(value.capacityWaitMs) < 0) errors.push(`${label} capacityWaitMs must be a non-negative integer`);
  if (terminalClassification === 'complete' && value.capacityOutcome !== 'admitted') errors.push(`${label} complete invocation must have been admitted`);
  const capture = value.capture === undefined ? undefined : validateCaptureIdentity(value.capture, `${label}.capture`, errors) ?? undefined;
  if (terminalClassification === 'complete' && !capture) errors.push(`${label} complete result requires capture`);
  if (terminalClassification === 'complete' && Number(sendCount) !== 1) errors.push(`${label} complete result requires sendCount 1`);
  if (terminalClassification !== 'complete' && capture) errors.push(`${label} non-complete result cannot credential a capture`);
  if (Number(sendCount) === 1 && terminalClassification !== 'complete' && retryClass !== 'retry-forbidden') errors.push(`${label} possible/post-send failure must forbid blind resend`);
  if (Number(sendCount) === 0 && ZERO_SEND_RETRYABLE.has(terminalClassification as TerminalClassification) && attemptOrdinal === 1 && retryClass !== 'eligible-zero-send') errors.push(`${label} proven zero-send quota/composer failure must be classified retry-eligible`);
  if (attemptOrdinal === 2 && retryClass === 'eligible-zero-send') errors.push(`${label} the one retry cannot create another retry opportunity`);
  if (capture && !expectedCaptureName(receipt.stage, capture, slot)) errors.push(`${label} capture filename does not match stage/slot`);
  if (errors.some((error) => error.startsWith(label))) return null;
  return {
    schema: REVIEWER_INVOCATION_ENVELOPE_SCHEMA,
    reviewEpisodeId: receipt.reviewEpisodeId,
    stageAttemptId: receipt.stageAttemptId,
    policyVersion: receipt.policyVersion,
    reviewerCardinality: receipt.reviewerCardinality,
    cardinalityConfigIdentity: receipt.cardinalityConfigIdentity,
    stage: receipt.stage as Exclude<ReviewStage, 'architectural-lens'>,
    sourceRevision: receipt.sourceRevision,
    invocationId,
    terminalResultIdentity,
    reviewerSource,
    reviewerSlot: slot,
    reviewerOrdinal: Number(reviewerOrdinal),
    attemptOrdinal: attemptOrdinal as 1 | 2,
    retryAttempt: Boolean(value.retryAttempt),
    terminal: Boolean(value.terminal),
    terminalClassification: terminalClassification as TerminalClassification,
    sendCount: Number(sendCount),
    retryClass: retryClass as RetryClass,
    revisionCheck: 'matched',
    capacityOutcome: value.capacityOutcome as 'admitted' | 'rejected-after-local-wait',
    capacityWaitMs: Number(value.capacityWaitMs),
    capture,
    ...(receipt.reviewLane ? { reviewLaneRouting: receipt.reviewLane.routing } : {}),
  };
}
function validateBrowserReceipt(receipt: StageCompletenessReceiptV1, errors: string[]): void {
  const requiredSlots = receipt.reviewLane?.finalRequiredSlots ?? expectedSlots(receipt.reviewerCardinality);
  if (!Array.isArray(receipt.invocations)) { errors.push(`stage ${receipt.stage} requires invocation envelopes`); return; }
  const invocations = receipt.invocations.map((value, index) => parseInvocation(value, receipt, index, errors)).filter((value): value is ReviewerInvocationEnvelopeV1 => Boolean(value));
  const bySlot = new Map<ReviewerSlot, ReviewerInvocationEnvelopeV1[]>();
  const invocationIds = new Set<string>(); const terminalResultIds = new Set<string>();
  for (const invocation of invocations) {
    if (invocationIds.has(invocation.invocationId)) errors.push(`stage ${receipt.stage} repeats invocationId ${invocation.invocationId}`);
    invocationIds.add(invocation.invocationId);
    if (terminalResultIds.has(invocation.terminalResultIdentity)) errors.push(`stage ${receipt.stage} repeats terminalResultIdentity ${invocation.terminalResultIdentity}`);
    terminalResultIds.add(invocation.terminalResultIdentity);
    const list = bySlot.get(invocation.reviewerSlot) ?? []; list.push(invocation); bySlot.set(invocation.reviewerSlot, list);
  }
  for (const slot of bySlot.keys()) if (!requiredSlots.includes(slot)) errors.push(`stage ${receipt.stage} has unexpected reviewer slot ${slot}`);
  const finalCaptures: CaptureIdentityV1[] = []; let hasEligibleRetry = false; let allFinalComplete = true;
  for (const slot of requiredSlots) {
    const attempts = [...(bySlot.get(slot) ?? [])].sort((a, b) => a.attemptOrdinal - b.attemptOrdinal);
    if (attempts.length === 0) { errors.push(`stage ${receipt.stage} missing reviewer slot ${slot}`); allFinalComplete = false; continue; }
    if (attempts.length > 2) errors.push(`stage ${receipt.stage} slot ${slot} exceeds one retry`);
    if (attempts[0]?.attemptOrdinal !== 1) errors.push(`stage ${receipt.stage} slot ${slot} must begin at attemptOrdinal 1`);
    if (receipt.reviewLane) {
      const evidence = receipt.reviewLane.sourceVerdictEvidence[slot];
      const finalCapture = attempts.at(-1)?.capture;
      const evidenceVerdict = evidence ? normalizeMaterialVerdict(evidence) : 'unparseable';
      if (evidenceVerdict === 'accept' || evidenceVerdict === 'material-findings') {
        if (!finalCapture || evidence?.captureIdentity !== finalCapture.captureIdentity) {
          errors.push(`stage ${receipt.stage} reviewLane producer evidence does not match capture for slot ${slot}`);
        }
        if (evidence?.rawFindingCount !== finalCapture?.rawFindingCount) {
          errors.push(`stage ${receipt.stage} reviewLane producer evidence finding count does not match capture for slot ${slot}`);
        }
      }
    }
    if (attempts.length === 2) {
      const first = attempts[0]!; const retry = attempts[1]!;
      if (retry.attemptOrdinal !== 2 || !retry.retryAttempt) errors.push(`stage ${receipt.stage} slot ${slot} retry envelope is malformed`);
      if (first.sendCount !== 0 || first.retryClass !== 'eligible-zero-send' || !ZERO_SEND_RETRYABLE.has(first.terminalClassification)) errors.push(`stage ${receipt.stage} slot ${slot} retry requires a proven retryable zero-send first result`);
      if (retry.reviewerSource !== first.reviewerSource) errors.push(`stage ${receipt.stage} slot ${slot} retry must preserve reviewerSource identity`);
      if (retry.retryClass === 'eligible-zero-send') errors.push(`stage ${receipt.stage} slot ${slot} retry cannot remain retry-eligible`);
    }
    const final = attempts.at(-1)!;
    if (!final.terminal) errors.push(`stage ${receipt.stage} slot ${slot} has no terminal helper result`);
    if (attempts.length === 1 && final.retryClass === 'eligible-zero-send') hasEligibleRetry = true;
    if (final.terminalClassification !== 'complete' || !final.capture) allFinalComplete = false;
    else finalCaptures.push(final.capture);
  }
  const finalSources = requiredSlots.map((slot) => [...(bySlot.get(slot) ?? [])].sort((a, b) => a.attemptOrdinal - b.attemptOrdinal).at(-1)?.reviewerSource).filter((source): source is string => Boolean(source));
  if (new Set(finalSources).size !== finalSources.length) errors.push(`stage ${receipt.stage} reviewer sources must be independent across slots`);
  const retryWasUsed = [...bySlot.values()].some((attempts) => attempts.length === 2);
  if (receipt.settlement.retryState === 'eligible' || (hasEligibleRetry && receipt.settlement.retryState !== 'abandoned')) errors.push(`stage ${receipt.stage} remains unsettled while a zero-send retry is eligible`);
  if (retryWasUsed && receipt.settlement.retryState !== 'exhausted') errors.push(`stage ${receipt.stage} used its retry but settlement.retryState is not exhausted`);
  if (!retryWasUsed && !hasEligibleRetry && receipt.settlement.retryState !== 'none') errors.push(`stage ${receipt.stage} has retry settlement without a retry event`);
  if (invocations.some((invocation) => !invocation.terminal)) errors.push(`stage ${receipt.stage} settlement contains a launched invocation without terminal result`);
  if (!receipt.settlement.allLaunchedTerminal) errors.push(`stage ${receipt.stage} settlement requires every launched invocation terminal`);
  if (!receipt.settlement.finalRevisionMatched) errors.push(`stage ${receipt.stage} settlement revision mismatch`);
  const allInvocationCaptures = invocations.flatMap((invocation) => invocation.capture ? [invocation.capture] : []);
  if (receipt.reviewLane) {
    const evidenceSlots = Object.keys(receipt.reviewLane.sourceVerdicts).sort();
    const requiredEvidenceSlots = [...requiredSlots].sort();
    if (evidenceSlots.length !== requiredEvidenceSlots.length || evidenceSlots.some((slot, index) => slot !== requiredEvidenceSlots[index])) {
      errors.push(`stage ${receipt.stage} reviewLane source verdicts do not match final required slots`);
    }
  }
  if (receipt.policyVersion === TRIPLE_SOURCE_POLICY_VERSION) {
    const passNumbers = new Set(allInvocationCaptures.map(sourceCapturePass).filter((pass): pass is number => pass !== null));
    if (allInvocationCaptures.length > 0 && passNumbers.size !== 1) errors.push(`stage ${receipt.stage} sibling captures must share one pass-NN prefix`);
  }
  if (!exactIdentitySet(allInvocationCaptures, receipt.relayEligibleCaptures)) errors.push(`stage ${receipt.stage} relayEligibleCaptures do not equal invocation capture evidence`);
  if (receipt.outcome === 'complete') {
    if (!allFinalComplete) errors.push(`stage ${receipt.stage} complete outcome requires every required slot complete`);
    if (receipt.settlement.retryState !== 'none' && receipt.settlement.retryState !== 'exhausted') errors.push(`stage ${receipt.stage} complete outcome has invalid retry settlement`);
    if (!exactIdentitySet(finalCaptures, receipt.credentialingCaptures)) errors.push(`stage ${receipt.stage} credentialingCaptures do not equal final successful slot captures`);
  } else {
    if (allFinalComplete) errors.push(`stage ${receipt.stage} has a non-complete outcome despite complete required slots`);
    if (receipt.credentialingCaptures.length > 0) errors.push(`stage ${receipt.stage} non-complete outcome cannot credential the stage`);
  }
}
function parseClaudeProducerEvidence(input: readonly unknown[], errors: string[]): Map<string, ClaudeProducerEvidenceV1> {
  const result = new Map<string, ClaudeProducerEvidenceV1>();
  for (let index = 0; index < input.length; index += 1) {
    const value = input[index]; const label = `Claude producer evidence[${index}]`;
    if (!isRecord(value)) { errors.push(`${label} must be an object`); continue; }
    const capture = validateCaptureIdentity(value.capture, `${label}.capture`, errors);
    const evidenceIdentity = nonEmpty(value.evidenceIdentity) ? value.evidenceIdentity.trim() : '';
    if (value.schema !== CLAUDE_PRODUCER_EVIDENCE_SCHEMA || !evidenceIdentity || !nonEmpty(value.reviewEpisodeId) || !nonEmpty(value.stageAttemptId) || !nonEmpty(value.sourceRevision) || !nonEmpty(value.invocationId) || !nonEmpty(value.producingRunIdentity) || !nonEmpty(value.terminalResultIdentity) || value.terminal !== true || value.terminalClassification !== 'complete' || value.exitCode !== 0 || value.m3Status !== 'recorded' || !capture) {
      errors.push(`${label} is not immutable terminal Claude CLI evidence`); continue;
    }
    if (result.has(evidenceIdentity)) { errors.push(`duplicate Claude producer evidence identity ${evidenceIdentity}`); continue; }
    result.set(evidenceIdentity, {
      schema: CLAUDE_PRODUCER_EVIDENCE_SCHEMA,
      evidenceIdentity,
      reviewEpisodeId: String(value.reviewEpisodeId).trim(),
      stageAttemptId: String(value.stageAttemptId).trim(),
      sourceRevision: String(value.sourceRevision).trim(),
      invocationId: String(value.invocationId).trim(),
      producingRunIdentity: String(value.producingRunIdentity).trim(),
      terminalResultIdentity: String(value.terminalResultIdentity).trim(),
      terminal: true,
      terminalClassification: 'complete',
      exitCode: 0,
      capture,
      m3Status: 'recorded',
    });
  }
  return result;
}
function validateClaudeReceipt(receipt: StageCompletenessReceiptV1, producerEvidence: Map<string, ClaudeProducerEvidenceV1>, errors: string[]): void {
  if (receipt.policyVersion !== SINGLE_SOURCE_POLICY_VERSION) errors.push('architectural-lens must use single-source/v1');
  if (receipt.policyVersion === REVIEW_LANE_ROUTING_POLICY_VERSION) errors.push('architectural-lens cannot use review-lane-routing/v1');
  if (receipt.reviewerCardinality !== 1) errors.push('architectural-lens must remain singular');
  if (receipt.invocations && receipt.invocations.length > 0) errors.push('architectural-lens cannot contain Browser-GPT invocation envelopes');
  if (!receipt.claude) { errors.push('architectural-lens requires a capture or claude-unavailable waiver branch'); return; }
  if (receipt.claude.kind === 'capture') {
    const branch = receipt.claude;
    const capture = validateCaptureIdentity(branch.capture, 'architectural-lens capture', errors);
    if (!capture || !expectedCaptureName('architectural-lens', capture)) errors.push('architectural-lens capture filename mismatch');
    if (branch.provider !== 'claude-cli' || !nonEmpty(branch.invocationId) || !nonEmpty(branch.producingRunIdentity) || !nonEmpty(branch.terminalResultIdentity) || !nonEmpty(branch.producerEvidenceIdentity) || branch.terminal !== true || branch.terminalClassification !== 'complete' || branch.exitCode !== 0 || branch.m3Status !== 'recorded') errors.push('architectural-lens capture branch requires immutable producing-run, invocation, terminal CLI result, and M3 evidence');
    const evidence = producerEvidence.get(branch.producerEvidenceIdentity);
    if (!evidence) errors.push(`architectural-lens producer evidence ${branch.producerEvidenceIdentity || '<missing>'} is not independently supplied`);
    else if (evidence.reviewEpisodeId !== receipt.reviewEpisodeId || evidence.stageAttemptId !== receipt.stageAttemptId || evidence.sourceRevision !== receipt.sourceRevision || evidence.invocationId !== branch.invocationId || evidence.producingRunIdentity !== branch.producingRunIdentity || evidence.terminalResultIdentity !== branch.terminalResultIdentity || !capture || !sameCapture(evidence.capture, capture)) errors.push('architectural-lens receipt does not match independently supplied Claude producer evidence');
    if (capture && !exactIdentitySet([capture], receipt.relayEligibleCaptures)) errors.push('architectural-lens relayEligibleCaptures must contain exactly the Claude capture');
    if (receipt.outcome === 'complete' && capture && !exactIdentitySet([capture], receipt.credentialingCaptures)) errors.push('architectural-lens credentialingCaptures must contain exactly the Claude capture');
  } else if (receipt.claude.kind === 'waiver') {
    const waiver = receipt.claude.waiver;
    if (waiver.reason !== 'claude-unavailable' || !CREDITED_LENS_UNAVAILABILITY_KINDS.has(waiver.unavailability) || !nonEmpty(waiver.evidenceIdentity)) errors.push('architectural-lens waiver branch is invalid');
    if (receipt.relayEligibleCaptures.length !== 0 || receipt.credentialingCaptures.length !== 0) errors.push('claude-unavailable waiver must contribute no capture');
  } else errors.push('architectural-lens has unknown Claude branch');
  if (!receipt.settlement.allLaunchedTerminal || !receipt.settlement.finalRevisionMatched) errors.push('architectural-lens settlement is incomplete');
  if (receipt.settlement.retryState === 'eligible') errors.push('architectural-lens cannot remain retry-eligible');
}
function parseStageReceipt(value: unknown, index: number, errors: string[]): StageCompletenessReceiptV1 | null {
  const label = `stage receipt[${index}]`;
  if (!isRecord(value)) { errors.push(`${label} must be an object`); return null; }
  if (value.schema !== STAGE_COMPLETENESS_RECEIPT_SCHEMA) errors.push(`${label} has unknown schema`);
  const tier = value.tier; const stage = value.stage; const policyVersion = value.policyVersion; const outcome = value.outcome;
  const taskIdentity = nonEmpty(value.taskIdentity) ? value.taskIdentity.trim() : '';
  const episodeFirstRevision = nonEmpty(value.episodeFirstRevision) ? value.episodeFirstRevision.trim() : '';
  const reviewEpisodeId = nonEmpty(value.reviewEpisodeId) ? value.reviewEpisodeId.trim() : '';
  const stageReceiptId = nonEmpty(value.stageReceiptId) ? value.stageReceiptId.trim() : '';
  const previousStageReceiptId = value.previousStageReceiptId === null ? null : nonEmpty(value.previousStageReceiptId) ? value.previousStageReceiptId.trim() : '';
  const reviewerCardinality = value.reviewerCardinality;
  const cardinalityConfigIdentity = nonEmpty(value.cardinalityConfigIdentity) ? value.cardinalityConfigIdentity.trim() : '';
  const reviewLane = value.reviewLane;
  const routedPolicy = policyVersion === REVIEW_LANE_ROUTING_POLICY_VERSION;
  if (reviewLane !== undefined && !isReviewLaneEvidence(reviewLane)) errors.push(`${label} reviewLane must be complete immutable evidence`);
  if (!routedPolicy && reviewLane !== undefined) errors.push(`${label} legacy policy cannot carry routed reviewLane evidence`);
  if (routedPolicy && !isReviewLaneEvidence(reviewLane)) errors.push(`${label} review-lane-routing/v1 requires full reviewLane evidence`);
  if (tier !== 'T1' && tier !== 'T2' && tier !== 'T3') errors.push(`${label} has unknown tier`);
  if (!COUNTED_STAGE_TOKENS.has(stage as ReviewStage)) errors.push(`${label} has unknown stage`);
  if (policyVersion !== TRIPLE_SOURCE_POLICY_VERSION && policyVersion !== SINGLE_SOURCE_POLICY_VERSION && policyVersion !== REVIEW_LANE_ROUTING_POLICY_VERSION) errors.push(`${label} has unknown policyVersion`);
  if (!validCardinality(reviewerCardinality)) errors.push(`${label} reviewerCardinality must be 1..99`);
  if (!cardinalityConfigIdentity) errors.push(`${label} missing cardinalityConfigIdentity`);
  if (!['complete', 'partial', 'blocked', 'incident'].includes(String(outcome))) errors.push(`${label} has unknown outcome`);
  if (!taskIdentity) errors.push(`${label} missing taskIdentity`);
  if (!episodeFirstRevision) errors.push(`${label} missing episodeFirstRevision`);
  if (!reviewEpisodeId) errors.push(`${label} missing reviewEpisodeId`);
  if (!stageReceiptId) errors.push(`${label} missing stageReceiptId`);
  if (previousStageReceiptId === '') errors.push(`${label} previousStageReceiptId must be null or non-empty`);
  if (!nonEmpty(value.stageAttemptId)) errors.push(`${label} missing stageAttemptId`);
  if (!nonEmpty(value.sourceRevision)) errors.push(`${label} missing sourceRevision`);
  if (!Number.isInteger(value.stageSequence) || Number(value.stageSequence) < 1) errors.push(`${label} stageSequence must be positive`);
  if (taskIdentity && episodeFirstRevision && reviewEpisodeId !== canonicalEpisodeId(taskIdentity, episodeFirstRevision)) errors.push(`${label} reviewEpisodeId is not bound to taskIdentity + first frozen revision`);
  if (reviewEpisodeId && Number.isInteger(value.stageSequence) && stageReceiptId !== canonicalStageReceiptId(reviewEpisodeId, Number(value.stageSequence))) errors.push(`${label} stageReceiptId is not canonical for the task-wide receipt sequence`);
  if (!Array.isArray(value.receiptCensus) || value.receiptCensus.some((item) => !nonEmpty(item))) errors.push(`${label} receiptCensus must be a non-empty-string array`);
  if (!isRecord(value.revisionChecks) || value.revisionChecks.attemptCreation !== 'matched' || value.revisionChecks.beforeLaunch !== 'matched' || value.revisionChecks.settlement !== 'matched') errors.push(`${label} revisionChecks must all be matched`);
  if (!isRecord(value.settlement)) errors.push(`${label} missing settlement`);
  else {
    if (value.settlement.allLaunchedTerminal !== true && value.settlement.allLaunchedTerminal !== false) errors.push(`${label} settlement.allLaunchedTerminal must be boolean`);
    if (!['none', 'eligible', 'exhausted', 'abandoned'].includes(String(value.settlement.retryState))) errors.push(`${label} settlement.retryState is invalid`);
    if (value.settlement.finalRevisionMatched !== true && value.settlement.finalRevisionMatched !== false) errors.push(`${label} settlement.finalRevisionMatched must be boolean`);
  }
  const credentialingCaptures = validateCaptureArray(value.credentialingCaptures, `${label}.credentialingCaptures`, errors);
  const relayEligibleCaptures = validateCaptureArray(value.relayEligibleCaptures, `${label}.relayEligibleCaptures`, errors);
  if (isReviewLaneEvidence(reviewLane)) {
    const reviewLaneRouting = reviewLane.routing;
    if (reviewLaneRouting.stageAttemptId !== String(value.stageAttemptId).trim()) errors.push(`${label} reviewLane stageAttemptId mismatch`);
    if (reviewLaneRouting.sourceRevision !== String(value.sourceRevision).trim()) errors.push(`${label} reviewLane sourceRevision mismatch`);
    if (reviewLaneRouting.reviewerCardinality !== Number(reviewerCardinality)) errors.push(`${label} reviewLane reviewerCardinality mismatch`);
    if (reviewLaneRouting.cardinalityConfigIdentity !== cardinalityConfigIdentity) errors.push(`${label} reviewLane cardinalityConfigIdentity mismatch`);
  }
  if (errors.some((error) => error.startsWith(label))) return null;
  const receipt: StageCompletenessReceiptV1 = {
    schema: STAGE_COMPLETENESS_RECEIPT_SCHEMA,
    tier: tier as ReviewTier,
    taskIdentity,
    episodeFirstRevision,
    reviewEpisodeId,
    stageReceiptId,
    previousStageReceiptId: previousStageReceiptId as string | null,
    receiptCensus: (value.receiptCensus as string[]).map((item) => item.trim()),
    stageAttemptId: String(value.stageAttemptId).trim(),
    stageSequence: Number(value.stageSequence),
    stage: stage as ReviewStage,
    policyVersion: policyVersion as typeof TRIPLE_SOURCE_POLICY_VERSION | typeof SINGLE_SOURCE_POLICY_VERSION | typeof REVIEW_LANE_ROUTING_POLICY_VERSION,
    reviewerCardinality: Number(reviewerCardinality),
    cardinalityConfigIdentity,
    sourceRevision: String(value.sourceRevision).trim(),
    outcome: outcome as StageOutcome,
    revisionChecks: value.revisionChecks as StageCompletenessReceiptV1['revisionChecks'],
    settlement: value.settlement as StageCompletenessReceiptV1['settlement'],
    invocations: Array.isArray(value.invocations) ? value.invocations as ReviewerInvocationEnvelopeV1[] : undefined,
    claude: isRecord(value.claude) ? value.claude as unknown as StageCompletenessReceiptV1['claude'] : undefined,
    credentialingCaptures,
    relayEligibleCaptures,
    ...(isReviewLaneEvidence(reviewLane) ? { reviewLane } : {}),
  };
  if (receipt.stage === 'competitive' || receipt.stage === 'architectural-review') {
    if (receipt.tier !== 'T3') errors.push(`${receipt.stage} is valid only for T3`);
    if (receipt.policyVersion !== TRIPLE_SOURCE_POLICY_VERSION && receipt.policyVersion !== REVIEW_LANE_ROUTING_POLICY_VERSION) errors.push(`${receipt.stage} must use triple-source/v1 or review-lane-routing/v1`);
  } else if (receipt.policyVersion === REVIEW_LANE_ROUTING_POLICY_VERSION) {
    errors.push(`${receipt.stage} review-lane-routing/v1 is limited to lane-controlled T3 stages`);
  } else {
    if (receipt.policyVersion !== SINGLE_SOURCE_POLICY_VERSION) errors.push(`${receipt.stage} must remain singular`);
    if (receipt.reviewerCardinality !== 1) errors.push(`${receipt.stage} must use reviewerCardinality 1`);
  }
  return receipt;
}
function validateRelayAttempt(value: unknown, index: number, governed: Map<string, CaptureIdentityV1>, errors: string[]): VerifiedRelayEvidenceV1 | null {
  const label = `relay evidence[${index}]`;
  if (!isRecord(value)) { errors.push(`${label} must be an object`); return null; }
  const relayAttemptId = nonEmpty(value.relayAttemptId) ? value.relayAttemptId.trim() : '';
  const identity = nonEmpty(value.captureIdentity) ? value.captureIdentity.trim() : '';
  const sourceLabel = nonEmpty(value.sourceLabel) ? value.sourceLabel.trim() : '';
  const governedCapture = governed.get(identity);
  if (!relayAttemptId) errors.push(`${label} missing relayAttemptId`);
  if (!governedCapture) { errors.push(`${label} references extra or unknown capture ${identity || '<missing>'}`); return null; }
  if (sourceLabel !== canonicalSourceLabel(governedCapture)) errors.push(`${label} sourceLabel does not match canonical source for ${identity}`);
  if (value.name !== governedCapture.name || value.byteLength !== governedCapture.byteLength || String(value.sha256).toLowerCase() !== governedCapture.sha256) errors.push(`${label} does not match immutable capture identity ${identity}`);
  if (value.verified !== true && value.verified !== false) errors.push(`${label} verified must be boolean`);
  const supersedes = value.supersedes === undefined ? undefined : nonEmpty(value.supersedes) ? value.supersedes.trim() : '';
  if (supersedes === '') errors.push(`${label} supersedes must be non-empty when present`);
  if (value.parts !== undefined) {
    if (!Array.isArray(value.parts) || value.parts.length === 0) errors.push(`${label} multipart evidence must contain parts`);
    else {
      const parts = value.parts as unknown[]; const expectedOf = parts.length; const seen = new Set<number>();
      for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
        const part = parts[partIndex];
        if (!isRecord(part) || part.verified !== true || part.of !== expectedOf || !Number.isInteger(part.part) || Number(part.part) < 1 || Number(part.part) > expectedOf || part.sourceLabel !== canonicalSourceLabel(governedCapture) || part.embeddedByteLength !== governedCapture.byteLength || String(part.embeddedSha256).toLowerCase() !== governedCapture.sha256) { errors.push(`${label} multipart part ${partIndex + 1} is invalid`); continue; }
        if (seen.has(Number(part.part))) errors.push(`${label} repeats multipart part ${part.part}`);
        seen.add(Number(part.part));
      }
      if (seen.size !== expectedOf) errors.push(`${label} multipart cardinality is incomplete`);
    }
  }
  if (errors.some((error) => error.startsWith(label))) return null;
  return { relayAttemptId, captureIdentity: identity, sourceLabel, name: governedCapture.name, byteLength: governedCapture.byteLength, sha256: governedCapture.sha256, verified: Boolean(value.verified), ...(supersedes ? { supersedes } : {}), ...(Array.isArray(value.parts) ? { parts: value.parts as VerifiedRelayPartV1[] } : {}) };
}
function selectVerifiedRelayHeads(input: readonly unknown[], governed: Map<string, CaptureIdentityV1>, errors: string[]): Map<string, CaptureIdentityV1> {
  const attempts = input.map((value, index) => validateRelayAttempt(value, index, governed, errors)).filter((value): value is VerifiedRelayEvidenceV1 => Boolean(value));
  const byAttempt = new Map<string, VerifiedRelayEvidenceV1>();
  for (const attempt of attempts) { if (byAttempt.has(attempt.relayAttemptId)) errors.push(`duplicate relayAttemptId ${attempt.relayAttemptId}`); else byAttempt.set(attempt.relayAttemptId, attempt); }
  for (const attempt of attempts) {
    if (!attempt.supersedes) continue;
    const previous = byAttempt.get(attempt.supersedes);
    if (!previous) errors.push(`relay attempt ${attempt.relayAttemptId} supersedes unknown attempt ${attempt.supersedes}`);
    else if (previous.captureIdentity !== attempt.captureIdentity) errors.push(`relay attempt ${attempt.relayAttemptId} supersedes a different capture`);
    else if (previous.relayAttemptId === attempt.relayAttemptId) errors.push(`relay attempt ${attempt.relayAttemptId} cannot supersede itself`);
  }
  const result = new Map<string, CaptureIdentityV1>();
  for (const [captureIdentity, capture] of governed) {
    const captureAttempts = attempts.filter((attempt) => attempt.captureIdentity === captureIdentity);
    if (captureAttempts.length === 0) continue;
    const superseded = new Set(captureAttempts.map((attempt) => attempt.supersedes).filter((id): id is string => Boolean(id)));
    const heads = captureAttempts.filter((attempt) => !superseded.has(attempt.relayAttemptId));
    if (heads.length !== 1) { errors.push(`capture ${captureIdentity} must have exactly one latest non-superseded relay attempt`); continue; }
    const head = heads[0]!; const visited = new Set<string>(); let current: VerifiedRelayEvidenceV1 | undefined = head;
    while (current?.supersedes) {
      if (visited.has(current.relayAttemptId)) { errors.push(`capture ${captureIdentity} relay supersession contains a cycle`); break; }
      visited.add(current.relayAttemptId); current = byAttempt.get(current.supersedes);
    }
    if (captureAttempts.length > 1 && visited.size + 1 !== captureAttempts.length) { errors.push(`capture ${captureIdentity} relay attempts are not one linear supersession chain`); continue; }
    if (!head.verified) { errors.push(`latest relay attempt ${head.relayAttemptId} for ${captureIdentity} is not verified`); continue; }
    result.set(captureIdentity, capture);
  }
  return result;
}
function validateInventoryAuthority(receipts: readonly StageCompletenessReceiptV1[], authority: ReviewEpisodeDerivationAuthorityV1 | undefined, errors: string[]): void {
  if (!authority || !isRecord(authority.tierIntake) || !isRecord(authority.receiptInventory)) { errors.push('review episode requires tier-intake/v1 plus an authoritative canonical receipt inventory'); return; }
  const intake = authority.tierIntake;
  if (intake.schema !== 'tier-intake/v1' || !nonEmpty(intake.producer) || !nonEmpty(intake.taskIdentity) || (intake.kind !== 'fresh' && intake.kind !== 'compatibility') || (intake.priorTier !== 'T1' && intake.priorTier !== 'T2' && intake.priorTier !== 'T3') || !nonEmpty(intake.firstRevision)) { errors.push('review episode tier-intake authority is malformed'); return; }
  const inventory = authority.receiptInventory;
  if (inventory.source !== 'canonical-review-directory') errors.push('review episode receipt inventory must come from the canonical review directory');
  if (!nonEmpty(inventory.taskIdentity) || !nonEmpty(inventory.episodeFirstRevision) || !nonEmpty(inventory.reviewEpisodeId) || !Array.isArray(inventory.stageReceiptIds) || inventory.stageReceiptIds.some((id) => !nonEmpty(id))) { errors.push('review episode receipt inventory is malformed'); return; }
  if (inventory.taskIdentity !== intake.taskIdentity || inventory.episodeFirstRevision !== intake.firstRevision) errors.push('review episode inventory root does not match immutable tier-intake/v1 authority');
  const expectedEpisodeId = canonicalEpisodeId(intake.taskIdentity, intake.firstRevision);
  if (inventory.reviewEpisodeId !== expectedEpisodeId) errors.push('review episode inventory root is not bound to task identity + intake first revision');
  const ids = receipts.map((receipt) => receipt.stageReceiptId);
  if (inventory.stageReceiptIds.length !== ids.length || inventory.stageReceiptIds.some((id, index) => id !== ids[index])) errors.push('canonical receipt inventory does not equal the complete supplied receipt chain');
  for (const receipt of receipts) if (receipt.taskIdentity !== inventory.taskIdentity || receipt.episodeFirstRevision !== inventory.episodeFirstRevision || receipt.reviewEpisodeId !== inventory.reviewEpisodeId) errors.push(`stage receipt ${receipt.stageReceiptId} is outside the authoritative episode root`);
}
export function deriveReviewEpisodeState(stageReceiptsInput: readonly unknown[], verifiedRelayEvidenceInput: readonly unknown[], authority?: ReviewEpisodeDerivationAuthorityV1): ReviewEpisodeStateV1 {
  const errors: string[] = [];
  const receipts = stageReceiptsInput.map((value, index) => parseStageReceipt(value, index, errors)).filter((value): value is StageCompletenessReceiptV1 => Boolean(value)).sort((a, b) => a.stageSequence - b.stageSequence || a.stageAttemptId.localeCompare(b.stageAttemptId));
  const episodeIds = new Set(receipts.map((receipt) => receipt.reviewEpisodeId));
  const taskIdentities = new Set(receipts.map((receipt) => receipt.taskIdentity));
  const firstRevisions = new Set(receipts.map((receipt) => receipt.episodeFirstRevision));
  const tiers = new Set(receipts.map((receipt) => receipt.tier));
  if (receipts.length === 0) errors.push('review episode requires at least one stage receipt');
  if (episodeIds.size > 1) errors.push('stage receipts mix reviewEpisodeId values');
  if (taskIdentities.size > 1) errors.push('stage receipts mix taskIdentity values');
  if (firstRevisions.size > 1) errors.push('stage receipts mix episodeFirstRevision values');
  if (tiers.size > 1) errors.push('stage receipts mix tiers');
  validateInventoryAuthority(receipts, authority, errors);
  const producerEvidence = parseClaudeProducerEvidence(authority?.claudeProducerEvidence ?? [], errors);
  const attemptIds = new Set<string>(); const stageSequences = new Set<number>(); const receiptIds = new Set<string>();
  const episodeInvocationIds = new Set<string>(); const episodeTerminalResultIds = new Set<string>(); const producingRunIds = new Set<string>();
  for (const receipt of receipts) {
    if (attemptIds.has(receipt.stageAttemptId)) errors.push(`duplicate stageAttemptId ${receipt.stageAttemptId}`); attemptIds.add(receipt.stageAttemptId);
    if (stageSequences.has(receipt.stageSequence)) errors.push(`duplicate stageSequence ${receipt.stageSequence}`); stageSequences.add(receipt.stageSequence);
    if (receiptIds.has(receipt.stageReceiptId)) errors.push(`duplicate stageReceiptId ${receipt.stageReceiptId}`); receiptIds.add(receipt.stageReceiptId);
    if (receipt.stage === 'architectural-lens') validateClaudeReceipt(receipt, producerEvidence, errors); else validateBrowserReceipt(receipt, errors);
    for (const invocation of receipt.invocations ?? []) {
      if (!isRecord(invocation)) continue;
      const invocationId = nonEmpty(invocation.invocationId) ? invocation.invocationId.trim() : '';
      const terminalResultIdentity = nonEmpty(invocation.terminalResultIdentity) ? invocation.terminalResultIdentity.trim() : '';
      if (invocationId) { if (episodeInvocationIds.has(invocationId)) errors.push(`review episode repeats invocationId ${invocationId}`); episodeInvocationIds.add(invocationId); }
      if (terminalResultIdentity) { if (episodeTerminalResultIds.has(terminalResultIdentity)) errors.push(`review episode repeats terminalResultIdentity ${terminalResultIdentity}`); episodeTerminalResultIds.add(terminalResultIdentity); }
    }
    if (receipt.claude?.kind === 'capture') {
      const branch = receipt.claude;
      if (episodeInvocationIds.has(branch.invocationId)) errors.push(`review episode repeats invocationId ${branch.invocationId}`); episodeInvocationIds.add(branch.invocationId);
      if (episodeTerminalResultIds.has(branch.terminalResultIdentity)) errors.push(`review episode repeats terminalResultIdentity ${branch.terminalResultIdentity}`); episodeTerminalResultIds.add(branch.terminalResultIdentity);
      if (producingRunIds.has(branch.producingRunIdentity)) errors.push(`review episode repeats Claude producingRunIdentity ${branch.producingRunIdentity}`); producingRunIds.add(branch.producingRunIdentity);
    }
  }
  if (receipts.length > 0) {
    const expectedReceiptIds: string[] = [];
    for (let index = 0; index < receipts.length; index += 1) {
      const receipt = receipts[index]!; const expectedSequence = index + 1;
      if (receipt.stageSequence !== expectedSequence) errors.push(`stage receipt sequence is incomplete: expected ${expectedSequence}, got ${receipt.stageSequence}`);
      const expectedPrevious = index === 0 ? null : receipts[index - 1]!.stageReceiptId;
      if (receipt.previousStageReceiptId !== expectedPrevious) errors.push(`stage receipt ${receipt.stageReceiptId} previousStageReceiptId does not match authoritative chain`);
      expectedReceiptIds.push(receipt.stageReceiptId);
      if (receipt.receiptCensus.length !== expectedReceiptIds.length || receipt.receiptCensus.some((id, censusIndex) => id !== expectedReceiptIds[censusIndex])) errors.push(`stage receipt ${receipt.stageReceiptId} receiptCensus does not prove the complete no-overwrite chain`);
    }
    if (receipts[0]!.sourceRevision !== receipts[0]!.episodeFirstRevision) errors.push('first stage receipt sourceRevision must equal episodeFirstRevision');
    const latestCensus = receipts.at(-1)!.receiptCensus;
    if (latestCensus.length !== receipts.length || latestCensus.some((id, index) => id !== receipts[index]!.stageReceiptId)) errors.push('latest stage receipt census omits or replaces earlier authoritative receipts');
  }
  const receiptsByStage: Record<ReviewStage, StageCompletenessReceiptV1[]> = { competitive: [], 'architectural-review': [], 'architectural-lens': [], architectural: [] };
  const credentialingReceiptsByStage: Partial<Record<ReviewStage, StageCompletenessReceiptV1>> = {};
  const credentialingCapturesByStage: Record<ReviewStage, CaptureIdentityV1[]> = { competitive: [], 'architectural-review': [], 'architectural-lens': [], architectural: [] };
  const rawFindingCountByStage: Record<ReviewStage, number> = { competitive: 0, 'architectural-review': 0, 'architectural-lens': 0, architectural: 0 };
  const governed = new Map<string, CaptureIdentityV1>();
  for (const receipt of receipts) {
    receiptsByStage[receipt.stage].push(receipt);
    if (receipt.outcome === 'complete') {
      if (credentialingReceiptsByStage[receipt.stage]) errors.push(`${receipt.stage} has more than one credentialing complete stage attempt`);
      else { credentialingReceiptsByStage[receipt.stage] = receipt; credentialingCapturesByStage[receipt.stage].push(...receipt.credentialingCaptures); }
    }
    for (const capture of receipt.relayEligibleCaptures) {
      const existing = governed.get(capture.captureIdentity);
      if (existing && !sameCapture(existing, capture)) errors.push(`capture identity ${capture.captureIdentity} has conflicting immutable facts`);
      else if (existing) errors.push(`capture identity ${capture.captureIdentity} is governed by more than one stage receipt`);
      else { governed.set(capture.captureIdentity, capture); rawFindingCountByStage[receipt.stage] += capture.rawFindingCount; }
    }
  }
  const relayed = selectVerifiedRelayHeads(verifiedRelayEvidenceInput, governed, errors);
  for (const stage of Object.keys(credentialingCapturesByStage) as ReviewStage[]) credentialingCapturesByStage[stage].sort((left, right) => left.name.localeCompare(right.name) || left.captureIdentity.localeCompare(right.captureIdentity));
  const governedCaptures = [...governed.values()].sort((left, right) => left.name.localeCompare(right.name) || left.captureIdentity.localeCompare(right.captureIdentity));
  const relayedCaptures = [...relayed.values()].sort((left, right) => left.name.localeCompare(right.name) || left.captureIdentity.localeCompare(right.captureIdentity));
  const governedCaptureUnion = [...governed.keys()].sort(); const relayedCaptureUnion = [...relayed.keys()].sort();
  const relayComplete = governedCaptureUnion.length === relayedCaptureUnion.length && governedCaptureUnion.every((identity, index) => identity === relayedCaptureUnion[index]);
  if (!relayComplete) errors.push('relayedCaptureUnion must equal governedCaptureUnion exactly');
  const attemptIdsByStage = new Map<ReviewStage, Set<string>>();
  for (const receipt of receipts) {
    const attemptIds = attemptIdsByStage.get(receipt.stage) ?? new Set<string>();
    attemptIds.add(receipt.stageAttemptId);
    attemptIdsByStage.set(receipt.stage, attemptIds);
  }
  for (const [stage, attemptIds] of attemptIdsByStage) {
    if (attemptIds.size > 1) {
      errors.push(`${stage} has a reopened logical round: multiple distinct stageAttemptId values`);
    }
  }
  const completeReceipts = receipts.filter((receipt) => receipt.outcome === 'complete');
  const activationReady = completeReceipts.length > 0 && errors.length === 0;
  return {
    reviewEpisodeId: episodeIds.size === 1 ? [...episodeIds][0]! : null,
    taskIdentity: taskIdentities.size === 1 ? [...taskIdentities][0]! : null,
    episodeFirstRevision: firstRevisions.size === 1 ? [...firstRevisions][0]! : null,
    tier: tiers.size === 1 ? [...tiers][0]! : null,
    receipts,
    receiptsByStage,
    credentialingReceiptsByStage,
    credentialingCapturesByStage,
    governedCaptures,
    relayedCaptures,
    governedCaptureUnion,
    relayedCaptureUnion,
    rawFindingCountByStage,
    rawFindingCount: Object.values(rawFindingCountByStage).reduce((sum, count) => sum + count, 0),
    logicalRoundIds: [...new Set(receipts.map((receipt) => receipt.stageAttemptId))],
    relayComplete,
    activationReady,
    errors,
  };
}
export function validateReviewEpisodeTopology(state: ReviewEpisodeStateV1, phase: 'pre-lens' | 'final-acceptance'): string[] {
  const errors: string[] = [];
  if (!state.tier) return ['review episode tier is unresolved'];
  const expected: ReviewStage[] = state.tier === 'T3' ? (phase === 'pre-lens' ? ['competitive', 'architectural-review'] : ['competitive', 'architectural-review', 'architectural-lens', 'architectural']) : ['architectural'];
  for (const stage of expected) {
    const receipts = state.receiptsByStage[stage]; const complete = receipts.filter((receipt) => receipt.outcome === 'complete');
    if (complete.length !== 1) errors.push(`${stage} requires exactly one credentialing complete stageAttemptId in the review episode`);
    const credentialing = complete[0];
    if (credentialing && receipts.at(-1) !== credentialing) errors.push(`${stage} credentialing complete attempt must be the latest settled attempt for that stage`);
    for (const receipt of receipts) {
      if (receipt !== credentialing && receipt.outcome === 'complete') errors.push(`${stage} has multiple credentialing attempts`);
      if (credentialing && receipt !== credentialing && receipt.stageSequence > credentialing.stageSequence) errors.push(`${stage} has a later non-credentialing attempt after completion`);
    }
  }
  for (const stage of Object.keys(state.receiptsByStage) as ReviewStage[]) if (!expected.includes(stage) && state.receiptsByStage[stage].length > 0) errors.push(`${stage} is not admissible for ${state.tier} ${phase}`);
  let highestStageIndex = -1; const completedBefore = new Set<ReviewStage>();
  for (const receipt of state.receipts) {
    const stageIndex = expected.indexOf(receipt.stage); if (stageIndex < 0) continue;
    if (stageIndex < highestStageIndex) errors.push(`${receipt.stage} stage attempt appears after a later stage has already started`);
    for (let predecessorIndex = 0; predecessorIndex < stageIndex; predecessorIndex += 1) {
      const predecessor = expected[predecessorIndex]!;
      if (!completedBefore.has(predecessor)) errors.push(`${receipt.stage} stage attempt ${receipt.stageAttemptId} started before ${predecessor} credentialed`);
    }
    highestStageIndex = Math.max(highestStageIndex, stageIndex);
    if (receipt.outcome === 'complete') completedBefore.add(receipt.stage);
  }
  const ordered = expected.map((stage) => state.credentialingReceiptsByStage[stage]).filter((receipt): receipt is StageCompletenessReceiptV1 => Boolean(receipt));
  for (let index = 1; index < ordered.length; index += 1) if (ordered[index]!.stageSequence <= ordered[index - 1]!.stageSequence) errors.push(`${ordered[index]!.stage} stage is out of order`);
  if (!state.relayComplete) errors.push('review episode relay is incomplete');
  if (phase === 'final-acceptance'
    && state.receipts.some((receipt) => receipt.policyVersion === TRIPLE_SOURCE_POLICY_VERSION || receipt.policyVersion === REVIEW_LANE_ROUTING_POLICY_VERSION)
    && !state.activationReady) {
    errors.push('review-lane-routing/v1 final acceptance is blocked until logical-round accounting is active');
  }
  return errors;
}

export function parseCaptureFileName(fileName: string): ParsedCapture | null {
  const sourceMatch = SOURCE_CAPTURE_FILENAME_RE.exec(fileName);
  if (sourceMatch?.[1] && sourceMatch[2] && sourceMatch[3]) {
    const passIndex = Number.parseInt(sourceMatch[1], 10);
    if (!Number.isInteger(passIndex) || passIndex < 0) return null;
    return { passIndex, stage: sourceMatch[2].toLowerCase(), fileName, reviewerSlot: sourceMatch[3], sourceSuffixed: true };
  }
  const match = LEGACY_CAPTURE_FILENAME_RE.exec(fileName);
  if (!match?.[1] || !match[2]) return null;
  const passIndex = Number.parseInt(match[1], 10);
  if (!Number.isInteger(passIndex) || passIndex < 0) return null;
  return { passIndex, stage: match[2].toLowerCase(), fileName, reviewerSlot: null, sourceSuffixed: false };
}
export function referencesCountedStageFilenameToken(fileName: string): boolean { return COUNTED_STAGE_FILENAME_TOKEN_RE.test(fileName); }
export function parseCompetitiveWaiver(reviewDir: string): { waiver: CompetitiveWaiver | null; invalid: boolean } {
  const waiverPath = join(reviewDir, COMPETITIVE_WAIVER_FILENAME);
  if (!existsSync(waiverPath)) return { waiver: null, invalid: false };
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(waiverPath, 'utf8')); } catch { return { waiver: null, invalid: true }; }
  if (!parsed || typeof parsed !== 'object') return { waiver: null, invalid: true };
  const record = parsed as Record<string, unknown>;
  const reason = typeof record.reason === 'string' ? record.reason.trim() : '';
  const recordedAt = typeof record['recorded-at'] === 'string' ? record['recorded-at'].trim() : '';
  const afterPass = parseAfterPassAnchor(record['after-pass']);
  if (!PARSEABLE_WAIVER_REASONS.has(reason) || !recordedAt || !isStrictIso8601Timestamp(recordedAt) || afterPass === null) return { waiver: null, invalid: true };
  return { waiver: { reason, recordedAt, afterPass }, invalid: false };
}
export function parseArchitectLensWaiver(reviewDir: string): { waiver: ArchitectLensWaiver | null; invalid: boolean } {
  const waiverPath = join(reviewDir, ARCHITECT_LENS_WAIVER_FILENAME);
  if (!existsSync(waiverPath)) return { waiver: null, invalid: false };
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(waiverPath, 'utf8')); } catch { return { waiver: null, invalid: true }; }
  if (!parsed || typeof parsed !== 'object') return { waiver: null, invalid: true };
  const record = parsed as Record<string, unknown>;
  const reason = typeof record.reason === 'string' ? record.reason.trim() : '';
  const recordedAt = typeof record['recorded-at'] === 'string' ? record['recorded-at'].trim() : '';
  const unavailability = typeof record.unavailability === 'string' ? record.unavailability.trim() : '';
  const afterPass = parseAfterPassAnchor(record['after-pass']);
  if (!PARSEABLE_LENS_WAIVER_REASONS.has(reason) || !recordedAt || !isStrictIso8601Timestamp(recordedAt) || !CREDITED_LENS_UNAVAILABILITY_KINDS.has(unavailability) || afterPass === null) return { waiver: null, invalid: true };
  return { waiver: { reason, recordedAt, afterPass, unavailability }, invalid: false };
}
function loadReviewCaptures(reviewDir: string): { captures: ParsedCapture[]; errors: string[] } {
  const captures: ParsedCapture[] = []; const errors: string[] = [];
  if (!existsSync(reviewDir)) return { captures, errors };
  for (const fileName of readdirSync(reviewDir).sort()) {
    if (!fileName.endsWith('.capture.txt')) continue;
    const parsed = parseCaptureFileName(fileName);
    if (!parsed) { if (referencesCountedStageFilenameToken(fileName)) errors.push(`unparseable capture filename: ${fileName}`); continue; }
    if (!COUNTED_STAGE_TOKENS.has(parsed.stage as ReviewStage)) continue;
    if (parsed.sourceSuffixed) { errors.push(`source-suffixed capture requires explicit ${STAGE_COMPLETENESS_RECEIPT_SCHEMA}: ${fileName}`); continue; }
    const body = readFileSync(join(reviewDir, fileName), 'utf8').trim();
    if (!body) { errors.push(`empty capture file: ${fileName}`); continue; }
    captures.push(parsed);
  }
  return { captures, errors };
}
function capturesFor(captures: readonly ParsedCapture[], stage: string): ParsedCapture[] { return captures.filter((capture) => capture.stage === stage); }
export function resolveActiveAcceptanceSegment(captures: readonly ParsedCapture[]): ActiveAcceptanceSegment {
  const ordered = [...captures].sort((a, b) => a.passIndex - b.passIndex || a.fileName.localeCompare(b.fileName));
  const competitivePasses = ordered.filter((capture) => capture.stage === 'competitive').map((capture) => capture.passIndex);
  const terminalBoundaries = ordered.filter((capture) => capture.stage === 'architectural' && competitivePasses.some((passIndex) => passIndex > capture.passIndex));
  const boundaryPass = terminalBoundaries.length > 0 ? Math.max(...terminalBoundaries.map((capture) => capture.passIndex)) : 0;
  return { boundaryPass, captures: ordered.filter((capture) => capture.passIndex > boundaryPass) };
}
function singlePass(captures: readonly ParsedCapture[], stage: string, errors: string[], missingMessage: string, duplicateMessage: string): number | null {
  const matches = capturesFor(captures, stage);
  if (matches.length === 0) { errors.push(missingMessage); return null; }
  if (matches.length !== 1) { errors.push(duplicateMessage); return null; }
  return matches[0]!.passIndex;
}
export function resolveRepoRootFromDraftPath(draftPath?: string): string {
  if (!draftPath) return process.cwd();
  const normalized = draftPath.replace(/\\/g, '/'); const marker = '/docs/issues_drafts/'; const idx = normalized.lastIndexOf(marker);
  return idx >= 0 ? normalized.slice(0, idx) : process.cwd();
}
function checkReceiptBackedStageCompleteness(tier: ReviewTier, options: StageCompletenessGuardOptions): StageCompletenessGuardResult {
  const phase = options.phase ?? 'final-acceptance';
  const state = deriveReviewEpisodeState(options.stageReceipts ?? [], options.verifiedRelayEvidence ?? [], options.episodeAuthority);
  const errors = [...state.errors];
  if (state.tier && state.tier !== tier) errors.push(`review episode tier ${state.tier} does not match task tier ${tier}`);
  errors.push(...validateReviewEpisodeTopology(state, phase));
  if (errors.length > 0 || !state.reviewEpisodeId || !state.tier) return { ok: false, errors: [...new Set(errors)], noop: false, receipt: null, episodeState: state };
  const policyVersion = state.receipts.some((receipt) => receipt.policyVersion === REVIEW_LANE_ROUTING_POLICY_VERSION)
    ? REVIEW_LANE_ROUTING_POLICY_VERSION
    : state.receipts.some((receipt) => receipt.policyVersion === TRIPLE_SOURCE_POLICY_VERSION)
      ? TRIPLE_SOURCE_POLICY_VERSION
      : SINGLE_SOURCE_POLICY_VERSION;
  return { ok: true, errors: [], noop: false, episodeState: state, receipt: { tier: state.tier, reviewEpisodeId: state.reviewEpisodeId, policyVersion, logicalRoundIds: state.logicalRoundIds, governedCaptureUnion: state.governedCaptureUnion, relayedCaptureUnion: state.relayedCaptureUnion, rawFindingCount: state.rawFindingCount, activationReady: state.activationReady } };
}
export function checkStageCompletenessGuard(draftText: string, options: StageCompletenessGuardOptions = {}): StageCompletenessGuardResult {
  const fence = parseComplexityTierFence(draftText);
  if (fence.kind !== 'tier-fence') return { ok: true, errors: [], noop: true, receipt: null };
  if (options.stageReceipts !== undefined) return checkReceiptBackedStageCompleteness(fence.tier as ReviewTier, options);
  if (fence.tier !== 'T3') return { ok: true, errors: [], noop: true, receipt: null };
  if (options.draftPath) {
    const repoRoot = options.repoRoot ?? process.cwd(); const { capturesDir } = resolveReviewArtifacts(options.draftPath, repoRoot);
    if (GRANDFATHERED_REVIEW_DIR_BASENAMES.has(basename(capturesDir))) return { ok: true, errors: [], noop: false, receipt: null };
  }
  return { ok: false, errors: [`fresh T3 requires explicit ${STAGE_COMPLETENESS_RECEIPT_SCHEMA} authority; legacy capture scanning is historical-only`], noop: false, receipt: null };
}
export function formatStageCompletenessPassMessage(result: StageCompletenessGuardResult): string {
  if (result.noop) return 'stage-completeness guard: PASS (receipt=noop non-T3)';
  if (!result.receipt) return 'stage-completeness guard: PASS (receipt=grandfathered)';
  if ('reviewEpisodeId' in result.receipt) return ['stage-completeness guard: PASS', `(receipt=${STAGE_COMPLETENESS_RECEIPT_SCHEMA} episode=${result.receipt.reviewEpisodeId}`, `rounds=${result.receipt.logicalRoundIds.length}`, `governed=${result.receipt.governedCaptureUnion.length}`, `relayed=${result.receipt.relayedCaptureUnion.length}`, `activation-ready=${String(result.receipt.activationReady)})`].join(' ');
  const { competitiveAnchor, architecturalReviewPass, lensMax, lensSkipAnchor, terminalPass } = result.receipt;
  const lensReceipt = lensMax !== null ? `lens-max=${lensMax}` : `lens-skip-anchor=${lensSkipAnchor}`;
  return ['stage-completeness guard: PASS', `(receipt=tier-fence tier=T3 competitive-anchor=${competitiveAnchor}`, `architectural-review-pass=${architecturalReviewPass} ${lensReceipt} terminal-pass=${terminalPass})`].join(' ');
}
