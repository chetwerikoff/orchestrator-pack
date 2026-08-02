import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  deriveReviewEpisodeId,
  deriveReviewEpisodeState,
  deriveStageReceiptId,
  validateReviewEpisodeTopology,
  CLAUDE_PRODUCER_EVIDENCE_SCHEMA,
  type CaptureIdentityV1,
  type ReviewerInvocationEnvelopeV1,
  type ReviewEpisodeDerivationAuthorityV1,
  type ReviewStage,
  type ReviewTier,
  type StageCompletenessReceiptV1,
  type TierIntakeAuthorityV1,
  type VerifiedRelayEvidenceV1,
} from './stage-completeness-core.ts';
import { checkFindingLedgerGuard } from '../finding-ledger-guard.mjs';

export const STAGE_EVIDENCE_SCHEMA = 'create-issue-stage-evidence/v1' as const;
export const AUTHOR_DISPOSITIONS_SCHEMA = 'create-issue-author-dispositions/v1' as const;
export const ARTIFACT_MANIFEST_SCHEMA = 'create-issue-acceptance-artifacts/v1' as const;

export const DEFECT_DISPOSITION_VALUES = [
  'addressed',
  'rejected-as-false',
  'unresolved',
] as const;
export const REMEDY_DISPOSITION_VALUES = [
  'accepted',
  'replaced-by-cheaper-sufficient',
  'rejected-as-overengineering',
] as const;

type JsonRecord = Record<string, unknown>;
type CycleBinding = { cycleId: string; sourceRevision: string; boundBeforeLaunch: true };
type ProducedStageReceipt = StageCompletenessReceiptV1 & { cycleId: string; cycleBinding: CycleBinding };

export interface ProduceAcceptanceArtifactsOptions {
  reviewDir: string;
  tierIntakePath: string;
  stageEvidencePaths: string[];
  authorDispositionsPath: string;
  claudeProducerEvidencePaths?: string[];
  outputDir?: string;
  phase?: 'pre-lens' | 'final-acceptance';
}

export interface AcceptanceArtifactMissingInput {
  artifact: string;
  reason: string;
}

export interface AcceptanceArtifactResult {
  ok: boolean;
  outputDir: string;
  files: string[];
  missing: AcceptanceArtifactMissingInput[];
  errors: string[];
  reviewEpisodeId?: string;
}

export interface AcceptanceArtifactStatus {
  ok: boolean;
  present: string[];
  missing: AcceptanceArtifactMissingInput[];
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value: unknown, label: string, errors: string[]): string {
  if (typeof value !== 'string' || value.trim() === '') {
    errors.push(`${label} is missing`);
    return '';
  }
  return value.trim();
}

function reviewTier(value: unknown): ReviewTier | null {
  return value === 'T1' || value === 'T2' || value === 'T3' ? value : null;
}

function reviewStage(value: unknown): ReviewStage | null {
  return value === 'competitive'
    || value === 'architectural-review'
    || value === 'architectural-lens'
    || value === 'architectural'
    ? value
    : null;
}

function reviewerStage(value: unknown): Exclude<ReviewStage, 'architectural-lens'> | null {
  return value === 'competitive'
    || value === 'architectural-review'
    || value === 'architectural'
    ? value
    : null;
}

function policyVersion(value: unknown): ReviewerInvocationEnvelopeV1['policyVersion'] | null {
  return value === 'triple-source/v1' || value === 'single-source/v1' ? value : null;
}

function terminalClassification(value: unknown): ReviewerInvocationEnvelopeV1['terminalClassification'] | null {
  return value === 'complete'
    || value === 'quota'
    || value === 'composer-refusal'
    || value === 'fill-timeout'
    || value === 'post-send-failure'
    || value === 'output-conflict'
    || value === 'incident'
    ? value
    : null;
}

function retryClass(value: unknown): ReviewerInvocationEnvelopeV1['retryClass'] | null {
  return value === 'none'
    || value === 'eligible-zero-send'
    || value === 'retry'
    || value === 'retry-forbidden'
    ? value
    : null;
}

function capacityOutcome(value: unknown): ReviewerInvocationEnvelopeV1['capacityOutcome'] | null {
  return value === 'admitted' || value === 'rejected-after-local-wait' ? value : null;
}

