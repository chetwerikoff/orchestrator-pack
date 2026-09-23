import { createHash } from 'node:crypto';
import {
  existsSync,
  linkSync,
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
import { TURN_STATES } from '../chatgpt-browser-turn/contracts.ts';
import {
  deriveReviewEpisodeId,
  deriveReviewEpisodeState,
  deriveStageReceiptId,
  validateReviewEpisodeTopology,
  CLAUDE_PRODUCER_EVIDENCE_SCHEMA,
  parseReviewerSourcePolicy,
  type AuthoritativeGithubArtifactAuthorityV1,
  type CaptureIdentityV1,
  type ReviewerInvocationEnvelopeV1,
  type ReviewEpisodeDerivationAuthorityV1,
  type ReviewEpisodeValidationPurpose,
  type ReviewStage,
  type ReviewTier,
  type StageCompletenessReceiptV1,
  type TierIntakeAuthorityV1,
  type VerifiedRelayEvidenceV1,
  resolveCanonicalReviewDirectory,
} from './stage-completeness-core.ts';
import { canonicalPredecessorStage, canonicalStagePlan, stagesForPhase } from './create-issue-stage-topology.ts';
import { evaluateStageCredentialingSettlement } from './create-issue-stage-lifecycle-acceptance.ts';
import { readEvidenceWaiverProducerEvidence } from './create-issue-stage-record-receipt.ts';
import { extractMarker, resolveRecoveredInvalidPublicActorPoisonWitness } from './create-issue-stage-record-marker.ts';
import { buildCanonicalLineage, deriveCanonicalCycleLineage } from './create-issue-stage-record-lineage.ts';
import { checkFindingLedgerGuard } from '../finding-ledger-guard.mjs';
import { validateTerminalOneShotBodyBinding } from './create-issue-final-acceptance-contract.ts';
import { defaultGhTransport, fetchIssueRevision, fetchRepositoryOwnerLogin, parseJournalEvents } from './create-issue-stage-record-gh.ts';
import type { CanonicalLineage, GhTransport, PartialMissingSourceWitness, ProducerEvidence, TrustedComment } from './create-issue-stage-record-types.ts';
import { resolvePublishedAuthorState } from './resolve-published-author-state.ts';
import { isReviewLaneRouting, validateReviewLaneRecord } from './review-lane-record.ts';
import { normalizeMaterialVerdict, settleReviewLane, type ReviewLaneRouting, type ReviewLaneSourceVerdict } from './review-lane-routing.ts';
import {
  resolveAuthenticatedGithubPrincipal,
  sameGithubPrincipal,
  selectPrincipalOwnedCanonicalArtifact,
} from './create-issue-github-artifact-authority.ts';
import {
  AUTHOR_DISPOSITIONS_SCHEMA,
  DEFECT_DISPOSITION_VALUES,
  REMEDY_DISPOSITION_VALUES,
  authorDispositionDiagnosticFromFailure,
  authorDispositionDiagnosticsText,
  locateGovernedAuthorDispositionBlock as locateAuthorDispositionBlock,
  parseGovernedAuthorDispositionText,
  renderAuthorDispositionPromptFragment,
  type AuthorDispositionDiagnostic,
} from './create-issue-author-dispositions-schema.ts';

export {
  AUTHOR_DISPOSITIONS_SCHEMA,
  DEFECT_DISPOSITION_VALUES,
  REMEDY_DISPOSITION_VALUES,
} from './create-issue-author-dispositions-schema.ts';

export const STAGE_EVIDENCE_SCHEMA = 'create-issue-stage-evidence/v1' as const;
export const ARTIFACT_MANIFEST_SCHEMA = 'create-issue-acceptance-artifacts/v1' as const;
export const TURN_RESULT_SCHEMA = 'turn-result/v1' as const;
export const AUTHORITATIVE_GITHUB_ARTIFACT_BASIS = 'authoritative-github-artifact' as const;

export const ACCEPTANCE_ARTIFACT_REQUIRED_INPUTS = [
  { property: 'tierIntakePath', flag: '--tier-intake', file: 'tier-intake.json', schema: 'tier-intake/v1', classification: 'lifecycle-tool-witnessed', repeatable: false },
  { property: 'stageEvidencePaths', flag: '--stage-evidence', file: 'attempt-NNN.json', schema: STAGE_EVIDENCE_SCHEMA, classification: 'lifecycle-tool-witnessed/GitHub-witnessed', repeatable: true },
  { property: 'authorDispositionsPath', flag: '--author-dispositions', file: 'author-dispositions.json', schema: AUTHOR_DISPOSITIONS_SCHEMA, classification: 'GitHub-witnessed/author-owned/lifecycle-tool-witnessed', repeatable: false },
] as const;

type AcceptanceArtifactInputProperty = typeof ACCEPTANCE_ARTIFACT_REQUIRED_INPUTS[number]['property'];

function acceptanceArtifactInputDescriptor(property: AcceptanceArtifactInputProperty) {
  const descriptor = ACCEPTANCE_ARTIFACT_REQUIRED_INPUTS.find((item) => item.property === property);
  if (!descriptor) throw new Error(`acceptance artifact input descriptor is missing for ${property}`);
  return descriptor;
}

function acceptanceArtifactInputReason(
  property: AcceptanceArtifactInputProperty,
  detail: string,
): string {
  const descriptor = acceptanceArtifactInputDescriptor(property);
  return `${detail}; authority=${descriptor.classification}; producer must obtain ${descriptor.file} from the declared authority`;
}

export function stageCompletenessReceiptFileName(stageAttemptId: string): string {
  return `stage-completeness-receipt-${stageAttemptId}.json`;
}

export const ACCEPTANCE_ARTIFACT_OUTPUT_NAMES = [
  'verified-relay-evidence.json',
  'finding-disposition-ledger.json',
  'review-episode-inventory.json',
  'acceptance-artifacts.json',
] as const;

export type AcceptanceArtifactTemporaryClassification =
  | 'source-unavailable'
  | 'identity-unresolved'
  | 'provenance-unresolved'
  | 'observation-lost';

type JsonRecord = Record<string, unknown>;
type CycleBinding = { cycleId: string; sourceRevision: string; boundBeforeLaunch: true };
type ProducedStageReceipt = StageCompletenessReceiptV1 & { cycleId: string; cycleBinding: CycleBinding };

export interface OperatorAcceptanceAdjudication {
  issueNumber: number;
  sourceRevision: string;
  verdictUrl: string;
  verdictSha256: string;
  verdictByteLength: number;
  verdictFindingCount: number;
  reason: string;
}

export interface AcceptanceArtifactPublicationHooks {
  /** Deterministic test-only failure seam. Production callers leave this unset. */
  afterInstall?: (event: { file: string; target: string; installIndex: number }) => void;
}

export interface ProduceAcceptanceArtifactsOptions {
  reviewDir: string;
  tierIntakePath: string;
  stageEvidencePaths: string[];
  authorDispositionsPath: string;
  claudeProducerEvidencePaths?: string[];
  waiverPath?: string;
  outputDir?: string;
  phase?: 'pre-lens' | 'post-lens' | 'final-acceptance';
  operatorAdjudication?: OperatorAcceptanceAdjudication;
  /** Backward-compatible injection point; it is only a transport seam, never an authority seam. */
  operatorReferenceTransport?: GhTransport;
  artifactSourceTransport?: GhTransport;
  repositoryFullName?: string;
  publicationHooks?: AcceptanceArtifactPublicationHooks;
}

interface OperatorNarrowingHint {
  repositoryFullName: string;
  issueNumber: number;
  sourceRevision: string;
  commentId: number;
  commentUrl: string;
  verdictSha256: string;
  verdictByteLength: number;
  reason: string;
}

interface AuthoritativeIssueComment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
  userLogin: string | null;
  authorAssociation: string | null;
  htmlUrl: string;
  issueUrl: string;
}

interface IssueCommentCensus {
  repositoryFullName: string;
  issueNumber: number;
  comments: AuthoritativeIssueComment[];
}

type AuthoritativeIssueCensus = IssueCommentCensus;

interface ArtifactAuthorityContext {
  transport: GhTransport;
  census: AuthoritativeIssueCensus;
  principalLogin: string;
  operatorHint?: OperatorNarrowingHint;
  publishedAuthorState?: {
    text: string;
    sha256: string;
    byteLength: number;
  };
}

interface AuthoritativeArtifactResolution {
  capture: CaptureIdentityV1;
  captureText: string;
  capturePath: string;
  captureCreated: boolean;
  authority: AuthoritativeGithubArtifactAuthorityV1;
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
  temporary?: AcceptanceArtifactTemporaryClassification;
  authorDiagnostics?: AuthorDispositionDiagnostic[];
  authorSchemaFragment?: string;
}

export interface AcceptanceArtifactStatus {
  ok: boolean;
  present: string[];
  missing: AcceptanceArtifactMissingInput[];
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalJsonValue(value[key])]),
  );
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalJsonValue(left)) === JSON.stringify(canonicalJsonValue(right));
}

