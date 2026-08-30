import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { defaultGhTransport, fetchIssueRevision } from './create-issue-stage-record-gh.ts';
import type { GhTransport } from './create-issue-stage-record-types.ts';
import { canonicalStagePlan, type ReviewTier } from './create-issue-stage-topology.ts';
import {
  deriveReviewEpisodeState,
  resolveCanonicalReviewDirectory,
  validateReviewEpisodeTopology,
  type ReviewEpisodeDerivationAuthorityV1,
} from './stage-completeness-core.ts';
import {
  ACCEPTANCE_ARTIFACT_OUTPUT_NAMES,
  ARTIFACT_MANIFEST_SCHEMA,
  AUTHORITATIVE_GITHUB_ARTIFACT_BASIS,
} from './create-issue-stage-record-artifacts.ts';

export const MANAGER_REVIEW_TERMINAL_BUNDLE_SCHEMA = 'manager-review-terminal-input-bundle/v1' as const;

const DEFECT_DISPOSITIONS = new Set(['addressed', 'rejected-as-false', 'unresolved']);
const REMEDY_DISPOSITIONS = new Set(['accepted', 'replaced-by-cheaper-sufficient', 'rejected-as-overengineering']);
const M4_DISPOSITIONS = new Set(['keep', 'simplify', 'defer', 'cut']);
const PROTECTED_TYPES = new Set(['security', 'scope-violation']);
const REVISION_RE = /^r[0-9]{2,}$/;
const SOURCE_REVISION_MARKER_RE = /<!--\s*source-revision:\s*(r[0-9]{2,})\s*-->/i;

type JsonRecord = Record<string, unknown>;

export interface ManagerReviewTerminalM4Entry {
  readonly mechanism: string;
  readonly disposition: 'keep' | 'simplify' | 'defer' | 'cut';
}

export interface ManagerReviewTerminalBundle {
  readonly schema: typeof MANAGER_REVIEW_TERMINAL_BUNDLE_SCHEMA;
  readonly repositoryFullName: string;
  readonly issueNumber: number;
  readonly reviewEpisodeId: string;
  readonly sourceRevision: string;
  readonly predecessorStage: string | null;
  readonly draft: string;
  readonly draftSha256: string;
  readonly rejectPartition: readonly JsonRecord[];
  readonly protectedM3: readonly JsonRecord[];
  readonly authorM4: readonly ManagerReviewTerminalM4Entry[];
  readonly reviewEconomics: {
    readonly contract: 'v1';
    readonly counts: {
      readonly rawFindingCount: number;
      readonly distinctFindingCount: number;
      readonly processedDistinctCount: number;
    };
    readonly stageReceipts: readonly {
      readonly stageReceiptId: string;
      readonly stage: string;
      readonly sourceRevision: string;
      readonly outcome: string;
    }[];
    readonly verifiedRelayCount: number;
  };
}

export interface BuildManagerReviewTerminalBundleOptions {
  readonly repositoryFullName: string;
  readonly issueNumber: number;
  readonly sourceRevision: string;
  readonly reviewDir: string;
  readonly authorDispositionsPath?: string;
  readonly transport?: GhTransport;
  readonly liveIssueBody?: string;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function requireString(record: JsonRecord, key: string, cause: string): string {
  const value = record[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(cause);
  return value;
}

function requireNullableString(record: JsonRecord, key: string, cause: string): string | null {
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== 'string' || !value.trim()) throw new Error(cause);
  return value;
}

function readJsonValue(path: string, cause: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    throw new Error(cause);
  }
}

function readJson(path: string, cause: string): JsonRecord {
  const parsed = readJsonValue(path, cause);
  if (!isRecord(parsed)) throw new Error(cause);
  return parsed;
}

function parseRevisionMarker(body: string): string {
  const matches = [...body.matchAll(new RegExp(SOURCE_REVISION_MARKER_RE.source, 'gi'))];
  if (matches.length !== 1 || !matches[0]?.[1]) throw new Error('terminal_bundle_live_revision_unavailable');
  return matches[0][1];
}

function validateCounts(value: unknown): ManagerReviewTerminalBundle['reviewEconomics']['counts'] {
  if (!isRecord(value)) throw new Error('terminal_bundle_review_economics_invalid');
  const keys = ['rawFindingCount', 'distinctFindingCount', 'processedDistinctCount'] as const;
  const result = {} as Record<(typeof keys)[number], number>;
  for (const key of keys) {
    const count = Number(value[key]);
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error('terminal_bundle_review_economics_invalid');
    }
    result[key] = count;
  }
  return result;
}

