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
} from './stage-completeness-core.ts';
import { canonicalStagePlan } from './create-issue-stage-topology.ts';
import { evaluateStageCredentialingSettlement } from './create-issue-stage-lifecycle-acceptance.ts';
import { readEvidenceWaiverProducerEvidence } from './create-issue-stage-record-receipt.ts';
import { extractMarker } from './create-issue-stage-record-marker.ts';
import { buildCanonicalLineage, deriveCanonicalCycleLineage } from './create-issue-stage-record-lineage.ts';
import { checkFindingLedgerGuard } from '../finding-ledger-guard.mjs';
import { defaultGhTransport, fetchRepositoryOwnerLogin, parseJournalEvents } from './create-issue-stage-record-gh.ts';
import type { CanonicalLineage, GhTransport, PartialMissingSourceWitness, ProducerEvidence, TrustedComment } from './create-issue-stage-record-types.ts';
import { resolvePublishedAuthorState } from './resolve-published-author-state.ts';

export const STAGE_EVIDENCE_SCHEMA = 'create-issue-stage-evidence/v1' as const;
export const AUTHOR_DISPOSITIONS_SCHEMA = 'create-issue-author-dispositions/v1' as const;
export const ARTIFACT_MANIFEST_SCHEMA = 'create-issue-acceptance-artifacts/v1' as const;
export const TURN_RESULT_SCHEMA = 'turn-result/v1' as const;
export const AUTHORITATIVE_GITHUB_ARTIFACT_BASIS = 'authoritative-github-artifact' as const;

export const ACCEPTANCE_ARTIFACT_REQUIRED_INPUTS = [
  { property: 'tierIntakePath', flag: '--tier-intake', file: 'tier-intake.json', schema: 'tier-intake/v1', classification: 'flow-manager-authored input', repeatable: false },
  { property: 'stageEvidencePaths', flag: '--stage-evidence', file: 'attempt-NNN.json', schema: STAGE_EVIDENCE_SCHEMA, classification: 'flow-manager-authored input', repeatable: true },
  { property: 'authorDispositionsPath', flag: '--author-dispositions', file: 'author-dispositions.json', schema: AUTHOR_DISPOSITIONS_SCHEMA, classification: 'flow-manager-authored input', repeatable: false },
] as const;

export function stageCompletenessReceiptFileName(stageAttemptId: string): string {
  return `stage-completeness-receipt-${stageAttemptId}.json`;
}

export const ACCEPTANCE_ARTIFACT_OUTPUT_NAMES = [
  'verified-relay-evidence.json',
  'finding-disposition-ledger.json',
  'review-episode-inventory.json',
  'acceptance-artifacts.json',
] as const;

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

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
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

function parseCanonicalCaptureRevision(text: string): { issueNumber: number; sourceRevision: string; findingCount: number } | null {
  const lines = text.split(/\n/).map((line) => line.replace(/\r$/, ''));
  const firstNonEmpty = lines.find((line) => line.trim().length > 0);
  const match = firstNonEmpty ? CANONICAL_REVISION_LINE_RE.exec(firstNonEmpty) : null;
  const declarations = lines.filter((line) => CANONICAL_REVISION_LINE_RE.test(line)).length;
  if (!match || declarations !== 1) return null;
  return {
    issueNumber: Number(match[1]),
    sourceRevision: match[2]!,
    findingCount: rawFindingCount(text),
  };
}

