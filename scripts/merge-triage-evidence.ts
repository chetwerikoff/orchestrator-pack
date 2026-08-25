import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  listPackReviewImmutableRecords,
  stagePackReviewImmutableRecord,
  stableJson,
  type PackReviewAuthorityOptions,
} from './pack-review-state.ts';

export const MERGE_TRIAGE_EVIDENCE_SCHEMA = 'merge-triage-evidence/v1';
export const MERGE_TRIAGE_PRIMARY_PATH_ID = 'scope-denylist-current-head/v1';
export const MERGE_TRIAGE_REGISTRY_VERSION = 1;

export interface MergeTriageEvidenceTuple {
  repository: string;
  prNumber: number;
  cycleId: string;
  currentHeadSha: string;
  atCapHash: string;
  registryVersion: number;
  producerExecutableDigest: string;
  boundIssueSnapshotDigest: string;
  changedPathCaptureDigest: string;
  inputDigest: string;
}

export interface MergeTriageFindingResolutionEvidence {
  findingSnapshotDigest: string;
  priorReviewedHeadSha: string;
  currentHeadSha: string;
  findingCount: number;
  blockingFindingCount: number;
  nonBlockingFindingCount: number;
  unresolvedBlockingFindingCount: number;
  resolutionBasis: 'explicit_current_head_finding_selection';
  predicateResult: 'resolved' | 'unresolved';
}

export interface MergeTriageEvidenceRecord {
  schema: typeof MERGE_TRIAGE_EVIDENCE_SCHEMA;
  evidenceId: string;
  expectedEvidenceKey: string;
  pathId: typeof MERGE_TRIAGE_PRIMARY_PATH_ID;
  producer: 'scripts/merge-triage-evidence.ts';
  tuple: MergeTriageEvidenceTuple;
  changedPaths: string[];
  denylistPatterns: string[];
  matchedPaths: string[];
  predicateResult: 'intersection' | 'no_intersection';
  findingResolution?: MergeTriageFindingResolutionEvidence;
  producedAtUtc: string;
}

export interface MergeTriageSelection {
  kind: 'selected' | 'missing' | 'authority_conflict';
  verdict: 'BLOCK' | 'PENDING_ARCHITECT' | 'PENDING_OPERATOR';
  evidence?: MergeTriageEvidenceRecord;
  evidenceDigest?: string;
  reason: string;
}

function nonEmpty(value: unknown, label: string): string {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`merge_triage_evidence_invalid: ${label}`);
  return text;
}

function fullSha(value: unknown, label: string): string {
  const sha = nonEmpty(value, label).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`merge_triage_evidence_invalid: ${label}`);
  return sha;
}

function fullDigest(value: unknown, label: string): string {
  const digest = nonEmpty(value, label).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error(`merge_triage_evidence_invalid: ${label}`);
  return digest;
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`merge_triage_evidence_invalid: ${label}`);
  return parsed;
}

function nonNegativeInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`merge_triage_evidence_invalid: ${label}`);
  return parsed;
}

