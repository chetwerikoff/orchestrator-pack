import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveCanonicalReviewDirectory } from './canonical-review-directory.ts';
import { parseConsumableStageReceipt } from './create-issue-stage-record-receipt.ts';
import {
  canonicalStagePlan,
  type CanonicalCompetitiveDecision,
  type CanonicalStagePlanEntry,
  type CanonicalStagePlanV1,
} from './create-issue-stage-topology.ts';

export type LifecycleReviewTier = 'T1' | 'T2' | 'T3';
export type LifecycleReviewStage = 'competitive' | 'architectural-review' | 'architectural-lens' | 'architectural';
export type CompetitiveDecision = CanonicalCompetitiveDecision;
export type LifecycleSettledOutcome = 'complete' | 'partial' | 'blocked' | 'incident';
export type CanonicalStageTopologyEntry = CanonicalStagePlanEntry;
export type CanonicalStageTopologyV1 = CanonicalStagePlanV1;

export const STAGE_SLOT_CONSUMED = 'stage_slot_consumed' as const;
export const STAGE_ORDER_VIOLATION = 'stage_order_violation' as const;
export const STAGE_AUTHORITY_INVALID = 'stage_authority_invalid' as const;
export const TERMINAL_BUNDLE_UNAVAILABLE = 'terminal_bundle_unavailable' as const;

const STAGE_RECEIPT_SCHEMA = 'stage-completeness-receipt/v1';
const AUTHOR_DISPOSITIONS_SCHEMA = 'create-issue-author-dispositions/v1';
const SOURCE_REVISION_RE = /^r[0-9]+$/;
const SOURCE_REVISION_MARKER_RE = /<!--\s*source-revision:\s*(r[0-9]+)\s*-->/i;
const SETTLED_OUTCOMES = new Set<LifecycleSettledOutcome>(['complete', 'partial', 'blocked', 'incident']);
const REVIEW_STAGES = new Set<LifecycleReviewStage>(['competitive', 'architectural-review', 'architectural-lens', 'architectural']);

export interface LifecycleTierIntakeV1 {
  schema: 'tier-intake/v1';
  producer: string;
  taskIdentity: string;
  kind: 'fresh' | 'compatibility';
  priorTier: LifecycleReviewTier;
  firstRevision: string;
  competitiveDecision?: CompetitiveDecision;
  competitiveRationale?: string;
}

export interface SettledStageSlot {
  tier: LifecycleReviewTier;
  stage: LifecycleReviewStage;
  stageAttemptId: string;
  stageSequence: number;
  sourceRevision: string;
  outcome: LifecycleSettledOutcome;
  reviewEpisodeId: string;
  taskIdentity: string;
  episodeFirstRevision: string;
  cycleId: string;
  policyVersion: string;
  reviewerCardinality: number;
}

export interface TerminalBundleV1 {
  schema: 'create-issue-terminal-input-bundle/v1';
  reviewEpisodeId: string;
  sourceRevision: string;
  predecessorStage: LifecycleReviewStage | null;
  currentIssue: { sourceRevision: string; body: string };
  rejectPartition: unknown[];
  protectedM3: unknown[];
  authorM4: unknown[];
  reviewEconomics: Record<string, unknown>;
}

export interface StageAdmissionInput {
  issueNumber: number;
  tier: LifecycleReviewTier;
  stage: LifecycleReviewStage;
  sourceRevision: string;
  issueBody: string;
  intake: unknown;
  receiptValues: readonly unknown[];
  terminalBundle?: TerminalBundleV1 | null;
}

export interface StageAdmissionResult {
  ok: boolean;
  code?: typeof STAGE_SLOT_CONSUMED | typeof STAGE_ORDER_VIOLATION | typeof STAGE_AUTHORITY_INVALID | typeof TERMINAL_BUNDLE_UNAVAILABLE;
  message?: string;
  consumingStageAttemptId?: string;
  expectedStage?: LifecycleReviewStage | null;
  predecessorStage?: LifecycleReviewStage | null;
  topology?: CanonicalStageTopologyV1;
  intake?: LifecycleTierIntakeV1;
  slots?: SettledStageSlot[];
}