function requiredString(value: unknown, label: string, errors: string[]): string {
  if (typeof value !== 'string' || value.trim() === '') {
    errors.push(`${label} is missing`);
    return '';
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function reviewTier(value: unknown): ReviewTier | null {
  return value === 'T1' || value === 'T2' || value === 'T3' ? value : null;
}

function canonicalTerminalPredecessor(
  intake: TierIntakeAuthorityV1,
  errors?: string[],
): ReviewStage | null {
  const tier = reviewTier(intake.priorTier);
  if (!tier) {
    errors?.push('tier-intake priorTier is invalid for canonical predecessor derivation');
    return null;
  }
  try {
    return canonicalPredecessorStage(tier, 'architectural', {
      competitiveDecision: intake.competitiveDecision === 'required' || intake.competitiveDecision === 'skipped'
        ? intake.competitiveDecision
        : undefined,
      competitiveRationale: typeof intake.competitiveRationale === 'string'
        ? intake.competitiveRationale
        : undefined,
    });
  } catch (error) {
    errors?.push(
      'canonical predecessor derivation failed: '
      + (error instanceof Error ? error.message : String(error)),
    );
    return null;
  }
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
  return value === 'triple-source/v1' || value === 'single-source/v1' || value === 'review-lane-routing/v1'
    ? value
    : null;
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
  artifactAuthority: AuthoritativeGithubArtifactAuthorityV1 | undefined,
  validatedTerminalResultIdentity: string | undefined,
  errors: string[],
  purpose: ReviewEpisodeValidationPurpose,
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
  const assertedTerminalResultIdentity = optionalString(value.terminalResultIdentity);
  const terminalResultIdentity = validatedTerminalResultIdentity ?? assertedTerminalResultIdentity;
  const reviewerSource = optionalString(value.reviewerSource);
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
  if (purpose === 'stage-time' && !artifactAuthority && !terminalResultIdentity) errors.push(`${label}.terminalResultIdentity is missing`);
  if (purpose === 'stage-time' && !artifactAuthority && !reviewerSource) errors.push(`${label}.reviewerSource is missing`);
  if (purpose === 'stage-time' && invocationTerminalClassification === 'complete' && !terminalResultIdentity) errors.push(`${label}.terminalResultIdentity is missing for successful transport`);
  if (purpose === 'stage-time' && invocationTerminalClassification === 'complete' && !reviewerSource) errors.push(`${label}.reviewerSource is missing for successful transport`);
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
    ...(terminalResultIdentity ? { terminalResultIdentity } : {}),
    ...(reviewerSource ? { reviewerSource } : {}),
    reviewerSlot,
    ...(value.reviewLaneRouting !== undefined ? { reviewLaneRouting: value.reviewLaneRouting as unknown as ReviewerInvocationEnvelopeV1['reviewLaneRouting'] } : {}),
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
    ...(artifactAuthority ? { artifactAuthority } : {}),
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

const FINDING_PAYLOAD_FIELDS = [
  /^\s*id:\s*\S+/im,
  /^\s*type:\s*\S+/im,
  /^\s*severity:\s*\S+/im,
  /^\s*evidence:\s*\S+/im,
  /^\s*recommendation:\s*\S+/im,
  /^\s*persistent-machinery:\s*(?:yes|no)\s*$/im,
];

function stripMarkdownFencedCodeBlocksExceptFindingPayloads(text: string): string {
  return text.replace(/```([^\n]*)\n([\s\S]*?)```/g, (block, info: string, body: string) => {
    const isFindingPayload = info.trim().toLowerCase() === 'text'
      && FINDING_PAYLOAD_FIELDS.every((field) => field.test(body));
    return isFindingPayload ? body : '\n'.repeat((block.match(/\n/g) ?? []).length);
  });
}

function rawFindingCount(text: string, captureName = ''): number {
  const withoutFences = /pass-\d+-architectural-lens\.capture\.txt$/i.test(captureName)
    ? stripMarkdownFencedCodeBlocksExceptFindingPayloads(text)
    : text.replace(/```[\s\S]*?```/g, '');
  return withoutFences
    .split(/\r?\n/)
    .filter((line) => !/^\s*>/.test(line))
    .filter((line) => /^id:\s*/i.test(line.trim()))
    .length;
}

const CANONICAL_REVISION_LINE_RE = /^Read revision: #([1-9][0-9]*) (r[0-9]+)$/;
const INVOCATION_ECHO_RE = /^INVOCATION_ID_TO_ECHO: (\S+)$/;

function isPluralFindingsVerdict(token: string | undefined): boolean {
  return token === 'FINDINGS' || token === 'NEEDS_ATTENTION';
}

function pluralCaptureVerdictIsCanonical(text: string, findingCount: number): boolean {
  if (findingCount <= 0) return true;
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const verdicts = lines.flatMap((line) => {
    const match = /^VERDICT: (\S+)$/.exec(line);
    return match ? [match[1]!] : [];
  });
  if (verdicts.length === 0) return true;
  return verdicts.length === 1 && isPluralFindingsVerdict(verdicts[0]);
}

export function parseCanonicalCaptureRevision(text: string): { issueNumber: number; sourceRevision: string; findingCount: number } | null {
  const lines = text.split(/\n/).map((line) => line.replace(/\r$/, ''));
  const firstNonEmpty = lines.find((line) => line.trim().length > 0);
  const match = firstNonEmpty ? CANONICAL_REVISION_LINE_RE.exec(firstNonEmpty) : null;
  const declarations = lines.filter((line) => CANONICAL_REVISION_LINE_RE.test(line)).length;
  if (!match || declarations !== 1) return null;
  const findingCount = rawFindingCount(text);
  if (!pluralCaptureVerdictIsCanonical(text, findingCount)) return null;
  return {
    issueNumber: Number(match[1]),
    sourceRevision: match[2]!,
    findingCount,
  };
}

function parseCanonicalTerminalVerdict(
  text: string,
  requireInvocationEcho = true,
): { issueNumber: number; sourceRevision: string; findingCount: number } | null {
  const revision = parseCanonicalCaptureRevision(text);
  if (!revision) return null;
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const exactCount = (token: string): number => lines.filter((line) => line === token).length;
  const verdicts = lines.flatMap((line) => {
    const match = /^VERDICT: (CLEAN|FINDINGS|NO_FINDINGS|NEEDS_ATTENTION)$/.exec(line);
    return match ? [match[1]!] : [];
  });
  const findingCountLines = lines.filter((line) => line.startsWith('FINDING_COUNT:'));
  const declaredFindingCounts = findingCountLines.flatMap((line) => {
    const match = /^FINDING_COUNT: ([0-9]+)$/.exec(line);
    return match ? [Number(match[1])] : [];
  });
  const omittedFindingCountOk = findingCountLines.length === 0
    && verdicts.length === 1
    && isPluralFindingsVerdict(verdicts[0])
    && revision.findingCount > 0;
  const explicitFindingCountOk = findingCountLines.length === 1
    && declaredFindingCounts.length === 1
    && declaredFindingCounts[0] === revision.findingCount;
  const findingsWithoutVerdictOk = explicitFindingCountOk
    && verdicts.length === 0
    && lines.every((line) => !line.startsWith('VERDICT:'))
    && revision.findingCount > 0;
  const invocationIds = lines.filter((line) => INVOCATION_ECHO_RE.test(line));
  const invocationEchoCountOk = requireInvocationEcho
    ? invocationIds.length === 1
    : invocationIds.length === 0;
  const cutCandidates = exactCount('simplification-cut-candidate: yes');
  const simplificationClean = exactCount('SIMPLIFICATION_CLEAN');
  if (
    exactCount('review-economics-contract: v1') !== 1
    || !(omittedFindingCountOk || explicitFindingCountOk)
    || !invocationEchoCountOk
    || (cutCandidates === 0 ? simplificationClean !== 1 : simplificationClean !== 0)
  ) return null;
  if (revision.findingCount === 0) {
    const cleanVerdict = verdicts[0] === 'CLEAN' && exactCount('NO_FINDINGS') === 1;
    const noFindingsVerdict = verdicts[0] === 'NO_FINDINGS' && exactCount('NO_FINDINGS') <= 1;
    if (!cleanVerdict && !noFindingsVerdict) return null;
  } else if (!findingsWithoutVerdictOk
    && (verdicts.length !== 1 || !isPluralFindingsVerdict(verdicts[0]) || exactCount('NO_FINDINGS') !== 0)) {
    return null;
  }
  return revision;
}

function isCanonicalReviewerArtifact(
  text: string,
  stage: Exclude<ReviewStage, 'architectural-lens'>,
  issueNumber: number,
  sourceRevision: string,
  invocationId?: string,
): boolean {
  const revision = parseCanonicalCaptureRevision(text);
  if (!revision || revision.issueNumber !== issueNumber || revision.sourceRevision !== sourceRevision) return false;
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  if (lines.filter((line) => line === 'review-economics-contract: v1').length !== 1) return false;
  const invocationEchoes = lines.flatMap((line) => {
    const match = INVOCATION_ECHO_RE.exec(line);
    return match ? [match[1]!] : [];
  });
  if (invocationId === undefined ? invocationEchoes.length !== 0 : (invocationEchoes.length !== 1 || invocationEchoes[0] !== invocationId)) return false;
  if (stage === 'architectural') return parseCanonicalTerminalVerdict(text, invocationId !== undefined) !== null;
  const noFindings = lines.filter((line) => line === 'NO_FINDINGS').length;
  const cutCandidates = lines.filter((line) => line === 'simplification-cut-candidate: yes').length;
  const simplificationClean = lines.filter((line) => line === 'SIMPLIFICATION_CLEAN').length;
  if (revision.findingCount === 0) return noFindings === 1 && cutCandidates === 0 && simplificationClean === 1;
  if (noFindings !== 0) return false;
  if (cutCandidates === 0 ? simplificationClean !== 1 : simplificationClean !== 0) return false;
  const declaredFindingCounts = lines.flatMap((line) => {
    const match = /^FINDING_COUNT: ([0-9]+)$/.exec(line);
    return match ? [Number(match[1])] : [];
  });
  return declaredFindingCounts.length === 0
    || (declaredFindingCounts.length === 1 && declaredFindingCounts[0] === revision.findingCount);
}

function canonicalReviewerArtifactRevision(
  text: string,
  stage: Exclude<ReviewStage, 'architectural-lens'>,
  issueNumber: number,
  invocationId: string,
): string | null {
  const revision = parseCanonicalCaptureRevision(text);
  if (!revision || revision.issueNumber !== issueNumber) return null;
  return isCanonicalReviewerArtifact(text, stage, issueNumber, revision.sourceRevision, invocationId)
    ? revision.sourceRevision
    : null;
}

function publicationBindingAnchors(
  text: string,
  issueNumber: number,
  sourceRevision: string,
  invocationId: string,
): boolean {
  const lines = text.split(/\n/).map((line) => line.replace(/\r$/, ''));
  const firstNonEmpty = lines.find((line) => line.trim().length > 0);
  const match = firstNonEmpty ? CANONICAL_REVISION_LINE_RE.exec(firstNonEmpty) : null;
  const declarations = lines.filter((line) => CANONICAL_REVISION_LINE_RE.test(line)).length;
  if (!match || declarations !== 1) return false;
  if (Number(match[1]) !== issueNumber || match[2] !== sourceRevision) return false;
  const echoes = lines.map((line) => line.trim()).flatMap((line) => {
    const echo = INVOCATION_ECHO_RE.exec(line);
    return echo ? [echo[1]!] : [];
  });
  return echoes.length === 1 && echoes[0] === invocationId;
}

function verdictGrammarIsPermanentlyNoncanonical(text: string): boolean {
  const findingCount = rawFindingCount(text);
  if (findingCount > 0) return !pluralCaptureVerdictIsCanonical(text, findingCount);
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const verdictLines = lines.filter((line) => line.startsWith('VERDICT:'));
  if (verdictLines.length === 0) return false;
  const canonicalVerdicts = verdictLines.filter((line) => (
    /^VERDICT: (CLEAN|FINDINGS|NO_FINDINGS|NEEDS_ATTENTION)$/.test(line)
  ));
  return verdictLines.length !== 1 || canonicalVerdicts.length !== 1;
}

function temporaryError(
  classification: AcceptanceArtifactTemporaryClassification,
  detail: string,
): string {
  return `TEMPORARY ${classification}: ${detail}`;
}

function temporaryClassification(errors: readonly string[]): AcceptanceArtifactTemporaryClassification | undefined {
  for (const classification of ['source-unavailable', 'identity-unresolved', 'provenance-unresolved', 'observation-lost'] as const) {
    if (errors.some((error) => error.startsWith(`TEMPORARY ${classification}:`))) return classification;
  }
  return undefined;
}

function parseRepositoryFullName(value: string, errors: string[]): { owner: string; name: string; fullName: string } | null {
  const fullName = value.trim();
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(fullName);
  if (!match) {
    errors.push('authoritative GitHub repository must be owner/name');
    return null;
  }
  return { owner: match[1]!, name: match[2]!, fullName };
}

function normalizeOperatorNarrowingHint(
  value: OperatorAcceptanceAdjudication | undefined,
  phase: ProduceAcceptanceArtifactsOptions['phase'],
  repositoryFullName: string,
  issueNumber: number,
  errors: string[],
): OperatorNarrowingHint | undefined {
  if (!value) return undefined;
  if ((phase ?? 'final-acceptance') !== 'final-acceptance') {
    errors.push('operator verdict URL hint is valid only for final-acceptance artifact production');
    return undefined;
  }
  const sourceRevision = String(value.sourceRevision ?? '').trim();
  const verdictUrl = String(value.verdictUrl ?? '').trim();
  const verdictSha256 = String(value.verdictSha256 ?? '').trim().toLowerCase();
  const verdictByteLength = Number(value.verdictByteLength);
  const reason = String(value.reason ?? '').trim();
  const match = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/issues\/([1-9][0-9]*)#issuecomment-([1-9][0-9]*)$/.exec(verdictUrl);
  const errorCountBefore = errors.length;
  if (!match) errors.push('operator verdict URL hint must be a canonical published Issue comment URL');
  if (Number(value.issueNumber) !== issueNumber) errors.push('operator verdict URL hint Issue does not match tier-intake Issue');
  if (!/^r[0-9]+$/.test(sourceRevision)) errors.push('operator verdict URL hint sourceRevision must be rNN');
  if (!/^[0-9a-f]{64}$/.test(verdictSha256)) errors.push('operator verdict URL hint verdictSha256 must be a 64-character hexadecimal digest');
  if (!Number.isSafeInteger(verdictByteLength) || verdictByteLength < 0) errors.push('operator verdict URL hint verdictByteLength must be a non-negative integer');
  if (!reason) errors.push('operator verdict URL hint reason must be non-empty');
  if (match && match[1]!.toLowerCase() !== repositoryFullName.toLowerCase()) errors.push('operator verdict URL hint repository mismatch');
  if (match && Number(match[2]) !== issueNumber) errors.push('operator verdict URL hint Issue mismatch');
  if (!match || errors.length !== errorCountBefore) return undefined;
  return {
    repositoryFullName,
    issueNumber,
    sourceRevision,
    commentId: Number(match[3]),
    commentUrl: verdictUrl,
    verdictSha256,
    verdictByteLength,
    reason,
  };
}

function parseAuthoritativeIssueComment(
  raw: unknown,
  label: string,
  errors: string[],
  unavailableClassification: AcceptanceArtifactTemporaryClassification = 'source-unavailable',
): AuthoritativeIssueComment | null {
  if (!isRecord(raw)) {
    errors.push(temporaryError(unavailableClassification, `${label} is malformed`));
    return null;
  }
  const user = isRecord(raw.user) ? raw.user : null;
  const id = Number(raw.id);
  const body = typeof raw.body === 'string' ? raw.body : null;
  const createdAt = typeof raw.created_at === 'string' ? raw.created_at : null;
  const updatedAt = typeof raw.updated_at === 'string' ? raw.updated_at : null;
  const userLogin = typeof user?.login === 'string' && user.login.trim() !== '' ? user.login.trim() : null;
  const authorAssociation = typeof raw.author_association === 'string' && raw.author_association.trim() !== ''
    ? raw.author_association.trim()
    : null;
  const htmlUrl = typeof raw.html_url === 'string' ? raw.html_url : null;
  const issueUrl = typeof raw.issue_url === 'string' ? raw.issue_url : null;
  if (!Number.isSafeInteger(id) || id < 1 || body === null || !createdAt || !updatedAt || !htmlUrl || !issueUrl) {
    errors.push(temporaryError(unavailableClassification, `${label} lacks authoritative identity/source fields`));
    return null;
  }
  return { id, body, createdAt, updatedAt, userLogin, authorAssociation, htmlUrl, issueUrl };
}

function issueCommentCensus(
  transport: GhTransport,
  repositoryFullName: string,
  issueNumber: number,
  errors: string[],
): IssueCommentCensus | null {
  const parsedRepo = parseRepositoryFullName(repositoryFullName, errors);
  if (!parsedRepo) return null;
  const comments: AuthoritativeIssueComment[] = [];
  const pageSize = 100;
  const maxPages = 100;
  for (let page = 1; page <= maxPages; page += 1) {
    const response = transport.runGh([
      'gh',
      'api',
      `repos/${parsedRepo.fullName}/issues/${issueNumber}/comments?per_page=${pageSize}&page=${page}`,
    ]);
    if (response.exitCode !== 0) {
      errors.push(temporaryError('source-unavailable', `Issue comment census failed on page ${page}`));
      return null;
    }
    let rawPage: unknown;
    try {
      rawPage = JSON.parse(response.stdout) as unknown;
    } catch {
      errors.push(temporaryError('source-unavailable', `Issue comment census page ${page} is malformed JSON`));
      return null;
    }
    if (!Array.isArray(rawPage)) {
      errors.push(temporaryError('source-unavailable', `Issue comment census page ${page} is not an array`));
      return null;
    }
    for (const [index, raw] of rawPage.entries()) {
      const parsed = parseAuthoritativeIssueComment(raw, `Issue comment census page ${page} item ${index}`, errors);
      if (!parsed) return null;
      comments.push(parsed);
    }
    if (rawPage.length < pageSize) {
      return { repositoryFullName: parsedRepo.fullName, issueNumber, comments };
    }
  }
  errors.push(temporaryError('source-unavailable', `Issue comment census exceeded ${maxPages} pages without proving completeness`));
  return null;
}

function authoritativeIssueCommentCensus(
  transport: GhTransport,
  repositoryFullName: string,
  issueNumber: number,
  errors: string[],
): AuthoritativeIssueCensus | null {
  return issueCommentCensus(transport, repositoryFullName, issueNumber, errors);
}

function canonicalIssueCommentLineage(
  transport: GhTransport,
  repositoryFullName: string,
  issueNumber: number,
  errors: string[],
): CanonicalLineage | null {
  let ownerLogin: string;
  try {
    ownerLogin = fetchRepositoryOwnerLogin(transport, repositoryFullName);
  } catch (error) {
    errors.push(temporaryError(
      'source-unavailable',
      `canonical Issue-comment lineage could not resolve repository owner: ${error instanceof Error ? error.message : String(error)}`,
    ));
    return null;
  }
  const census = issueCommentCensus(transport, repositoryFullName, issueNumber, errors);
  if (!census) return null;
  const trustedJournalComments: TrustedComment[] = [];
  for (const comment of census.comments) {
    if (!extractMarker(comment.body)) continue;
    if (!comment.userLogin || !comment.authorAssociation) {
      errors.push(temporaryError(
        'source-unavailable',
        `journal-marked comment ${comment.id} is missing required trust fields`,
      ));
      return null;
    }
    if (!sameGithubPrincipal(comment.userLogin, ownerLogin)) {
      errors.push(`canonical Issue-comment journal foreign-comment: journal-marked comment ${comment.id} is not owned by repository owner`);
      return null;
    }
    if (comment.updatedAt !== comment.createdAt) {
      errors.push(`canonical Issue-comment journal edited-comment: journal-marked comment ${comment.id} was edited`);
      return null;
    }
    trustedJournalComments.push({
      id: comment.id,
      body: comment.body,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
      userLogin: comment.userLogin,
      authorAssociation: comment.authorAssociation,
    });
  }
  const parsed = parseJournalEvents(trustedJournalComments);
  const lineage = buildCanonicalLineage(parsed.events);
  const recoveredPoison = resolveRecoveredInvalidPublicActorPoisonWitness({
    comments: trustedJournalComments,
    parsedDiagnostics: parsed.diagnostics,
    lineage,
  });
  const blockingParseDiagnostics = parsed.diagnostics.filter((diagnostic) => (
    diagnostic.code !== 'malformed-marker'
    || diagnostic.commentId !== recoveredPoison?.poisonCommentId
  ));
  if (blockingParseDiagnostics.length > 0) {
    errors.push(...blockingParseDiagnostics.map((diagnostic) => `canonical Issue-comment journal ${diagnostic.code}: ${diagnostic.message}`));
    return null;
  }
  const blockingLineageDiagnostics = lineage.diagnostics.filter((diagnostic) => (
    diagnostic.code !== 'duplicate-remote-event' && diagnostic.code !== 'non-current-cycle-fork'
  ));
  if (blockingLineageDiagnostics.length > 0) {
    errors.push(...blockingLineageDiagnostics.map((diagnostic) => `canonical cycle lineage ${diagnostic.code}: ${diagnostic.message}`));
    return null;
  }
  return lineage;
}

function invocationRequiresAuthoritativeArtifact(invocation: JsonRecord): boolean {
  return invocation.terminalClassification === 'complete' || invocation.sendCount === 1;
}

function expectedCaptureName(
  stage: Exclude<ReviewStage, 'architectural-lens'>,
  stageSequence: number,
  reviewerSlot: string,
): string {
  const pass = String(stageSequence).padStart(2, '0');
  return stage === 'competitive' || stage === 'architectural-review'
    ? `pass-${pass}-${stage}-${reviewerSlot}.capture.txt`
    : `pass-${pass}-architectural.capture.txt`;
}

function authoritativeCaptureName(
  reviewDir: string,
  stage: Exclude<ReviewStage, 'architectural-lens'>,
  stageSequence: number,
  reviewerSlot: string,
  assertedCapturePath: unknown,
): string {
  const expected = expectedCaptureName(stage, stageSequence, reviewerSlot);
  const publishedArchitecturalPath = resolve(reviewDir, 'pass-01-architectural.capture.txt');
  if (
    stage === 'architectural'
    && stageSequence === 2
    && typeof assertedCapturePath === 'string'
    && resolve(reviewDir, assertedCapturePath) === publishedArchitecturalPath
    && existsSync(publishedArchitecturalPath)
  ) {
    return 'pass-01-architectural.capture.txt';
  }
  return expected;
}

function materializeAuthoritativeCapture(
  reviewDir: string,
  name: string,
  text: string,
  assertedCapturePath: unknown,
  assertedIdentity: unknown,
  captureTexts: Map<string, string>,
  captureTimestamps: Map<string, number>,
  errors: string[],
): { capture: CaptureIdentityV1; path: string; created: boolean } | null {
  const target = resolve(reviewDir, name);
  const existedBefore = existsSync(target);
  if (assertedCapturePath !== undefined) {
    const asserted = resolve(reviewDir, String(assertedCapturePath));
    if (asserted !== target) {
      errors.push(`authoritative artifact capturePath must resolve to canonical path ${target}`);
      return null;
    }
  }
  mkdirSync(reviewDir, { recursive: true });
  if (existsSync(target)) {
    let stat;
    try { stat = lstatSync(target); } catch {
      errors.push(temporaryError('observation-lost', `canonical capture became unreadable before verification: ${target}`));
      return null;
    }
    if (!stat.isFile()) {
      errors.push(`canonical capture target is not a regular file: ${target}`);
      return null;
    }
    let existing: string;
    try { existing = readFileSync(target, 'utf8'); } catch {
      errors.push(temporaryError('observation-lost', `canonical capture could not be reread: ${target}`));
      return null;
    }
    if (existing !== text) {
      errors.push(`authoritative GitHub artifact conflicts with existing canonical capture: ${target}`);
      return null;
    }
  } else {
    const stagingDir = mkdtempSync(join(reviewDir, `.${name}.tmp-`));
    const staged = join(stagingDir, name);
    try {
      writeFileSync(staged, text, { encoding: 'utf8', flag: 'wx' });
      if (readFileSync(staged, 'utf8') !== text) {
        errors.push(temporaryError('observation-lost', `authoritative capture staging bytes could not be verified: ${target}`));
        return null;
      }
      try {
        linkSync(staged, target);
      } catch {
        if (!existsSync(target)) {
          errors.push(temporaryError('observation-lost', `authoritative capture atomic materialization failed before durable observation: ${target}`));
          return null;
        }
        let raced: string;
        try { raced = readFileSync(target, 'utf8'); } catch {
          errors.push(temporaryError('observation-lost', `raced canonical capture could not be reread: ${target}`));
          return null;
        }
        if (raced !== text) {
          errors.push(`authoritative GitHub artifact conflicts with concurrently materialized canonical capture: ${target}`);
          return null;
        }
      }
    } finally {
      rmSync(stagingDir, { recursive: true, force: true });
    }
  }
  let verifiedText: string;
  try { verifiedText = readFileSync(target, 'utf8'); } catch {
    errors.push(temporaryError('observation-lost', `canonical capture was lost before final verification: ${target}`));
    return null;
  }
  if (verifiedText !== text) {
    errors.push(`canonical capture bytes do not equal authoritative GitHub artifact: ${target}`);
    return null;
  }
  const digest = sha256(verifiedText);
  const identity = captureIdentity(name, digest);
  if (assertedIdentity !== undefined && assertedIdentity !== identity) {
    errors.push(`capture identity assertion does not match authoritative bytes for ${target}`);
    return null;
  }
  const capture: CaptureIdentityV1 = {
    captureIdentity: identity,
    name,
    byteLength: Buffer.byteLength(verifiedText),
    sha256: digest,
    rawFindingCount: rawFindingCount(verifiedText, name),
  };
  captureTexts.set(identity, verifiedText);
  try { captureTimestamps.set(identity, statSync(target).mtimeMs); } catch {
    errors.push(temporaryError('observation-lost', `canonical capture could not be statted after materialization: ${target}`));
    return null;
  }
  return { capture, path: target, created: !existedBefore };
}

function expectedCommentUrl(repositoryFullName: string, issueNumber: number, commentId: number): string {
  return `https://github.com/${repositoryFullName}/issues/${issueNumber}#issuecomment-${commentId}`;
}

function expectedIssueApiUrl(repositoryFullName: string, issueNumber: number): string {
  return `https://api.github.com/repos/${repositoryFullName}/issues/${issueNumber}`;
}

function commentTargetsExpectedIssue(
  comment: AuthoritativeIssueComment,
  repositoryFullName: string,
  issueNumber: number,
): boolean {
  return comment.htmlUrl === expectedCommentUrl(repositoryFullName, issueNumber, comment.id)
    && comment.issueUrl === expectedIssueApiUrl(repositoryFullName, issueNumber);
}

function rereadAuthoritativeIssueComment(
  context: ArtifactAuthorityContext,
  censusComment: AuthoritativeIssueComment,
  stage: Exclude<ReviewStage, 'architectural-lens'>,
  sourceRevision: string,
  invocationId: string,
  errors: string[],
): AuthoritativeIssueComment | null {
  const response = context.transport.runGh([
    'gh',
    'api',
    `repos/${context.census.repositoryFullName}/issues/comments/${censusComment.id}`,
  ]);
  if (response.exitCode !== 0) {
    errors.push(temporaryError('source-unavailable', `authoritative reread failed for comment ${censusComment.id}`));
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(response.stdout) as unknown;
  } catch {
    errors.push(temporaryError('source-unavailable', `authoritative reread for comment ${censusComment.id} is malformed JSON`));
    return null;
  }
  const reread = parseAuthoritativeIssueComment(raw, `authoritative reread comment ${censusComment.id}`, errors);
  if (!reread) return null;
  if (!commentTargetsExpectedIssue(reread, context.census.repositoryFullName, context.census.issueNumber)) {
    errors.push(`authoritative GitHub artifact target mismatch on reread: comment ${censusComment.id}`);
    return null;
  }
  if (!reread.userLogin) {
    errors.push(temporaryError('identity-unresolved', `authoritative reread comment ${reread.id} has no publisher login`));
    return null;
  }
  if (!censusComment.userLogin) {
    errors.push(temporaryError('identity-unresolved', `authoritative census candidate ${censusComment.id} has no publisher login`));
    return null;
  }
  if (!sameGithubPrincipal(reread.userLogin, context.principalLogin)
    || !sameGithubPrincipal(censusComment.userLogin, context.principalLogin)) {
    errors.push(`authoritative GitHub artifact publisher mismatch: expected=${context.principalLogin} observed=${reread.userLogin}`);
    return null;
  }
  if (reread.createdAt !== reread.updatedAt) {
    errors.push(`authoritative GitHub artifact was edited: ${reread.htmlUrl}`);
    return null;
  }
  if (!isCanonicalReviewerArtifact(
    reread.body,
    stage,
    context.census.issueNumber,
    sourceRevision,
    invocationId,
  )) {
    const observedRevision = canonicalReviewerArtifactRevision(
      reread.body,
      stage,
      context.census.issueNumber,
      invocationId,
    );
    if (observedRevision) {
      errors.push(`authoritative GitHub artifact revision mismatch: expected=${sourceRevision} observed=${observedRevision} comment=${reread.htmlUrl}`);
    } else {
      errors.push(`authoritative GitHub artifact is malformed or invocation-mismatched on reread: ${reread.htmlUrl}`);
    }
    return null;
  }
  if (
    reread.id !== censusComment.id
    || reread.body !== censusComment.body
    || reread.createdAt !== censusComment.createdAt
    || reread.updatedAt !== censusComment.updatedAt
    || !sameGithubPrincipal(reread.userLogin, censusComment.userLogin)
    || reread.authorAssociation !== censusComment.authorAssociation
    || reread.htmlUrl !== censusComment.htmlUrl
    || reread.issueUrl !== censusComment.issueUrl
  ) {
    errors.push(`authoritative GitHub artifact changed between complete census and reread: ${censusComment.htmlUrl}`);
    return null;
  }
  return reread;
}

function resolveAuthoritativeArtifact(
  context: ArtifactAuthorityContext,
  reviewDir: string,
  stage: Exclude<ReviewStage, 'architectural-lens'>,
  stageSequence: number,
  invocation: JsonRecord,
  captureTexts: Map<string, string>,
  captureTimestamps: Map<string, number>,
  errors: string[],
): AuthoritativeArtifactResolution | null {
  const invocationId = optionalString(invocation.invocationId) ?? '';
  const sourceRevision = optionalString(invocation.sourceRevision) ?? '';
  const reviewerSlot = optionalString(invocation.reviewerSlot) ?? '';
  if (!invocationId || !sourceRevision || !reviewerSlot) return null;

  const targetedComments = context.census.comments.filter((comment) => (
    commentTargetsExpectedIssue(comment, context.census.repositoryFullName, context.census.issueNumber)
  ));
  const selection = selectPrincipalOwnedCanonicalArtifact(
    targetedComments,
    context.principalLogin,
    (comment) => isCanonicalReviewerArtifact(
      comment.body,
      stage,
      context.census.issueNumber,
      sourceRevision,
      invocationId,
    ),
  );
  if (!selection.ok) {
    if (selection.cause === 'zero_principal_owned_match') {
      const principalRevisionCandidates = targetedComments.flatMap((comment) => {
        if (!comment.userLogin || !sameGithubPrincipal(comment.userLogin, context.principalLogin)) return [];
        const observedRevision = canonicalReviewerArtifactRevision(
          comment.body,
          stage,
          context.census.issueNumber,
          invocationId,
        );
        return observedRevision ? [observedRevision] : [];
      });
      const permanentNoncanonical = targetedComments.filter((comment) => (
        comment.userLogin !== null
        && sameGithubPrincipal(comment.userLogin, context.principalLogin)
        && comment.createdAt === comment.updatedAt
        && publicationBindingAnchors(comment.body, context.census.issueNumber, sourceRevision, invocationId)
        && verdictGrammarIsPermanentlyNoncanonical(comment.body)
      ));
      if (permanentNoncanonical.length === 1 && principalRevisionCandidates.length === 0) {
        const comment = permanentNoncanonical[0]!;
        errors.push(
          `authoritative GitHub artifact permanently_noncanonical_publication: repository=${context.census.repositoryFullName} issue=#${context.census.issueNumber} stage=${stage} invocationId=${invocationId} comment=${comment.id}`,
        );
        return null;
      }
      if (principalRevisionCandidates.length > 0) {
        errors.push(
          `authoritative GitHub artifact revision mismatch: repository=${context.census.repositoryFullName} issue=#${context.census.issueNumber} stage=${stage} invocationId=${invocationId} expected=${sourceRevision} observed=${[...new Set(principalRevisionCandidates)].sort().join(',')}`,
        );
        return null;
      }
    }
    errors.push(`authoritative GitHub artifact ${selection.cause}: ${selection.detail}`);
    return null;
  }
  const censusComment = selection.comment as AuthoritativeIssueComment;
  if (censusComment.createdAt !== censusComment.updatedAt) {
    errors.push(`authoritative GitHub artifact was edited: ${censusComment.htmlUrl}`);
    return null;
  }
  const comment = rereadAuthoritativeIssueComment(
    context,
    censusComment,
    stage,
    sourceRevision,
    invocationId,
    errors,
  );
  if (!comment) return null;
  const authority: AuthoritativeGithubArtifactAuthorityV1 = {
    kind: AUTHORITATIVE_GITHUB_ARTIFACT_BASIS,
    repositoryFullName: context.census.repositoryFullName,
    issueNumber: context.census.issueNumber,
    commentId: comment.id,
    commentUrl: comment.htmlUrl,
    publisherLogin: comment.userLogin!,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
  };
  if (invocation.artifactAuthority !== undefined && !jsonEqual(invocation.artifactAuthority, authority)) {
    errors.push('stage evidence artifactAuthority assertion disagrees with authoritative GitHub reread for invocation ' + invocationId);
    return null;
  }
  const name = authoritativeCaptureName(reviewDir, stage, stageSequence, reviewerSlot, invocation.capturePath);
  const materialized = materializeAuthoritativeCapture(
    reviewDir,
    name,
    comment.body,
    invocation.capturePath,
    invocation.captureIdentity,
    captureTexts,
    captureTimestamps,
    errors,
  );
  if (!materialized) return null;
  if (invocation.captureByteLength !== undefined && Number(invocation.captureByteLength) !== materialized.capture.byteLength) {
    errors.push('stage evidence captureByteLength assertion disagrees with authoritative GitHub bytes for invocation ' + invocationId);
    return null;
  }
  if (invocation.captureSha256 !== undefined && invocation.captureSha256 !== materialized.capture.sha256) {
    errors.push('stage evidence captureSha256 assertion disagrees with authoritative GitHub bytes for invocation ' + invocationId);
    return null;
  }
  if (invocation.rawFindingCount !== undefined && Number(invocation.rawFindingCount) !== materialized.capture.rawFindingCount) {
    errors.push('stage evidence rawFindingCount assertion disagrees with authoritative GitHub bytes for invocation ' + invocationId);
    return null;
  }
  return {
    capture: materialized.capture,
    captureText: comment.body,
    capturePath: materialized.path,
    captureCreated: materialized.created,
    authority,
  };
}



type ReconciliationTransportClassification = ReviewerInvocationEnvelopeV1['terminalClassification'];
type ReconciliationRetryClass = ReviewerInvocationEnvelopeV1['retryClass'];

export type ZeroSendCauseClass = 'transient' | 'deterministic-input' | 'state-conflict';

export interface ZeroSendCausePolicy {
  class: ZeroSendCauseClass;
  code: string;
  rawCause: string;
}

export interface ZeroSendTerminalObservation {
  stageAttemptId: string;
  sourceRevision: string;
  stage: string;
  attemptOrdinal: 1;
  policy: ZeroSendCausePolicy;
  invocationId?: string;
  reviewerSlot?: string;
  owned_prompt_seen?: boolean;
  observed_user_heads?: string[];
}

const ZERO_SEND_EXCLUDED_CAUSES = [
  'child_start_failed',
  'browser process spawn failure',
] as const;

function envelopeText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function zeroSendCauseText(envelope: JsonRecord): { state: string; cause: string; incident: string } {
  return {
    state: envelopeText(envelope.turn_result_state) || envelopeText(envelope.state),
    cause: envelopeText(envelope.turn_result_cause) || envelopeText(envelope.cause),
    incident: envelopeText(envelope.incident),
  };
}

function observableTurnResult(envelope: JsonRecord): boolean {
  return envelope.schema === TURN_RESULT_SCHEMA
    || typeof envelope.turn_result_state === 'string'
    || typeof envelope.turn_result_cause === 'string'
    || (typeof envelope.state === 'string' && typeof envelope.cause === 'string');
}

function excludedZeroSendCause(text: string): boolean {
  return ZERO_SEND_EXCLUDED_CAUSES.some((cause) => text.includes(cause));
}

function deterministicZeroSendCode(state: string, cause: string): string | null {
  const blob = `${state}\n${cause}`;
  if (blob.includes('input_invalid')) return 'input_invalid';
  if (blob.includes('canonical_prompt_mismatch')) return 'canonical_prompt_mismatch';
  if (blob.includes('argument_required:')) return 'argument_required';
  if (blob.includes('operator configuration missing')) return 'operator_configuration_missing';
  if (blob.includes('owned_conversation_identity_mismatch')) return 'owned_conversation_identity_mismatch';
  return null;
}

function transientZeroSendCode(state: string, cause: string): string | null {
  if (state === 'rate_limit' || cause === 'rate_limit') return 'rate_limit';
  if (state === 'quota' || cause === 'quota') return 'quota';
  if (state === 'chrome_not_running' || cause === 'chrome_not_running') return 'chrome_not_running';
  if (state === 'composer-refusal' || cause.includes('composer') || cause === 'blocking_page_overlay') return 'composer-refusal';
  if (state === 'fill-timeout' || cause.includes('fill')) return 'fill-timeout';
  return null;
}

export function zeroSendEnvelopeDiagnostics(envelope: JsonRecord): {
  owned_prompt_seen?: boolean;
  observed_user_heads?: string[];
} {
  const candidates = [envelope];
  if (isRecord(envelope.observation_uncertainty_diagnostics)) candidates.push(envelope.observation_uncertainty_diagnostics);
  if (isRecord(envelope.uncertainty)) candidates.push(envelope.uncertainty);
  let ownedPromptSeen: boolean | undefined;
  let observedUserHeads: string[] | undefined;
  for (const candidate of candidates) {
    if (ownedPromptSeen === undefined && typeof candidate.owned_prompt_seen === 'boolean') {
      ownedPromptSeen = candidate.owned_prompt_seen;
    }
    if (
      !observedUserHeads
      && Array.isArray(candidate.observed_user_heads)
      && candidate.observed_user_heads.every((item) => typeof item === 'string' && item.trim().length > 0)
    ) {
      observedUserHeads = [...candidate.observed_user_heads];
    }
  }
  return {
    ...(ownedPromptSeen !== undefined ? { owned_prompt_seen: ownedPromptSeen } : {}),
    ...(observedUserHeads ? { observed_user_heads: observedUserHeads } : {}),
  };
}

export function classifyZeroSendCausePolicy(envelope: JsonRecord): ZeroSendCausePolicy | null {
  if (envelope.send_count !== 0) return null;
  if (!observableTurnResult(envelope)) return null;
  const { state, cause, incident } = zeroSendCauseText(envelope);
  const rawCause = cause || state || incident;
  if (!rawCause) return null;
  if (excludedZeroSendCause(`${state}\n${cause}\n${incident}`)) return null;
  if (state.includes('observation_marker_conflict') || cause.includes('observation_marker_conflict')) {
    return { class: 'state-conflict', code: 'marker_conflict', rawCause };
  }
  const deterministic = deterministicZeroSendCode(state, cause);
  if (deterministic) return { class: 'deterministic-input', code: deterministic, rawCause };
  const transient = transientZeroSendCode(state, cause);
  if (transient) return { class: 'transient', code: transient, rawCause };
  return null;
}

export function reconcileStageReadIsRetryable(result: {
  temporary?: string;
  errors: readonly string[];
}): boolean {
  return Boolean(result.temporary)
    || result.errors.some((error) => error.includes('zero_principal_owned_match')
      || error.includes('authoritative GitHub artifact absent'));
}

function resolveInvocationEnvelope(evidencePath: string, invocation: JsonRecord): JsonRecord | null {
  if (isRecord(invocation.terminalEnvelope)) return invocation.terminalEnvelope;
  const terminalEnvelopePath = optionalString(invocation.terminalEnvelopePath);
  if (!terminalEnvelopePath) return null;
  const resolved = resolve(dirname(evidencePath), terminalEnvelopePath);
  try {
    const parsed: unknown = JSON.parse(readFileSync(resolved, 'utf8'));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function readEvidenceZeroSendTerminal(evidencePath: string): ZeroSendTerminalObservation | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(evidencePath, 'utf8')) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.invocations)) return null;
  const stageAttemptId = optionalString(parsed.stageAttemptId);
  const sourceRevision = optionalString(parsed.sourceRevision);
  const stage = optionalString(parsed.stage);
  if (!stageAttemptId || !sourceRevision || !stage) return null;
  let conflict: ZeroSendTerminalObservation | null = null;
  for (const invocation of parsed.invocations) {
    if (!isRecord(invocation)) continue;
    if (invocation.attemptOrdinal === 2) continue;
    if (invocation.terminal !== true || invocation.sendCount !== 0) continue;
    const envelope = resolveInvocationEnvelope(evidencePath, invocation);
    if (!envelope) continue;
    const policy = classifyZeroSendCausePolicy(envelope);
    if (!policy || policy.class === 'transient') continue;
    const diagnostics = zeroSendEnvelopeDiagnostics(envelope);
    const observation: ZeroSendTerminalObservation = {
      stageAttemptId,
      sourceRevision,
      stage,
      attemptOrdinal: 1,
      policy,
      ...(optionalString(invocation.invocationId) ? { invocationId: optionalString(invocation.invocationId) } : {}),
      ...(optionalString(invocation.reviewerSlot) ? { reviewerSlot: optionalString(invocation.reviewerSlot) } : {}),
      ...diagnostics,
    };
    if (policy.class === 'deterministic-input') return observation;
    if (!conflict) conflict = observation;
  }
  return conflict;
}

export function readCanonicalZeroSendTerminal(input: {
  issueNumber: number;
  sourceRevision: string;
  stage?: string;
  stateRootOverride?: string;
}): ZeroSendTerminalObservation | null {
  let directory: string;
  try {
    directory = resolveCanonicalReviewDirectory(
      { taskIdentity: `issue:${input.issueNumber}` },
      input.stateRootOverride,
    ).directory;
  } catch {
    return null;
  }
  if (!existsSync(directory)) return null;
  let conflict: ZeroSendTerminalObservation | null = null;
  const paths = readdirSync(directory)
    .filter((name) => /^attempt-[0-9]{3}\.json$/.test(name))
    .sort()
    .map((name) => join(directory, name));
  for (const path of paths) {
    const observed = readEvidenceZeroSendTerminal(path);
    if (!observed) continue;
    if (observed.sourceRevision.toLowerCase() !== input.sourceRevision.toLowerCase()) continue;
    if (input.stage && observed.stage !== input.stage) continue;
    if (observed.policy.class === 'deterministic-input') return observed;
    if (!conflict) conflict = observed;
  }
  return conflict;
}

function sealedPostSendSendCount(envelope: JsonRecord): 1 | null {
  const diagnostics = isRecord(envelope.diagnostics) ? envelope.diagnostics : null;
  const lastHeartbeat = diagnostics && isRecord(diagnostics.last_heartbeat) ? diagnostics.last_heartbeat : null;
  if (envelope.delivery === 'POSSIBLY_DELIVERED' && lastHeartbeat?.phase === 'post_send_observation') {
    return 1;
  }
  return null;
}

export function classifyReconciliationTransport(
  envelope: JsonRecord,
  attemptOrdinal: number,
): {
  terminalClassification: ReconciliationTransportClassification;
  sendCount: 0 | 1;
  retryClass: ReconciliationRetryClass;
} | null {
  const sendCount = envelope.send_count === 0 || envelope.send_count === 1
    ? envelope.send_count
    : sealedPostSendSendCount(envelope);
  if (sendCount !== 0 && sendCount !== 1) return null;
  const state = optionalString(envelope.turn_result_state) ?? '';
  const cause = optionalString(envelope.turn_result_cause) ?? '';
  const zeroSendPolicy = sendCount === 0 ? classifyZeroSendCausePolicy(envelope) : null;
  let terminalClassification: ReconciliationTransportClassification;
  if (envelope.lifecycle_outcome === 'success' && state === 'ok' && sendCount === 1) {
    terminalClassification = 'complete';
  } else if (
    zeroSendPolicy?.code === 'quota'
    || zeroSendPolicy?.code === 'rate_limit'
    || state === 'quota'
    || state === 'rate_limit'
  ) {
    terminalClassification = 'quota';
  } else if (
    sendCount === 0
    && (zeroSendPolicy?.code === 'composer-refusal'
      || cause.includes('composer')
      || cause === 'blocking_page_overlay')
  ) {
    terminalClassification = 'composer-refusal';
  } else if (sendCount === 0 && (zeroSendPolicy?.code === 'fill-timeout' || cause.includes('fill'))) {
    terminalClassification = 'fill-timeout';
  } else if (sendCount === 1 && state === 'output_conflict') {
    terminalClassification = 'output-conflict';
  } else if (sendCount === 1) {
    terminalClassification = 'post-send-failure';
  } else {
    terminalClassification = 'incident';
  }
  // A child-witnessed sendCount 0 proves nothing reached the reviewer, whatever the
  // pre-send cause; the two-attempt budget bounds the single retry.
  const retryableZeroSend = attemptOrdinal === 1
    && sendCount === 0
    && terminalClassification !== 'complete';
  return {
    terminalClassification,
    sendCount,
    retryClass: terminalClassification === 'complete'
      ? 'none'
      : retryableZeroSend
        ? 'eligible-zero-send'
        : 'retry-forbidden',
  };
}

function hydrateReconciliationTransport(
  evidencePath: string,
  invocation: JsonRecord,
  index: number,
  errors: string[],
): JsonRecord | null {
  const existingTerminalClassification = terminalClassification(invocation.terminalClassification);
  const existingRetryClass = retryClass(invocation.retryClass);
  const completeExisting = invocation.terminal === true
    && existingTerminalClassification !== null
    && (invocation.sendCount === 0 || invocation.sendCount === 1)
    && existingRetryClass !== null;
  const existingNeedsObservedZeroSendIdentity = completeExisting
    && invocation.sendCount === 0
    && existingTerminalClassification === 'incident'
    && existingRetryClass === 'retry-forbidden';
  const attemptOrdinal = invocation.attemptOrdinal === 2 ? 2 : 1;
  const storedEligibleZeroSendOnSecondAttempt = completeExisting
    && attemptOrdinal === 2
    && invocation.sendCount === 0
    && existingRetryClass === 'eligible-zero-send';
  const reuseStoredTransport = completeExisting && !storedEligibleZeroSendOnSecondAttempt;
  if (reuseStoredTransport && !existingNeedsObservedZeroSendIdentity) return { ...invocation };

  const terminalEnvelopePath = optionalString(invocation.terminalEnvelopePath);
  if (!terminalEnvelopePath) {
    errors.push('stage evidence invocation[' + index + '].terminalEnvelopePath is missing; authority=lifecycle-tool-witnessed');
    return null;
  }
  const resolved = resolve(dirname(evidencePath), terminalEnvelopePath);
  const observed = readJson(resolved, 'flow-manager terminal envelope', errors);
  if (!isRecord(observed) || observed.schema !== 'flow-manager-long-running-child-terminal/v1') {
    errors.push('stage evidence invocation[' + index + '] terminal envelope is malformed: ' + resolved);
    return null;
  }
  const transport = classifyReconciliationTransport(observed, attemptOrdinal);
  if (!transport) {
    errors.push('stage evidence invocation[' + index + '] terminal envelope has no exact send_count; authority=lifecycle-tool-witnessed');
    return null;
  }
  if (typeof observed.terminal_at !== 'string' || !observed.terminal_at.trim()) {
    errors.push('stage evidence invocation[' + index + '] terminal envelope is not terminal');
    return null;
  }
  if (
    completeExisting
    && (
      existingTerminalClassification !== transport.terminalClassification
      || invocation.sendCount !== transport.sendCount
    )
  ) {
    errors.push('stage evidence invocation[' + index + '] terminal transport disagrees with its bound terminal envelope');
    return null;
  }

  const needsObservedZeroSendIdentity = reuseStoredTransport
    ? existingNeedsObservedZeroSendIdentity
    : transport.sendCount === 0
      && transport.terminalClassification === 'incident'
      && transport.retryClass === 'retry-forbidden';
  let observedTerminalResultIdentity: string | undefined;
  if (needsObservedZeroSendIdentity) {
    const admittedInvocationId = optionalString(invocation.invocationId);
    const observedInvocationId = optionalString(observed.observed_invocation_id);
    const observedIdentity = optionalString(observed.observed_turn_result_identity);
    if (!admittedInvocationId || observedInvocationId !== admittedInvocationId) {
      errors.push('stage evidence invocation[' + index + '] terminal envelope observed_invocation_id does not match admitted invocationId');
      return null;
    }
    if (!observedIdentity || !/^sha256:[0-9a-f]{64}:turn-result-v1$/.test(observedIdentity)) {
      errors.push('stage evidence invocation[' + index + '] terminal envelope lacks a valid observed turn-result identity');
      return null;
    }
    const assertedIdentity = optionalString(invocation.terminalResultIdentity);
    if (assertedIdentity && assertedIdentity !== observedIdentity) {
      errors.push('stage evidence invocation[' + index + '] terminalResultIdentity disagrees with observed turn-result identity');
      return null;
    }
    observedTerminalResultIdentity = observedIdentity;
  }
  return {
    ...invocation,
    terminal: true,
    ...(reuseStoredTransport ? {} : {
      terminalClassification: transport.terminalClassification,
      sendCount: transport.sendCount,
      retryClass: transport.retryClass,
    }),
    ...(observedTerminalResultIdentity ? { terminalResultIdentity: observedTerminalResultIdentity } : {}),
  };
}

function atomicReplaceStageEvidence(
  path: string,
  expectedCurrentText: string,
  value: JsonRecord,
  errors: string[],
): boolean {
  let current: string;
  try { current = readFileSync(path, 'utf8'); } catch {
    errors.push('stage evidence became unreadable before reconciliation commit: ' + path);
    return false;
  }
  if (current !== expectedCurrentText) {
    errors.push('stale_next_action: lifecycle stage evidence changed during reconciliation');
    return false;
  }
  const temporary = path + '.reconcile-' + process.pid + '.tmp';
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    renameSync(temporary, path);
    return true;
  } catch (error) {
    errors.push('unable to commit lifecycle stage evidence: ' + (error instanceof Error ? error.message : String(error)));
    return false;
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { force: true });
  }
}