export function sha256Bytes(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function normalizeChangedPath(value: unknown): string {
  const path = nonEmpty(value, 'changed path').replaceAll('\\', '/');
  if (path.startsWith('/') || path.includes('\0') || path.split('/').includes('..')) {
    throw new Error(`merge_triage_evidence_invalid: unsafe path ${path}`);
  }
  return path.replace(/^\.\//, '');
}

export function parseIssueDenylist(issueBody: string): string[] {
  const matches = [...String(issueBody).matchAll(/```denylist\s*\r?\n([\s\S]*?)```/gi)];
  if (matches.length !== 1) {
    throw new Error(`merge_triage_evidence_invalid: expected one denylist fence, got ${matches.length}`);
  }
  const patterns = String(matches[0]?.[1] ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map(normalizeChangedPath);
  return [...new Set(patterns)].sort();
}

function globToRegExp(pattern: string): RegExp {
  let out = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    const next = pattern[index + 1];
    if (char === '*' && next === '*') {
      index += 1;
      if (pattern[index + 1] === '/') {
        index += 1;
        out += '(?:.*/)?';
      } else {
        out += '.*';
      }
    } else if (char === '*') {
      out += '[^/]*';
    } else if (char === '?') {
      out += '[^/]';
    } else {
      out += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }
  out += '$';
  return new RegExp(out);
}

export function pathMatchesDenylist(path: string, patterns: readonly string[]): boolean {
  const normalized = normalizeChangedPath(path);
  return patterns.some((pattern) => globToRegExp(normalizeChangedPath(pattern)).test(normalized));
}

export function buildMergeTriageFindingResolutionEvidence(input: {
  findingSnapshotDigest: string;
  priorReviewedHeadSha: string;
  currentHeadSha: string;
  findingCount: number;
  blockingFindingCount: number;
  unresolvedBlockingFindingCount: number;
}): MergeTriageFindingResolutionEvidence {
  const findingCount = positiveInteger(input.findingCount, 'findingResolution.findingCount');
  const blockingFindingCount = nonNegativeInteger(
    input.blockingFindingCount,
    'findingResolution.blockingFindingCount',
  );
  const unresolvedBlockingFindingCount = nonNegativeInteger(
    input.unresolvedBlockingFindingCount,
    'findingResolution.unresolvedBlockingFindingCount',
  );
  if (blockingFindingCount > findingCount) {
    throw new Error('merge_triage_evidence_invalid: findingResolution.blockingFindingCount exceeds findingCount');
  }
  if (unresolvedBlockingFindingCount > blockingFindingCount) {
    throw new Error('merge_triage_evidence_invalid: findingResolution.unresolvedBlockingFindingCount exceeds blockingFindingCount');
  }
  return {
    findingSnapshotDigest: fullDigest(input.findingSnapshotDigest, 'findingResolution.findingSnapshotDigest'),
    priorReviewedHeadSha: fullSha(input.priorReviewedHeadSha, 'findingResolution.priorReviewedHeadSha'),
    currentHeadSha: fullSha(input.currentHeadSha, 'findingResolution.currentHeadSha'),
    findingCount,
    blockingFindingCount,
    nonBlockingFindingCount: findingCount - blockingFindingCount,
    unresolvedBlockingFindingCount,
    resolutionBasis: 'explicit_current_head_finding_selection',
    predicateResult: unresolvedBlockingFindingCount === 0 ? 'resolved' : 'unresolved',
  };
}

export function deriveMergeTriageEvidenceTuple(input: {
  repository: string;
  prNumber: number;
  cycleId: string;
  currentHeadSha: string;
  atCapHash: string;
  producerExecutableBytes: string | Uint8Array;
  boundIssueSnapshotBytes: string | Uint8Array;
  changedPathCaptureBytes: string | Uint8Array;
  input: unknown;
  registryVersion?: number;
}): MergeTriageEvidenceTuple {
  return {
    repository: nonEmpty(input.repository, 'repository'),
    prNumber: positiveInteger(input.prNumber, 'prNumber'),
    cycleId: nonEmpty(input.cycleId, 'cycleId'),
    currentHeadSha: fullSha(input.currentHeadSha, 'currentHeadSha'),
    atCapHash: nonEmpty(input.atCapHash, 'atCapHash'),
    registryVersion: positiveInteger(
      input.registryVersion ?? MERGE_TRIAGE_REGISTRY_VERSION,
      'registryVersion',
    ),
    producerExecutableDigest: sha256Bytes(input.producerExecutableBytes),
    boundIssueSnapshotDigest: sha256Bytes(input.boundIssueSnapshotBytes),
    changedPathCaptureDigest: sha256Bytes(input.changedPathCaptureBytes),
    inputDigest: sha256Bytes(stableJson(input.input)),
  };
}

export function expectedMergeTriageEvidenceKey(tuple: MergeTriageEvidenceTuple): string {
  return sha256Bytes(stableJson(tuple));
}

export function buildMergeTriageEvidenceRecord(input: {
  tuple: MergeTriageEvidenceTuple;
  changedPaths: readonly string[];
  denylistPatterns: readonly string[];
  findingResolution?: MergeTriageFindingResolutionEvidence;
  producedAtUtc?: string;
}): MergeTriageEvidenceRecord {
  nonEmpty(input.tuple.repository, 'tuple.repository');
  positiveInteger(input.tuple.prNumber, 'tuple.prNumber');
  nonEmpty(input.tuple.cycleId, 'tuple.cycleId');
  fullSha(input.tuple.currentHeadSha, 'tuple.currentHeadSha');
  nonEmpty(input.tuple.atCapHash, 'tuple.atCapHash');
  positiveInteger(input.tuple.registryVersion, 'tuple.registryVersion');
  for (const [label, digest] of [
    ['producerExecutableDigest', input.tuple.producerExecutableDigest],
    ['boundIssueSnapshotDigest', input.tuple.boundIssueSnapshotDigest],
    ['changedPathCaptureDigest', input.tuple.changedPathCaptureDigest],
    ['inputDigest', input.tuple.inputDigest],
  ] as const) {
    if (!/^[0-9a-f]{64}$/.test(nonEmpty(digest, label))) {
      throw new Error(`merge_triage_evidence_invalid: ${label}`);
    }
  }
  const changedPaths = [...new Set(input.changedPaths.map(normalizeChangedPath))].sort();
  const denylistPatterns = [...new Set(input.denylistPatterns.map(normalizeChangedPath))].sort();
  const matchedPaths = changedPaths.filter((path) => pathMatchesDenylist(path, denylistPatterns));
  const expectedEvidenceKey = expectedMergeTriageEvidenceKey(input.tuple);
  const evidenceId = `mte-${expectedEvidenceKey}`;
  return {
    schema: MERGE_TRIAGE_EVIDENCE_SCHEMA,
    evidenceId,
    expectedEvidenceKey,
    pathId: MERGE_TRIAGE_PRIMARY_PATH_ID,
    producer: 'scripts/merge-triage-evidence.ts',
    tuple: structuredClone(input.tuple),
    changedPaths,
    denylistPatterns,
    matchedPaths,
    predicateResult: matchedPaths.length > 0 ? 'intersection' : 'no_intersection',
    ...(input.findingResolution ? { findingResolution: structuredClone(input.findingResolution) } : {}),
    producedAtUtc: input.producedAtUtc ?? new Date().toISOString(),
  };
}

export function produceMergeTriageEvidence(input: {
  tuple: MergeTriageEvidenceTuple;
  changedPaths: readonly string[];
  issueBody: string;
  options: PackReviewAuthorityOptions;
  findingResolution?: MergeTriageFindingResolutionEvidence;
  producedAtUtc?: string;
}): { record: MergeTriageEvidenceRecord; digest: string; created: boolean } {
  const record = buildMergeTriageEvidenceRecord({
    tuple: input.tuple,
    changedPaths: input.changedPaths,
    denylistPatterns: parseIssueDenylist(input.issueBody),
    findingResolution: input.findingResolution,
    producedAtUtc: input.producedAtUtc,
  });
  const staged = stagePackReviewImmutableRecord({
    kind: 'evidence',
    key: record.evidenceId,
    value: record,
    options: input.options,
  });
  return { record, digest: staged.digest, created: staged.created };
}

function isEvidenceRecord(value: unknown): value is MergeTriageEvidenceRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Partial<MergeTriageEvidenceRecord>;
  return row.schema === MERGE_TRIAGE_EVIDENCE_SCHEMA
    && row.pathId === MERGE_TRIAGE_PRIMARY_PATH_ID
    && row.producer === 'scripts/merge-triage-evidence.ts'
    && typeof row.expectedEvidenceKey === 'string'
    && Array.isArray(row.matchedPaths)
    && (row.predicateResult === 'intersection' || row.predicateResult === 'no_intersection');
}

export function selectMergeTriageEvidence(input: {
  tuple: MergeTriageEvidenceTuple;
  options: PackReviewAuthorityOptions;
}): MergeTriageSelection {
  const expectedKey = expectedMergeTriageEvidenceKey(input.tuple);
  const records = listPackReviewImmutableRecords('evidence', input.options);
  if (records.some((entry) => entry.malformed)) {
    return { kind: 'missing', verdict: 'PENDING_OPERATOR', reason: 'evidence_malformed' };
  }
  const matches = records
    .filter((entry): entry is typeof entry & { value: MergeTriageEvidenceRecord } =>
      isEvidenceRecord(entry.value),
    )
    .filter((entry) => entry.value.expectedEvidenceKey === expectedKey)
    .filter((entry) => stableJson(entry.value.tuple) === stableJson(input.tuple));
  if (matches.length === 0) {
    return { kind: 'missing', verdict: 'PENDING_OPERATOR', reason: 'evidence_missing' };
  }
  const digestSet = new Set(matches.map((entry) => entry.digest));
  if (digestSet.size !== 1 || matches.length !== 1) {
    return {
      kind: 'authority_conflict',
      verdict: 'PENDING_OPERATOR',
      reason: 'evidence_ambiguous',
    };
  }
  const match = matches[0]!;
  const evidence = match.value as MergeTriageEvidenceRecord;
  return {
    kind: 'selected',
    verdict: evidence.predicateResult === 'intersection' ? 'BLOCK' : 'PENDING_ARCHITECT',
    evidence,
    evidenceDigest: match.digest,
    reason: evidence.predicateResult === 'intersection'
      ? 'trusted_current_head_denylist_intersection'
      : 'trusted_current_head_no_intersection',
  };
}

export function classifyTextOnlyMergeTriageCandidate(input: {
  blockMarker?: boolean;
  scopeViolationCandidate?: boolean;
}): { verdict: 'PENDING_ARCHITECT'; reason: string } {
  return {
    verdict: 'PENDING_ARCHITECT',
    reason: input.scopeViolationCandidate
      ? 'scope_candidate_requires_trusted_producer'
      : input.blockMarker
        ? 'block_marker_requires_architect_or_trusted_producer'
        : 'semantic_findings_require_architect',
  };
}

export function producerExecutableDigest(filePath = import.meta.filename): string {
  const path = resolve(filePath);
  if (!existsSync(path)) throw new Error(`merge_triage_evidence_invalid: producer missing ${path}`);
  return sha256Bytes(readFileSync(path));
}