function validateM4(raw: unknown, reviewEpisodeId: string, sourceRevision: string, predecessorStage: string | null): ManagerReviewTerminalM4Entry[] {
  if (!isRecord(raw)) throw new Error('terminal_bundle_author_m4_missing');
  if (raw.reviewEpisodeId !== reviewEpisodeId || raw.sourceRevision !== sourceRevision || raw.predecessorStage !== predecessorStage) {
    throw new Error('terminal_bundle_author_m4_stale');
  }
  if (!Array.isArray(raw.inventory)) throw new Error('terminal_bundle_author_m4_missing');
  const result: ManagerReviewTerminalM4Entry[] = [];
  const mechanisms = new Set<string>();
  for (const item of raw.inventory) {
    if (!isRecord(item)) throw new Error('terminal_bundle_author_m4_invalid');
    const mechanism = typeof item.mechanism === 'string' ? item.mechanism.trim() : '';
    const disposition = typeof item.disposition === 'string' ? item.disposition.trim() : '';
    if (!mechanism || !M4_DISPOSITIONS.has(disposition) || mechanisms.has(mechanism)) {
      throw new Error('terminal_bundle_author_m4_invalid');
    }
    mechanisms.add(mechanism);
    result.push({ mechanism, disposition: disposition as ManagerReviewTerminalM4Entry['disposition'] });
  }
  return result;
}

function normalizeFindings(raw: unknown): JsonRecord[] {
  if (!Array.isArray(raw)) throw new Error('terminal_bundle_author_dispositions_invalid');
  return raw.map((item) => {
    if (!isRecord(item)) throw new Error('terminal_bundle_author_dispositions_invalid');
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    const defectDisposition = typeof item.defectDisposition === 'string' ? item.defectDisposition.trim() : '';
    const remedyDisposition = typeof item.remedyDisposition === 'string' ? item.remedyDisposition.trim() : '';
    if (!id || !DEFECT_DISPOSITIONS.has(defectDisposition) || !REMEDY_DISPOSITIONS.has(remedyDisposition)) {
      throw new Error('terminal_bundle_author_dispositions_invalid');
    }
    return item;
  });
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalizeJson(value[key])]),
  );
}

function sameFindingState(left: JsonRecord, right: JsonRecord): boolean {
  return JSON.stringify(canonicalizeJson(left)) === JSON.stringify(canonicalizeJson(right));
}

function manifestFiles(manifest: JsonRecord): string[] {
  if (manifest.schema !== ARTIFACT_MANIFEST_SCHEMA
    || manifest.acceptanceBasis !== AUTHORITATIVE_GITHUB_ARTIFACT_BASIS
    || !Array.isArray(manifest.files)) {
    throw new Error('terminal_bundle_acceptance_manifest_invalid');
  }
  const files = manifest.files.filter((item): item is string => typeof item === 'string' && item.length > 0);
  if (files.length !== manifest.files.length || new Set(files).size !== files.length) {
    throw new Error('terminal_bundle_acceptance_manifest_invalid');
  }
  for (const required of [
    ...ACCEPTANCE_ARTIFACT_OUTPUT_NAMES,
  ]) {
    if (!files.includes(required)) throw new Error('terminal_bundle_acceptance_manifest_invalid');
  }
  return files;
}

