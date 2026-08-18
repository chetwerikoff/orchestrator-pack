import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveCanonicalReviewDirectory } from './canonical-review-directory.ts';

export type LifecycleReviewTier = 'T1' | 'T2' | 'T3';
export type LifecycleReviewStage = 'competitive' | 'architectural-review' | 'architectural-lens' | 'architectural';
export type CompetitiveDecision = 'required' | 'skipped';
export type LifecycleSettledOutcome = 'complete' | 'partial' | 'blocked' | 'incident';

export const STAGE_SLOT_CONSUMED = 'stage_slot_consumed' as const;
export const STAGE_ORDER_VIOLATION = 'stage_order_violation' as const;
export const STAGE_AUTHORITY_INVALID = 'stage_authority_invalid' as const;
export const TERMINAL_BUNDLE_UNAVAILABLE = 'terminal_bundle_unavailable' as const;

const STAGE_RECEIPT_SCHEMA = 'stage-completeness-receipt/v1';
const AUTHOR_DISPOSITIONS_SCHEMA = 'create-issue-author-dispositions/v1';
const SOURCE_REVISION_RE = /^r[0-9]+$/;
const SOURCE_REVISION_MARKER_RE = /<!--\s*source-revision:\s*(r[0-9]+)\s*-->/i;
const SETTLED_OUTCOMES = new Set<LifecycleSettledOutcome>(['complete', 'partial', 'blocked', 'incident']);
const REVIEW_STAGES = new Set<LifecycleReviewStage>([
  'competitive',
  'architectural-review',
  'architectural-lens',
  'architectural',
]);

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

export interface CanonicalStageTopologyEntry {
  stage: LifecycleReviewStage;
  reviewerCardinality: 1 | 3;
  producer: 'browser-gpt' | 'claude-cli';
}

export interface CanonicalStageTopologyV1 {
  schema: 'create-issue-stage-topology-plan/v1';
  tier: LifecycleReviewTier;
  competitiveDecision: CompetitiveDecision | 'not-applicable';
  competitiveRationale: string | null;
  stages: CanonicalStageTopologyEntry[];
}

export interface SettledStageSlot {
  stage: LifecycleReviewStage;
  stageAttemptId: string;
  stageSequence: number;
  sourceRevision: string;
  outcome: LifecycleSettledOutcome;
  reviewEpisodeId?: string;
  taskIdentity?: string;
  episodeFirstRevision?: string;
}