export interface CanonicalLifecycleAuthority {
  reviewDir: string;
  intakePath: string;
  intake: unknown;
  receiptPaths: string[];
  receiptValues: unknown[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
function asTier(value: unknown): LifecycleReviewTier | null {
  return value === 'T1' || value === 'T2' || value === 'T3' ? value : null;
}
function taskIssueNumber(taskIdentity: string): number | null {
  const candidate = taskIdentity.trim().split(':').at(-1)?.trim() ?? '';
  const match = /^([1-9][0-9]*)(?:-|$)/.exec(candidate);
  return match?.[1] ? Number(match[1]) : null;
}
function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}
function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function parseLifecycleTierIntake(value: unknown): LifecycleTierIntakeV1 | null {
  if (!isRecord(value)) return null;
  const priorTier = asTier(value.priorTier);
  if (
    value.schema !== 'tier-intake/v1'
    || !nonEmpty(value.producer)
    || !nonEmpty(value.taskIdentity)
    || (value.kind !== 'fresh' && value.kind !== 'compatibility')
    || !priorTier
    || !nonEmpty(value.firstRevision)
    || !SOURCE_REVISION_RE.test(value.firstRevision)
  ) return null;
  const competitiveDecision = value.competitiveDecision === 'required' || value.competitiveDecision === 'skipped'
    ? value.competitiveDecision
    : undefined;
  const competitiveRationale = nonEmpty(value.competitiveRationale) ? value.competitiveRationale.trim() : undefined;
  if (value.competitiveDecision !== undefined && !competitiveDecision) return null;
  if (value.competitiveRationale !== undefined && !competitiveRationale) return null;
  return {
    schema: 'tier-intake/v1',
    producer: value.producer.trim(),
    taskIdentity: value.taskIdentity.trim(),
    kind: value.kind,
    priorTier,
    firstRevision: value.firstRevision.trim(),
    ...(competitiveDecision ? { competitiveDecision } : {}),
    ...(competitiveRationale ? { competitiveRationale } : {}),
  };
}

/** Compatibility name retained for callers; the executable authority lives in create-issue-stage-topology.ts. */
export function canonicalStageTopology(tier: LifecycleReviewTier, intake: LifecycleTierIntakeV1): CanonicalStageTopologyV1 {
  return canonicalStagePlan(tier, {
    competitiveDecision: intake.competitiveDecision,
    competitiveRationale: intake.competitiveRationale,
  });
}

export function parseSettledStageSlot(value: unknown): SettledStageSlot | null {
  if (!isRecord(value) || value.schema !== STAGE_RECEIPT_SCHEMA) return null;
  const parsed = parseConsumableStageReceipt(value);
  if (!parsed.receipt || parsed.errors.length > 0) return null;
  const receipt = parsed.receipt;
  const tier = asTier(receipt.tier);
  const stage = REVIEW_STAGES.has(receipt.stage as LifecycleReviewStage) ? receipt.stage as LifecycleReviewStage : null;
  const outcome = SETTLED_OUTCOMES.has(receipt.outcome as LifecycleSettledOutcome) ? receipt.outcome as LifecycleSettledOutcome : null;
  if (
    !tier
    || !stage
    || !outcome
    || !Number.isInteger(value.stageSequence)
    || Number(value.stageSequence) < 1
    || !SOURCE_REVISION_RE.test(receipt.sourceRevision)
    || !nonEmpty(value.reviewEpisodeId)
    || !nonEmpty(value.taskIdentity)
    || !nonEmpty(value.episodeFirstRevision)
    || !SOURCE_REVISION_RE.test(value.episodeFirstRevision)
  ) return null;
  return {
    tier,
    stage,
    stageAttemptId: receipt.stageAttemptId,
    stageSequence: Number(value.stageSequence),
    sourceRevision: receipt.sourceRevision,
    outcome,
    reviewEpisodeId: value.reviewEpisodeId.trim(),
    taskIdentity: value.taskIdentity.trim(),
    episodeFirstRevision: value.episodeFirstRevision.trim(),
    cycleId: receipt.cycleId,
    policyVersion: receipt.policyVersion,
    reviewerCardinality: receipt.reviewerCardinality,
  };
}

export function admissionStageSequence(
  topology: CanonicalStageTopologyV1,
  slots: readonly SettledStageSlot[],
): { expectedStage: LifecycleReviewStage | null; predecessorStage: LifecycleReviewStage | null; errors: string[] } {
  const errors: string[] = [];
  const stageOrder = topology.stages.map((entry) => entry.stage as LifecycleReviewStage);
  const byStage = new Map<LifecycleReviewStage, SettledStageSlot[]>();
  for (const slot of slots) {
    const topologyEntry = topology.stages.find((entry) => entry.stage === slot.stage);
    if (!topologyEntry) {
      errors.push(`settled stage ${slot.stage} is outside canonical ${topology.tier} topology`);
      continue;
    }
    if (slot.tier !== topology.tier) errors.push(`${slot.stage} receipt tier ${slot.tier} does not match canonical ${topology.tier} topology`);
    const routedPolicyCompatible = slot.policyVersion === 'review-lane-routing/v1'
      && (slot.stage === 'competitive' || slot.stage === 'architectural-review');
    if (slot.policyVersion !== topologyEntry.policyVersion && !routedPolicyCompatible) {
      errors.push(`${slot.stage} receipt policy ${slot.policyVersion} does not match canonical ${topologyEntry.policyVersion}`);
    }
    if (slot.reviewerCardinality !== topologyEntry.reviewerCardinality) errors.push(`${slot.stage} receipt cardinality ${slot.reviewerCardinality} does not match canonical ${topologyEntry.reviewerCardinality}`);
    const list = byStage.get(slot.stage) ?? [];
    list.push(slot);
    byStage.set(slot.stage, list);
  }
  for (const [stage, entries] of byStage) {
    if (entries.length > 1) errors.push(`${stage} has ${entries.length} settled stageAttemptId values; a semantic stage slot is Issue-lifetime singular`);
  }
  const sorted = [...slots].sort((left, right) => left.stageSequence - right.stageSequence);
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index]!.stageSequence <= sorted[index - 1]!.stageSequence) errors.push('settled receipt stageSequence values are not strictly increasing');
  }
  for (let index = 0; index < sorted.length && index < stageOrder.length; index += 1) {
    if (sorted[index]!.stage !== stageOrder[index]) {
      errors.push(`stageSequence ${sorted[index]!.stageSequence} records ${sorted[index]!.stage} where canonical topology requires ${stageOrder[index]}`);
    }
  }
  const consumed = new Set(slots.map((slot) => slot.stage));
  const expectedIndex = stageOrder.findIndex((stage) => !consumed.has(stage));
  const expectedStage = expectedIndex < 0 ? null : stageOrder[expectedIndex]!;
  const predecessorStage = expectedIndex <= 0 ? null : stageOrder[expectedIndex - 1]!;
  for (let index = 0; index < Math.max(expectedIndex, 0); index += 1) {
    const predecessor = byStage.get(stageOrder[index]!)?.[0];
    if (predecessor && predecessor.outcome !== 'complete' && predecessor.outcome !== 'partial') {
      errors.push(`${predecessor.stage} settled ${predecessor.outcome}; its slot is consumed but it cannot credential a successor stage`);
    }
  }
  if (expectedIndex >= 0) {
    for (let index = expectedIndex + 1; index < stageOrder.length; index += 1) {
      if (consumed.has(stageOrder[index]!)) errors.push(`${stageOrder[index]} is settled before required predecessor ${expectedStage}`);
    }
  }
  return { expectedStage, predecessorStage, errors };
}