const PUBLISHED_COMMENT_URL_RE = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/issues\/([1-9][0-9]*)#issuecomment-([1-9][0-9]*)$/;

export interface BindPublishedCommentToSlotOptions {
  reviewDir: string;
  stageEvidencePath: string;
  repositoryFullName: string;
  issueNumber: number;
  reviewerSlot: string;
  invocationId: string;
  commentUrl: string;
  artifactSourceTransport?: GhTransport;
}

export interface BindPublishedCommentToSlotResult {
  ok: boolean;
  errors: string[];
  sendCount?: 1;
  reviewerSlot?: string;
  invocationId?: string;
  commentUrl?: string;
}

function publishedCommentHeaderMatches(
  body: string,
  issueNumber: number,
  sourceRevision: string,
  invocationId: string,
  stage: Exclude<ReviewStage, 'architectural-lens'> | null,
): boolean {
  const lines = body.split(/\n/).map((line) => line.replace(/\r$/, '').trim()).filter((line) => line.length > 0);
  if (lines.length < 2) return false;
  const revision = CANONICAL_REVISION_LINE_RE.exec(lines[0]!);
  if (!revision || Number(revision[1]) !== issueNumber || revision[2] !== sourceRevision) return false;
  const echoes = lines.flatMap((line) => {
    const match = INVOCATION_ECHO_RE.exec(line);
    return match ? [match[1]!] : [];
  });
  if (echoes.length !== 1 || echoes[0] !== invocationId) return false;
  if (!stage) return false;
  return isCanonicalReviewerArtifact(body, stage, issueNumber, sourceRevision, invocationId);
}

function publishedCommentReviewEpisodeId(
  raw: JsonRecord,
  reviewDir: string,
  errors: string[],
): string | undefined {
  const explicit = optionalString(raw.reviewEpisodeId);
  const intakePath = join(reviewDir, 'tier-intake.json');
  let derived: string | undefined;
  if (existsSync(intakePath)) {
    const intakeErrors: string[] = [];
    const intake = loadTierIntake(intakePath, intakeErrors);
    if (!intake) {
      errors.push(...intakeErrors);
      return undefined;
    }
    const taskIdentity = optionalString(raw.taskIdentity);
    if (taskIdentity && taskIdentity !== intake.taskIdentity) {
      errors.push('tier-intake taskIdentity does not match stage evidence');
      return undefined;
    }
    derived = deriveReviewEpisodeId(intake.taskIdentity, intake.firstRevision);
  }
  if (explicit && derived && explicit !== derived) {
    errors.push('stage evidence.reviewEpisodeId is not canonical for tier-intake');
    return undefined;
  }
  if (explicit || derived) return explicit ?? derived;
  errors.push('stage evidence.reviewEpisodeId is missing and tier-intake/v1 is not in the review directory');
  return undefined;
}