export interface TerminalBundleV1 {
  schema: 'create-issue-terminal-input-bundle/v1';
  reviewEpisodeId: string;
  sourceRevision: string;
  predecessorStage: LifecycleReviewStage | null;
  currentIssue: {
    sourceRevision: string;
    body: string;
  };
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
  const competitiveRationale = nonEmpty(value.competitiveRationale)
    ? value.competitiveRationale.trim()
    : undefined;
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

export function canonicalStageTopology(
  tier: LifecycleReviewTier,
  intake: LifecycleTierIntakeV1,
): CanonicalStageTopologyV1 {
  if (tier === 'T1') {
    return {
      schema: 'create-issue-stage-topology-plan/v1',
      tier,
      competitiveDecision: 'not-applicable',
      competitiveRationale: null,
      stages: [{ stage: 'architectural', reviewerCardinality: 1, producer: 'browser-gpt' }],
    };
  }
  if (tier === 'T2') {
    return {
      schema: 'create-issue-stage-topology-plan/v1',
      tier,
      competitiveDecision: 'not-applicable',
      competitiveRationale: null,
      stages: [
        { stage: 'architectural-review', reviewerCardinality: 3, producer: 'browser-gpt' },
        { stage: 'architectural', reviewerCardinality: 1, producer: 'browser-gpt' },
      ],
    };
  }

  if (!intake.competitiveDecision || !intake.competitiveRationale) {
    throw new Error('fresh T3 tier-intake/v1 must freeze competitiveDecision and a non-empty competitiveRationale');
  }
  const competitive = intake.competitiveDecision === 'required'
    ? [{ stage: 'competitive', reviewerCardinality: 3, producer: 'browser-gpt' } as const]
    : [];
  return {
    schema: 'create-issue-stage-topology-plan/v1',
    tier,
    competitiveDecision: intake.competitiveDecision,
    competitiveRationale: intake.competitiveRationale,
    stages: [
      ...competitive,
      { stage: 'architectural-review', reviewerCardinality: 3, producer: 'browser-gpt' },
      { stage: 'architectural-lens', reviewerCardinality: 1, producer: 'claude-cli' },
      { stage: 'architectural', reviewerCardinality: 1, producer: 'browser-gpt' },
    ],
  };
}

export function parseSettledStageSlot(value: unknown): SettledStageSlot | null {
  if (!isRecord(value) || value.schema !== STAGE_RECEIPT_SCHEMA) return null;
  const stage = REVIEW_STAGES.has(value.stage as LifecycleReviewStage)
    ? value.stage as LifecycleReviewStage
    : null;
  const outcome = SETTLED_OUTCOMES.has(value.outcome as LifecycleSettledOutcome)
    ? value.outcome as LifecycleSettledOutcome
    : null;
  if (
    !stage
    || !outcome
    || !nonEmpty(value.stageAttemptId)
    || !Number.isInteger(value.stageSequence)
    || Number(value.stageSequence) < 1
    || !nonEmpty(value.sourceRevision)
  ) return null;
  return {
    stage,
    stageAttemptId: value.stageAttemptId.trim(),
    stageSequence: Number(value.stageSequence),
    sourceRevision: value.sourceRevision.trim(),
    outcome,
    ...(nonEmpty(value.reviewEpisodeId) ? { reviewEpisodeId: value.reviewEpisodeId.trim() } : {}),
    ...(nonEmpty(value.taskIdentity) ? { taskIdentity: value.taskIdentity.trim() } : {}),
    ...(nonEmpty(value.episodeFirstRevision) ? { episodeFirstRevision: value.episodeFirstRevision.trim() } : {}),
  };
}

export function admissionStageSequence(
  topology: CanonicalStageTopologyV1,
  slots: readonly SettledStageSlot[],
): { expectedStage: LifecycleReviewStage | null; predecessorStage: LifecycleReviewStage | null; errors: string[] } {
  const errors: string[] = [];
  const stageOrder = topology.stages.map((entry) => entry.stage);
  const byStage = new Map<LifecycleReviewStage, SettledStageSlot[]>();
  for (const slot of slots) {
    if (!stageOrder.includes(slot.stage)) {
      errors.push(`settled stage ${slot.stage} is outside canonical ${topology.tier} topology`);
      continue;
    }
    const stageSlots = byStage.get(slot.stage) ?? [];
    stageSlots.push(slot);
    byStage.set(slot.stage, stageSlots);
  }
  for (const [stage, stageSlots] of byStage) {
    if (stageSlots.length > 1) errors.push(`${stage} has ${stageSlots.length} settled stageAttemptId values; a semantic stage slot is Issue-lifetime singular`);
  }
  const consumed = new Set(slots.map((slot) => slot.stage));
  const expectedIndex = stageOrder.findIndex((stage) => !consumed.has(stage));
  const expectedStage = expectedIndex < 0 ? null : stageOrder[expectedIndex]!;
  const predecessorStage = expectedIndex <= 0 ? null : stageOrder[expectedIndex - 1]!;
  if (expectedIndex >= 0) {
    for (let index = expectedIndex + 1; index < stageOrder.length; index += 1) {
      if (consumed.has(stageOrder[index]!)) {
        errors.push(`${stageOrder[index]} is settled before required predecessor ${expectedStage}`);
      }
    }
  }
  return { expectedStage, predecessorStage, errors };
}

export function admitStageLaunch(input: StageAdmissionInput): StageAdmissionResult {
  const intake = parseLifecycleTierIntake(input.intake);
  if (!intake) {
    return { ok: false, code: STAGE_AUTHORITY_INVALID, message: 'canonical tier-intake/v1 is missing or malformed' };
  }
  if (taskIssueNumber(intake.taskIdentity) !== input.issueNumber) {
    return { ok: false, code: STAGE_AUTHORITY_INVALID, message: `tier-intake taskIdentity ${intake.taskIdentity} does not bind Issue #${input.issueNumber}` };
  }
  const marker = SOURCE_REVISION_MARKER_RE.exec(input.issueBody)?.[1];
  if (!marker || marker !== input.sourceRevision) {
    return { ok: false, code: STAGE_AUTHORITY_INVALID, message: `live Issue source-revision marker ${marker ?? '<missing>'} does not match launch revision ${input.sourceRevision}` };
  }

  let topology: CanonicalStageTopologyV1;
  try {
    topology = canonicalStageTopology(input.tier, intake);
  } catch (error) {
    return {
      ok: false,
      code: STAGE_AUTHORITY_INVALID,
      message: error instanceof Error ? error.message : String(error),
      intake,
    };
  }
  const parsedSlots = input.receiptValues.map(parseSettledStageSlot);
  if (parsedSlots.some((slot) => slot === null)) {
    return { ok: false, code: STAGE_AUTHORITY_INVALID, message: 'canonical receipt inventory contains a malformed stage receipt', topology, intake };
  }
  const slots = parsedSlots as SettledStageSlot[];
  const episodeId = `${intake.taskIdentity}@${intake.firstRevision}`;
  if (slots.some((slot) => slot.reviewEpisodeId && slot.reviewEpisodeId !== episodeId)) {
    return { ok: false, code: STAGE_AUTHORITY_INVALID, message: 'canonical receipt inventory mixes reviewEpisodeId values', topology, intake, slots };
  }
  if (slots.some((slot) => slot.taskIdentity && slot.taskIdentity !== intake.taskIdentity)) {
    return { ok: false, code: STAGE_AUTHORITY_INVALID, message: 'canonical receipt inventory mixes taskIdentity values', topology, intake, slots };
  }
  if (slots.some((slot) => slot.episodeFirstRevision && slot.episodeFirstRevision !== intake.firstRevision)) {
    return { ok: false, code: STAGE_AUTHORITY_INVALID, message: 'canonical receipt inventory mixes episodeFirstRevision values', topology, intake, slots };
  }
  const consumed = slots.find((slot) => slot.stage === input.stage);
  if (consumed) {
    return {
      ok: false,
      code: STAGE_SLOT_CONSUMED,
      message: `${input.stage} semantic stage slot was permanently consumed by ${consumed.stageAttemptId} (${consumed.outcome})`,
      consumingStageAttemptId: consumed.stageAttemptId,
      topology,
      intake,
      slots,
    };
  }

  const sequence = admissionStageSequence(topology, slots);
  if (sequence.errors.length > 0) {
    return {
      ok: false,
      code: STAGE_AUTHORITY_INVALID,
      message: sequence.errors.join('; '),
      expectedStage: sequence.expectedStage,
      predecessorStage: sequence.predecessorStage,
      topology,
      intake,
      slots,
    };
  }
  if (sequence.expectedStage !== input.stage) {
    return {
      ok: false,
      code: STAGE_ORDER_VIOLATION,
      message: sequence.expectedStage
        ? `expected next stage ${sequence.expectedStage}; requested ${input.stage}; predecessor=${sequence.predecessorStage ?? 'none'}`
        : `review episode has no remaining stage slot; requested ${input.stage}`,
      expectedStage: sequence.expectedStage,
      predecessorStage: sequence.predecessorStage,
      topology,
      intake,
      slots,
    };
  }
  if ((input.stage === 'architectural-lens' || input.stage === 'architectural') && !input.terminalBundle) {
    return {
      ok: false,
      code: TERMINAL_BUNDLE_UNAVAILABLE,
      message: `${input.stage} requires a composable terminal input bundle before stageAttemptId minting`,
      expectedStage: sequence.expectedStage,
      predecessorStage: sequence.predecessorStage,
      topology,
      intake,
      slots,
    };
  }
  if (input.terminalBundle) {
    if (input.terminalBundle.reviewEpisodeId !== episodeId) {
      return { ok: false, code: TERMINAL_BUNDLE_UNAVAILABLE, message: 'terminal bundle reviewEpisodeId is stale or foreign', topology, intake, slots };
    }
    if (input.terminalBundle.sourceRevision !== input.sourceRevision || input.terminalBundle.currentIssue.sourceRevision !== input.sourceRevision || input.terminalBundle.currentIssue.body !== input.issueBody) {
      return { ok: false, code: TERMINAL_BUNDLE_UNAVAILABLE, message: 'terminal bundle does not bind the exact live Issue revision bytes', topology, intake, slots };
    }
    if (input.terminalBundle.predecessorStage !== sequence.predecessorStage) {
      return { ok: false, code: TERMINAL_BUNDLE_UNAVAILABLE, message: 'terminal bundle predecessor binding is stale', topology, intake, slots };
    }
  }
  return {
    ok: true,
    expectedStage: sequence.expectedStage,
    predecessorStage: sequence.predecessorStage,
    topology,
    intake,
    slots,
  };
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

export function loadCanonicalLifecycleAuthority(
  issueNumber: number,
  stateRootOverride?: string,
): CanonicalLifecycleAuthority {
  const canonical = resolveCanonicalReviewDirectory({ taskIdentity: `issue:${issueNumber}` }, stateRootOverride);
  if (!existsSync(canonical.intakePath)) throw new Error(`missing canonical tier-intake/v1: ${canonical.intakePath}`);
  const receiptPaths = existsSync(canonical.directory)
    ? readdirSync(canonical.directory)
      .filter((name) => /^stage-completeness-receipt-.+\.json$/.test(name))
      .map((name) => join(canonical.directory, name))
      .sort()
    : [];
  return {
    reviewDir: canonical.directory,
    intakePath: canonical.intakePath,
    intake: readJson(canonical.intakePath),
    receiptPaths,
    receiptValues: receiptPaths.map(readJson),
  };
}

function requiredJsonRecord(path: string, label: string): Record<string, unknown> {
  if (!existsSync(path)) throw new Error(`missing ${label}: ${path}`);
  const value = readJson(path);
  if (!isRecord(value)) throw new Error(`${label} must be a JSON object: ${path}`);
  return value;
}

export function composeTerminalBundle(input: {
  reviewDir: string;
  reviewEpisodeId: string;
  sourceRevision: string;
  predecessorStage: LifecycleReviewStage | null;
  issueBody: string;
}): TerminalBundleV1 {
  const author = requiredJsonRecord(join(input.reviewDir, 'author-dispositions.json'), 'author dispositions');
  if (author.schema !== AUTHOR_DISPOSITIONS_SCHEMA || !Array.isArray(author.findings)) {
    throw new Error(`author dispositions must use ${AUTHOR_DISPOSITIONS_SCHEMA}`);
  }
  const ledger = requiredJsonRecord(join(input.reviewDir, 'finding-disposition-ledger.json'), 'finding disposition ledger');
  const inventory = requiredJsonRecord(join(input.reviewDir, 'review-episode-inventory.json'), 'review episode inventory');
  if (inventory.reviewEpisodeId !== input.reviewEpisodeId) {
    throw new Error('review episode inventory is stale or foreign');
  }
  const findings = author.findings.filter(isRecord);
  if (findings.length !== author.findings.length) throw new Error('author dispositions findings must all be objects');
  const rejectPartition = findings.filter((finding) => finding.defectDisposition === 'rejected-as-false');
  const protectedM3 = findings.filter((finding) => Boolean(finding.architectRequired) || finding.protectedActivation !== undefined);
  const authorM4 = findings.map((finding) => ({
    id: finding.id,
    remedyDisposition: finding.remedyDisposition ?? null,
    simplificationCutCandidate: finding.simplificationCutCandidate ?? false,
  }));
  const counts = isRecord(ledger.counts) ? ledger.counts : null;
  if (!counts) throw new Error('finding disposition ledger is missing review-economics counts');
  const marker = SOURCE_REVISION_MARKER_RE.exec(input.issueBody)?.[1];
  if (marker !== input.sourceRevision) throw new Error('terminal bundle Issue bytes do not contain the requested source-revision marker');
  return {
    schema: 'create-issue-terminal-input-bundle/v1',
    reviewEpisodeId: input.reviewEpisodeId,
    sourceRevision: input.sourceRevision,
    predecessorStage: input.predecessorStage,
    currentIssue: { sourceRevision: input.sourceRevision, body: input.issueBody },
    rejectPartition,
    protectedM3,
    authorM4,
    reviewEconomics: counts,
  };
}