function buildInvocation(
  value: JsonRecord,
  index: number,
  context: Pick<
    StageCompletenessReceiptV1,
    | 'reviewEpisodeId'
    | 'stageAttemptId'
    | 'policyVersion'
    | 'reviewerCardinality'
    | 'cardinalityConfigIdentity'
    | 'stage'
    | 'sourceRevision'
  >,
  capture: CaptureIdentityV1 | undefined,
  errors: string[],
): ReviewerInvocationEnvelopeV1 | null {
  const label = `stage ${context.stage} invocation[${index}]`;
  const schema = value.schema === 'reviewer-invocation-envelope/v1' ? value.schema : null;
  const reviewEpisodeId = requiredString(value.reviewEpisodeId, `${label}.reviewEpisodeId`, errors);
  const stageAttemptId = requiredString(value.stageAttemptId, `${label}.stageAttemptId`, errors);
  const invocationPolicyVersion = policyVersion(value.policyVersion);
  const cardinalityConfigIdentity = requiredString(
    value.cardinalityConfigIdentity,
    `${label}.cardinalityConfigIdentity`,
    errors,
  );
  const stage = reviewerStage(value.stage);
  const sourceRevision = requiredString(value.sourceRevision, `${label}.sourceRevision`, errors);
  const invocationId = requiredString(value.invocationId, `${label}.invocationId`, errors);
  const terminalResultIdentity = requiredString(
    value.terminalResultIdentity,
    `${label}.terminalResultIdentity`,
    errors,
  );
  const reviewerSource = requiredString(value.reviewerSource, `${label}.reviewerSource`, errors);
  const reviewerSlot = requiredString(value.reviewerSlot, `${label}.reviewerSlot`, errors);
  const reviewerOrdinal = Number.isInteger(value.reviewerOrdinal) && Number(value.reviewerOrdinal) >= 1
    ? Number(value.reviewerOrdinal)
    : null;
  const attemptOrdinal = value.attemptOrdinal === 1 || value.attemptOrdinal === 2
    ? value.attemptOrdinal
    : null;
  const retryAttempt = typeof value.retryAttempt === 'boolean' ? value.retryAttempt : null;
  const terminal = typeof value.terminal === 'boolean' ? value.terminal : null;
  const invocationTerminalClassification = terminalClassification(value.terminalClassification);
  const sendCount = value.sendCount === 0 || value.sendCount === 1 ? value.sendCount : null;
  const invocationRetryClass = retryClass(value.retryClass);
  const revisionCheck = value.revisionCheck === 'matched' ? value.revisionCheck : null;
  const invocationCapacityOutcome = capacityOutcome(value.capacityOutcome);
  const capacityWaitMs = Number.isInteger(value.capacityWaitMs) && Number(value.capacityWaitMs) >= 0
    ? Number(value.capacityWaitMs)
    : null;
  const contextMatches = reviewEpisodeId === context.reviewEpisodeId
    && stageAttemptId === context.stageAttemptId
    && invocationPolicyVersion === context.policyVersion
    && value.reviewerCardinality === context.reviewerCardinality
    && cardinalityConfigIdentity === context.cardinalityConfigIdentity
    && stage === context.stage
    && sourceRevision === context.sourceRevision;

  if (schema === null) errors.push(`${label} has unknown schema`);
  if (invocationPolicyVersion === null) errors.push(`${label} has unknown policyVersion`);
  if (stage === null) errors.push(`${label} has unknown stage`);
  if (reviewerOrdinal === null) errors.push(`${label}.reviewerOrdinal must be a positive integer`);
  if (attemptOrdinal === null) errors.push(`${label}.attemptOrdinal must be 1 or 2`);
  if (retryAttempt === null) errors.push(`${label}.retryAttempt must be boolean`);
  if (terminal === null) errors.push(`${label}.terminal must be boolean`);
  if (invocationTerminalClassification === null) errors.push(`${label} has unknown terminalClassification`);
  if (sendCount === null) errors.push(`${label}.sendCount must be 0 or 1`);
  if (invocationRetryClass === null) errors.push(`${label} has unknown retryClass`);
  if (revisionCheck === null) errors.push(`${label}.revisionCheck must be matched`);
  if (invocationCapacityOutcome === null) errors.push(`${label} has unknown capacityOutcome`);
  if (capacityWaitMs === null) errors.push(`${label}.capacityWaitMs must be a non-negative integer`);
  if (!contextMatches) errors.push(`${label} does not match its stage receipt`);

  if (
    schema === null
    || invocationPolicyVersion === null
    || stage === null
    || reviewerOrdinal === null
    || attemptOrdinal === null
    || retryAttempt === null
    || terminal === null
    || invocationTerminalClassification === null
    || sendCount === null
    || invocationRetryClass === null
    || revisionCheck === null
    || invocationCapacityOutcome === null
    || capacityWaitMs === null
    || !contextMatches
  ) {
    return null;
  }
  return {
    schema,
    reviewEpisodeId,
    stageAttemptId,
    policyVersion: invocationPolicyVersion,
    reviewerCardinality: context.reviewerCardinality,
    cardinalityConfigIdentity,
    stage,
    sourceRevision,
    invocationId,
    terminalResultIdentity,
    reviewerSource,
    reviewerSlot,
    reviewerOrdinal,
    attemptOrdinal,
    retryAttempt,
    terminal,
    terminalClassification: invocationTerminalClassification,
    sendCount,
    retryClass: invocationRetryClass,
    revisionCheck,
    capacityOutcome: invocationCapacityOutcome,
    capacityWaitMs,
    ...(capture ? { capture } : {}),
  };
}