function parseCanonicalTerminalVerdict(
  text: string,
): { issueNumber: number; sourceRevision: string; findingCount: number } | null {
  const revision = parseCanonicalCaptureRevision(text);
  if (!revision) return null;
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const exactCount = (token: string): number => lines.filter((line) => line === token).length;
  const verdicts = lines.flatMap((line) => {
    const match = /^VERDICT: (CLEAN|FINDINGS|NO_FINDINGS)$/.exec(line);
    return match ? [match[1]!] : [];
  });
  const findingCountLines = lines.filter((line) => line.startsWith('FINDING_COUNT:'));
  const declaredFindingCounts = findingCountLines.flatMap((line) => {
    const match = /^FINDING_COUNT: ([0-9]+)$/.exec(line);
    return match ? [Number(match[1])] : [];
  });
  const omittedFindingCountOk = findingCountLines.length === 0
    && verdicts.length === 1
    && verdicts[0] === 'FINDINGS'
    && revision.findingCount > 0;
  const explicitFindingCountOk = findingCountLines.length === 1
    && declaredFindingCounts.length === 1
    && declaredFindingCounts[0] === revision.findingCount;
  const findingsWithoutVerdictOk = explicitFindingCountOk
    && verdicts.length === 0
    && lines.every((line) => !line.startsWith('VERDICT:'))
    && revision.findingCount > 0;
  const invocationIds = lines.filter((line) => INVOCATION_ECHO_RE.test(line));
  const cutCandidates = exactCount('simplification-cut-candidate: yes');
  const simplificationClean = exactCount('SIMPLIFICATION_CLEAN');
  if (
    exactCount('review-economics-contract: v1') !== 1
    || !(omittedFindingCountOk || explicitFindingCountOk)
    || invocationIds.length !== 1
    || (cutCandidates === 0 ? simplificationClean !== 1 : simplificationClean !== 0)
  ) return null;
  if (revision.findingCount === 0) {
    const cleanVerdict = verdicts[0] === 'CLEAN' && exactCount('NO_FINDINGS') === 1;
    const noFindingsVerdict = verdicts[0] === 'NO_FINDINGS' && exactCount('NO_FINDINGS') <= 1;
    if (!cleanVerdict && !noFindingsVerdict) return null;
  } else if (!findingsWithoutVerdictOk
    && (verdicts.length !== 1 || verdicts[0] !== 'FINDINGS' || exactCount('NO_FINDINGS') !== 0)) {
    return null;
  }
  return revision;
}