function publishedCommentInvocationRow(
  raw: JsonRecord,
  reviewerSlot: string,
  invocationId: string,
  sourceRevision: string,
  artifactAuthority: JsonRecord,
  reviewEpisodeId: string,
): JsonRecord {
  const stage = reviewerStage(raw.stage);
  const version = policyVersion(raw.policyVersion);
  const stageAttemptId = optionalString(raw.stageAttemptId);
  const cardinalityConfigIdentity = optionalString(raw.cardinalityConfigIdentity);
  const routing = isReviewLaneRouting(raw.reviewLaneRouting)
    ? raw.reviewLaneRouting
    : (isRecord(raw.reviewLane) && isReviewLaneRouting(raw.reviewLane.routing) ? raw.reviewLane.routing : undefined);
  return {
    schema: 'reviewer-invocation-envelope/v1',
    reviewEpisodeId,
    ...(stageAttemptId ? { stageAttemptId } : {}),
    ...(version ? { policyVersion: version } : {}),
    ...(typeof raw.reviewerCardinality === 'number' ? { reviewerCardinality: raw.reviewerCardinality } : {}),
    ...(cardinalityConfigIdentity ? { cardinalityConfigIdentity } : {}),
    ...(stage ? { stage } : {}),
    sourceRevision,
    invocationId,
    reviewerSlot,
    reviewerOrdinal: Number(reviewerSlot),
    attemptOrdinal: 1,
    retryAttempt: false,
    terminal: true,
    terminalClassification: 'incident',
    sendCount: 1,
    retryClass: 'retry-forbidden',
    revisionCheck: 'matched',
    capacityOutcome: 'admitted',
    capacityWaitMs: 0,
    artifactAuthority,
    ...(routing ? { reviewLaneRouting: routing } : {}),
  };
}

export function bindPublishedCommentToSlot(
  options: BindPublishedCommentToSlotOptions,
): BindPublishedCommentToSlotResult {
  const errors: string[] = [];
  const reviewerSlot = options.reviewerSlot.trim();
  const invocationId = options.invocationId.trim();
  const commentUrl = options.commentUrl.trim();
  if (!reviewerSlot) errors.push('reviewerSlot is missing');
  if (!invocationId) errors.push('invocationId is missing');
  const urlMatch = PUBLISHED_COMMENT_URL_RE.exec(commentUrl);
  if (!urlMatch) errors.push('comment URL must be a canonical published Issue comment URL');
  if (urlMatch && urlMatch[1]!.toLowerCase() !== options.repositoryFullName.toLowerCase()) {
    errors.push('comment URL repository does not match --repo');
  }
  if (urlMatch && Number(urlMatch[2]) !== options.issueNumber) {
    errors.push('comment URL Issue does not match --issue-number');
  }
  let originalText: string;
  try { originalText = readFileSync(options.stageEvidencePath, 'utf8'); } catch {
    return { ok: false, errors: ['missing stage evidence: ' + options.stageEvidencePath] };
  }
  let rawValue: unknown;
  try { rawValue = JSON.parse(originalText) as unknown; } catch {
    return { ok: false, errors: ['unable to read stage evidence: ' + options.stageEvidencePath] };
  }
  if (!isRecord(rawValue) || rawValue.schema !== STAGE_EVIDENCE_SCHEMA) {
    return { ok: false, errors: ['stage evidence must use ' + STAGE_EVIDENCE_SCHEMA + ': ' + options.stageEvidencePath] };
  }
  const raw: JsonRecord = structuredClone(rawValue);
  const sourceRevision = requiredString(raw.sourceRevision, 'stage evidence.sourceRevision', errors);
  const invocations = Array.isArray(raw.invocations)
    ? raw.invocations.filter((value): value is JsonRecord => isRecord(value))
    : [];
  if (!Array.isArray(raw.invocations)) errors.push('stage evidence.invocations must be an array');
  if (errors.length > 0 || !urlMatch || !sourceRevision) {
    return { ok: false, errors: [...new Set(errors)] };
  }

  const transport = options.artifactSourceTransport ?? defaultGhTransport();
  const commentId = Number(urlMatch[3]);
  const response = transport.runGh([
    'gh',
    'api',
    `repos/${options.repositoryFullName}/issues/comments/${commentId}`,
  ]);
  if (response.exitCode !== 0) {
    return { ok: false, errors: [temporaryError('source-unavailable', 'published comment GET failed for ' + commentUrl)] };
  }
  let parsedRaw: unknown;
  try { parsedRaw = JSON.parse(response.stdout) as unknown; } catch {
    return { ok: false, errors: [temporaryError('source-unavailable', 'published comment GET is malformed JSON for ' + commentUrl)] };
  }
  const comment = parseAuthoritativeIssueComment(parsedRaw, 'published comment ' + commentId, errors);
  if (!comment) return { ok: false, errors: [...new Set(errors)] };
  if (comment.htmlUrl !== commentUrl) {
    return { ok: false, errors: ['published comment html_url does not match the requested comment URL'] };
  }
  if (!commentTargetsExpectedIssue(comment, options.repositoryFullName, options.issueNumber)) {
    return { ok: false, errors: ['published comment does not target the requested repository Issue'] };
  }
  if (!comment.userLogin) {
    return { ok: false, errors: [temporaryError('identity-unresolved', 'published comment has no publisher login')] };
  }
  if (comment.createdAt !== comment.updatedAt) {
    return { ok: false, errors: [`authoritative GitHub artifact was edited: ${comment.htmlUrl}`] };
  }
  let principalLogin: string;
  try {
    principalLogin = resolveAuthenticatedGithubPrincipal(transport);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, errors: [temporaryError('identity-unresolved', 'authenticated GitHub principal could not be resolved through tracked GET /user: ' + detail)] };
  }
  if (!sameGithubPrincipal(comment.userLogin, principalLogin)) {
    return { ok: false, errors: [`published comment publisher is not the authenticated principal: ${comment.userLogin}`] };
  }
  if (!publishedCommentHeaderMatches(comment.body, options.issueNumber, sourceRevision, invocationId, reviewerStage(raw.stage))) {
    return {
      ok: false,
      errors: ['published comment first two non-empty lines must be the revision line and INVOCATION_ID_TO_ECHO for that invocation'],
    };
  }

  const slotInvocations = invocations
    .filter((value) => optionalString(value.reviewerSlot) === reviewerSlot)
    .sort((left, right) => Number(left.attemptOrdinal ?? 0) - Number(right.attemptOrdinal ?? 0));
  const final = slotInvocations.at(-1);
  if (final && optionalString(final.invocationId) !== invocationId) {
    return { ok: false, errors: ['named slot final invocationId does not match --invocation-id'] };
  }
  if (!final && !/^\d{2}$/.test(reviewerSlot)) {
    return { ok: false, errors: ['reviewerSlot must be NN'] };
  }
  const createdReviewEpisodeId = final
    ? undefined
    : publishedCommentReviewEpisodeId(raw, options.reviewDir, errors);
  if (!final && !createdReviewEpisodeId) {
    return { ok: false, errors: [...new Set(errors)] };
  }

  const otherSlotsBefore = invocations
    .filter((value) => optionalString(value.reviewerSlot) !== reviewerSlot)
    .map((value) => JSON.stringify(value));
  const artifactAuthority = {
    kind: AUTHORITATIVE_GITHUB_ARTIFACT_BASIS,
    repositoryFullName: options.repositoryFullName,
    issueNumber: options.issueNumber,
    commentId: comment.id,
    commentUrl: comment.htmlUrl,
    publisherLogin: comment.userLogin,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
  };
  if (final) {
    final.sendCount = 1;
    final.artifactAuthority = artifactAuthority;
  } else {
    invocations.push(publishedCommentInvocationRow(raw, reviewerSlot, invocationId, sourceRevision, artifactAuthority, createdReviewEpisodeId!));
  }
  const otherSlotsAfter = invocations
    .filter((value) => optionalString(value.reviewerSlot) !== reviewerSlot)
    .map((value) => JSON.stringify(value));
  if (otherSlotsBefore.length !== otherSlotsAfter.length
    || otherSlotsBefore.some((value, index) => value !== otherSlotsAfter[index])) {
    return { ok: false, errors: ['bind-published-comment must not create or mutate mappings for other slots'] };
  }

  raw.invocations = invocations;
  if (!atomicReplaceStageEvidence(options.stageEvidencePath, originalText, raw, errors)) {
    return { ok: false, errors: [...new Set(errors)] };
  }
  return {
    ok: true,
    errors: [],
    sendCount: 1,
    reviewerSlot,
    invocationId,
    commentUrl,
  };
}

export interface ReconcileCreateIssueStageOptions {
  reviewDir: string;
  stageEvidencePath: string;
  repositoryFullName: string;
  issueNumber: number;
  artifactSourceTransport?: GhTransport;
}

export interface ReconcileCreateIssueStageResult {
  ok: boolean;
  stageAttemptId?: string;
  stage?: Exclude<ReviewStage, 'architectural-lens'>;
  sourceRevision?: string;
  capturePaths: string[];
  alreadySettled?: boolean;
  errors: string[];
  temporary?: AcceptanceArtifactTemporaryClassification;
}

function rollbackNewReconciliationCaptures(
  candidates: readonly string[],
  preExisting: ReadonlySet<string>,
): void {
  for (const path of candidates) {
    if (preExisting.has(path) || !existsSync(path)) continue;
    try { unlinkSync(path); } catch {}
  }
}

const ROUTED_SOURCE_VERDICTS_DISAGREE = 'routed review record sourceVerdicts disagree with producer evidence';

function rebuildRoutedReviewLaneFromProducerEvidence(reviewLane: unknown): JsonRecord | null {
  if (!isRecord(reviewLane) || !isReviewLaneRouting(reviewLane.routing) || !isRecord(reviewLane.sourceVerdictEvidence)) return null;
  const sourceVerdicts: Record<string, ReviewLaneSourceVerdict> = {};
  for (const [slot, slotEvidence] of Object.entries(reviewLane.sourceVerdictEvidence)) {
    if (!isRecord(slotEvidence) || typeof slotEvidence.terminalClassification !== 'string' || slotEvidence.terminalClassification.trim() === '') return null;
    if (typeof slotEvidence.producerEvidenceIdentity !== 'string' || slotEvidence.producerEvidenceIdentity.trim() === '') return null;
    sourceVerdicts[slot] = normalizeMaterialVerdict({
      terminalClassification: slotEvidence.terminalClassification,
      captureVerified: typeof slotEvidence.captureVerified === 'boolean' ? slotEvidence.captureVerified : undefined,
      digestMatches: typeof slotEvidence.digestMatches === 'boolean' ? slotEvidence.digestMatches : undefined,
      verdictText: typeof slotEvidence.verdictText === 'string' ? slotEvidence.verdictText : undefined,
      rawFindingCount: typeof slotEvidence.rawFindingCount === 'number' ? slotEvidence.rawFindingCount : undefined,
      materialFindingBlocks: typeof slotEvidence.materialFindingBlocks === 'number' ? slotEvidence.materialFindingBlocks : undefined,
    });
  }
  const routing = reviewLane.routing;
  const settlement = settleReviewLane(routing, sourceVerdicts);
  const rebuilt = {
    routing,
    finalRequiredSlots: settlement.finalRequiredSlots,
    sourceVerdicts,
    sourceVerdictEvidence: reviewLane.sourceVerdictEvidence,
    conflictDecision: settlement.conflictDecision,
    settlement,
  };
  return validateReviewLaneRecord(rebuilt).ok ? rebuilt : null;
}

function projectReconciledStageReceipt(
  reviewDir: string,
  evidencePath: string,
  issueNumber: number,
  raw: JsonRecord,
  captureTexts: Map<string, string>,
  captureTimestamps: Map<string, number>,
  context: ArtifactAuthorityContext,
  errors: string[],
): JsonRecord | null {
  const intakeErrors: string[] = [];
  const intakePath = join(reviewDir, 'tier-intake.json');
  const intake = existsSync(intakePath) ? loadTierIntake(intakePath, intakeErrors) : null;
  const taskIdentity = intake?.taskIdentity
    ?? (typeof raw.taskIdentity === 'string' ? raw.taskIdentity : `issue:${issueNumber}`);
  const episodeFirstRevision = intake?.firstRevision
    ?? (typeof raw.sourceRevision === 'string' ? raw.sourceRevision : '');
  if (!taskIdentity || !episodeFirstRevision) {
    errors.push(...intakeErrors, 'same-attempt receipt rebuild cannot observe the episode identity');
    return null;
  }
  const episodeId = deriveReviewEpisodeId(taskIdentity, episodeFirstRevision);
  const before = errors.length;
  const receipt = buildReceipt(
    evidencePath,
    raw,
    taskIdentity,
    episodeFirstRevision,
    episodeId,
    captureTexts,
    captureTimestamps,
    errors,
    undefined,
    context,
  );
  if (!receipt || errors.length > before) return null;
  return receipt as unknown as JsonRecord;
}

function atomicReplaceStageCompletenessReceipt(
  path: string,
  expectedCurrentText: string,
  value: JsonRecord,
  errors: string[],
): boolean {
  let current: string;
  try { current = readFileSync(path, 'utf8'); } catch {
    errors.push('stage-completeness receipt became unreadable before reconciliation commit: ' + path);
    return false;
  }
  if (current !== expectedCurrentText) {
    errors.push('stale_next_action: stage-completeness receipt changed during reconciliation');
    return false;
  }
  const temporary = path + '.reconcile-' + process.pid + '.tmp';
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    renameSync(temporary, path);
    return true;
  } catch (error) {
    errors.push('unable to commit stage-completeness receipt: ' + (error instanceof Error ? error.message : String(error)));
    return false;
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { force: true });
  }
}