function stageReceipts(reviewDir: string, files: readonly string[], reviewEpisodeId: string): ManagerReviewTerminalBundle['reviewEconomics']['stageReceipts'] {
  const receiptFiles = files.filter((name) => /^stage-completeness-receipt-.+\.json$/.test(name));
  if (receiptFiles.length === 0) throw new Error('terminal_bundle_stage_receipts_missing');
  const rows = receiptFiles.map((name) => {
    const receipt = readJson(join(reviewDir, name), 'terminal_bundle_stage_receipt_invalid');
    if (receipt.schema !== 'stage-completeness-receipt/v1' || receipt.reviewEpisodeId !== reviewEpisodeId) {
      throw new Error('terminal_bundle_stage_receipt_invalid');
    }
    return {
      stageReceiptId: requireString(receipt, 'stageReceiptId', 'terminal_bundle_stage_receipt_invalid'),
      stage: requireString(receipt, 'stage', 'terminal_bundle_stage_receipt_invalid'),
      sourceRevision: requireString(receipt, 'sourceRevision', 'terminal_bundle_stage_receipt_invalid'),
      outcome: requireString(receipt, 'outcome', 'terminal_bundle_stage_receipt_invalid'),
      stageSequence: Number(receipt.stageSequence),
    };
  });
  if (rows.some((row) => !Number.isSafeInteger(row.stageSequence) || row.stageSequence < 1)) {
    throw new Error('terminal_bundle_stage_receipt_invalid');
  }
  rows.sort((left, right) => left.stageSequence - right.stageSequence);
  if (new Set(rows.map((row) => row.stageReceiptId)).size !== rows.length) {
    throw new Error('terminal_bundle_stage_receipt_invalid');
  }
  return rows.map(({ stageSequence: _stageSequence, ...row }) => row);
}

function stageReceiptValues(reviewDir: string, files: readonly string[]): JsonRecord[] {
  return files
    .filter((name) => /^stage-completeness-receipt-.+\.json$/.test(name))
    .map((name) => readJson(join(reviewDir, name), 'terminal_bundle_stage_receipt_invalid'));
}

function resolveTierAndPredecessor(
  intake: JsonRecord,
  predecessorStage: string | null,
): { readonly tier: ReviewTier; readonly expectedPredecessorStage: string | null } {
  const priorTier = intake.priorTier;
  if (priorTier !== 'T1' && priorTier !== 'T2' && priorTier !== 'T3') {
    throw new Error('terminal_bundle_tier_intake_invalid');
  }
  let plan;
  try {
    plan = canonicalStagePlan(priorTier, {
      competitiveDecision: intake.competitiveDecision === 'required' || intake.competitiveDecision === 'skipped'
        ? intake.competitiveDecision
        : undefined,
      competitiveRationale: typeof intake.competitiveRationale === 'string'
        ? intake.competitiveRationale
        : undefined,
    });
  } catch {
    throw new Error('terminal_bundle_tier_intake_invalid');
  }
  const expectedPredecessorStage = plan.stages.length > 1
    ? plan.stages[plan.stages.length - 2]!.stage
    : null;
  if (predecessorStage !== expectedPredecessorStage) {
    throw new Error('terminal_bundle_predecessor_invalid');
  }
  return { tier: priorTier, expectedPredecessorStage };
}

function validateGovernedArtifacts(
  reviewDir: string,
  files: readonly string[],
  intake: JsonRecord,
  reviewEpisodeId: string,
  tier: ReviewTier,
): ReturnType<typeof deriveReviewEpisodeState> {
  const receipts = stageReceiptValues(reviewDir, files);
  const relay = readJsonValue(join(reviewDir, 'verified-relay-evidence.json'), 'terminal_bundle_relay_invalid');
  if (!Array.isArray(relay)) throw new Error('terminal_bundle_relay_invalid');
  const claudeEvidencePath = join(reviewDir, 'claude-producer-evidence.json');
  const claudeProducerEvidence = existsSync(claudeEvidencePath)
    ? readJsonValue(claudeEvidencePath, 'terminal_bundle_claude_producer_evidence_invalid')
    : [];
  if (!Array.isArray(claudeProducerEvidence)) {
    throw new Error('terminal_bundle_claude_producer_evidence_invalid');
  }
  const taskIdentity = requireString(intake, 'taskIdentity', 'terminal_bundle_tier_intake_invalid');
  const firstRevision = requireString(intake, 'firstRevision', 'terminal_bundle_tier_intake_invalid');
  const authority: ReviewEpisodeDerivationAuthorityV1 = {
    tierIntake: intake as unknown as ReviewEpisodeDerivationAuthorityV1['tierIntake'],
    receiptInventory: {
      source: 'canonical-review-directory',
      taskIdentity,
      episodeFirstRevision: firstRevision,
      reviewEpisodeId,
      stageReceiptIds: receipts.map((receipt) => requireString(
        receipt,
        'stageReceiptId',
        'terminal_bundle_stage_receipt_invalid',
      )),
    },
    claudeProducerEvidence,
    validationPurpose: 'stage-time',
  };
  const state = deriveReviewEpisodeState(receipts, relay, authority);
  const phase = tier === 'T2' ? 'pre-lens' : 'post-lens';
  const errors = [...state.errors, ...validateReviewEpisodeTopology(state, phase)];
  if (!state.relayComplete) errors.push('review episode relay is incomplete');
  if (errors.length > 0) throw new Error('terminal_bundle_governed_artifacts_invalid');
  return state;
}

