import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  deriveReviewEpisodeId,
  deriveReviewEpisodeState,
  deriveStageReceiptId,
  validateReviewEpisodeTopology,
  type CaptureIdentityV1,
  type ReviewStage,
  type ReviewTier,
  type StageCompletenessReceiptV1,
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

function captureIdentity(name: string, digest: string): string {
  return `sha256:${digest}:${name}`;
}

function captureFromEvidence(
  evidencePath: string,
  capturePathValue: unknown,
  assertedIdentity: unknown,
  captureTexts: Map<string, string>,
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

function loadTierIntake(path: string, errors: string[]): JsonRecord | null {
  const value = readJson(path, 'tier-intake/v1 evidence', errors);
  if (!isRecord(value) || value.schema !== 'tier-intake/v1') {
    errors.push(`tier-intake/v1 evidence is malformed: ${path}`);
    return null;
  }
  requiredString(value.taskIdentity, 'tier-intake.taskIdentity', errors);
  requiredString(value.firstRevision, 'tier-intake.firstRevision', errors);
  if (value.kind !== 'fresh' && value.kind !== 'compatibility') errors.push('tier-intake.kind is invalid');
  if (!['T1', 'T2', 'T3'].includes(String(value.priorTier))) errors.push('tier-intake.priorTier is invalid');
  return value;
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
  errors: string[],
): ProducedStageReceipt | null {
  if (raw.schema !== STAGE_EVIDENCE_SCHEMA) {
    errors.push(`stage evidence has unknown schema: ${evidencePath}`);
    return null;
  }
  const stage = requiredString(raw.stage, 'stage evidence.stage', errors) as ReviewStage;
  const tier = requiredString(raw.tier, 'stage evidence.tier', errors) as ReviewTier;
  const stageAttemptId = requiredString(raw.stageAttemptId, 'stage evidence.stageAttemptId', errors);
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
  const invocations: JsonRecord[] = [];
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
      const invocation = { ...value };
      const capture = value.capturePath === undefined
        ? null
        : captureFromEvidence(evidencePath, value.capturePath, value.captureIdentity, captureTexts, errors);
      delete invocation.capturePath;
      delete invocation.captureIdentity;
      if (capture) {
        invocation.capture = capture;
        captures.push(capture);
      }
      assertDerived(value.reviewEpisodeId, episodeId, `invocation[${index}].reviewEpisodeId`, errors);
      invocations.push(invocation);
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
      : captureFromEvidence(evidencePath, raw.claude.capturePath, raw.claude.captureIdentity, captureTexts, errors);
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
    policyVersion: raw.policyVersion as StageCompletenessReceiptV1['policyVersion'],
    reviewerCardinality: Number(raw.reviewerCardinality),
    cardinalityConfigIdentity: requiredString(raw.cardinalityConfigIdentity, 'stage evidence.cardinalityConfigIdentity', errors),
    sourceRevision,
    cycleId,
    cycleBinding: cycleBinding as { cycleId: string; sourceRevision: string; boundBeforeLaunch: true },
    outcome: raw.outcome as StageCompletenessReceiptV1['outcome'],
    revisionChecks: raw.revisionChecks as StageCompletenessReceiptV1['revisionChecks'],
    settlement: raw.settlement as StageCompletenessReceiptV1['settlement'],
    ...(invocations.length > 0 ? { invocations: invocations as StageCompletenessReceiptV1['invocations'] } : {}),
    ...(claude ? { claude: claude as unknown as StageCompletenessReceiptV1['claude'] } : {}),
    credentialingCaptures: raw.outcome === 'complete' ? captures : [],
    relayEligibleCaptures: captures,
  };
  return receipt;
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

export function produceAcceptanceArtifacts(
  options: ProduceAcceptanceArtifactsOptions,
): AcceptanceArtifactResult {
  const outputDir = options.outputDir ?? options.reviewDir;
  const errors: string[] = [];
  const intake = loadTierIntake(options.tierIntakePath, errors);
  const taskIdentity = intake && requiredString(intake.taskIdentity, 'tier-intake.taskIdentity', errors);
  const episodeFirstRevision = intake && requiredString(intake.firstRevision, 'tier-intake.firstRevision', errors);
  if (!taskIdentity || !episodeFirstRevision) {
    return { ok: false, outputDir, files: [], missing: [], errors: [...new Set(errors)] };
  }
  const episodeId = deriveReviewEpisodeId(taskIdentity, episodeFirstRevision);
  const captureTexts = new Map<string, string>();
  const receipts = options.stageEvidencePaths
    .map((path) => {
      const value = readJson(path, 'stage evidence', errors);
      return isRecord(value) ? buildReceipt(path, value, taskIdentity, episodeFirstRevision, episodeId, captureTexts, errors) : null;
    })
    .filter((value): value is StageCompletenessReceiptV1 => Boolean(value))
    .sort((left, right) => left.stageSequence - right.stageSequence);
  const tier = receipts[0]?.tier as ReviewTier | undefined;
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
  const authority = tier && {
    tierIntake: intake,
    receiptInventory: {
      source: 'canonical-review-directory' as const,
      taskIdentity,
      episodeFirstRevision,
      reviewEpisodeId: episodeId,
      stageReceiptIds: receipts.map((receipt) => receipt.stageReceiptId),
    },
  };
  if (ledger && tier) {
    const state = deriveReviewEpisodeState(receipts, relay, authority);
    errors.push(...state.errors);
    errors.push(...validateReviewEpisodeTopology(state, options.phase ?? 'final-acceptance'));
    const ledgerResult = checkFindingLedgerGuard(
      captures.map((capture) => captureTexts.get(capture.captureIdentity) ?? ''),
      ledger,
      {
        reviewEconomics: true,
        phase: options.phase ?? 'final-acceptance',
        issueRevision: episodeFirstRevision,
        stageTerminalConfirmed: true,
        stageReceipts: receipts,
        verifiedRelayEvidence: relay,
        episodeAuthority: authority,
        captureMetadata: captures.map((capture, index) => ({ name: capture.name, timestampMs: index + 1, captureIdentity: capture.captureIdentity })),
      },
    );
    if (!ledgerResult.ok) errors.push(...ledgerResult.errors);
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
      stageEvidence: options.stageEvidencePaths.map((path) => resolve(path)),
      authorDispositions: resolve(options.authorDispositionsPath),
    },
  };
  mkdirSync(outputDir, { recursive: true });
  receipts.forEach((receipt) => writeFileSync(join(outputDir, `stage-completeness-receipt-${receipt.stageAttemptId}.json`), JSON.stringify(receipt, null, 2) + '\n'));
  writeFileSync(join(outputDir, 'verified-relay-evidence.json'), JSON.stringify(relay, null, 2) + '\n');
  writeFileSync(join(outputDir, 'finding-disposition-ledger.json'), ledger);
  writeFileSync(join(outputDir, 'review-episode-inventory.json'), JSON.stringify(authority!.receiptInventory, null, 2) + '\n');
  writeFileSync(join(outputDir, 'acceptance-artifacts.json'), JSON.stringify(manifest, null, 2) + '\n');
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
  if (options.stageEvidencePaths.length === 0) {
    missing.push({ artifact: 'stage-completeness-receipt/v1', reason: 'no recorded stage evidence paths were supplied' });
  }
  for (const path of options.stageEvidencePaths) requirePath(path, 'stage evidence', 'recorded stage result is missing');
  for (const path of options.stageEvidencePaths) {
    if (!existsSync(path)) continue;
    const value = readJson(path, 'stage evidence', []);
    if (!isRecord(value) || !Array.isArray(value.invocations)) continue;
    for (const invocation of value.invocations) {
      if (!isRecord(invocation) || invocation.capturePath === undefined) continue;
      const capturePath = resolve(dirname(path), String(invocation.capturePath));
      requirePath(capturePath, 'capture', 'stage evidence names a capture that is not present');
    }
  }
  requirePath(join(options.outputDir ?? options.reviewDir, 'verified-relay-evidence.json'), 'verified relay evidence', 'relay manifest has not been produced');
  requirePath(join(options.outputDir ?? options.reviewDir, 'finding-disposition-ledger.json'), 'finding ledger', 'finding ledger has not been produced');
  return { ok: missing.length === 0, present, missing };
}