export function admitStageLaunch(input: StageAdmissionInput): StageAdmissionResult {
  const intake = parseLifecycleTierIntake(input.intake);
  if (!intake) return { ok: false, code: STAGE_AUTHORITY_INVALID, message: 'canonical tier-intake/v1 is missing or malformed' };
  if (taskIssueNumber(intake.taskIdentity) !== input.issueNumber) return { ok: false, code: STAGE_AUTHORITY_INVALID, message: `tier-intake taskIdentity ${intake.taskIdentity} does not bind Issue #${input.issueNumber}` };
  if (intake.priorTier !== input.tier) return { ok: false, code: STAGE_AUTHORITY_INVALID, message: `tier-intake priorTier ${intake.priorTier} does not match launch tier ${input.tier}` };
  const marker = SOURCE_REVISION_MARKER_RE.exec(input.issueBody)?.[1];
  if (!marker || marker !== input.sourceRevision) return { ok: false, code: STAGE_AUTHORITY_INVALID, message: `live Issue source-revision marker ${marker ?? '<missing>'} does not match launch revision ${input.sourceRevision}` };

  let topology: CanonicalStageTopologyV1;
  try { topology = canonicalStageTopology(input.tier, intake); }
  catch (error) { return { ok: false, code: STAGE_AUTHORITY_INVALID, message: error instanceof Error ? error.message : String(error), intake }; }
  const parsed = input.receiptValues.map(parseSettledStageSlot);
  if (parsed.some((slot) => slot === null)) return { ok: false, code: STAGE_AUTHORITY_INVALID, message: 'canonical receipt inventory contains a malformed stage receipt', topology, intake };
  const slots = parsed as SettledStageSlot[];
  const episodeId = `${intake.taskIdentity}@${intake.firstRevision}`;
  if (slots.some((slot) => slot.reviewEpisodeId !== episodeId)) return { ok: false, code: STAGE_AUTHORITY_INVALID, message: 'canonical receipt inventory mixes reviewEpisodeId values', topology, intake, slots };
  if (slots.some((slot) => slot.taskIdentity !== intake.taskIdentity)) return { ok: false, code: STAGE_AUTHORITY_INVALID, message: 'canonical receipt inventory mixes taskIdentity values', topology, intake, slots };
  if (slots.some((slot) => slot.episodeFirstRevision !== intake.firstRevision)) return { ok: false, code: STAGE_AUTHORITY_INVALID, message: 'canonical receipt inventory mixes episodeFirstRevision values', topology, intake, slots };

  const consumed = slots.find((slot) => slot.stage === input.stage);
  if (consumed) return {
    ok: false,
    code: STAGE_SLOT_CONSUMED,
    message: `${input.stage} semantic stage slot was permanently consumed by ${consumed.stageAttemptId} (${consumed.outcome})`,
    consumingStageAttemptId: consumed.stageAttemptId,
    topology,
    intake,
    slots,
  };

  const sequence = admissionStageSequence(topology, slots);
  if (sequence.errors.length > 0) return { ok: false, code: STAGE_ORDER_VIOLATION, message: sequence.errors.join('; '), expectedStage: sequence.expectedStage, predecessorStage: sequence.predecessorStage, topology, intake, slots };
  if (sequence.expectedStage !== input.stage) return {
    ok: false,
    code: STAGE_ORDER_VIOLATION,
    message: sequence.expectedStage ? `expected next stage ${sequence.expectedStage}; requested ${input.stage}; predecessor=${sequence.predecessorStage ?? 'none'}` : `review episode has no remaining stage slot; requested ${input.stage}`,
    expectedStage: sequence.expectedStage,
    predecessorStage: sequence.predecessorStage,
    topology,
    intake,
    slots,
  };
  if ((input.stage === 'architectural-lens' || input.stage === 'architectural') && !input.terminalBundle) return {
    ok: false,
    code: TERMINAL_BUNDLE_UNAVAILABLE,
    message: `${input.stage} requires a composable terminal input bundle before stageAttemptId minting`,
    expectedStage: sequence.expectedStage,
    predecessorStage: sequence.predecessorStage,
    topology,
    intake,
    slots,
  };
  if (input.terminalBundle) {
    if (input.terminalBundle.reviewEpisodeId !== episodeId) return { ok: false, code: TERMINAL_BUNDLE_UNAVAILABLE, message: 'terminal bundle reviewEpisodeId is stale or foreign', topology, intake, slots };
    if (input.terminalBundle.sourceRevision !== input.sourceRevision || input.terminalBundle.currentIssue.sourceRevision !== input.sourceRevision || input.terminalBundle.currentIssue.body !== input.issueBody) return { ok: false, code: TERMINAL_BUNDLE_UNAVAILABLE, message: 'terminal bundle does not bind the exact live Issue revision bytes', topology, intake, slots };
    if (input.terminalBundle.predecessorStage !== sequence.predecessorStage) return { ok: false, code: TERMINAL_BUNDLE_UNAVAILABLE, message: 'terminal bundle predecessor binding is stale', topology, intake, slots };
  }
  return { ok: true, expectedStage: sequence.expectedStage, predecessorStage: sequence.predecessorStage, topology, intake, slots };
}