function readJson(path: string, label: string, errors: string[]): unknown | null {
  if (!existsSync(path)) {
    errors.push(`missing ${label}: ${path}`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    errors.push(`unable to read ${label}: ${path}`);
    return null;
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function rawFindingCount(text: string): number {
  const withoutFences = text.replace(/```[\s\S]*?```/g, '');
  return withoutFences
    .split(/\r?\n/)
    .filter((line) => !/^\s*>/.test(line))
    .filter((line) => /^id:\s*/i.test(line.trim()))
    .length;
}

function readClaudeProducerEvidence(
  path: string,
  errors: string[],
): unknown[] {
  if (!existsSync(path)) {
    errors.push(`missing ${CLAUDE_PRODUCER_EVIDENCE_SCHEMA}: ${path}`);
    return [];
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    errors.push(`unable to read ${CLAUDE_PRODUCER_EVIDENCE_SCHEMA}: ${path}`);
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function captureIdentity(name: string, digest: string): string {
  return `sha256:${digest}:${name}`;
}

function captureFromEvidence(
  evidencePath: string,
  capturePathValue: unknown,
  assertedIdentity: unknown,
  captureTexts: Map<string, string>,
  captureTimestamps: Map<string, number>,
  errors: string[],
): CaptureIdentityV1 | null {
  const capturePath = requiredString(capturePathValue, 'capturePath', errors);
  if (!capturePath) return null;
  const resolved = resolve(dirname(evidencePath), capturePath);
  if (!existsSync(resolved)) {
    errors.push(`missing capture file: ${resolved}`);
    return null;
  }
  let text: string;
  try {
    text = readFileSync(resolved, 'utf8');
  } catch {
    errors.push(`unable to read capture file: ${resolved}`);
    return null;
  }
  const name = basename(resolved);
  const digest = sha256(text);
  const identity = captureIdentity(name, digest);
  captureTexts.set(identity, text);
  try {
    captureTimestamps.set(identity, statSync(resolved).mtimeMs);
  } catch {
    errors.push(`unable to stat capture file: ${resolved}`);
    return null;
  }
  if (assertedIdentity !== undefined && assertedIdentity !== identity) {
    errors.push(`capture identity assertion does not match bytes for ${resolved}`);
  }
  return {
    captureIdentity: identity,
    name,
    byteLength: Buffer.byteLength(text),
    sha256: digest,
    rawFindingCount: rawFindingCount(text),
  };
}

function loadTierIntake(path: string, errors: string[]): TierIntakeAuthorityV1 | null {
  const value = readJson(path, 'tier-intake/v1 evidence', errors);
  if (!isRecord(value) || value.schema !== 'tier-intake/v1') {
    errors.push(`tier-intake/v1 evidence is malformed: ${path}`);
    return null;
  }
  const producer = requiredString(value.producer, 'tier-intake.producer', errors);
  const taskIdentity = requiredString(value.taskIdentity, 'tier-intake.taskIdentity', errors);
  const firstRevision = requiredString(value.firstRevision, 'tier-intake.firstRevision', errors);
  const kind = value.kind === 'fresh' || value.kind === 'compatibility' ? value.kind : null;
  const priorTier = reviewTier(value.priorTier);
  if (kind === null) errors.push('tier-intake.kind is invalid');
  if (priorTier === null) errors.push('tier-intake.priorTier is invalid');
  if (!producer || !taskIdentity || !firstRevision || kind === null || priorTier === null) return null;
  return { schema: 'tier-intake/v1', producer, taskIdentity, kind, priorTier, firstRevision };
}

function assertDerived(
  value: unknown,
  expected: string,
  label: string,
  errors: string[],
): void {
  if (value !== undefined && value !== expected) errors.push(`${label} is not canonical; expected ${expected}`);
}

function buildReceipt(
  evidencePath: string,
  raw: JsonRecord,
  taskIdentity: string,
  episodeFirstRevision: string,
  episodeId: string,
  captureTexts: Map<string, string>,
  captureTimestamps: Map<string, number>,
  errors: string[],
): ProducedStageReceipt | null {
  if (raw.schema !== STAGE_EVIDENCE_SCHEMA) {
    errors.push(`stage evidence has unknown schema: ${evidencePath}`);
    return null;
  }
  const stage = reviewStage(raw.stage);
  const tier = reviewTier(raw.tier);
  if (stage === null) errors.push('stage evidence.stage is invalid');
  if (tier === null) errors.push('stage evidence.tier is invalid');
  if (stage === null || tier === null) return null;
  const stageAttemptId = requiredString(raw.stageAttemptId, 'stage evidence.stageAttemptId', errors);
  if (!isSafeFileComponent(stageAttemptId)) {
    errors.push('stage evidence.stageAttemptId must be a safe output filename component');
    return null;
  }
  const sourceRevision = requiredString(raw.sourceRevision, 'stage evidence.sourceRevision', errors);
  const cycleId = requiredString(raw.cycleId, 'stage evidence.cycleId', errors);
  const cycleBinding = isRecord(raw.cycleBinding) ? raw.cycleBinding : null;
  if (!cycleBinding || cycleBinding.cycleId !== cycleId || cycleBinding.sourceRevision !== sourceRevision || cycleBinding.boundBeforeLaunch !== true) {
    errors.push('stage evidence.cycleBinding must prove the admitted cycle and pre-launch revision');
  }
  const sequence = Number(raw.stageSequence);
  if (!Number.isInteger(sequence) || sequence < 1) errors.push('stage evidence.stageSequence must be positive');
  if (raw.taskIdentity !== undefined && raw.taskIdentity !== taskIdentity) errors.push(`stage evidence taskIdentity does not match ${taskIdentity}`);
  if (raw.episodeFirstRevision !== undefined && raw.episodeFirstRevision !== episodeFirstRevision) errors.push(`stage evidence episodeFirstRevision does not match ${episodeFirstRevision}`);
  assertDerived(raw.reviewEpisodeId, episodeId, 'stage evidence reviewEpisodeId', errors);
  assertDerived(raw.stageReceiptId, deriveStageReceiptId(episodeId, sequence), 'stage evidence stageReceiptId', errors);

  const invocationValues = raw.invocations;
  const invocations: ReviewerInvocationEnvelopeV1[] = [];
  const receiptPolicyVersion = policyVersion(raw.policyVersion);
  if (receiptPolicyVersion === null) errors.push('stage evidence.policyVersion is invalid');
  const captures: CaptureIdentityV1[] = [];
  if (Array.isArray(invocationValues)) {
    for (const [index, value] of invocationValues.entries()) {
      if (!isRecord(value)) {
        errors.push(`stage evidence invocation[${index}] must be an object`);
        continue;
      }
      if (value.capture !== undefined) errors.push(`stage evidence invocation[${index}] capture must be derived from capturePath`);
      if (value.terminalClassification === 'complete' && value.capturePath === undefined) {
        errors.push(`missing capture file evidence for completed invocation[${index}]`);
      }
      const capture = value.capturePath === undefined
        ? null
        : captureFromEvidence(evidencePath, value.capturePath, value.captureIdentity, captureTexts, captureTimestamps, errors);
      if (capture) captures.push(capture);
      assertDerived(value.reviewEpisodeId, episodeId, `invocation[${index}].reviewEpisodeId`, errors);
      if (receiptPolicyVersion !== null) {
        const invocation = buildInvocation(
          value,
          index,
          {
            reviewEpisodeId: episodeId,
            stageAttemptId,
            policyVersion: receiptPolicyVersion,
            reviewerCardinality: Number(raw.reviewerCardinality),
            cardinalityConfigIdentity: requiredString(
              raw.cardinalityConfigIdentity,
              'stage evidence.cardinalityConfigIdentity',
              errors,
            ),
            stage,
            sourceRevision,
          },
          capture ?? undefined,
          errors,
        );
        if (invocation) invocations.push(invocation);
      }
    }
  } else if (stage !== 'architectural-lens') {
    errors.push('stage evidence.invocations is missing');
  }

  let claude: JsonRecord | undefined;
  if (isRecord(raw.claude)) {
    if (raw.claude.capture !== undefined) errors.push('stage evidence claude.capture must be derived from capturePath');
    claude = { ...raw.claude };
    const capture = raw.claude.capturePath === undefined
      ? null
      : captureFromEvidence(evidencePath, raw.claude.capturePath, raw.claude.captureIdentity, captureTexts, captureTimestamps, errors);
    delete claude.capturePath;
    delete claude.captureIdentity;
    if (capture) {
      claude.capture = capture;
      captures.push(capture);
    }
  }

  const receipt: ProducedStageReceipt = {
    schema: 'stage-completeness-receipt/v1',
    tier,
    taskIdentity,
    episodeFirstRevision,
    reviewEpisodeId: episodeId,
    stageReceiptId: deriveStageReceiptId(episodeId, sequence),
    previousStageReceiptId: null,
    receiptCensus: [],
    stageAttemptId,
    stageSequence: sequence,
    stage,
    policyVersion: receiptPolicyVersion ?? 'single-source/v1',
    reviewerCardinality: Number(raw.reviewerCardinality),
    cardinalityConfigIdentity: requiredString(raw.cardinalityConfigIdentity, 'stage evidence.cardinalityConfigIdentity', errors),
    sourceRevision,
    cycleId,
    cycleBinding: cycleBinding as { cycleId: string; sourceRevision: string; boundBeforeLaunch: true },
    outcome: raw.outcome as StageCompletenessReceiptV1['outcome'],
    revisionChecks: raw.revisionChecks as StageCompletenessReceiptV1['revisionChecks'],
    settlement: raw.settlement as StageCompletenessReceiptV1['settlement'],
    ...(invocations.length > 0 ? { invocations } : {}),
    ...(claude ? { claude: claude as unknown as StageCompletenessReceiptV1['claude'] } : {}),
    credentialingCaptures: raw.outcome === 'complete' ? captures : [],
    relayEligibleCaptures: captures,
  };
  return receipt;
}

function isValidSettlement(
  value: unknown,
): value is StageCompletenessReceiptV1['settlement'] {
  return isRecord(value)
    && typeof value.allLaunchedTerminal === 'boolean'
    && (value.retryState === 'none'
      || value.retryState === 'eligible'
      || value.retryState === 'exhausted'
      || value.retryState === 'abandoned')
    && typeof value.finalRevisionMatched === 'boolean';
}

function buildLedger(
  path: string,
  captures: readonly CaptureIdentityV1[],
  errors: string[],
): string | null {
  const raw = readJson(path, 'author dispositions', errors);
  if (!isRecord(raw) || raw.schema !== AUTHOR_DISPOSITIONS_SCHEMA || !Array.isArray(raw.findings)) {
    errors.push(`author dispositions must use ${AUTHOR_DISPOSITIONS_SCHEMA}: ${path}`);
    return null;
  }
  const invalidFindingIndexes = raw.findings.flatMap((finding, index) => (
    isRecord(finding) ? [] : [index]
  ));
  if (invalidFindingIndexes.length > 0) {
    for (const index of invalidFindingIndexes) {
      errors.push(`author dispositions findings[${index}] must be an object`);
    }
    return null;
  }
  const findings = raw.findings as JsonRecord[];
  const ledger = {
    version: 2,
    ...(typeof raw.draft === 'string' ? { draft: raw.draft } : {}),
    counts: {
      rawFindingCount: captures.reduce((sum, capture) => sum + capture.rawFindingCount, 0),
      distinctFindingCount: findings.length,
      processedDistinctCount: findings.filter((finding) => (
        finding.defectDisposition === 'addressed' || finding.defectDisposition === 'rejected-as-false'
      )).length,
    },
    findings,
  };
  return JSON.stringify(ledger, null, 2) + '\n';
}

function relayEvidence(
  episodeId: string,
  captures: readonly CaptureIdentityV1[],
): VerifiedRelayEvidenceV1[] {
  return captures.map((capture) => ({
    relayAttemptId: `${episodeId}:relay:${capture.captureIdentity}`,
    captureIdentity: capture.captureIdentity,
    sourceLabel: `${capture.name}|${capture.captureIdentity}`,
    name: capture.name,
    byteLength: capture.byteLength,
    sha256: capture.sha256,
    verified: true,
  }));
}

function expectedStages(tier: ReviewTier, phase: 'pre-lens' | 'final-acceptance'): ReviewStage[] {
  if (tier === 'T3') {
    return phase === 'pre-lens'
      ? ['competitive', 'architectural-review']
      : ['competitive', 'architectural-review', 'architectural-lens', 'architectural'];
  }
  return ['architectural'];
}

const PRODUCED_ARTIFACT_NAMES = new Set([
  'verified-relay-evidence.json',
  'finding-disposition-ledger.json',
  'review-episode-inventory.json',
  'acceptance-artifacts.json',
]);

function isProducedArtifactName(name: string): boolean {
  return PRODUCED_ARTIFACT_NAMES.has(name)
    || /^stage-completeness-receipt-[^/\\]+\.json$/.test(name);
}

function invalidateOutputArtifacts(outputDir: string): void {
  if (!existsSync(outputDir)) return;
  for (const entry of readdirSync(outputDir, { withFileTypes: true })) {
    if (entry.isFile() && isProducedArtifactName(entry.name)) {
      unlinkSync(join(outputDir, entry.name));
    }
  }
}

function isRecordedStageEvidenceFile(path: string): boolean {
  const name = basename(path);
  if (/^attempt-[^/\\]+\.json$/i.test(name)) return true;
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return isRecord(value) && value.schema === STAGE_EVIDENCE_SCHEMA;
  } catch {
    return false;
  }
}

function stageEvidenceFilesInReviewDir(reviewDir: string): string[] {
  if (!existsSync(reviewDir)) return [];
  try {
    return readdirSync(reviewDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(reviewDir, entry.name))
      .filter((path) => isRecordedStageEvidenceFile(path))
      .sort();
  } catch {
    return [];
  }
}

function resolveCanonicalStageEvidencePaths(
  reviewDir: string,
  requestedPaths: readonly string[],
  errors: string[],
): string[] | null {
  const canonicalPaths = stageEvidenceFilesInReviewDir(reviewDir);
  const canonicalSet = new Set(canonicalPaths.map((path) => resolve(path)));
  const requestedSet = new Set(requestedPaths.map((path) => resolve(path)));
  const missing = canonicalPaths.filter((path) => !requestedSet.has(resolve(path)));
  const unexpected = requestedPaths
    .map((path) => resolve(path))
    .filter((path) => !canonicalSet.has(path));
  if (missing.length > 0) {
    errors.push(`--stage-evidence omitted canonical stage evidence files: ${missing.join(', ')}`);
  }
  if (unexpected.length > 0) {
    errors.push(`--stage-evidence includes files outside the canonical review directory: ${[...new Set(unexpected)].join(', ')}`);
  }
  return missing.length === 0 && unexpected.length === 0 ? canonicalPaths : null;
}

function isSafeFileComponent(value: string): boolean {
  return value.length > 0
    && value !== '.'
    && value !== '..'
    && !value.includes('/')
    && !value.includes('\\')
    && !value.includes('..');
}

function publishArtifactSet(
  outputDir: string,
  files: readonly string[],
  contents: ReadonlyMap<string, string>,
): void {
  const parentDir = dirname(outputDir);
  mkdirSync(parentDir, { recursive: true });
  const stagingDir = mkdtempSync(join(parentDir, `.${basename(outputDir)}.tmp-`));
  const movedTargets: string[] = [];
  try {
    for (const file of files) {
      writeFileSync(join(stagingDir, file), contents.get(file) ?? '');
    }
    mkdirSync(outputDir, { recursive: true });
    for (const file of files) {
      const target = join(outputDir, file);
      if (existsSync(target)) {
        const targetStat = lstatSync(target);
        if (!targetStat.isFile()) {
          throw new Error(`cannot replace non-file artifact target: ${target}`);
        }
        unlinkSync(target);
      }
      renameSync(join(stagingDir, file), target);
      movedTargets.push(target);
    }
  } catch (error) {
    for (const target of movedTargets.reverse()) {
      try {
        unlinkSync(target);
      } catch {
        // Preserve the original publication failure.
      }
    }
    throw error;
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

export function produceAcceptanceArtifacts(
  options: ProduceAcceptanceArtifactsOptions,
): AcceptanceArtifactResult {
  const outputDir = options.outputDir ?? options.reviewDir;
  invalidateOutputArtifacts(outputDir);
  const errors: string[] = [];
  const intake = loadTierIntake(options.tierIntakePath, errors);
  const taskIdentity = intake && requiredString(intake.taskIdentity, 'tier-intake.taskIdentity', errors);
  const episodeFirstRevision = intake && requiredString(intake.firstRevision, 'tier-intake.firstRevision', errors);
  if (!intake || !taskIdentity || !episodeFirstRevision) {
    return { ok: false, outputDir, files: [], missing: [], errors: [...new Set(errors)] };
  }
  const episodeId = deriveReviewEpisodeId(taskIdentity, episodeFirstRevision);
  const canonicalStageEvidencePaths = resolveCanonicalStageEvidencePaths(
    options.reviewDir,
    options.stageEvidencePaths,
    errors,
  );
  if (canonicalStageEvidencePaths === null) {
    return { ok: false, outputDir, files: [], missing: [], errors: [...new Set(errors)], reviewEpisodeId: episodeId };
  }
  const captureTexts = new Map<string, string>();
  const captureTimestamps = new Map<string, number>();
  const receipts = canonicalStageEvidencePaths
    .map((path) => {
      const value = readJson(path, 'stage evidence', errors);
      return isRecord(value) ? buildReceipt(path, value, taskIdentity, episodeFirstRevision, episodeId, captureTexts, captureTimestamps, errors) : null;
    })
    .filter((r): r is ProducedStageReceipt => r !== null)
    .sort((left, right) => left.stageSequence - right.stageSequence);
  const tier = receipts[0]?.tier;
  const cycleIds = new Set(receipts.map((receipt) => receipt.cycleId));
  if (cycleIds.size > 1) errors.push('stage evidence mixes cycle identities');
  if (!tier) errors.push('no completed-stage evidence was supplied');
  if (tier && receipts.length > 0) {
    const required = expectedStages(tier, options.phase ?? 'final-acceptance');
    for (const stage of required) {
      if (!receipts.some((receipt) => receipt.stage === stage && receipt.outcome === 'complete')) {
        errors.push(`missing completed stage evidence: ${stage}`);
      }
    }
  }
  for (let index = 0; index < receipts.length; index += 1) {
    const receipt = receipts[index]!;
    receipt.previousStageReceiptId = index === 0 ? null : receipts[index - 1]!.stageReceiptId;
    receipt.receiptCensus = receipts.slice(0, index + 1).map((item) => item.stageReceiptId);
  }
  const captures = receipts.flatMap((receipt) => receipt.relayEligibleCaptures);
  const relay = relayEvidence(episodeId, captures);
  const ledger = buildLedger(options.authorDispositionsPath, captures, errors);
  const claudeProducerEvidence = (options.claudeProducerEvidencePaths ?? [])
    .flatMap((path) => readClaudeProducerEvidence(path, errors));
  const requiresClaudeProducerEvidence = tier === 'T3' && receipts.some((receipt) => (
    receipt.stage === 'architectural-lens'
    && isRecord(receipt.claude)
    && receipt.claude.kind === 'capture'
  ));
  if (requiresClaudeProducerEvidence && (options.claudeProducerEvidencePaths ?? []).length === 0) {
    errors.push(`missing ${CLAUDE_PRODUCER_EVIDENCE_SCHEMA} input for T3 architectural-lens capture: --claude-producer-evidence <path>`);
  }
  const authority: ReviewEpisodeDerivationAuthorityV1 | undefined = tier
    ? {
        tierIntake: intake,
        receiptInventory: {
          source: 'canonical-review-directory',
          taskIdentity,
          episodeFirstRevision,
          reviewEpisodeId: episodeId,
          stageReceiptIds: receipts.map((receipt) => receipt.stageReceiptId),
        },
        claudeProducerEvidence,
      }
    : undefined;
  if (ledger && tier) {
    const state = deriveReviewEpisodeState(receipts, relay, authority);
    errors.push(...state.errors);
    errors.push(...validateReviewEpisodeTopology(state, options.phase ?? 'final-acceptance'));
    const settlementsValid = receipts.every((receipt, index) => {
      if (!isValidSettlement(receipt.settlement)) {
        errors.push(`stage receipt[${index}] settlement is missing or malformed`);
        return false;
      }
      return true;
    });
    const stageTerminalConfirmed = settlementsValid && receipts.every((receipt) => (
      receipt.settlement.allLaunchedTerminal === true
      && (receipt.invocations ?? []).every((invocation) => invocation.terminal === true)
    ));
    if (!stageTerminalConfirmed) {
      errors.push('stage evidence does not prove terminal settlement for every launched invocation');
    }
    if (settlementsValid) {
      const ledgerResult = checkFindingLedgerGuard(
        captures.map((capture) => captureTexts.get(capture.captureIdentity) ?? ''),
        ledger,
        {
          reviewEconomics: true,
          phase: options.phase ?? 'final-acceptance',
          issueRevision: episodeFirstRevision,
          stageTerminalConfirmed,
          stageReceipts: receipts,
          verifiedRelayEvidence: relay,
          episodeAuthority: authority,
          captureMetadata: captures.map((capture) => ({
            name: capture.name,
            timestampMs: captureTimestamps.get(capture.captureIdentity) ?? 0,
            captureIdentity: capture.captureIdentity,
          })),
        },
      );
      if (!ledgerResult.ok) errors.push(...ledgerResult.errors);
    }
  }
  if (errors.length > 0 || !ledger || !tier) {
    return { ok: false, outputDir, files: [], missing: [], errors: [...new Set(errors)], reviewEpisodeId: episodeId };
  }

  const files = [
    ...receipts.map((receipt) => `stage-completeness-receipt-${receipt.stageAttemptId}.json`),
    'verified-relay-evidence.json',
    'finding-disposition-ledger.json',
    'review-episode-inventory.json',
    'acceptance-artifacts.json',
  ];
  const manifest = {
    schema: ARTIFACT_MANIFEST_SCHEMA,
    reviewEpisodeId: episodeId,
    files,
    derivedFrom: {
      tierIntake: resolve(options.tierIntakePath),
      stageEvidence: canonicalStageEvidencePaths.map((path) => resolve(path)),
      authorDispositions: resolve(options.authorDispositionsPath),
    },
  };
  const artifactContents = new Map<string, string>();
  receipts.forEach((receipt) => artifactContents.set(
    `stage-completeness-receipt-${receipt.stageAttemptId}.json`,
    JSON.stringify(receipt, null, 2) + '\n',
  ));
  artifactContents.set('verified-relay-evidence.json', JSON.stringify(relay, null, 2) + '\n');
  artifactContents.set('finding-disposition-ledger.json', ledger);
  artifactContents.set('review-episode-inventory.json', JSON.stringify(authority!.receiptInventory, null, 2) + '\n');
  artifactContents.set('acceptance-artifacts.json', JSON.stringify(manifest, null, 2) + '\n');
  try {
    publishArtifactSet(outputDir, files, artifactContents);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      outputDir,
      files: [],
      missing: [],
      errors: [`unable to publish acceptance artifacts: ${message}`],
      reviewEpisodeId: episodeId,
    };
  }
  return { ok: true, outputDir, files, missing: [], errors: [], reviewEpisodeId: episodeId };
}

export function inspectAcceptanceArtifacts(
  options: ProduceAcceptanceArtifactsOptions,
): AcceptanceArtifactStatus {
  const present: string[] = [];
  const missing: AcceptanceArtifactMissingInput[] = [];
  const requirePath = (path: string, artifact: string, reason: string): void => {
    if (existsSync(path)) present.push(path);
    else missing.push({ artifact, reason: `${reason}: ${path}` });
  };
  requirePath(options.tierIntakePath, 'tier-intake/v1', 'tier intake evidence is missing');
  requirePath(options.authorDispositionsPath, 'author dispositions', 'author disposition evidence is missing');
  const coverageErrors: string[] = [];
  const canonicalStageEvidencePaths = resolveCanonicalStageEvidencePaths(
    options.reviewDir,
    options.stageEvidencePaths,
    coverageErrors,
  );
  for (const error of coverageErrors) {
    missing.push({ artifact: 'stage-completeness-receipt/v1', reason: error });
  }
  if (options.stageEvidencePaths.length === 0) {
    missing.push({ artifact: 'stage-completeness-receipt/v1', reason: 'no recorded stage evidence paths were supplied' });
  }
  const stageEvidencePaths = canonicalStageEvidencePaths ?? options.stageEvidencePaths;
  let requiresClaudeProducerEvidence = false;
  for (const path of stageEvidencePaths) requirePath(path, 'stage evidence', 'recorded stage result is missing');
  for (const path of stageEvidencePaths) {
    if (!existsSync(path)) continue;
    const value = readJson(path, 'stage evidence', []);
    if (!isRecord(value)) continue;
    if (Array.isArray(value.invocations)) {
      for (const [index, invocation] of value.invocations.entries()) {
        if (!isRecord(invocation)) continue;
        if (invocation.terminalClassification === 'complete' && invocation.capturePath === undefined) {
          missing.push({
            artifact: 'capture',
            reason: `completed invocation[${index}] is missing capturePath: ${path}`,
          });
        } else if (invocation.capturePath !== undefined) {
          const capturePath = resolve(dirname(path), String(invocation.capturePath));
          requirePath(capturePath, 'capture', 'stage evidence names a capture that is not present');
        }
      }
    }
    if (
      value.tier === 'T3'
      && value.stage === 'architectural-lens'
      && isRecord(value.claude)
      && value.claude.kind === 'capture'
    ) {
      requiresClaudeProducerEvidence = true;
    }
    if (isRecord(value.claude)) {
      if (value.claude.kind === 'capture' && value.claude.capturePath === undefined) {
        missing.push({
          artifact: 'capture',
          reason: `Claude capture branch is missing capturePath: ${path}`,
        });
      } else if (value.claude.capturePath !== undefined) {
        const capturePath = resolve(dirname(path), String(value.claude.capturePath));
        requirePath(capturePath, 'capture', 'stage evidence names a Claude capture that is not present');
      }
    }
  }
  const claudeProducerEvidencePaths = options.claudeProducerEvidencePaths ?? [];
  for (const path of claudeProducerEvidencePaths) {
    requirePath(path, CLAUDE_PRODUCER_EVIDENCE_SCHEMA, 'Claude producer evidence is missing');
  }
  if (requiresClaudeProducerEvidence && claudeProducerEvidencePaths.length === 0) {
    missing.push({
      artifact: CLAUDE_PRODUCER_EVIDENCE_SCHEMA,
      reason: 'T3 architectural-lens capture requires --claude-producer-evidence <path>',
    });
  }
  requirePath(join(options.outputDir ?? options.reviewDir, 'verified-relay-evidence.json'), 'verified relay evidence', 'relay manifest has not been produced');
  requirePath(join(options.outputDir ?? options.reviewDir, 'finding-disposition-ledger.json'), 'finding ledger', 'finding ledger has not been produced');
  return { ok: missing.length === 0, present, missing };
}