export function reconcileCreateIssueStage(
  options: ReconcileCreateIssueStageOptions,
): ReconcileCreateIssueStageResult {
  const errors: string[] = [];
  let originalText: string;
  try { originalText = readFileSync(options.stageEvidencePath, 'utf8'); } catch {
    return { ok: false, capturePaths: [], errors: ['missing stage evidence: ' + options.stageEvidencePath] };
  }
  let rawValue: unknown;
  try { rawValue = JSON.parse(originalText) as unknown; } catch {
    return { ok: false, capturePaths: [], errors: ['unable to read stage evidence: ' + options.stageEvidencePath] };
  }
  if (!isRecord(rawValue) || rawValue.schema !== STAGE_EVIDENCE_SCHEMA) {
    return { ok: false, capturePaths: [], errors: ['stage evidence must use ' + STAGE_EVIDENCE_SCHEMA + ': ' + options.stageEvidencePath] };
  }
  const raw: JsonRecord = structuredClone(rawValue);
  const stage = reviewerStage(raw.stage);
  const stageAttemptId = requiredString(raw.stageAttemptId, 'stage evidence.stageAttemptId', errors);
  const sourceRevision = requiredString(raw.sourceRevision, 'stage evidence.sourceRevision', errors);
  const stageSequence = Number(raw.stageSequence);
  if (!stage) errors.push('stage reconciliation is only valid for Browser-GPT reviewer stages');
  if (!Number.isInteger(stageSequence) || stageSequence < 1) errors.push('stage evidence.stageSequence must be positive');
  if (typeof raw.taskIdentity === 'string' && raw.taskIdentity.trim() !== 'issue:' + options.issueNumber) {
    errors.push('stage evidence taskIdentity ' + raw.taskIdentity + ' does not bind Issue #' + options.issueNumber);
  }
  if (!stage || !stageAttemptId || !sourceRevision || errors.length > 0) {
    return {
      ok: false,
      ...(stageAttemptId ? { stageAttemptId } : {}),
      ...(stage ? { stage } : {}),
      ...(sourceRevision ? { sourceRevision } : {}),
      capturePaths: [],
      errors: [...new Set(errors)],
    };
  }

  let sameAttemptReceipt: { path: string; originalReceiptText: string; value: JsonRecord } | null = null;
  if (existsSync(options.reviewDir)) {
    for (const name of readdirSync(options.reviewDir).filter((candidate) => /^stage-completeness-receipt-.+\.json$/.test(candidate))) {
      const path = join(options.reviewDir, name);
      let originalReceiptText: string;
      try { originalReceiptText = readFileSync(path, 'utf8'); } catch { continue; }
      let value: unknown;
      try { value = JSON.parse(originalReceiptText) as unknown; } catch { continue; }
      if (!isRecord(value) || value.stage !== stage) continue;
      const settledAttemptId = optionalString(value.stageAttemptId);
      if (!settledAttemptId) continue;
      if (settledAttemptId !== stageAttemptId) {
        return {
          ok: false,
          stageAttemptId,
          stage,
          sourceRevision,
          capturePaths: [],
          errors: ['stage_slot_consumed: ' + stage + ' is already settled by stageAttemptId ' + settledAttemptId],
        };
      }
      const laneValidation = validateReviewLaneRecord(value.reviewLane);
      if (!laneValidation.ok && laneValidation.errors.includes(ROUTED_SOURCE_VERDICTS_DISAGREE)) {
        if (!rebuildRoutedReviewLaneFromProducerEvidence(value.reviewLane)) {
          return {
            ok: false,
            stageAttemptId,
            stage,
            sourceRevision,
            capturePaths: [],
            errors: [ROUTED_SOURCE_VERDICTS_DISAGREE],
          };
        }
      }
      sameAttemptReceipt = { path, originalReceiptText, value };
      break;
    }
  }

  if (!Array.isArray(raw.invocations)) {
    return { ok: false, stageAttemptId, stage, sourceRevision, capturePaths: [], errors: ['stage evidence.invocations is missing'] };
  }
  const hydrated = raw.invocations.map((value, index) => (
    isRecord(value) ? hydrateReconciliationTransport(options.stageEvidencePath, value, index, errors) : null
  ));
  if (hydrated.some((value) => value === null)) {
    if (raw.invocations.some((value) => !isRecord(value))) errors.push('stage evidence invocations must all be objects');
    return { ok: false, stageAttemptId, stage, sourceRevision, capturePaths: [], errors: [...new Set(errors)] };
  }
  const invocations = hydrated as JsonRecord[];
  raw.invocations = invocations;

  const routing = isReviewLaneRouting(raw.reviewLaneRouting) ? raw.reviewLaneRouting as ReviewLaneRouting : null;
  const initialRequiredSlots = routing ? routing.initiallyActivatedSlots : requiredFinalSlots(raw);
  if (initialRequiredSlots.length === 0) {
    return { ok: false, stageAttemptId, stage, sourceRevision, capturePaths: [], errors: ['stage evidence has no required reviewer slots'] };
  }

  const transport = options.artifactSourceTransport ?? defaultGhTransport();
  let liveIssue: ReturnType<typeof fetchIssueRevision>;
  try {
    liveIssue = fetchIssueRevision(transport, options.repositoryFullName, options.issueNumber);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const message = temporaryError('source-unavailable', 'unable to revalidate live Issue before reconciliation: ' + detail);
    return { ok: false, stageAttemptId, stage, sourceRevision, capturePaths: [], errors: [message], temporary: 'source-unavailable' };
  }
  const liveRevision = /<!--\s*source-revision:\s*(r[0-9]+)\s*-->/i.exec(liveIssue.body)?.[1];
  const sourceRevisionOrdinal = /^r([0-9]+)$/i.exec(sourceRevision)?.[1];
  const liveRevisionOrdinal = liveRevision ? /^r([0-9]+)$/i.exec(liveRevision)?.[1] : undefined;
  const acceptsNextLiveRevision = Boolean(sourceRevisionOrdinal && liveRevisionOrdinal)
    && BigInt(liveRevisionOrdinal!) === BigInt(sourceRevisionOrdinal!) + 1n
    && authorReplyDispositionForStage(options.reviewDir, sourceRevision, stage) === 'current';
  if (!liveRevision || (liveRevision.toLowerCase() !== sourceRevision.toLowerCase() && !acceptsNextLiveRevision)) {
    return {
      ok: false,
      stageAttemptId,
      stage,
      sourceRevision,
      capturePaths: [],
      errors: ['stale_next_action: live Issue revision is ' + (liveRevision ?? '<missing>') + ', expected ' + sourceRevision],
    };
  }

  let principalLogin: string;
  try {
    principalLogin = resolveAuthenticatedGithubPrincipal(transport);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const message = temporaryError('identity-unresolved', 'authenticated GitHub principal could not be resolved through tracked GET /user: ' + detail);
    return { ok: false, stageAttemptId, stage, sourceRevision, capturePaths: [], errors: [message], temporary: 'identity-unresolved' };
  }
  const census = authoritativeIssueCommentCensus(transport, options.repositoryFullName, options.issueNumber, errors);
  if (!census) {
    const temporary = temporaryClassification(errors) ?? 'source-unavailable';
    return { ok: false, stageAttemptId, stage, sourceRevision, capturePaths: [], errors: [...new Set(errors)], temporary };
  }
  const context: ArtifactAuthorityContext = { transport, census, principalLogin };
  const captureTexts = new Map<string, string>();
  const captureTimestamps = new Map<string, number>();
  const candidatePaths: string[] = [];
  const preExisting = new Set<string>();
  const capturePaths: string[] = [];
  const resolvedBySlot = new Map<string, AuthoritativeArtifactResolution>();

  const resolveSlot = (reviewerSlot: string): boolean => {
    const candidates = invocations
      .filter((value) => optionalString(value.reviewerSlot) === reviewerSlot)
      .sort((left, right) => Number(left.attemptOrdinal ?? 0) - Number(right.attemptOrdinal ?? 0));
    const final = candidates.at(-1);
    if (!final) {
      errors.push('stage evidence missing final invocation mapping for reviewerSlot ' + reviewerSlot);
      return false;
    }
    if (final.stageAttemptId !== stageAttemptId) errors.push('reviewerSlot ' + reviewerSlot + ' stageAttemptId does not match admitted attempt');
    if (final.stage !== stage) errors.push('reviewerSlot ' + reviewerSlot + ' stage does not match admitted stage');
    if (final.sourceRevision !== sourceRevision) errors.push('reviewerSlot ' + reviewerSlot + ' sourceRevision does not match admitted revision');
    if (!optionalString(final.invocationId)) errors.push('reviewerSlot ' + reviewerSlot + ' invocationId is missing');
    if (final.sendCount === 0) {
      if (
        final.terminal !== true
        || final.terminalClassification !== 'incident'
        || final.retryClass !== 'retry-forbidden'
        || !optionalString(final.terminalResultIdentity)
      ) {
        errors.push('reviewerSlot ' + reviewerSlot + ' zero-send evidence cannot credential a missing source; retryClass=' + String(final.retryClass));
        return false;
      }
      return true;
    }
    if (final.sendCount !== 1) {
      errors.push('reviewerSlot ' + reviewerSlot + ' has no GitHub-reconcilable delivery; observed sendCount=' + String(final.sendCount) + ' retryClass=' + String(final.retryClass));
      return false;
    }
    if (errors.length > 0) return false;
    const captureTarget = resolve(
      options.reviewDir,
      authoritativeCaptureName(options.reviewDir, stage, stageSequence, reviewerSlot, final.capturePath),
    );
    candidatePaths.push(captureTarget);
    if (existsSync(captureTarget)) preExisting.add(captureTarget);
    const resolvedArtifact = resolveAuthoritativeArtifact(
      context,
      options.reviewDir,
      stage,
      stageSequence,
      final,
      captureTexts,
      captureTimestamps,
      errors,
    );
    if (!resolvedArtifact) return false;
    const assertedByteLength = final.captureByteLength;
    const assertedSha256 = final.captureSha256;
    const assertedFindingCount = final.rawFindingCount;
    if (assertedByteLength !== undefined && Number(assertedByteLength) !== resolvedArtifact.capture.byteLength) {
      errors.push('reviewerSlot ' + reviewerSlot + ' captureByteLength assertion disagrees with authoritative GitHub bytes');
      return false;
    }
    if (assertedSha256 !== undefined && assertedSha256 !== resolvedArtifact.capture.sha256) {
      errors.push('reviewerSlot ' + reviewerSlot + ' captureSha256 assertion disagrees with authoritative GitHub bytes');
      return false;
    }
    if (assertedFindingCount !== undefined && Number(assertedFindingCount) !== resolvedArtifact.capture.rawFindingCount) {
      errors.push('reviewerSlot ' + reviewerSlot + ' rawFindingCount assertion disagrees with authoritative GitHub bytes');
      return false;
    }
    resolvedBySlot.set(reviewerSlot, resolvedArtifact);
    final.capturePath = resolvedArtifact.capturePath;
    final.captureIdentity = resolvedArtifact.capture.captureIdentity;
    final.captureByteLength = resolvedArtifact.capture.byteLength;
    final.captureSha256 = resolvedArtifact.capture.sha256;
    final.rawFindingCount = resolvedArtifact.capture.rawFindingCount;
    final.artifactAuthority = resolvedArtifact.authority;
    capturePaths.push(resolvedArtifact.capturePath);
    return true;
  };

  for (const slot of initialRequiredSlots) resolveSlot(slot);

  let reviewLane: JsonRecord | undefined;
  if (routing && errors.length === 0) {
    const sourceVerdicts: Record<string, 'accept' | 'material-findings'> = {};
    const sourceVerdictEvidence: Record<string, JsonRecord> = {};
    const registerVerdict = (slot: string): void => {
      const resolvedArtifact = resolvedBySlot.get(slot);
      const finalInvocation = invocations
        .filter((value) => optionalString(value.reviewerSlot) === slot)
        .sort((left, right) => Number(left.attemptOrdinal ?? 0) - Number(right.attemptOrdinal ?? 0))
        .at(-1);
      if (!resolvedArtifact || !finalInvocation) return;
      const verdict = resolvedArtifact.capture.rawFindingCount === 0 ? 'accept' : 'material-findings';
      sourceVerdicts[slot] = verdict;
      sourceVerdictEvidence[slot] = {
        producerEvidenceIdentity: 'authoritative-github-artifact:comment-' + resolvedArtifact.authority.commentId,
        captureIdentity: resolvedArtifact.capture.captureIdentity,
        terminalClassification: resolvedArtifact.authority.kind === AUTHORITATIVE_GITHUB_ARTIFACT_BASIS
          ? 'complete'
          : finalInvocation.terminalClassification,
        credentialingAuthority: 'authoritative-github-artifact',
        captureVerified: true,
        digestMatches: true,
        verdictText: verdict === 'accept' ? 'NO_FINDINGS' : 'FINDINGS',
        rawFindingCount: resolvedArtifact.capture.rawFindingCount,
      };
    };
    for (const slot of initialRequiredSlots) registerVerdict(slot);
    let laneSettlement = settleReviewLane(routing, sourceVerdicts);
    for (const slot of laneSettlement.finalRequiredSlots) {
      if (resolvedBySlot.has(slot)) continue;
      resolveSlot(slot);
      if (errors.length === 0) registerVerdict(slot);
    }
    if (errors.length === 0) laneSettlement = settleReviewLane(routing, sourceVerdicts);
    if (!laneSettlement.ok) errors.push(...laneSettlement.errors.map((error) => 'reviewLane settlement: ' + error));
    reviewLane = {
      routing,
      finalRequiredSlots: laneSettlement.finalRequiredSlots,
      sourceVerdicts,
      sourceVerdictEvidence,
      conflictDecision: laneSettlement.conflictDecision,
      settlement: laneSettlement,
    };
  }

  if (errors.length > 0) {
    rollbackNewReconciliationCaptures(candidatePaths, preExisting);
    const temporary = temporaryClassification(errors);
    return {
      ok: false,
      stageAttemptId,
      stage,
      sourceRevision,
      capturePaths: [],
      errors: [...new Set(errors)],
      ...(temporary ? { temporary } : {}),
    };
  }

  const finalRequiredSlots = reviewLane && Array.isArray(reviewLane.finalRequiredSlots)
    ? reviewLane.finalRequiredSlots.filter((slot): slot is string => typeof slot === 'string')
    : initialRequiredSlots;
  const unresolvedRequiredSlots = finalRequiredSlots.filter((slot) => !resolvedBySlot.has(slot));
  raw.outcome = unresolvedRequiredSlots.length === 0 ? 'complete' : 'partial';
  raw.producerEvidence = 'not-applicable';
  if (unresolvedRequiredSlots.length === 0) raw.partialMissingSources = [];
  raw.tierTransition = 'none';
  raw.revisionChecks = { attemptCreation: 'matched', beforeLaunch: 'matched', settlement: 'matched' };
  raw.settlement = { allLaunchedTerminal: true, retryState: 'none', finalRevisionMatched: true };
  if (reviewLane) {
    raw.reviewLane = reviewLane;
    raw.invocations = invocations.map((invocation) => ({
      ...invocation,
      reviewLaneRouting: routing,
    }));
  }
  let projectedReceipt: JsonRecord | null = null;
  if (sameAttemptReceipt) {
    const projectionErrors: string[] = [];
    projectedReceipt = projectReconciledStageReceipt(
      options.reviewDir,
      options.stageEvidencePath,
      options.issueNumber,
      raw,
      captureTexts,
      captureTimestamps,
      context,
      projectionErrors,
    );
    if (!projectedReceipt) {
      rollbackNewReconciliationCaptures(candidatePaths, preExisting);
      return {
        ok: false,
        stageAttemptId,
        stage,
        sourceRevision,
        capturePaths: [],
        errors: [...new Set(projectionErrors.length > 0 ? projectionErrors : ['same-attempt receipt cannot be rebuilt from observable evidence'])],
      };
    }
    const candidateBytes = Buffer.from(JSON.stringify(projectedReceipt, null, 2) + '\n');
    if (stageReceiptPayloadsMatchExceptDerivedChain(Buffer.from(sameAttemptReceipt.originalReceiptText), candidateBytes)) {
      rollbackNewReconciliationCaptures(candidatePaths, preExisting);
      return {
        ok: true,
        stageAttemptId,
        stage,
        sourceRevision,
        capturePaths: [],
        alreadySettled: true,
        errors: [],
      };
    }
  }

  if (!atomicReplaceStageEvidence(options.stageEvidencePath, originalText, raw, errors)) {
    rollbackNewReconciliationCaptures(candidatePaths, preExisting);
    return { ok: false, stageAttemptId, stage, sourceRevision, capturePaths: [], errors: [...new Set(errors)] };
  }

  if (sameAttemptReceipt && projectedReceipt) {
    const commitErrors: string[] = [];
    if (!atomicReplaceStageCompletenessReceipt(sameAttemptReceipt.path, sameAttemptReceipt.originalReceiptText, projectedReceipt, commitErrors)) {
      rollbackNewReconciliationCaptures(candidatePaths, preExisting);
      return { ok: false, stageAttemptId, stage, sourceRevision, capturePaths: [], errors: [...new Set(commitErrors)] };
    }
  }

  return { ok: true, stageAttemptId, stage, sourceRevision, capturePaths, errors: [] };
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

function turnResultIdentity(name: string, digest: string): string {
  return `sha256:${digest}:${name}`;
}

function readTurnResultForInvocation(
  evidencePath: string,
  invocation: JsonRecord,
  index: number,
  capture: CaptureIdentityV1 | null,
  captureText: string | null,
  errors: string[],
  artifactBacked: boolean,
  purpose: ReviewEpisodeValidationPurpose,
): string | null {
  const transportClassification = invocation.terminalClassification;
  if (purpose === 'final-acceptance' && artifactBacked) return null;
  if (transportClassification !== 'complete') return null;
  const label = `stage evidence invocation[${index}]`;
  const turnResultPath = optionalString(invocation.turnResultPath);
  if (!turnResultPath) {
    if (transportClassification === 'complete') errors.push(`${label}.turnResultPath is missing`);
    return null;
  }
  const resolved = resolve(dirname(evidencePath), turnResultPath);
  let stat;
  try { stat = lstatSync(resolved); } catch {
    if (transportClassification === 'complete') errors.push(`missing turn-result/v1 artifact for ${label}: ${resolved}`);
    return null;
  }
  if (!stat.isFile()) {
    if (transportClassification === 'complete') errors.push(`turn-result/v1 artifact for ${label} is not a regular file: ${resolved}`);
    return null;
  }
  let text: string;
  try { text = readFileSync(resolved, 'utf8'); } catch {
    if (transportClassification === 'complete') errors.push(`unable to read turn-result/v1 artifact for ${label}: ${resolved}`);
    return null;
  }
  let value: unknown;
  try { value = JSON.parse(text) as unknown; } catch {
    if (transportClassification === 'complete') errors.push(`turn-result/v1 artifact for ${label} is malformed: ${resolved}`);
    return null;
  }
  if (!isRecord(value) || value.schema !== TURN_RESULT_SCHEMA) {
    if (transportClassification === 'complete') errors.push(`turn-result/v1 artifact for ${label} has an invalid schema: ${resolved}`);
    return null;
  }
  const stateValid = TURN_STATES.includes(value.state as (typeof TURN_STATES)[number]);
  if (!stateValid) {
    if (transportClassification === 'complete') errors.push(`turn-result/v1 artifact for ${label} has an invalid state: ${resolved}`);
    return null;
  }
  const terminalFieldsValid = typeof value.scope === 'string'
    && typeof value.cause === 'string'
    && typeof value.configured_profile_key === 'string';
  if (transportClassification === 'complete' && !terminalFieldsValid) {
    errors.push(`turn-result/v1 artifact for ${label} is missing required terminal fields: ${resolved}`);
  }
  const frozenPolicy = parseReviewerSourcePolicy(optionalString(invocation.reviewerSource) ?? '')?.capturePolicy;
  const recoveryRequired = artifactBacked
    && invocation.sendCount === 1
    && frozenPolicy === 'direct-publication/v1'
    && value.state === 'recovery_required'
    && value.cause === 'direct_publication_no_owned_publication'
    && value.send_count === 1
    && terminalFieldsValid;
  if (transportClassification === 'complete' && value.state !== 'ok' && !recoveryRequired) {
    errors.push(`turn-result/v1 artifact for ${label} is not a successful terminal result: ${resolved}`);
  }
  const invocationMatches = value.invocation_id === invocation.invocationId;
  if (!invocationMatches) errors.push(`turn-result/v1 artifact for ${label} invocation_id does not match stage evidence: ${resolved}`);
  if (value.send_count !== undefined) {
    if ((value.send_count !== 0 && value.send_count !== 1) || Number(value.send_count) !== Number(invocation.sendCount)) {
      errors.push(`turn-result/v1 artifact for ${label}.send_count does not match stage evidence: ${resolved}`);
    }
  }
  const identity = turnResultIdentity(basename(resolved), sha256(text));
  if (invocation.terminalResultIdentity !== undefined && invocation.terminalResultIdentity !== identity) {
    errors.push(`stage evidence ${label}.terminalResultIdentity is not derived from the referenced turn-result: ${resolved}`);
  }
  if (transportClassification !== 'complete' || recoveryRequired) return identity;

  const output = isRecord(value.output) ? value.output : null;
  if (
    !output
    || !Number.isInteger(output.byte_length)
    || Number(output.byte_length) < 0
    || typeof output.sha256 !== 'string'
    || !/^[0-9a-f]{64}$/.test(output.sha256)
  ) {
    errors.push(`turn-result/v1 artifact for ${label} has invalid output metadata: ${resolved}`);
  }
  const reviewerSource = isRecord(value.reviewer_source) ? value.reviewer_source : null;
  const reviewerSourceKind = reviewerSource?.kind;
  const directSuccess = reviewerSourceKind === 'service-observed-issue-comment/v1';
  const directFailure = reviewerSourceKind === 'failed-write-final-assistant/v1';
  if (frozenPolicy === 'direct-publication/v1' && !directSuccess && !directFailure) {
    errors.push(`turn-result/v1 artifact for ${label} direct-publication policy requires terminal reviewer_source metadata: ${resolved}`);
  }
  if (frozenPolicy !== 'direct-publication/v1' && (directSuccess || directFailure)) {
    errors.push(`turn-result/v1 artifact for ${label} direct reviewer_source kind conflicts with frozen policy: ${resolved}`);
  }
  if (directSuccess || directFailure) {
    if (!capture) errors.push(`turn-result/v1 artifact for ${label} direct reviewer_source requires capture bytes: ${resolved}`);
    if (
      !reviewerSource
      || !Number.isInteger(reviewerSource.byte_length)
      || Number(reviewerSource.byte_length) !== capture?.byteLength
      || typeof reviewerSource.sha256 !== 'string'
      || reviewerSource.sha256 !== capture?.sha256
      || typeof reviewerSource.tool_call_id !== 'string'
      || typeof reviewerSource.repository_full_name !== 'string'
      || reviewerSource.repository_full_name.length === 0
      || !Number.isInteger(reviewerSource.issue_number)
      || Number(reviewerSource.issue_number) < 1
      || typeof reviewerSource.source_revision !== 'string'
      || reviewerSource.source_revision !== invocation.sourceRevision
      || !Number.isInteger(reviewerSource.finding_count)
      || (directSuccess && (typeof reviewerSource.comment_id !== 'string' || typeof reviewerSource.comment_url !== 'string'))
      || (directFailure && (reviewerSource.comment_id !== undefined || reviewerSource.comment_url !== undefined))
    ) {
      errors.push(`turn-result/v1 artifact for ${label} has invalid reviewer_source metadata: ${resolved}`);
    }
    if (capture && captureText !== null) {
      const parsed = parseCanonicalCaptureRevision(captureText);
      if (
        !parsed
        || parsed.issueNumber !== Number(reviewerSource?.issue_number)
        || parsed.sourceRevision !== reviewerSource?.source_revision
        || parsed.sourceRevision !== invocation.sourceRevision
        || parsed.findingCount !== Number(reviewerSource?.finding_count)
        || parsed.findingCount !== capture.rawFindingCount
      ) {
        errors.push(`turn-result/v1 artifact for ${label} reviewer_source does not match canonical capture bytes: ${resolved}`);
      }
    }
  }
  if (directFailure && capture && output && (Number(output.byte_length) !== capture.byteLength || output.sha256 !== capture.sha256)) {
    errors.push(`turn-result/v1 artifact for ${label} output does not match failed-write source bytes: ${resolved}`);
  } else if (!directSuccess && !directFailure && capture && output && (Number(output.byte_length) !== capture.byteLength || output.sha256 !== capture.sha256)) {
    errors.push(`turn-result/v1 artifact for ${label} output does not match capture bytes: ${resolved}`);
  }
  return identity;
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
  try { text = readFileSync(resolved, 'utf8'); } catch {
    errors.push(`unable to read capture file: ${resolved}`);
    return null;
  }
  const name = basename(resolved);
  const digest = sha256(text);
  const identity = captureIdentity(name, digest);
  captureTexts.set(identity, text);
  try { captureTimestamps.set(identity, statSync(resolved).mtimeMs); } catch {
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
    rawFindingCount: rawFindingCount(text, name),
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
  return { ...value, schema: 'tier-intake/v1', producer, taskIdentity, kind, priorTier, firstRevision } as TierIntakeAuthorityV1;
}

function assertDerived(
  value: unknown,
  expected: string,
  label: string,
  errors: string[],
): void {
  if (value !== undefined && value !== expected) errors.push(`${label} is not canonical; expected ${expected}`);
}

function requiredFinalSlots(raw: JsonRecord): string[] {
  if (isRecord(raw.reviewLane) && Array.isArray(raw.reviewLane.finalRequiredSlots)) {
    const slots = raw.reviewLane.finalRequiredSlots.filter((slot): slot is string => typeof slot === 'string' && /^\d{2}$/.test(slot));
    if (slots.length > 0) return slots;
  }
  const cardinality = Number(raw.reviewerCardinality);
  return Number.isInteger(cardinality) && cardinality > 0
    ? Array.from({ length: cardinality }, (_, index) => String(index + 1).padStart(2, '0'))
    : [];
}

function finalCredentialingCaptures(
  invocations: readonly ReviewerInvocationEnvelopeV1[],
  requiredSlots: readonly string[],
): CaptureIdentityV1[] | null {
  const captures: CaptureIdentityV1[] = [];
  for (const slot of requiredSlots) {
    const final = invocations
      .filter((invocation) => invocation.reviewerSlot === slot)
      .sort((left, right) => left.attemptOrdinal - right.attemptOrdinal)
      .at(-1);
    if (!final?.capture || (final.terminalClassification !== 'complete' && !final.artifactAuthority)) return null;
    captures.push(final.capture);
  }
  return captures;
}

function readOperatorWaiver(
  path: string | undefined,
  expected?: { stage: string; sourceRevision: string; missingSlots: readonly string[] },
): ProducerEvidence {
  return readEvidenceWaiverProducerEvidence(
    path,
    (candidate) => JSON.parse(readFileSync(candidate, 'utf8')) as unknown,
    expected,
  );
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
  operatorWaiverPath: string | undefined,
  artifactContext?: ArtifactAuthorityContext,
  purpose: ReviewEpisodeValidationPurpose = 'stage-time',
  createdInputPaths?: Set<string>,
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
      if (value.capture !== undefined) errors.push(`stage evidence invocation[${index}] capture must be derived from source bytes`);
      const browserStage = reviewerStage(stage);
      const artifactRequired = browserStage !== null && invocationRequiresAuthoritativeArtifact(value);
      let artifactResolution: AuthoritativeArtifactResolution | null = null;
      if (artifactRequired) {
        if (!artifactContext || browserStage === null) {
          errors.push(temporaryError('source-unavailable', `authoritative GitHub artifact census unavailable for invocation ${String(value.invocationId ?? index)}`));
        } else {
          artifactResolution = resolveAuthoritativeArtifact(
            artifactContext,
            dirname(evidencePath),
            browserStage,
            sequence,
            value,
            captureTexts,
            captureTimestamps,
            errors,
          );
          if (artifactResolution?.captureCreated) createdInputPaths?.add(artifactResolution.capturePath);
        }
      }
      if (!artifactRequired && value.terminalClassification === 'complete' && value.capturePath === undefined) {
        errors.push(`missing capture file evidence for completed invocation[${index}]`);
      }
      const capture = artifactResolution?.capture ?? (value.capturePath === undefined
        ? null
        : captureFromEvidence(evidencePath, value.capturePath, value.captureIdentity, captureTexts, captureTimestamps, errors));
      if (capture) captures.push(capture);
      const validatedTerminalResultIdentity = readTurnResultForInvocation(
        evidencePath,
        value,
        index,
        capture,
        capture ? captureTexts.get(capture.captureIdentity) ?? null : null,
        errors,
        Boolean(artifactResolution),
        purpose,
      ) ?? undefined;
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
            cardinalityConfigIdentity: requiredString(raw.cardinalityConfigIdentity, 'stage evidence.cardinalityConfigIdentity', errors),
            stage,
            sourceRevision,
          },
          capture ?? undefined,
          artifactResolution?.authority,
          validatedTerminalResultIdentity,
          errors,
          purpose,
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

  const browserCredentialing = stage === 'architectural-lens'
    ? null
    : finalCredentialingCaptures(invocations, requiredFinalSlots(raw));
  const derivedOutcome: StageCompletenessReceiptV1['outcome'] = browserCredentialing
    ? 'complete'
    : raw.outcome as StageCompletenessReceiptV1['outcome'];
  const partialMissingSources = Array.isArray(raw.partialMissingSources)
    ? raw.partialMissingSources as PartialMissingSourceWitness[]
    : [];
  const operatorWaiverEvidence = readOperatorWaiver(operatorWaiverPath, {
    stage,
    sourceRevision,
    missingSlots: partialMissingSources.flatMap((source) => (
      isRecord(source) && typeof source.reviewerSlot === 'string' ? [source.reviewerSlot] : []
    )),
  });
  const assertedProducerEvidence: ProducerEvidence = raw.producerEvidence === 'verified' || raw.producerEvidence === 'waived'
    ? raw.producerEvidence
    : 'not-applicable';
  let producerEvidence = assertedProducerEvidence;
  if (stage === 'architectural-lens') {
    producerEvidence = claude?.kind === 'capture' ? 'verified' : 'waived';
  } else if (assertedProducerEvidence === 'waived') {
    if (operatorWaiverEvidence !== 'waived') {
      errors.push(`stage ${stage} asserted producerEvidence=waived without a valid explicit operator waiver through --waiver`);
      producerEvidence = 'not-applicable';
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
    outcome: derivedOutcome,
    producerEvidence,
    partialMissingSources,
    revisionChecks: raw.revisionChecks as StageCompletenessReceiptV1['revisionChecks'],
    settlement: raw.settlement as StageCompletenessReceiptV1['settlement'],
    ...(invocations.length > 0 ? { invocations } : {}),
    ...(claude ? { claude: claude as unknown as StageCompletenessReceiptV1['claude'] } : {}),
    credentialingCaptures: stage === 'architectural-lens'
      ? (raw.outcome === 'complete' ? captures : [])
      : (browserCredentialing ?? []),
    relayEligibleCaptures: captures,
    ...(isRecord(raw.reviewLane) ? { reviewLane: raw.reviewLane as unknown as StageCompletenessReceiptV1['reviewLane'] } : {}),
  };
  if (stage !== 'architectural-lens' && receipt.outcome === 'partial') {
    const credentialing = evaluateStageCredentialingSettlement(receipt, receipt.reviewerCardinality, stage, purpose);
    errors.push(...credentialing.errors);
    if (credentialing.credentialed) receipt.credentialingCaptures = credentialing.credentialingCaptures as CaptureIdentityV1[];
  }
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
  rawValue: unknown,
  captures: readonly CaptureIdentityV1[],
  errors: string[],
): string | null {
  const raw = rawValue;
  if (!isRecord(raw) || raw.schema !== AUTHOR_DISPOSITIONS_SCHEMA || !Array.isArray(raw.findings)) {
    errors.push('author dispositions must use ' + AUTHOR_DISPOSITIONS_SCHEMA + '; field=author-dispositions authority=author-owned/GitHub-witnessed/lifecycle-tool-witnessed');
    return null;
  }
  if (raw.producer !== 'governed-author-output/v1' && raw.producer !== 'lifecycle-zero-state/v1') {
    errors.push('author dispositions lack governed producer provenance; field=findings/m4 authority=author-owned');
    return null;
  }
  const invalidFindingIndexes = raw.findings.flatMap((finding, index) => (
    isRecord(finding) ? [] : [index]
  ));
  if (invalidFindingIndexes.length > 0) {
    for (const index of invalidFindingIndexes) errors.push('author dispositions findings[' + index + '] must be an object; authority=author-owned');
    return null;
  }
  const findings = raw.findings as JsonRecord[];
  const ledger = {
    version: 2,
    ...(typeof raw.reviewEpisodeId === 'string' ? { reviewEpisodeId: raw.reviewEpisodeId } : {}),
    ...(typeof raw.sourceRevision === 'string' ? { sourceRevision: raw.sourceRevision } : {}),
    ...((raw.predecessorStage === null || typeof raw.predecessorStage === 'string')
      ? { predecessorStage: raw.predecessorStage }
      : {}),
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

function certifyTerminalCorrection(
  ledgerText: string,
  reviewDir: string,
  receipts: readonly ProducedStageReceipt[],
  issueRevision: string,
  phase: ProduceAcceptanceArtifactsOptions['phase'],
): boolean {
  if (phase !== 'final-acceptance') return false;
  let ledger: unknown;
  try {
    ledger = JSON.parse(ledgerText) as unknown;
  } catch {
    return false;
  }
  if (!isRecord(ledger) || typeof ledger.draft !== 'string' || typeof ledger.sourceRevision !== 'string') return false;
  const terminal = receipts.find((receipt) => receipt.stage === 'architectural' && receipt.outcome === 'complete');
  if (!terminal) return false;
  const sourcePath = join(reviewDir, `issue-${terminal.sourceRevision}-body.json`);
  if (!existsSync(sourcePath)) return false;
  let sourceSnapshot: unknown;
  try {
    sourceSnapshot = JSON.parse(readFileSync(sourcePath, 'utf8')) as unknown;
  } catch {
    return false;
  }
  if (!isRecord(sourceSnapshot) || typeof sourceSnapshot.body !== 'string') return false;
  const errors: string[] = [];
  return validateTerminalOneShotBodyBinding(
    sourceSnapshot.body,
    ledger.draft,
    issueRevision,
    receipts,
    errors,
  ) && errors.length === 0;
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

export function canonicalAcceptanceStages(
  tier: ReviewTier,
  intakeValue: unknown,
  phase: 'pre-lens' | 'post-lens' | 'final-acceptance',
  observedStages: readonly ReviewStage[] = [],
): ReviewStage[] {
  const intake = isRecord(intakeValue) ? intakeValue : {};
  const competitiveDecision = intake.competitiveDecision === 'required' || intake.competitiveDecision === 'skipped'
    ? intake.competitiveDecision
    : undefined;
  const competitiveRationale = optionalString(intake.competitiveRationale);
  const stages = canonicalStagePlan(tier, { competitiveDecision, competitiveRationale }).stages.map((entry) => entry.stage);
  return stagesForPhase(tier, stages, phase, observedStages);
}

const PRODUCED_ARTIFACT_NAMES = new Set<string>(ACCEPTANCE_ARTIFACT_OUTPUT_NAMES);

function isProducedArtifactName(name: string): boolean {
  return PRODUCED_ARTIFACT_NAMES.has(name);
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

function isLaterLensEvidence(path: string, phase: 'pre-lens' | 'post-lens' | 'final-acceptance'): boolean {
  if (phase !== 'pre-lens') return false;
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return isRecord(value)
      && value.schema === STAGE_EVIDENCE_SCHEMA
      && value.stage === 'architectural-lens';
  } catch {
    return false;
  }
}

function resolveCanonicalStageEvidencePaths(
  reviewDir: string,
  requestedPaths: readonly string[],
  errors: string[],
  phase: 'pre-lens' | 'post-lens' | 'final-acceptance' = 'final-acceptance',
): string[] | null {
  const discoveredPaths = stageEvidenceFilesInReviewDir(reviewDir);
  const ignored = new Set(discoveredPaths
    .filter((path) => isLaterLensEvidence(path, phase))
    .map((path) => resolve(path)));
  const canonicalPaths = discoveredPaths.filter((path) => !ignored.has(resolve(path)));
  const canonicalSet = new Set(canonicalPaths.map((path) => resolve(path)));
  const requestedSet = requestedPaths.length === 0
    ? new Set(canonicalPaths.map((path) => resolve(path)))
    : new Set(requestedPaths
        .map((path) => resolve(path))
        .filter((path) => !ignored.has(path)));
  const missing = canonicalPaths.filter((path) => !requestedSet.has(resolve(path)));
  const unexpected = requestedPaths
    .map((path) => resolve(path))
    .filter((path) => !canonicalSet.has(path) && !ignored.has(path));
  if (missing.length > 0) errors.push(`--stage-evidence omitted canonical stage evidence files: ${missing.join(', ')}`);
  if (unexpected.length > 0) errors.push(`--stage-evidence includes files outside the canonical review directory: ${[...new Set(unexpected)].join(', ')}`);
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

const DERIVED_STAGE_RECEIPT_FIELDS = new Set([
  'stageReceiptId',
  'previousStageReceiptId',
  'receiptCensus',
  'stageSequence',
]);

export function stageReceiptPayloadsMatchExceptDerivedChain(
  currentBytes: Buffer,
  candidateBytes: Buffer,
): boolean {
  const matches = (current: unknown, candidate: unknown, topLevel = false): boolean => {
    if (Array.isArray(current) || Array.isArray(candidate)) {
      if (!Array.isArray(current) || !Array.isArray(candidate) || current.length !== candidate.length) return false;
      return current.every((item, index) => matches(item, candidate[index], false));
    }
    if (isRecord(current) || isRecord(candidate)) {
      if (!isRecord(current) || !isRecord(candidate)) return false;
      const invocation = !topLevel && current.schema === 'reviewer-invocation-envelope/v1' && candidate.schema === 'reviewer-invocation-envelope/v1';
      const keys = new Set([...Object.keys(current), ...Object.keys(candidate)]);
      for (const key of keys) {
        if (topLevel && DERIVED_STAGE_RECEIPT_FIELDS.has(key)) continue;
        const currentHasKey = Object.prototype.hasOwnProperty.call(current, key);
        const candidateHasKey = Object.prototype.hasOwnProperty.call(candidate, key);
        if (topLevel && key === 'invocations' && (!currentHasKey || !candidateHasKey)) {
          const present = currentHasKey ? current[key] : candidate[key];
          if (Array.isArray(present) && present.length === 0) continue;
        }
        if (invocation && key === 'reviewerSource' && (!currentHasKey || !candidateHasKey)) continue;
        if (!currentHasKey || !candidateHasKey || !matches(current[key], candidate[key], false)) return false;
      }
      return true;
    }
    return Object.is(current, candidate);
  };

  try {
    const current = JSON.parse(currentBytes.toString('utf8')) as unknown;
    const candidate = JSON.parse(candidateBytes.toString('utf8')) as unknown;
    if (!isRecord(current) || !isRecord(candidate)) return false;
    return matches(current, candidate, true);
  } catch {
    return false;
  }
}

function publishArtifactSet(
  outputDir: string,
  files: readonly string[],
  contents: ReadonlyMap<string, string>,
  hooks?: AcceptanceArtifactPublicationHooks,
): void {
  const parentDir = dirname(outputDir);
  mkdirSync(parentDir, { recursive: true });
  const stagingDir = mkdtempSync(join(parentDir, `.${basename(outputDir)}.tmp-`));
  const backups = new Map<string, string>();
  const originallyAbsent = new Set<string>();
  try {
    for (const file of files) writeFileSync(join(stagingDir, file), contents.get(file) ?? '', { flag: 'wx' });
    mkdirSync(outputDir, { recursive: true });

    for (const [index, file] of files.entries()) {
      const target = join(outputDir, file);
      const staged = join(stagingDir, file);
      if (!existsSync(target)) {
        originallyAbsent.add(target);
        continue;
      }
      const targetStat = lstatSync(target);
      if (!targetStat.isFile()) throw new Error(`cannot replace non-file artifact target: ${target}`);
      const currentBytes = readFileSync(target);
      const candidateBytes = readFileSync(staged);
      if (
        file.startsWith('stage-completeness-receipt-')
        && !currentBytes.equals(candidateBytes)
        && !stageReceiptPayloadsMatchExceptDerivedChain(currentBytes, candidateBytes)
      ) {
        throw new Error(`conflicting immutable stage receipt target: ${target}`);
      }
      if (currentBytes.equals(candidateBytes)) continue;
      const backup = join(stagingDir, `.backup-${index}`);
      writeFileSync(backup, currentBytes, { flag: 'wx' });
      backups.set(target, backup);
    }

    let installIndex = 0;
    for (const file of files) {
      const target = join(outputDir, file);
      const staged = join(stagingDir, file);
      if (existsSync(target) && readFileSync(target).equals(readFileSync(staged))) continue;
      if (existsSync(target)) unlinkSync(target);
      renameSync(staged, target);
      installIndex += 1;
      hooks?.afterInstall?.({ file, target, installIndex });
    }
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const file of [...files].reverse()) {
      const target = join(outputDir, file);
      const backup = backups.get(target);
      try {
        if (backup && existsSync(backup)) {
          if (existsSync(target)) unlinkSync(target);
          renameSync(backup, target);
        } else if (originallyAbsent.has(target) && existsSync(target)) {
          unlinkSync(target);
        }
      } catch (rollbackError) {
        rollbackErrors.push(`${target}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
    }
    if (rollbackErrors.length > 0) {
      const original = error instanceof Error ? error.message : String(error);
      throw new Error(`${original}; rollback failed: ${rollbackErrors.join('; ')}`);
    }
    throw error;
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

function validateReceiptCycleLineage(
  receipts: readonly ProducedStageReceipt[],
  lineage: CanonicalLineage,
  errors: string[],
): void {
  const head = lineage.head;
  if (!head || head.logical.schema !== 'create-issue-review-cycle/v1') {
    errors.push('canonical cycle lineage has no admitted head cycle');
    return;
  }
  const derived = deriveCanonicalCycleLineage(lineage, head.logical['cycle-id']);
  errors.push(...derived.errors.map((error) => `canonical cycle lineage: ${error}`));
  const byCycleId = new Map(derived.entries.map((entry) => [entry.cycleId, entry]));
  let previousPosition = -1;
  for (const receipt of receipts) {
    const cycle = byCycleId.get(receipt.cycleId);
    if (!cycle) {
      errors.push(`stage receipt ${receipt.stageReceiptId} cycle ${receipt.cycleId} is off canonical predecessor lineage`);
      continue;
    }
    if (cycle.sourceRevision !== receipt.sourceRevision) {
      errors.push(`stage receipt ${receipt.stageReceiptId} sourceRevision ${receipt.sourceRevision} does not match canonical cycle revision ${cycle.sourceRevision}`);
    }
    if (receipt.cycleBinding.cycleId !== receipt.cycleId || receipt.cycleBinding.sourceRevision !== receipt.sourceRevision || receipt.cycleBinding.boundBeforeLaunch !== true) {
      errors.push(`stage receipt ${receipt.stageReceiptId} does not preserve its admitted cycleBinding`);
    }
    if (cycle.position < previousPosition) {
      errors.push(`stage receipt ${receipt.stageReceiptId} moves backward on canonical cycle lineage`);
    }
    previousPosition = Math.max(previousPosition, cycle.position);
  }
}

function stageInputsRequireAuthoritativeCensus(values: readonly JsonRecord[]): boolean {
  return values.some((stage) => Array.isArray(stage.invocations)
    && stage.invocations.some((invocation) => isRecord(invocation) && invocationRequiresAuthoritativeArtifact(invocation)));
}


interface AcceptanceIssueSnapshot {
  issueNumber: number;
  sourceRevision: string;
  title: string;
  body: string;
  path: string;
  bytes: string;
}

function stableAcceptanceIssueSnapshot(
  transport: GhTransport,
  repositoryFullName: string,
  issueNumber: number,
  reviewDir: string,
  errors: string[],
): AcceptanceIssueSnapshot | null {
  let first: ReturnType<typeof fetchIssueRevision>;
  let second: ReturnType<typeof fetchIssueRevision>;
  try {
    first = fetchIssueRevision(transport, repositoryFullName, issueNumber);
    second = fetchIssueRevision(transport, repositoryFullName, issueNumber);
  } catch (error) {
    errors.push(temporaryError(
      'source-unavailable',
      'GitHub-witnessed Issue body snapshot is unavailable: ' + (error instanceof Error ? error.message : String(error)),
    ));
    return null;
  }
  if (first.body !== second.body || first.title !== second.title) {
    errors.push('Issue title/body moved during acceptance snapshot production; authority=GitHub-witnessed');
    return null;
  }
  const matches = [...first.body.matchAll(/<!--\s*source-revision:\s*(r[0-9]+)\s*-->/gi)];
  if (matches.length !== 1 || !matches[0]?.[1]) {
    errors.push('Issue body snapshot has no unique source-revision marker; authority=GitHub-witnessed');
    return null;
  }
  const sourceRevision = matches[0][1];
  const path = join(reviewDir, 'issue-' + sourceRevision + '-body.json');
  const snapshot = {
    schema: 'create-issue-live-snapshot/v1',
    issueNumber,
    sourceRevision,
    title: first.title,
    body: first.body,
  };
  const bytes = JSON.stringify(snapshot, null, 2) + '\n';
  if (existsSync(path)) {
    let existing: string;
    try { existing = readFileSync(path, 'utf8'); } catch {
      errors.push('existing Issue body snapshot is unreadable: ' + path + '; field=issue snapshot authority=GitHub-witnessed');
      return null;
    }
    if (existing !== bytes) {
      errors.push('existing Issue body snapshot conflicts with current GitHub title/body bytes: ' + path + '; field=issue snapshot authority=GitHub-witnessed');
      return null;
    }
  }
  return { issueNumber, sourceRevision, title: first.title, body: first.body, path, bytes };
}

function latestAuthorReplyPath(reviewDir: string): string | null {
  if (!existsSync(reviewDir)) return null;
  const candidates = readdirSync(reviewDir)
    .map((name) => {
      const match = /^round-([0-9]+)-author-reply\.(?:md|txt)$/.exec(name);
      return match ? { name, round: Number(match[1]) } : null;
    })
    .filter((value): value is { name: string; round: number } => Boolean(value))
    .sort((left, right) => right.round - left.round || right.name.localeCompare(left.name));
  return candidates[0] ? join(reviewDir, candidates[0].name) : null;
}

export function locateGovernedAuthorDispositionBlock(
  text: string,
): { body: string } | { error: 'multiple' | 'none' } {
  return locateAuthorDispositionBlock(text);
}

export interface GovernedAuthorDispositionInspection {
  path: string;
  value: JsonRecord | null;
  diagnostics: AuthorDispositionDiagnostic[];
  schemaFragment: string;
}

export function inspectGovernedAuthorDispositionReply(path: string): GovernedAuthorDispositionInspection {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return {
      path,
      value: null,
      diagnostics: [{
        reason: 'invalid_author_field',
        ownership: 'author-owned',
        field: '$',
        message: 'governed author output is unreadable: ' + path,
      }],
      schemaFragment: renderAuthorDispositionPromptFragment(),
    };
  }
  const parsed = parseGovernedAuthorDispositionText(text);
  return {
    path,
    value: parsed.diagnostics.length === 0 && isRecord(parsed.value) ? parsed.value : null,
    diagnostics: parsed.diagnostics,
    schemaFragment: parsed.schemaFragment,
  };
}

export function latestGovernedAuthorReplyPath(reviewDir: string): string | null {
  return latestAuthorReplyPath(reviewDir);
}

export function inspectLatestGovernedAuthorDisposition(
  reviewDir: string,
): GovernedAuthorDispositionInspection | null {
  const path = latestAuthorReplyPath(reviewDir);
  return path ? inspectGovernedAuthorDispositionReply(path) : null;
}

function parseGovernedAuthorDispositionOutput(
  path: string,
  errors: string[],
  authorDiagnostics?: AuthorDispositionDiagnostic[],
): JsonRecord | null {
  const inspection = inspectGovernedAuthorDispositionReply(path);
  if (inspection.diagnostics.length > 0) {
    authorDiagnostics?.push(...inspection.diagnostics);
    errors.push(
      'governed author disposition rejected: '
      + authorDispositionDiagnosticsText(inspection.diagnostics)
      + '; authority=author-owned',
    );
    return null;
  }
  return inspection.value;
}

interface PreparedAuthorDispositions {
  path: string;
  bytes: string;
  value: JsonRecord;
  replaceExisting: boolean;
}

export type AuthorDispositionAdmission = 'lifecycle-zero-state' | 'defer-stage-materialization' | 'require-governed-reply';

/** Reviewer-stage materialization does not consume author adjudication. Post-lens and final-acceptance bundles do. */
export function producerConsumesAuthorAdjudication(phase: 'pre-lens' | 'post-lens' | 'final-acceptance'): boolean {
  return phase !== 'pre-lens';
}

/**
 * Missing `round-NN-author-reply.*` is decided by whether this operation consumes
 * author adjudication. `predecessorStage === null` only selects lifecycle zero-state.
 */
export type AuthorReplyDisposition = 'absent' | 'current' | 'historical' | 'malformed';

export function authorDispositionAdmission(input: {
  consumesAuthorAdjudication: boolean;
  predecessorPresent: boolean;
  authorReplyDisposition: AuthorReplyDisposition;
}): AuthorDispositionAdmission {
  if (input.authorReplyDisposition === 'malformed') return 'require-governed-reply';
  if (!input.consumesAuthorAdjudication && input.predecessorPresent && input.authorReplyDisposition !== 'current') {
    return 'defer-stage-materialization';
  }
  if (!input.predecessorPresent && input.authorReplyDisposition !== 'current') return 'lifecycle-zero-state';
  return 'require-governed-reply';
}

function stageAuthorBinding(reviewDir: string): { sourceRevision: string | null; predecessorStage: ReviewStage | null } {
  const stageInputs = stageEvidenceFilesInReviewDir(reviewDir).flatMap((path) => {
    try {
      const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
      return isRecord(value) ? [{ path, value }] : [];
    } catch {
      return [];
    }
  });
  const predecessorStage = latestLifecycleStage(stageInputs);
  const latest = stageInputs
    .map((entry) => ({
      stage: reviewStage(entry.value.stage),
      sequence: Number(entry.value.stageSequence),
      sourceRevision: typeof entry.value.sourceRevision === 'string' ? entry.value.sourceRevision : null,
    }))
    .filter((entry): entry is { stage: ReviewStage; sequence: number; sourceRevision: string | null } => (
      Boolean(entry.stage) && Number.isInteger(entry.sequence)
    ))
    .sort((left, right) => right.sequence - left.sequence)[0];
  return { sourceRevision: latest?.sourceRevision ?? null, predecessorStage };
}

function authorReplyDispositionForStage(
  reviewDir: string,
  sourceRevision: string | null,
  _predecessorStage: ReviewStage | null,
): AuthorReplyDisposition {
  const authorReplyPath = latestAuthorReplyPath(reviewDir);
  if (!authorReplyPath) return 'absent';
  const errors: string[] = [];
  const parsed = parseGovernedAuthorDispositionOutput(authorReplyPath, errors);
  if (!parsed) return 'malformed';
  if (sourceRevision === null || parsed.sourceRevision !== sourceRevision) return 'historical';
  return 'current';
}

function prepareAuthorDispositionsFromGovernedOutput(input: {
  reviewDir: string;
  targetPath: string;
  reviewEpisodeId: string;
  sourceRevision: string;
  predecessorStage: ReviewStage | null;
  draft: string;
  allowZeroState: boolean;
  errors: string[];
  authorDiagnostics: AuthorDispositionDiagnostic[];
}): PreparedAuthorDispositions | null {
  const authorReplyPath = latestAuthorReplyPath(input.reviewDir);
  let payload: JsonRecord;
  let producer: 'governed-author-output/v1' | 'lifecycle-zero-state/v1';
  if (!authorReplyPath) {
    if (!input.allowZeroState) {
      input.errors.push('missing governed author output round-NN-author-reply.*; field=findings/m4 authority=author-owned');
      return null;
    }
    producer = 'lifecycle-zero-state/v1';
    payload = {
      schema: AUTHOR_DISPOSITIONS_SCHEMA,
      sourceRevision: input.sourceRevision,
      findings: [],
      m4: { inventory: [] },
    };
  } else {
    producer = 'governed-author-output/v1';
    const parsed = parseGovernedAuthorDispositionOutput(
      authorReplyPath,
      input.errors,
      input.authorDiagnostics,
    );
    if (!parsed) return null;
    payload = parsed;
  }

  if (payload.sourceRevision !== input.sourceRevision) {
    input.errors.push('author dispositions sourceRevision disagrees with the stable GitHub snapshot; field=sourceRevision authority=GitHub-witnessed');
    return null;
  }
  const m4 = payload.m4 as JsonRecord;
  const produced: JsonRecord = {
    schema: AUTHOR_DISPOSITIONS_SCHEMA,
    producer,
    reviewEpisodeId: input.reviewEpisodeId,
    sourceRevision: input.sourceRevision,
    predecessorStage: input.predecessorStage,
    draft: input.draft,
    findings: payload.findings,
    m4: {
      reviewEpisodeId: input.reviewEpisodeId,
      sourceRevision: input.sourceRevision,
      predecessorStage: input.predecessorStage,
      inventory: m4.inventory,
    },
  };
  const bytes = JSON.stringify(produced, null, 2) + '\n';
  let replaceExisting = false;
  if (existsSync(input.targetPath)) {
    let existingText = '';
    try { existingText = readFileSync(input.targetPath, 'utf8'); } catch {
      input.errors.push('existing author-dispositions.json is unreadable: ' + input.targetPath + '; field=findings/m4 authority=author-owned');
      return null;
    }
    if (existingText !== bytes) {
      let existing: unknown;
      try { existing = JSON.parse(existingText) as unknown; } catch { existing = null; }
      if (!isRecord(existing)
        || existing.schema !== AUTHOR_DISPOSITIONS_SCHEMA
        || (existing.producer !== 'governed-author-output/v1' && existing.producer !== 'lifecycle-zero-state/v1')
        || existing.reviewEpisodeId !== input.reviewEpisodeId) {
        input.errors.push('existing author-dispositions.json is not a replaceable producer-owned binding; field=findings/m4 authority=author-owned');
        return null;
      }
      replaceExisting = true;
    }
  }
  return { path: input.targetPath, bytes, value: produced, replaceExisting };
}

interface PreparedInputCommit {
  created: string[];
  replaced: Map<string, string>;
}

function rollbackPreparedInputCommit(commit: PreparedInputCommit): void {
  for (const [path, previous] of [...commit.replaced.entries()].reverse()) {
    const temporary = path + '.rollback-' + process.pid + '.tmp';
    try {
      writeFileSync(temporary, previous, { encoding: 'utf8', flag: 'wx' });
      renameSync(temporary, path);
    } catch {
      try { if (existsSync(temporary)) unlinkSync(temporary); } catch {}
    }
  }
  for (const path of [...commit.created].reverse()) {
    try { if (existsSync(path)) unlinkSync(path); } catch {}
  }
}

function commitPreparedInputs(
  inputs: readonly { path: string; bytes: string; allowReplace?: boolean }[],
): PreparedInputCommit {
  const commit: PreparedInputCommit = { created: [], replaced: new Map() };
  try {
    for (const input of inputs) {
      mkdirSync(dirname(input.path), { recursive: true });
      if (existsSync(input.path)) {
        const previous = readFileSync(input.path, 'utf8');
        if (previous === input.bytes) continue;
        if (input.allowReplace !== true) throw new Error('conflicting immutable producer input: ' + input.path);
        const temporary = input.path + '.replace-' + process.pid + '.tmp';
        writeFileSync(temporary, input.bytes, { encoding: 'utf8', flag: 'wx' });
        renameSync(temporary, input.path);
        commit.replaced.set(input.path, previous);
        continue;
      }
      writeFileSync(input.path, input.bytes, { encoding: 'utf8', flag: 'wx' });
      commit.created.push(input.path);
    }
    return commit;
  } catch (error) {
    rollbackPreparedInputCommit(commit);
    throw error;
  }
}

function rollbackCreatedInputs(paths: Iterable<string>): void {
  for (const path of [...paths].reverse()) {
    try { if (existsSync(path)) unlinkSync(path); } catch {}
  }
}

function latestLifecycleStage(stageInputs: readonly { path: string; value: JsonRecord }[]): ReviewStage | null {
  const candidates = stageInputs
    .map((entry) => ({
      stage: reviewStage(entry.value.stage),
      sequence: Number(entry.value.stageSequence),
    }))
    .filter((entry): entry is { stage: ReviewStage; sequence: number } => Boolean(entry.stage) && Number.isInteger(entry.sequence))
    .sort((left, right) => right.sequence - left.sequence);
  return candidates[0]?.stage ?? null;
}

export function produceAcceptanceArtifacts(
  options: ProduceAcceptanceArtifactsOptions,
): AcceptanceArtifactResult {
  const outputDir = options.outputDir ?? options.reviewDir;
  const errors: string[] = [];
  const intake = loadTierIntake(options.tierIntakePath, errors);
  const taskIdentity = intake && requiredString(intake.taskIdentity, 'tier-intake.taskIdentity', errors);
  const episodeFirstRevision = intake && requiredString(intake.firstRevision, 'tier-intake.firstRevision', errors);
  if (!intake || !taskIdentity || !episodeFirstRevision) {
    return { ok: false, outputDir, files: [], missing: [], errors: [...new Set(errors)] };
  }
  const episodeId = deriveReviewEpisodeId(taskIdentity, episodeFirstRevision);
  const canonicalStageEvidencePaths = resolveCanonicalStageEvidencePaths(options.reviewDir, options.stageEvidencePaths, errors, options.phase ?? 'final-acceptance');
  if (canonicalStageEvidencePaths === null) {
    return { ok: false, outputDir, files: [], missing: [], errors: [...new Set(errors)], reviewEpisodeId: episodeId };
  }
  const stageInputs = canonicalStageEvidencePaths.map((path) => {
    const value = readJson(path, 'stage evidence', errors);
    return { path, value: isRecord(value) ? value : null };
  });
  const validStageInputs = stageInputs.filter((entry): entry is { path: string; value: JsonRecord } => entry.value !== null);
  const taskIssueMatch = /^issue:([1-9][0-9]*)$/.exec(taskIdentity);
  const repositoryFullName = options.repositoryFullName ?? 'chetwerikoff/orchestrator-pack';
  const artifactSourceTransport = options.artifactSourceTransport ?? options.operatorReferenceTransport ?? defaultGhTransport();
  const purpose: ReviewEpisodeValidationPurpose = (options.phase ?? 'final-acceptance') === 'final-acceptance'
    ? 'final-acceptance'
    : 'stage-time';

  const createdInputPaths = new Set<string>();
  const authorDiagnostics: AuthorDispositionDiagnostic[] = [];
  const authorSchemaFragment = renderAuthorDispositionPromptFragment();
  let issueSnapshot: AcceptanceIssueSnapshot | null = null;
  let preparedAuthor: PreparedAuthorDispositions | null = null;
  let authorAdjudicationDeferred = false;
  if (!taskIssueMatch) {
    errors.push('acceptance input authority requires tier-intake taskIdentity issue:<N>');
  } else {
    issueSnapshot = stableAcceptanceIssueSnapshot(
      artifactSourceTransport,
      repositoryFullName,
      Number(taskIssueMatch[1]),
      options.reviewDir,
      errors,
    );
  }
  if (issueSnapshot) {
    const predecessorStage = canonicalTerminalPredecessor(intake, errors);
    const artifactPhase = options.phase ?? 'final-acceptance';
    const admission = authorDispositionAdmission({
      consumesAuthorAdjudication: producerConsumesAuthorAdjudication(artifactPhase),
      predecessorPresent: predecessorStage !== null,
      authorReplyDisposition: authorReplyDispositionForStage(options.reviewDir, issueSnapshot.sourceRevision, predecessorStage),
    });
    if (admission === 'defer-stage-materialization') {
      authorAdjudicationDeferred = true;
    } else {
      preparedAuthor = prepareAuthorDispositionsFromGovernedOutput({
        reviewDir: options.reviewDir,
        targetPath: options.authorDispositionsPath,
        reviewEpisodeId: episodeId,
        sourceRevision: issueSnapshot.sourceRevision,
        predecessorStage,
        draft: issueSnapshot.body,
        allowZeroState: admission === 'lifecycle-zero-state',
        errors,
        authorDiagnostics,
      });
    }
  }

  let canonicalLineage: CanonicalLineage | undefined;
  if (purpose === 'stage-time' || purpose === 'final-acceptance') {
    if (!taskIssueMatch) {
      errors.push('canonical cycle lineage requires tier-intake taskIdentity issue:<N>');
    } else {
      canonicalLineage = canonicalIssueCommentLineage(
        artifactSourceTransport,
        repositoryFullName,
        Number(taskIssueMatch[1]),
        errors,
      ) ?? undefined;
    }
  }
  let artifactContext: ArtifactAuthorityContext | undefined;
  if (stageInputsRequireAuthoritativeCensus(validStageInputs.map((entry) => entry.value))) {
    if (!taskIssueMatch) {
      errors.push('authoritative GitHub artifact acceptance requires tier-intake taskIdentity issue:<N>');
    } else {
      const issueNumber = Number(taskIssueMatch[1]);
      const operatorHint = normalizeOperatorNarrowingHint(
        options.operatorAdjudication,
        options.phase,
        repositoryFullName,
        issueNumber,
        errors,
      );
      let principalLogin: string | null = null;
      if (errors.length === 0) {
        try {
          principalLogin = resolveAuthenticatedGithubPrincipal(artifactSourceTransport);
        } catch (error) {
          errors.push(temporaryError(
            'identity-unresolved',
            `authenticated GitHub principal could not be resolved through tracked GET /user: ${error instanceof Error ? error.message : String(error)}`,
          ));
        }
      }
      const census = errors.length === 0 && principalLogin
        ? authoritativeIssueCommentCensus(artifactSourceTransport, repositoryFullName, issueNumber, errors)
        : null;
      if (census && principalLogin) {
        const publishedComment = operatorHint
          ? census.comments.find((candidate) => (
              candidate.id === operatorHint.commentId
              && candidate.htmlUrl === operatorHint.commentUrl
              && commentTargetsExpectedIssue(candidate, census.repositoryFullName, census.issueNumber)
            ))
          : undefined;
        if (operatorHint && !publishedComment) {
          errors.push('operator verdict URL hint does not identify a published Issue comment in authoritative census');
        }
        if (publishedComment && publishedComment.createdAt !== publishedComment.updatedAt) {
          errors.push(`authoritative GitHub artifact was edited: ${publishedComment.htmlUrl}`);
        }
        const publishedAuthorStateResult = resolvePublishedAuthorState({
          adjudication: operatorHint && publishedComment
            ? {
                issueNumber: operatorHint.issueNumber,
                sourceRevision: operatorHint.sourceRevision,
                verdictUrl: operatorHint.commentUrl,
                verdictSha256: operatorHint.verdictSha256,
                verdictByteLength: operatorHint.verdictByteLength,
              }
            : undefined,
          repo: census.repositoryFullName,
          issueNumber: census.issueNumber,
          comments: publishedComment ? [publishedComment] : [],
          errorStyle: 'artifacts',
        });
        errors.push(...publishedAuthorStateResult.errors);
        const publishedAuthorState = publishedAuthorStateResult.state;
        artifactContext = {
          transport: artifactSourceTransport,
          census,
          principalLogin,
          ...(operatorHint ? { operatorHint } : {}),
          ...(publishedAuthorState ? { publishedAuthorState } : {}),
        };
      }
    }
  } else if (options.operatorAdjudication) {
    errors.push('operator verdict URL hint cannot create an acceptance path when no invocation requires authoritative artifact resolution');
  }
  if (errors.length > 0) {
    const temporary = temporaryClassification(errors);
    return {
      ok: false,
      outputDir,
      files: [],
      missing: [],
      errors: [...new Set(errors)],
      reviewEpisodeId: episodeId,
      ...(temporary ? { temporary } : {}),
      ...(authorDiagnostics.length > 0 ? { authorDiagnostics, authorSchemaFragment } : {}),
    };
  }

  const captureTexts = new Map<string, string>();
  const captureTimestamps = new Map<string, number>();
  const receipts = validStageInputs
    .map(({ path, value }) => buildReceipt(
      path,
      value,
      taskIdentity,
      episodeFirstRevision,
      episodeId,
      captureTexts,
      captureTimestamps,
      errors,
      options.waiverPath,
      artifactContext,
      purpose,
      createdInputPaths,
    ))
    .filter((receipt): receipt is ProducedStageReceipt => receipt !== null)
    .sort((left, right) => left.stageSequence - right.stageSequence);
  const tier = receipts[0]?.tier;
  if (purpose === 'stage-time' && canonicalLineage) validateReceiptCycleLineage(receipts, canonicalLineage, errors);
  if (!tier) errors.push('no completed-stage evidence was supplied');
  for (let index = 0; index < receipts.length; index += 1) {
    const receipt = receipts[index]!;
    receipt.previousStageReceiptId = index === 0 ? null : receipts[index - 1]!.stageReceiptId;
    receipt.receiptCensus = receipts.slice(0, index + 1).map((item) => item.stageReceiptId);
  }
  const captures = receipts.flatMap((receipt) => receipt.relayEligibleCaptures);
  const relay = relayEvidence(episodeId, captures);
  const ledger = authorAdjudicationDeferred ? null : buildLedger(preparedAuthor?.value, captures, errors);
  const claudeProducerEvidenceAuditErrors: string[] = [];
  const claudeProducerEvidence = (options.claudeProducerEvidencePaths ?? []).flatMap((path) => readClaudeProducerEvidence(
    path,
    purpose === 'stage-time' ? errors : claudeProducerEvidenceAuditErrors,
  ));
  const requiresClaudeProducerEvidence = purpose === 'stage-time'
    && tier === 'T3'
    && receipts.some((receipt) => (
      receipt.stage === 'architectural-lens' && isRecord(receipt.claude) && receipt.claude.kind === 'capture'
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
        validationPurpose: purpose,
      }
    : undefined;
  if (tier && (ledger || authorAdjudicationDeferred)) {
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
    if (!stageTerminalConfirmed) errors.push('stage evidence does not prove terminal settlement for every launched invocation');
    if (ledger && settlementsValid) {
      let issueRevision = receipts.at(-1)?.sourceRevision ?? episodeFirstRevision;
      try {
        const parsedLedger = JSON.parse(ledger) as unknown;
        if (isRecord(parsedLedger) && typeof parsedLedger.sourceRevision === 'string') issueRevision = parsedLedger.sourceRevision;
      } catch {}
      const terminalCorrectionCertified = certifyTerminalCorrection(
        ledger,
        options.reviewDir,
        receipts,
        issueRevision,
        options.phase,
      );
      const ledgerOptions = {
        reviewEconomics: true,
        phase: (options.phase ?? 'final-acceptance') as 'pre-lens' | 'final-acceptance',
        issueRevision,
        stageTerminalConfirmed,
        stageReceipts: receipts,
        verifiedRelayEvidence: relay,
        episodeAuthority: authority,
        captureMetadata: captures.map((capture) => ({
          name: capture.name,
          timestampMs: captureTimestamps.get(capture.captureIdentity) ?? 0,
          captureIdentity: capture.captureIdentity,
        })),
        terminalCorrectionCertified,
        ...((options.phase ?? 'final-acceptance') === 'final-acceptance' && artifactContext?.publishedAuthorState
          ? { publishedAuthorState: artifactContext.publishedAuthorState }
          : {}),
      } as Parameters<typeof checkFindingLedgerGuard>[2] & { terminalCorrectionCertified: boolean };
      const ledgerResult = checkFindingLedgerGuard(
        captures.map((capture) => captureTexts.get(capture.captureIdentity) ?? ''),
        ledger,
        ledgerOptions,
      );
      if (!ledgerResult.ok) errors.push(...ledgerResult.errors);
    }
  }
  if (errors.length > 0 || !tier || !issueSnapshot || (!authorAdjudicationDeferred && (!ledger || !preparedAuthor))) {
    for (const error of errors) {
      const derived = authorDispositionDiagnosticFromFailure(error);
      if (derived && !authorDiagnostics.some((item) => (
        item.reason === derived.reason
        && item.field === derived.field
        && item.message === derived.message
      ))) {
        authorDiagnostics.push(derived);
      }
    }
    rollbackCreatedInputs(createdInputPaths);
    const temporary = temporaryClassification(errors);
    return {
      ok: false,
      outputDir,
      files: [],
      missing: [],
      errors: [...new Set(errors)],
      reviewEpisodeId: episodeId,
      ...(temporary ? { temporary } : {}),
      ...(authorDiagnostics.length > 0 ? { authorDiagnostics, authorSchemaFragment } : {}),
    };
  }

  const acceptanceOutputNames = authorAdjudicationDeferred
    ? ACCEPTANCE_ARTIFACT_OUTPUT_NAMES.filter((name) => name !== 'finding-disposition-ledger.json')
    : [...ACCEPTANCE_ARTIFACT_OUTPUT_NAMES];
  const files = [
    ...receipts.map((receipt) => stageCompletenessReceiptFileName(receipt.stageAttemptId)),
    ...acceptanceOutputNames,
  ];
  const manifest = {
    schema: ARTIFACT_MANIFEST_SCHEMA,
    reviewEpisodeId: episodeId,
    acceptanceBasis: AUTHORITATIVE_GITHUB_ARTIFACT_BASIS,
    files,
    ...(issueSnapshot
      ? {
        liveIssueSnapshot: {
          path: resolve(issueSnapshot.path),
          issueNumber: issueSnapshot.issueNumber,
          sourceRevision: issueSnapshot.sourceRevision,
          titleSha256: sha256(issueSnapshot.title),
          bodySha256: sha256(issueSnapshot.body),
        },
      }
      : {}),
    ...(artifactContext?.publishedAuthorState
      ? {
        publishedAuthorState: {
          sha256: artifactContext.publishedAuthorState.sha256,
          byteLength: artifactContext.publishedAuthorState.byteLength,
        },
      }
      : {}),
    derivedFrom: {
      tierIntake: resolve(options.tierIntakePath),
      stageEvidence: canonicalStageEvidencePaths.map((path) => resolve(path)),
      ...(preparedAuthor ? { authorDispositions: resolve(options.authorDispositionsPath) } : {}),
      ...(issueSnapshot ? { issueSnapshot: resolve(issueSnapshot.path) } : {}),
      ...(options.waiverPath ? { operatorWaiver: resolve(options.waiverPath) } : {}),
    },
  };
  const artifactContents = new Map<string, string>();
  receipts.forEach((receipt) => artifactContents.set(
    stageCompletenessReceiptFileName(receipt.stageAttemptId),
    JSON.stringify(receipt, null, 2) + '\n',
  ));
  artifactContents.set('verified-relay-evidence.json', JSON.stringify(relay, null, 2) + '\n');
  if (ledger) artifactContents.set('finding-disposition-ledger.json', ledger);
  artifactContents.set('review-episode-inventory.json', JSON.stringify(authority!.receiptInventory, null, 2) + '\n');
  artifactContents.set('acceptance-artifacts.json', JSON.stringify(manifest, null, 2) + '\n');
  let committedInputs: PreparedInputCommit = { created: [], replaced: new Map() };
  try {
    committedInputs = commitPreparedInputs([
      { path: issueSnapshot.path, bytes: issueSnapshot.bytes },
      ...(preparedAuthor
        ? [{ path: preparedAuthor.path, bytes: preparedAuthor.bytes, allowReplace: preparedAuthor.replaceExisting }]
        : []),
    ]);
    for (const path of committedInputs.created) createdInputPaths.add(path);
    publishArtifactSet(outputDir, files, artifactContents, options.publicationHooks);
  } catch (error) {
    rollbackPreparedInputCommit(committedInputs);
    rollbackCreatedInputs(createdInputPaths);
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
  const outputDir = options.outputDir ?? options.reviewDir;
  const purpose: ReviewEpisodeValidationPurpose = (options.phase ?? 'final-acceptance') === 'final-acceptance'
    ? 'final-acceptance'
    : 'stage-time';
  type ReasonDecorator = (detail: string) => string;
  const requireRegularFile = (path: string, artifact: string, reason: string, decorate?: ReasonDecorator): boolean => {
    let stat;
    try { stat = lstatSync(path); } catch {
      missing.push({ artifact, reason: (decorate ? decorate(reason) : reason) + ': ' + path });
      return false;
    }
    if (!stat.isFile()) {
      const detail = artifact + ' is not a regular file';
      missing.push({ artifact, reason: (decorate ? decorate(detail) : detail) + ': ' + path });
      return false;
    }
    present.push(path);
    return true;
  };
  const READ_ARTIFACT_JSON_FAILED = Symbol('read-artifact-json-failed');
  const readArtifactJson = (path: string, artifact: string, reason: string, decorate?: ReasonDecorator): unknown => {
    if (!requireRegularFile(path, artifact, reason, decorate)) return READ_ARTIFACT_JSON_FAILED;
    try { return JSON.parse(readFileSync(path, 'utf8')) as unknown; } catch {
      const detail = artifact + ' is malformed JSON';
      missing.push({ artifact, reason: (decorate ? decorate(detail) : detail) + ': ' + path });
      return READ_ARTIFACT_JSON_FAILED;
    }
  };
  const addInvalid = (artifact: string, path: string, detail: string, decorate?: ReasonDecorator): void => {
    missing.push({ artifact, reason: (decorate ? decorate(detail) : detail) + ': ' + path });
  };
  const tierInputReason: ReasonDecorator = (detail) => acceptanceArtifactInputReason('tierIntakePath', detail);
  const stageInputReason: ReasonDecorator = (detail) => acceptanceArtifactInputReason('stageEvidencePaths', detail);
  const dispositionsInputReason: ReasonDecorator = (detail) => acceptanceArtifactInputReason('authorDispositionsPath', detail);

  const intake = readArtifactJson(options.tierIntakePath, 'tier-intake/v1', 'tier intake evidence is missing', tierInputReason);
  if (intake !== READ_ARTIFACT_JSON_FAILED && (!isRecord(intake) || intake.schema !== 'tier-intake/v1')) {
    addInvalid('tier-intake/v1', options.tierIntakePath, 'tier intake evidence is malformed', tierInputReason);
  }
  if (existsSync(options.authorDispositionsPath)) {
    const dispositions = readArtifactJson(options.authorDispositionsPath, 'author dispositions', 'derived author disposition evidence is unreadable', dispositionsInputReason);
    if (dispositions !== READ_ARTIFACT_JSON_FAILED && (
      !isRecord(dispositions)
      || dispositions.schema !== AUTHOR_DISPOSITIONS_SCHEMA
      || !Array.isArray(dispositions.findings)
      || (dispositions.producer !== 'governed-author-output/v1' && dispositions.producer !== 'lifecycle-zero-state/v1')
    )) {
      addInvalid(
        'author dispositions',
        options.authorDispositionsPath,
        'derived author disposition evidence is malformed or lacks governed producer provenance; authority=author-owned/GitHub-witnessed/lifecycle-tool-witnessed',
      );
    }
  } else {
    const authorBinding = stageAuthorBinding(options.reviewDir);
    const authorReplyDisposition = authorReplyDispositionForStage(options.reviewDir, authorBinding.sourceRevision, authorBinding.predecessorStage);
    const admission = authorDispositionAdmission({
      consumesAuthorAdjudication: producerConsumesAuthorAdjudication(options.phase ?? 'final-acceptance'),
      predecessorPresent: authorBinding.predecessorStage !== null,
      authorReplyDisposition,
    });
    if (authorReplyDisposition === 'malformed') {
      const authorReply = latestAuthorReplyPath(options.reviewDir);
      const authorErrors: string[] = [];
      if (authorReply) parseGovernedAuthorDispositionOutput(authorReply, authorErrors);
      for (const error of authorErrors) missing.push({ artifact: 'governed author output', reason: error });
    } else if (admission === 'require-governed-reply' && authorReplyDisposition !== 'current') {
      missing.push({
        artifact: 'governed author output',
        reason: 'missing governed author output round-NN-author-reply.*; field=findings/m4 authority=author-owned',
      });
    }
  }

  const coverageErrors: string[] = [];
  const canonicalStageEvidencePaths = resolveCanonicalStageEvidencePaths(options.reviewDir, options.stageEvidencePaths, coverageErrors, options.phase ?? 'final-acceptance');
  for (const error of coverageErrors) missing.push({ artifact: 'stage-completeness-receipt/v1', reason: stageInputReason(error) });
  if ((canonicalStageEvidencePaths ?? []).length === 0) missing.push({ artifact: 'stage-completeness-receipt/v1', reason: stageInputReason('no lifecycle-tool-witnessed stage evidence exists in the canonical review directory') });
  const stageEvidencePaths = canonicalStageEvidencePaths ?? options.stageEvidencePaths;
  const stageReceiptNames: string[] = [];
  let evidenceTier: ReviewTier | null = null;
  let requiresClaudeProducerEvidence = false;
  for (const path of stageEvidencePaths) {
    const value = readArtifactJson(path, 'stage evidence', 'recorded stage result is missing', stageInputReason);
    if (value === READ_ARTIFACT_JSON_FAILED) continue;
    if (!isRecord(value) || value.schema !== STAGE_EVIDENCE_SCHEMA) {
      addInvalid('stage evidence', path, 'recorded stage result is malformed', stageInputReason);
      continue;
    }
    const stageTier = reviewTier(value.tier);
    if (stageTier && evidenceTier && stageTier !== evidenceTier) missing.push({ artifact: 'stage-completeness-receipt', reason: stageInputReason('stage evidence mixes tier values: ' + path) });
    else if (stageTier) evidenceTier = stageTier;
    const stageAttemptId = typeof value.stageAttemptId === 'string' ? value.stageAttemptId.trim() : '';
    if (isSafeFileComponent(stageAttemptId)) stageReceiptNames.push(stageCompletenessReceiptFileName(stageAttemptId));
    else missing.push({ artifact: 'stage-completeness-receipt', reason: stageInputReason('stage evidence has no safe stageAttemptId: ' + path) });

    let producedInvocations: unknown[] | undefined;
    if (isSafeFileComponent(stageAttemptId)) {
      const producedReceiptPath = join(outputDir, stageCompletenessReceiptFileName(stageAttemptId));
      if (existsSync(producedReceiptPath)) {
        try {
          const producedReceipt = JSON.parse(readFileSync(producedReceiptPath, 'utf8')) as unknown;
          if (isRecord(producedReceipt)
            && producedReceipt.schema === 'stage-completeness-receipt/v1'
            && Array.isArray(producedReceipt.invocations)) {
            producedInvocations = producedReceipt.invocations;
          }
        } catch {}
      }
    }
    if (Array.isArray(value.invocations)) {
      for (const [index, invocation] of value.invocations.entries()) {
        if (!isRecord(invocation)) {
          missing.push({ artifact: 'stage evidence', reason: stageInputReason('stage evidence invocation[' + index + '] must be an object: ' + path) });
          continue;
        }
        const transportComplete = invocation.terminalClassification === 'complete';
        const producedInvocation = producedInvocations?.[index];
        const artifactBacked = isRecord(producedInvocation)
          && isRecord(producedInvocation.artifactAuthority)
          && producedInvocation.artifactAuthority.kind === 'authoritative-github-artifact';
        if (transportComplete && invocation.capturePath === undefined) {
          missing.push({ artifact: 'capture', reason: 'completed invocation[' + index + '] is missing capturePath: ' + path });
        }
        if (transportComplete && invocation.capturePath !== undefined) {
          const captureErrors: string[] = [];
          const captureTexts = new Map<string, string>();
          const captureTimestamps = new Map<string, number>();
          const capture = captureFromEvidence(path, invocation.capturePath, invocation.captureIdentity, captureTexts, captureTimestamps, captureErrors);
          for (const error of captureErrors) missing.push({ artifact: 'capture', reason: error });
          const turnResultErrors: string[] = [];
          readTurnResultForInvocation(path, invocation, index, capture, capture ? captureTexts.get(capture.captureIdentity) ?? null : null, turnResultErrors, artifactBacked, purpose);
          for (const error of turnResultErrors) missing.push({ artifact: 'turn-result/v1', reason: error });
        }
      }
    } else if (value.stage !== 'architectural-lens') {
      missing.push({ artifact: 'stage evidence', reason: stageInputReason('stage evidence.invocations is missing: ' + path) });
    }
    if (purpose === 'stage-time' && value.tier === 'T3' && value.stage === 'architectural-lens' && isRecord(value.claude) && value.claude.kind === 'capture') {
      requiresClaudeProducerEvidence = true;
    }
    if (isRecord(value.claude)) {
      if (value.claude.kind === 'capture' && value.claude.capturePath === undefined) {
        missing.push({ artifact: 'capture', reason: 'Claude capture branch is missing capturePath: ' + path });
      } else if (value.claude.capturePath !== undefined) {
        const capturePath = resolve(dirname(path), String(value.claude.capturePath));
        requireRegularFile(capturePath, 'capture', 'Claude capture is missing; stage evidence names a capture that is not present');
      }
    }
  }

  const claudeProducerEvidencePaths = options.claudeProducerEvidencePaths ?? [];
  if (purpose === 'stage-time') {
    for (const path of claudeProducerEvidencePaths) readArtifactJson(path, CLAUDE_PRODUCER_EVIDENCE_SCHEMA, 'Claude producer evidence is missing');
  }
  if (requiresClaudeProducerEvidence && claudeProducerEvidencePaths.length === 0) {
    missing.push({ artifact: CLAUDE_PRODUCER_EVIDENCE_SCHEMA, reason: 'T3 architectural-lens capture requires --claude-producer-evidence <path>' });
  }

  const deferredOutputBinding = stageAuthorBinding(options.reviewDir);
  const deferFindingLedger = authorDispositionAdmission({
    consumesAuthorAdjudication: producerConsumesAuthorAdjudication(options.phase ?? 'final-acceptance'),
    predecessorPresent: deferredOutputBinding.predecessorStage !== null,
    authorReplyDisposition: authorReplyDispositionForStage(options.reviewDir, deferredOutputBinding.sourceRevision, deferredOutputBinding.predecessorStage),
  }) === 'defer-stage-materialization';
  const acceptanceOutputNames = deferFindingLedger
    ? ACCEPTANCE_ARTIFACT_OUTPUT_NAMES.filter((name) => name !== 'finding-disposition-ledger.json')
    : [...ACCEPTANCE_ARTIFACT_OUTPUT_NAMES];
  const expectedOutputNames = [...new Set([...stageReceiptNames, ...acceptanceOutputNames])];
  const outputValues = new Map<string, unknown>();
  for (const name of expectedOutputNames) {
    const artifact = name.startsWith('stage-completeness-receipt-')
      ? 'stage-completeness-receipt'
      : name === 'verified-relay-evidence.json'
        ? 'verified relay evidence'
        : name === 'finding-disposition-ledger.json'
          ? 'finding ledger'
          : name === 'review-episode-inventory.json'
            ? 'review-episode-inventory'
            : 'acceptance-artifacts';
    const artifactPath = join(outputDir, name);
    const value = readArtifactJson(artifactPath, artifact, 'required acceptance artifact is missing');
    if (value !== null) outputValues.set(name, value);
    else if (present.includes(artifactPath)) addInvalid(artifact, artifactPath, artifact + ' is malformed JSON');
  }
  const credentialedStages = new Set<ReviewStage>();
  const observedStages = new Set<ReviewStage>();
  for (const name of stageReceiptNames) {
    const value = outputValues.get(name);
    if (value !== undefined && (!isRecord(value) || value.schema !== 'stage-completeness-receipt/v1')) {
      addInvalid('stage-completeness-receipt', join(outputDir, name), 'stage receipt has an invalid schema');
      continue;
    }
    if (!isRecord(value)) continue;
    const stage = reviewStage(value.stage);
    const cardinality = Number(value.reviewerCardinality);
    if (!stage || !Number.isInteger(cardinality) || cardinality < 1) continue;
    observedStages.add(stage);
    const operatorWaiverEvidence = readOperatorWaiver(options.waiverPath, {
      stage,
      sourceRevision: typeof value.sourceRevision === 'string' ? value.sourceRevision : '',
      missingSlots: Array.isArray(value.partialMissingSources)
        ? value.partialMissingSources.flatMap((source) => (
          isRecord(source) && typeof source.reviewerSlot === 'string' ? [source.reviewerSlot] : []
        ))
        : [],
    });
    if (stage === 'architectural-lens') {
      if (value.outcome === 'complete') credentialedStages.add(stage);
      continue;
    }
    if (value.outcome === 'partial' && value.producerEvidence === 'waived' && operatorWaiverEvidence !== 'waived') {
      missing.push({ artifact: 'operator waiver', reason: `${stage} partial receipt asserts an operator waiver but --waiver does not resolve to the existing waiver seam` });
      continue;
    }
    const settlement = evaluateStageCredentialingSettlement(value, cardinality, stage, purpose);
    if (settlement.credentialed) credentialedStages.add(stage);
    else if (value.outcome === 'complete' || value.outcome === 'partial') {
      for (const error of settlement.errors) missing.push({ artifact: 'stage-completeness-receipt', reason: error + ': ' + join(outputDir, name) });
    }
  }

  if (evidenceTier) {
    try {
      const requiredStages = canonicalAcceptanceStages(evidenceTier, intake, options.phase ?? 'final-acceptance', [...observedStages]);
      for (const stage of requiredStages) {
        if (!credentialedStages.has(stage)) missing.push({ artifact: 'stage-completeness-receipt', reason: stageInputReason('missing credentialing complete-or-proven-partial stage evidence for ' + stage + ' at ' + (options.phase ?? 'final-acceptance')) });
      }
    } catch (error) {
      missing.push({ artifact: 'tier-intake/v1', reason: tierInputReason(error instanceof Error ? error.message : String(error)) });
    }
  }

  const relay = outputValues.get('verified-relay-evidence.json');
  if (relay !== undefined && !Array.isArray(relay)) addInvalid('verified-relay-evidence', join(outputDir, 'verified-relay-evidence.json'), 'verified relay evidence is malformed');
  const ledger = outputValues.get('finding-disposition-ledger.json');
  if (ledger !== undefined && (!isRecord(ledger) || ledger.version !== 2 || !isRecord(ledger.counts) || !Array.isArray(ledger.findings))) {
    addInvalid('finding-disposition-ledger', join(outputDir, 'finding-disposition-ledger.json'), 'finding disposition ledger is malformed');
  }
  const inventory = outputValues.get('review-episode-inventory.json');
  if (inventory !== undefined && (!isRecord(inventory)
    || inventory.source !== 'canonical-review-directory'
    || typeof inventory.taskIdentity !== 'string'
    || typeof inventory.episodeFirstRevision !== 'string'
    || typeof inventory.reviewEpisodeId !== 'string'
    || !Array.isArray(inventory.stageReceiptIds))) {
    addInvalid('review-episode-inventory', join(outputDir, 'review-episode-inventory.json'), 'review episode inventory is malformed');
  }
  const manifest = outputValues.get('acceptance-artifacts.json');
  if (!isRecord(manifest) || manifest.schema !== ARTIFACT_MANIFEST_SCHEMA || !Array.isArray(manifest.files)) {
    addInvalid('acceptance-artifacts', join(outputDir, 'acceptance-artifacts.json'), 'acceptance artifact manifest is malformed');
  } else {
    if (manifest.acceptanceBasis !== AUTHORITATIVE_GITHUB_ARTIFACT_BASIS) {
      addInvalid('acceptance-artifacts', join(outputDir, 'acceptance-artifacts.json'), 'acceptanceBasis must be authoritative-github-artifact');
    }
    if (manifest.operatorAdjudication !== undefined) {
      addInvalid('acceptance-artifacts', join(outputDir, 'acceptance-artifacts.json'), 'operator adjudication is not an acceptance authority');
    }
    if (!isRecord(manifest.liveIssueSnapshot)
      || typeof manifest.liveIssueSnapshot.path !== 'string'
      || typeof manifest.liveIssueSnapshot.sourceRevision !== 'string'
      || typeof manifest.liveIssueSnapshot.titleSha256 !== 'string'
      || typeof manifest.liveIssueSnapshot.bodySha256 !== 'string') {
      addInvalid('acceptance-artifacts', join(outputDir, 'acceptance-artifacts.json'), 'manifest lacks the producer-owned GitHub-witnessed Issue snapshot binding');
    } else {
      const snapshotPath = String(manifest.liveIssueSnapshot.path);
      const snapshot = readArtifactJson(snapshotPath, 'Issue body snapshot', 'GitHub-witnessed Issue body snapshot is missing');
      if (!isRecord(snapshot)
        || snapshot.schema !== 'create-issue-live-snapshot/v1'
        || snapshot.sourceRevision !== manifest.liveIssueSnapshot.sourceRevision
        || typeof snapshot.title !== 'string'
        || typeof snapshot.body !== 'string'
        || sha256(snapshot.title) !== manifest.liveIssueSnapshot.titleSha256
        || sha256(snapshot.body) !== manifest.liveIssueSnapshot.bodySha256) {
        addInvalid('Issue body snapshot', snapshotPath, 'Issue body snapshot disagrees with the acceptance manifest; authority=GitHub-witnessed');
      }
    }
    const declared = new Set(manifest.files.filter((value): value is string => typeof value === 'string'));
    const expected = new Set(expectedOutputNames);
    for (const name of expected) if (!declared.has(name)) missing.push({ artifact: 'acceptance-artifacts', reason: 'manifest omits required artifact ' + name + ': ' + join(outputDir, 'acceptance-artifacts.json') });
    for (const name of declared) if (!expected.has(name)) missing.push({ artifact: 'acceptance-artifacts', reason: 'manifest names unexpected artifact ' + name + ': ' + join(outputDir, 'acceptance-artifacts.json') });
  }
  return { ok: missing.length === 0, present, missing };
}