function validateRepository(repositoryFullName: string): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repositoryFullName)) {
    throw new Error('terminal_bundle_context_invalid_repository');
  }
}

export function buildManagerReviewTerminalBundle(options: BuildManagerReviewTerminalBundleOptions): ManagerReviewTerminalBundle {
  validateRepository(options.repositoryFullName);
  if (!Number.isSafeInteger(options.issueNumber) || options.issueNumber < 1) throw new Error('terminal_bundle_context_invalid_issue');
  if (!REVISION_RE.test(options.sourceRevision)) throw new Error('terminal_bundle_context_invalid_revision');

  const reviewDir = resolve(options.reviewDir);
  const authorDispositionsPath = resolve(options.authorDispositionsPath ?? join(reviewDir, 'author-dispositions.json'));
  const author = readJson(authorDispositionsPath, 'terminal_bundle_author_dispositions_invalid');
  if (author.schema !== 'create-issue-author-dispositions/v1') throw new Error('terminal_bundle_author_dispositions_invalid');

  const reviewEpisodeId = requireString(author, 'reviewEpisodeId', 'terminal_bundle_binding_missing');
  const authorRevision = requireString(author, 'sourceRevision', 'terminal_bundle_binding_missing');
  const predecessorStage = requireNullableString(author, 'predecessorStage', 'terminal_bundle_binding_missing');
  const draft = requireString(author, 'draft', 'terminal_bundle_draft_missing');
  if (authorRevision !== options.sourceRevision) throw new Error('terminal_bundle_author_dispositions_stale');

  const liveBody = options.liveIssueBody ?? fetchIssueRevision(
    options.transport ?? defaultGhTransport(),
    options.repositoryFullName,
    options.issueNumber,
  ).body;
  if (parseRevisionMarker(liveBody) !== options.sourceRevision || liveBody !== draft) {
    throw new Error('terminal_bundle_live_issue_mismatch');
  }

  const findings = normalizeFindings(author.findings);
  if (findings.some((row) => row.defectDisposition === 'unresolved')) {
    throw new Error('terminal_bundle_unresolved_findings');
  }
  const authorM4 = validateM4(author.m4, reviewEpisodeId, options.sourceRevision, predecessorStage);

  const intake = readJson(join(reviewDir, 'tier-intake.json'), 'terminal_bundle_tier_intake_invalid');
  if (intake.schema !== 'tier-intake/v1'
    || intake.taskIdentity !== `issue:${options.issueNumber}`
    || typeof intake.firstRevision !== 'string'
    || `${intake.taskIdentity}@${intake.firstRevision}` !== reviewEpisodeId) {
    throw new Error('terminal_bundle_tier_intake_stale');
  }
  const canonicalReviewDirectory = resolveCanonicalReviewDirectory({
    taskIdentity: String(intake.taskIdentity),
  });
  if (reviewDir !== canonicalReviewDirectory.directory
    || resolve(join(reviewDir, 'tier-intake.json')) !== canonicalReviewDirectory.intakePath) {
    throw new Error('terminal_bundle_noncanonical_review_dir');
  }
  const { tier } = resolveTierAndPredecessor(intake, predecessorStage);
  if (tier === 'T1' && predecessorStage === null && authorM4.length > 0) {
    throw new Error('terminal_bundle_zero_state_m4_invalid');
  }

  let ledgerFindings: JsonRecord[] = findings;
  let receipts: ManagerReviewTerminalBundle['reviewEconomics']['stageReceipts'] = [];
  let verifiedRelayCount = 0;
  let counts: ManagerReviewTerminalBundle['reviewEconomics']['counts'] = {
    rawFindingCount: 0,
    distinctFindingCount: 0,
    processedDistinctCount: 0,
  };

  if (predecessorStage === null) {
    if (findings.length > 0) throw new Error('terminal_bundle_zero_state_findings_invalid');
  } else {
    const manifest = readJson(join(reviewDir, 'acceptance-artifacts.json'), 'terminal_bundle_acceptance_manifest_invalid');
    const files = manifestFiles(manifest);
    if (manifest.reviewEpisodeId !== reviewEpisodeId) throw new Error('terminal_bundle_acceptance_manifest_stale');
    const receiptNames = files.filter((name) => /^stage-completeness-receipt-.+\.json$/.test(name));
    const expectedFiles = new Set([...receiptNames, ...ACCEPTANCE_ARTIFACT_OUTPUT_NAMES]);
    if (files.length !== expectedFiles.size || files.some((name) => !expectedFiles.has(name))) {
      throw new Error('terminal_bundle_acceptance_manifest_invalid');
    }

    const inventory = readJson(join(reviewDir, 'review-episode-inventory.json'), 'terminal_bundle_inventory_invalid');
    const receiptValues = stageReceiptValues(reviewDir, files);
    const receiptIds = receiptValues.map((receipt) => requireString(
      receipt,
      'stageReceiptId',
      'terminal_bundle_stage_receipt_invalid',
    ));
    if (inventory.source !== 'canonical-review-directory'
      || inventory.taskIdentity !== intake.taskIdentity
      || inventory.episodeFirstRevision !== intake.firstRevision
      || inventory.reviewEpisodeId !== reviewEpisodeId
      || !Array.isArray(inventory.stageReceiptIds)
      || JSON.stringify(inventory.stageReceiptIds) !== JSON.stringify(receiptIds)) {
      throw new Error('terminal_bundle_inventory_stale');
    }

    const ledger = readJson(join(reviewDir, 'finding-disposition-ledger.json'), 'terminal_bundle_ledger_invalid');
    if (ledger.reviewEpisodeId !== reviewEpisodeId || ledger.sourceRevision !== options.sourceRevision || ledger.predecessorStage !== predecessorStage || ledger.draft !== draft) {
      throw new Error('terminal_bundle_ledger_stale');
    }
    ledgerFindings = normalizeFindings(ledger.findings);
    const authorIds = findings.map((row) => row.id);
    const ledgerIds = ledgerFindings.map((row) => row.id);
    if (JSON.stringify(authorIds) !== JSON.stringify(ledgerIds)) throw new Error('terminal_bundle_ledger_disposition_mismatch');
    if (findings.length !== ledgerFindings.length
      || findings.some((finding, index) => !sameFindingState(finding, ledgerFindings[index]!))) {
      throw new Error('terminal_bundle_ledger_disposition_mismatch');
    }

    receipts = stageReceipts(reviewDir, files, reviewEpisodeId);
    const latestReceipt = receipts.at(-1);
    if (!latestReceipt || latestReceipt.stage === 'architectural') throw new Error('terminal_bundle_predecessor_invalid');
    if (predecessorStage !== latestReceipt.stage) throw new Error('terminal_bundle_predecessor_stale');

    const relay = readJsonValue(join(reviewDir, 'verified-relay-evidence.json'), 'terminal_bundle_relay_invalid');
    if (!Array.isArray(relay) || relay.some((item) => !isRecord(item) || item.verified !== true)) {
      throw new Error('terminal_bundle_relay_invalid');
    }
    verifiedRelayCount = relay.length;
    counts = validateCounts(ledger.counts);
    const episodeState = validateGovernedArtifacts(reviewDir, files, intake, reviewEpisodeId, tier);
    const expectedCounts = {
      rawFindingCount: episodeState.rawFindingCount,
      distinctFindingCount: ledgerFindings.length,
      processedDistinctCount: ledgerFindings.filter((row) => (
        row.defectDisposition === 'addressed' || row.defectDisposition === 'rejected-as-false'
      )).length,
    };
    if (JSON.stringify(counts) !== JSON.stringify(expectedCounts)) {
      throw new Error('terminal_bundle_review_economics_invalid');
    }
  }

  const rejectPartition = ledgerFindings.filter((row) => row.defectDisposition === 'rejected-as-false');
  const protectedM3 = ledgerFindings.filter((row) => PROTECTED_TYPES.has(String(row.type ?? '').toLowerCase()));

  return {
    schema: MANAGER_REVIEW_TERMINAL_BUNDLE_SCHEMA,
    repositoryFullName: options.repositoryFullName,
    issueNumber: options.issueNumber,
    reviewEpisodeId,
    sourceRevision: options.sourceRevision,
    predecessorStage,
    draft,
    draftSha256: sha256(draft),
    rejectPartition,
    protectedM3,
    authorM4,
    reviewEconomics: {
      contract: 'v1',
      counts,
      stageReceipts: receipts,
      verifiedRelayCount,
    },
  };
}