export function loadCanonicalLifecycleAuthority(issueNumber: number, stateRootOverride?: string): CanonicalLifecycleAuthority {
  const canonical = resolveCanonicalReviewDirectory({ taskIdentity: `issue:${issueNumber}` }, stateRootOverride);
  if (!existsSync(canonical.intakePath)) throw new Error(`missing canonical tier-intake/v1: ${canonical.intakePath}`);
  const receiptPaths = existsSync(canonical.directory)
    ? readdirSync(canonical.directory).filter((name) => /^stage-completeness-receipt-.+\.json$/.test(name)).map((name) => join(canonical.directory, name)).sort()
    : [];
  return { reviewDir: canonical.directory, intakePath: canonical.intakePath, intake: readJson(canonical.intakePath), receiptPaths, receiptValues: receiptPaths.map(readJson) };
}

function requiredJsonRecord(path: string, label: string): Record<string, unknown> {
  if (!existsSync(path)) throw new Error(`missing ${label}: ${path}`);
  const value = readJson(path);
  if (!isRecord(value)) throw new Error(`${label} must be a JSON object: ${path}`);
  return value;
}

function rawFindingCountFromReceipts(receipts: readonly unknown[]): number {
  let count = 0;
  for (const value of receipts) {
    if (!isRecord(value) || !Array.isArray(value.relayEligibleCaptures)) continue;
    for (const capture of value.relayEligibleCaptures) {
      if (!isRecord(capture) || !Number.isInteger(capture.rawFindingCount) || Number(capture.rawFindingCount) < 0) throw new Error('canonical receipt has malformed relayEligibleCaptures review-economics evidence');
      count += Number(capture.rawFindingCount);
    }
  }
  return count;
}