function isCanonicalReviewerArtifact(
  text: string,
  stage: Exclude<ReviewStage, 'architectural-lens'>,
  issueNumber: number,
  sourceRevision: string,
  invocationId: string,
): boolean {
  const revision = parseCanonicalCaptureRevision(text);
  if (!revision || revision.issueNumber !== issueNumber || revision.sourceRevision !== sourceRevision) return false;
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  if (lines.filter((line) => line === 'review-economics-contract: v1').length !== 1) return false;
  const invocationEchoes = lines.flatMap((line) => {
    const match = INVOCATION_ECHO_RE.exec(line);
    return match ? [match[1]!] : [];
  });
  if (invocationEchoes.length !== 1 || invocationEchoes[0] !== invocationId) return false;
  if (stage === 'architectural') return parseCanonicalTerminalVerdict(text) !== null;
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

function sameGithubLogin(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
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

const TRUSTED_REVIEW_ARTIFACT_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

function isTrustedReviewArtifactComment(comment: AuthoritativeIssueComment): boolean {
  return Boolean(
    comment.userLogin
    && comment.authorAssociation
    && TRUSTED_REVIEW_ARTIFACT_ASSOCIATIONS.has(comment.authorAssociation.toUpperCase()),
  );
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
    if (!sameGithubLogin(comment.userLogin, ownerLogin)) continue;
    if (comment.updatedAt !== comment.createdAt) continue;
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
  if (parsed.diagnostics.length > 0) {
    errors.push(...parsed.diagnostics.map((diagnostic) => `canonical Issue-comment journal ${diagnostic.code}: ${diagnostic.message}`));
    return null;
  }
  const lineage = buildCanonicalLineage(parsed.events);
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
): { capture: CaptureIdentityV1; path: string } | null {
  const target = resolve(reviewDir, name);
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
  return { capture, path: target };
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
  if (!reread.userLogin || !reread.authorAssociation) {
    errors.push(temporaryError('source-unavailable', `authoritative reread comment ${reread.id} has no repository-trust fields`));
    return null;
  }
  if (!censusComment.userLogin || !censusComment.authorAssociation) {
    errors.push(temporaryError('source-unavailable', `authoritative census candidate ${censusComment.id} has no repository-trust fields`));
    return null;
  }
  if (!isTrustedReviewArtifactComment(reread) || !isTrustedReviewArtifactComment(censusComment)) {
    errors.push(`authoritative GitHub artifact is not repository-trusted: ${reread.htmlUrl}`);
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
    || !sameGithubLogin(reread.userLogin, censusComment.userLogin)
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
  const invocationCandidates = context.census.comments.flatMap((comment) => {
    if (!commentTargetsExpectedIssue(comment, context.census.repositoryFullName, context.census.issueNumber)) return [];
    const observedRevision = canonicalReviewerArtifactRevision(
      comment.body,
      stage,
      context.census.issueNumber,
      invocationId,
    );
    return observedRevision ? [{ comment, observedRevision }] : [];
  });
  const sameRevisionCandidates = invocationCandidates.filter(({ observedRevision }) => observedRevision === sourceRevision);
  const matches = sameRevisionCandidates.filter(({ comment }) => (
    isTrustedReviewArtifactComment(comment) && comment.createdAt === comment.updatedAt
  ));
  if (matches.length === 0) {
    if (sameRevisionCandidates.some(({ comment }) => !comment.userLogin || !comment.authorAssociation)) {
      errors.push(temporaryError(
        'source-unavailable',
        `invocation ${invocationId} canonical artifact candidate has no repository-trust fields`,
      ));
      return null;
    }
    if (sameRevisionCandidates.some(({ comment }) => !isTrustedReviewArtifactComment(comment))) {
      errors.push(`authoritative GitHub artifact is not repository-trusted for invocation ${invocationId}`);
      return null;
    }
    if (sameRevisionCandidates.some(({ comment }) => comment.createdAt !== comment.updatedAt)) {
      errors.push(`authoritative GitHub artifact was edited for invocation ${invocationId}`);
      return null;
    }
    if (invocationCandidates.length > 0) {
      const observedRevisions = [...new Set(invocationCandidates.map(({ observedRevision }) => observedRevision))].sort();
      errors.push(
        `authoritative GitHub artifact revision mismatch: repository=${context.census.repositoryFullName} issue=#${context.census.issueNumber} stage=${stage} invocationId=${invocationId} expected=${sourceRevision} observed=${observedRevisions.join(',')}`,
      );
      return null;
    }
    const journalableUnobservableSend = invocation.terminal === true
      && invocation.sendCount === 1
      && invocation.retryClass === 'retry-forbidden'
      && (invocation.terminalClassification === 'post-send-failure'
        || invocation.terminalClassification === 'output-conflict'
        || invocation.terminalClassification === 'incident');
    if (journalableUnobservableSend) return null;
    errors.push(
      `authoritative GitHub artifact absent after complete census: repository=${context.census.repositoryFullName} issue=#${context.census.issueNumber} stage=${stage} sourceRevision=${sourceRevision} invocationId=${invocationId} source=GitHub-Issue-comments`,
    );
    return null;
  }
  const distinctBodies = new Set(matches.map(({ comment }) => comment.body));
  if (distinctBodies.size > 1) {
    const identities = matches.map(({ comment }) => `${comment.id}:${comment.htmlUrl}`).join(', ');
    errors.push(`authoritative GitHub artifact content conflict for invocation ${invocationId}: ${identities}`);
    return null;
  }
  const censusComment = [...matches].sort((left, right) => left.comment.id - right.comment.id)[0]!.comment;
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
  return {
    capture: materialized.capture,
    captureText: comment.body,
    capturePath: materialized.path,
    authority: {
      kind: AUTHORITATIVE_GITHUB_ARTIFACT_BASIS,
      repositoryFullName: context.census.repositoryFullName,
      issueNumber: context.census.issueNumber,
      commentId: comment.id,
      commentUrl: comment.htmlUrl,
      publisherLogin: comment.userLogin!,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
    },
  };
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
  if (transportClassification !== 'complete' && !artifactBacked) return null;
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
): ReviewStage[] {
  const intake = isRecord(intakeValue) ? intakeValue : {};
  const competitiveDecision = intake.competitiveDecision === 'required' || intake.competitiveDecision === 'skipped'
    ? intake.competitiveDecision
    : undefined;
  const competitiveRationale = optionalString(intake.competitiveRationale);
  const stages = canonicalStagePlan(tier, { competitiveDecision, competitiveRationale }).stages.map((entry) => entry.stage);
  if (tier === 'T3' && phase === 'pre-lens') {
    return stages.filter((stage) => stage === 'competitive' || stage === 'architectural-review');
  }
  if (phase === 'post-lens' && tier === 'T3') {
    return stages.filter((stage) => stage !== 'architectural');
  }
  if (phase === 'post-lens') return [];
  return stages;
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
  const requestedSet = new Set(requestedPaths
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
  let canonicalLineage: CanonicalLineage | undefined;
  if (purpose === 'stage-time') {
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
      const census = errors.length === 0
        ? authoritativeIssueCommentCensus(artifactSourceTransport, repositoryFullName, issueNumber, errors)
        : null;
      if (census) {
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
  const ledger = buildLedger(options.authorDispositionsPath, captures, errors);
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
    if (!stageTerminalConfirmed) errors.push('stage evidence does not prove terminal settlement for every launched invocation');
    if (settlementsValid) {
      const ledgerResult = checkFindingLedgerGuard(
        captures.map((capture) => captureTexts.get(capture.captureIdentity) ?? ''),
        ledger,
        {
          reviewEconomics: true,
          phase: (options.phase ?? 'final-acceptance') as 'pre-lens' | 'final-acceptance',
          issueRevision: receipts.at(-1)?.sourceRevision ?? episodeFirstRevision,
          stageTerminalConfirmed,
          stageReceipts: receipts,
          verifiedRelayEvidence: relay,
          episodeAuthority: authority,
          captureMetadata: captures.map((capture) => ({
            name: capture.name,
            timestampMs: captureTimestamps.get(capture.captureIdentity) ?? 0,
            captureIdentity: capture.captureIdentity,
          })),
          ...((options.phase ?? 'final-acceptance') === 'final-acceptance' && artifactContext?.publishedAuthorState
            ? { publishedAuthorState: artifactContext.publishedAuthorState }
            : {}),
        },
      );
      if (!ledgerResult.ok) errors.push(...ledgerResult.errors);
    }
  }
  if (errors.length > 0 || !ledger || !tier) {
    const temporary = temporaryClassification(errors);
    return {
      ok: false,
      outputDir,
      files: [],
      missing: [],
      errors: [...new Set(errors)],
      reviewEpisodeId: episodeId,
      ...(temporary ? { temporary } : {}),
    };
  }

  const files = [
    ...receipts.map((receipt) => stageCompletenessReceiptFileName(receipt.stageAttemptId)),
    ...ACCEPTANCE_ARTIFACT_OUTPUT_NAMES,
  ];
  const manifest = {
    schema: ARTIFACT_MANIFEST_SCHEMA,
    reviewEpisodeId: episodeId,
    acceptanceBasis: AUTHORITATIVE_GITHUB_ARTIFACT_BASIS,
    files,
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
      authorDispositions: resolve(options.authorDispositionsPath),
      ...(options.waiverPath ? { operatorWaiver: resolve(options.waiverPath) } : {}),
    },
  };
  const artifactContents = new Map<string, string>();
  receipts.forEach((receipt) => artifactContents.set(
    stageCompletenessReceiptFileName(receipt.stageAttemptId),
    JSON.stringify(receipt, null, 2) + '\n',
  ));
  artifactContents.set('verified-relay-evidence.json', JSON.stringify(relay, null, 2) + '\n');
  artifactContents.set('finding-disposition-ledger.json', ledger);
  artifactContents.set('review-episode-inventory.json', JSON.stringify(authority!.receiptInventory, null, 2) + '\n');
  artifactContents.set('acceptance-artifacts.json', JSON.stringify(manifest, null, 2) + '\n');
  try {
    publishArtifactSet(outputDir, files, artifactContents, options.publicationHooks);
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
  const outputDir = options.outputDir ?? options.reviewDir;
  const purpose: ReviewEpisodeValidationPurpose = (options.phase ?? 'final-acceptance') === 'final-acceptance'
    ? 'final-acceptance'
    : 'stage-time';
  const requireRegularFile = (path: string, artifact: string, reason: string): boolean => {
    let stat;
    try { stat = lstatSync(path); } catch {
      missing.push({ artifact, reason: reason + ': ' + path });
      return false;
    }
    if (!stat.isFile()) {
      missing.push({ artifact, reason: artifact + ' is not a regular file: ' + path });
      return false;
    }
    present.push(path);
    return true;
  };
  const readArtifactJson = (path: string, artifact: string, reason: string): unknown | null => {
    if (!requireRegularFile(path, artifact, reason)) return null;
    try { return JSON.parse(readFileSync(path, 'utf8')) as unknown; } catch {
      missing.push({ artifact, reason: artifact + ' is malformed JSON: ' + path });
      return null;
    }
  };
  const addInvalid = (artifact: string, path: string, detail: string): void => {
    missing.push({ artifact, reason: detail + ': ' + path });
  };

  const intake = readArtifactJson(options.tierIntakePath, 'tier-intake/v1', 'tier intake evidence is missing');
  if (!isRecord(intake) || intake.schema !== 'tier-intake/v1') {
    addInvalid('tier-intake/v1', options.tierIntakePath, 'tier intake evidence is malformed');
  }
  const dispositions = readArtifactJson(options.authorDispositionsPath, 'author dispositions', 'author disposition evidence is missing');
  if (!isRecord(dispositions) || dispositions.schema !== AUTHOR_DISPOSITIONS_SCHEMA || !Array.isArray(dispositions.findings)) {
    addInvalid('author dispositions', options.authorDispositionsPath, 'author disposition evidence is malformed');
  }

  const coverageErrors: string[] = [];
  const canonicalStageEvidencePaths = resolveCanonicalStageEvidencePaths(options.reviewDir, options.stageEvidencePaths, coverageErrors, options.phase ?? 'final-acceptance');
  for (const error of coverageErrors) missing.push({ artifact: 'stage-completeness-receipt/v1', reason: error });
  if (options.stageEvidencePaths.length === 0) missing.push({ artifact: 'stage-completeness-receipt/v1', reason: 'no recorded stage evidence paths were supplied' });
  const stageEvidencePaths = canonicalStageEvidencePaths ?? options.stageEvidencePaths;
  const stageReceiptNames: string[] = [];
  let evidenceTier: ReviewTier | null = null;
  let requiresClaudeProducerEvidence = false;
  for (const path of stageEvidencePaths) {
    const value = readArtifactJson(path, 'stage evidence', 'recorded stage result is missing');
    if (!isRecord(value) || value.schema !== STAGE_EVIDENCE_SCHEMA) {
      addInvalid('stage evidence', path, 'recorded stage result is malformed');
      continue;
    }
    const stageTier = reviewTier(value.tier);
    if (stageTier && evidenceTier && stageTier !== evidenceTier) missing.push({ artifact: 'stage-completeness-receipt', reason: 'stage evidence mixes tier values: ' + path });
    else if (stageTier) evidenceTier = stageTier;
    const stageAttemptId = typeof value.stageAttemptId === 'string' ? value.stageAttemptId.trim() : '';
    if (isSafeFileComponent(stageAttemptId)) stageReceiptNames.push(stageCompletenessReceiptFileName(stageAttemptId));
    else missing.push({ artifact: 'stage-completeness-receipt', reason: 'stage evidence has no safe stageAttemptId: ' + path });

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
          missing.push({ artifact: 'stage evidence', reason: 'stage evidence invocation[' + index + '] must be an object: ' + path });
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
      missing.push({ artifact: 'stage evidence', reason: 'stage evidence.invocations is missing: ' + path });
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

  const expectedOutputNames = [...new Set([...stageReceiptNames, ...ACCEPTANCE_ARTIFACT_OUTPUT_NAMES])];
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
      const requiredStages = canonicalAcceptanceStages(evidenceTier, intake, options.phase ?? 'final-acceptance');
      for (const stage of requiredStages) {
        if (!credentialedStages.has(stage)) missing.push({ artifact: 'stage-completeness-receipt', reason: 'missing credentialing complete-or-proven-partial stage evidence for ' + stage + ' at ' + (options.phase ?? 'final-acceptance') });
      }
    } catch (error) {
      missing.push({ artifact: 'tier-intake/v1', reason: error instanceof Error ? error.message : String(error) });
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
    const declared = new Set(manifest.files.filter((value): value is string => typeof value === 'string'));
    const expected = new Set(expectedOutputNames);
    for (const name of expected) if (!declared.has(name)) missing.push({ artifact: 'acceptance-artifacts', reason: 'manifest omits required artifact ' + name + ': ' + join(outputDir, 'acceptance-artifacts.json') });
    for (const name of declared) if (!expected.has(name)) missing.push({ artifact: 'acceptance-artifacts', reason: 'manifest names unexpected artifact ' + name + ': ' + join(outputDir, 'acceptance-artifacts.json') });
  }
  return { ok: missing.length === 0, present, missing };
}