export function validateManagerReviewTerminalBundle(
  value: unknown,
  context: {
    readonly repositoryFullName: string;
    readonly issueNumber: number;
    readonly sourceRevision: string;
    readonly stage: string;
  },
): ManagerReviewTerminalBundle {
  if (!isRecord(value) || value.schema !== MANAGER_REVIEW_TERMINAL_BUNDLE_SCHEMA) {
    throw new Error('canonical_prompt_terminal_bundle_invalid');
  }
  if (context.stage !== 'architectural') throw new Error('canonical_prompt_terminal_bundle_unexpected');
  if (value.repositoryFullName !== context.repositoryFullName || value.issueNumber !== context.issueNumber || value.sourceRevision !== context.sourceRevision) {
    throw new Error('canonical_prompt_terminal_bundle_stale');
  }
  if (typeof value.reviewEpisodeId !== 'string' || !value.reviewEpisodeId || !REVISION_RE.test(String(value.sourceRevision))) {
    throw new Error('canonical_prompt_terminal_bundle_invalid');
  }
  if (value.predecessorStage !== null && (typeof value.predecessorStage !== 'string' || !value.predecessorStage)) {
    throw new Error('canonical_prompt_terminal_bundle_invalid');
  }
  if (typeof value.draft !== 'string' || !value.draft || value.draftSha256 !== sha256(value.draft)) {
    throw new Error('canonical_prompt_terminal_bundle_invalid');
  }
  if (!Array.isArray(value.rejectPartition) || !Array.isArray(value.protectedM3) || !Array.isArray(value.authorM4)) {
    throw new Error('canonical_prompt_terminal_bundle_invalid');
  }
  if (!isRecord(value.reviewEconomics) || value.reviewEconomics.contract !== 'v1') {
    throw new Error('canonical_prompt_terminal_bundle_invalid');
  }
  validateCounts(value.reviewEconomics.counts);
  if (!Array.isArray(value.reviewEconomics.stageReceipts)) {
    throw new Error('canonical_prompt_terminal_bundle_invalid');
  }
  const relayCount = Number(value.reviewEconomics.verifiedRelayCount);
  if (!Number.isSafeInteger(relayCount) || relayCount < 0) {
    throw new Error('canonical_prompt_terminal_bundle_invalid');
  }
  for (const receipt of value.reviewEconomics.stageReceipts) {
    if (!isRecord(receipt)
      || typeof receipt.stageReceiptId !== 'string'
      || typeof receipt.stage !== 'string'
      || typeof receipt.sourceRevision !== 'string'
      || typeof receipt.outcome !== 'string') {
      throw new Error('canonical_prompt_terminal_bundle_invalid');
    }
  }
  const normalized = value as unknown as ManagerReviewTerminalBundle;
  for (const entry of normalized.authorM4) {
    if (!entry || typeof entry.mechanism !== 'string' || !entry.mechanism.trim() || !M4_DISPOSITIONS.has(entry.disposition)) {
      throw new Error('canonical_prompt_terminal_bundle_invalid');
    }
  }
  return normalized;
}

export function parseManagerReviewTerminalBundle(
  text: string,
  context: {
    readonly repositoryFullName: string;
    readonly issueNumber: number;
    readonly sourceRevision: string;
    readonly stage: string;
  },
): ManagerReviewTerminalBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error('canonical_prompt_terminal_bundle_invalid');
  }
  return validateManagerReviewTerminalBundle(parsed, context);
}

export function renderManagerReviewTerminalBundle(bundle: ManagerReviewTerminalBundle): string {
  return JSON.stringify(bundle, null, 2);
}

export function writeManagerReviewTerminalBundle(path: string, bundle: ManagerReviewTerminalBundle): void {
  writeFileSync(path, `${renderManagerReviewTerminalBundle(bundle)}\n`, { mode: 0o600 });
}

export function terminalBundleFileName(issueNumber: number, sourceRevision: string): string {
  return `manager-review-terminal-bundle-${issueNumber}-${sourceRevision}.json`;
}

export function terminalBundleDisplayName(path: string): string {
  return basename(path);
}