export function composeTerminalBundle(input: {
  reviewDir: string;
  reviewEpisodeId: string;
  sourceRevision: string;
  predecessorStage: LifecycleReviewStage | null;
  issueBody: string;
}): TerminalBundleV1 {
  const marker = SOURCE_REVISION_MARKER_RE.exec(input.issueBody)?.[1];
  if (marker !== input.sourceRevision) throw new Error('terminal bundle Issue bytes do not contain the requested source-revision marker');
  const authorityReceipts = readdirSync(input.reviewDir)
    .filter((name) => /^stage-completeness-receipt-.+\.json$/.test(name))
    .map((name) => readJson(join(input.reviewDir, name)));
  const slots = authorityReceipts.map(parseSettledStageSlot);
  if (slots.some((slot) => slot === null)) throw new Error('terminal bundle canonical receipt inventory is malformed');
  const settled = (slots as SettledStageSlot[]).sort((left, right) => left.stageSequence - right.stageSequence);
  if (settled.some((slot) => slot.reviewEpisodeId !== input.reviewEpisodeId)) throw new Error('terminal bundle canonical receipt inventory is stale or foreign');
  const successful = settled.filter((slot) => slot.outcome === 'complete' || slot.outcome === 'partial');
  const actualPredecessor = successful.at(-1)?.stage ?? null;
  if (actualPredecessor !== input.predecessorStage) throw new Error(`terminal bundle predecessor is stale: expected ${input.predecessorStage ?? 'none'}, canonical receipt chain ends at ${actualPredecessor ?? 'none'}`);

  const author = requiredJsonRecord(join(input.reviewDir, 'author-dispositions.json'), 'author dispositions');
  if (author.schema !== AUTHOR_DISPOSITIONS_SCHEMA || !Array.isArray(author.findings)) throw new Error(`author dispositions must use ${AUTHOR_DISPOSITIONS_SCHEMA}`);
  if (author.reviewEpisodeId !== input.reviewEpisodeId) throw new Error('author dispositions reviewEpisodeId binding is stale or foreign');
  if (author.sourceRevision !== input.sourceRevision) throw new Error('author dispositions sourceRevision binding is stale');
  if ((author.predecessorStage ?? null) !== input.predecessorStage) throw new Error('author dispositions predecessorStage binding is stale');
  if (author.draft !== input.issueBody) throw new Error('author dispositions draft binding does not equal the exact live Issue bytes');

  const ledger = requiredJsonRecord(join(input.reviewDir, 'finding-disposition-ledger.json'), 'finding disposition ledger');
  const counts = isRecord(ledger.counts) ? ledger.counts : null;
  if (!counts || !Number.isInteger(counts.rawFindingCount) || Number(counts.rawFindingCount) < 0) throw new Error('finding disposition ledger is missing review-economics rawFindingCount');
  if (ledger.draft !== input.issueBody) throw new Error('finding disposition ledger is not bound to the exact live Issue bytes');
  if (!Array.isArray(ledger.findings) || !jsonEqual(ledger.findings, author.findings)) throw new Error('finding disposition ledger findings do not match the bound author disposition record');
  const receiptRawFindingCount = rawFindingCountFromReceipts(authorityReceipts);
  if (Number(counts.rawFindingCount) !== receiptRawFindingCount) throw new Error(`finding disposition ledger is stale for current receipt chain: ledger rawFindingCount=${String(counts.rawFindingCount)} receipts=${receiptRawFindingCount}`);

  const findings = author.findings.filter(isRecord);
  if (findings.length !== author.findings.length) throw new Error('author dispositions findings must all be objects');
  const rejectPartition = findings.filter((finding) => finding.defectDisposition === 'rejected-as-false');
  const protectedM3 = findings.filter((finding) => Boolean(finding.architectRequired) || finding.protectedActivation !== undefined || finding.protectedType !== undefined);
  const authorM4 = findings.map((finding) => ({ id: finding.id, remedyDisposition: finding.remedyDisposition ?? null, simplificationCutCandidate: finding.simplificationCutCandidate ?? false }));
  return {
    schema: 'create-issue-terminal-input-bundle/v1',
    reviewEpisodeId: input.reviewEpisodeId,
    sourceRevision: input.sourceRevision,
    predecessorStage: input.predecessorStage,
    currentIssue: { sourceRevision: input.sourceRevision, body: input.issueBody },
    rejectPartition,
    protectedM3,
    authorM4,
    reviewEconomics: {
      ...counts,
      reviewEpisodeId: input.reviewEpisodeId,
      sourceRevision: input.sourceRevision,
      predecessorStage: input.predecessorStage,
      evidenceBasis: 'receipt-backed-finding-ledger/v1',
    },
  };
}
