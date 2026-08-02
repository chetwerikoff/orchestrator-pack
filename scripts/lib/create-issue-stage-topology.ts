import { createHash } from 'node:crypto';

export const TOPOLOGY_SCHEMA = 'create-issue-review-topology/v1' as const;
export const SOURCE_SCHEMA = 'create-issue-review-source/v1' as const;
export const DISPOSITION_SCHEMA = 'create-issue-author-disposition-m4/v1' as const;
export const MIGRATION_SCHEMA = 'create-issue-parked-review-import/v1' as const;
export const RECORD_MARKER_SCHEMA = 'create-issue-review-record/v1' as const;

export const COMMENT_BODY_UTF8_LIMIT = 65_536;
export const MAX_RAW_PART_BYTES = 32_000;
export const MAX_PART_COUNT = 32;
export const MAX_STAGE_SOURCE_RECORDS = 256;
export const ISSUE_COMMENT_PAGE_SIZE = 100;
export const MAX_ISSUE_COMMENT_PAGES = 10;
export const MAX_ISSUE_COMMENT_CENSUS = ISSUE_COMMENT_PAGE_SIZE * MAX_ISSUE_COMMENT_PAGES;
export const MAX_OUTPUT_UTF8_BYTES = MAX_RAW_PART_BYTES * MAX_PART_COUNT;
const SHA256_RE = /^[a-f0-9]{64}$/;
export const MAX_REPRESENTABLE_REVIEWER_CARDINALITY =
  Math.floor(MAX_STAGE_SOURCE_RECORDS / MAX_PART_COUNT);

export const PRODUCER_REASONS = [
  'invalid-identity',
  'empty-output',
  'invalid-utf8',
  'output-too-large',
  'too-many-parts',
  'too-many-stage-records',
  'serialized-comment-too-large',
  'completed-turn-unavailable',
  'completed-result-unavailable',
] as const;
export type ProducerReason = typeof PRODUCER_REASONS[number];

export const OBSERVATION_REASONS = ['transport-unavailable', 'census-incomplete'] as const;
export type ObservationReason = typeof OBSERVATION_REASONS[number];

export const PUBLICATION_CONFLICT_REASONS = [
  'duplicate-conflicting',
  'incompatible-identity',
  'edited-record',
  'malformed-payload',
  'truncated-payload',
  'missing-raw-bytes',
  'extra-slot',
  'invalid-base64',
  'part-hash-mismatch',
  'part-offset-mismatch',
  'part-count-mismatch',
  'part-length-mismatch',
  'assembled-length-mismatch',
  'output-id-mismatch',
  'invalid-assembled-utf8',
  'unexpected-record-count',
  'stale-active-attempt',
  'missing-topology',
  'duplicate-topology',
  'invalid-waiver',
] as const;
export type PublicationConflictReason = typeof PUBLICATION_CONFLICT_REASONS[number];

export const ADMISSION_STATES = [
  'pending-not-emitted',
  'turn-completed-awaiting-harvest',
  'completed-awaiting-event',
  'pending-publication',
  'pending-observation',
  'admitted',
  'waived-not-required',
  'terminal-producer-failed',
  'terminal-publication-conflict',
  'cancelled',
  'superseded',
] as const;
export type AdmissionState = typeof ADMISSION_STATES[number];

export type ReviewStage =
  | 'architectural'
  | 'competitive'
  | 'architectural-review'
  | 'architectural-lens';
export type ReviewTier = 'T1' | 'T2' | 'T3';
export type ReviewPolicy = 'single-source/v1' | 'triple-source/v1';
export type LifecycleState = 'active' | 'cancelled' | 'superseded';

export interface TopologyIdentity {
  issueNumber: number;
  cycleId: string;
  sourceRevision: string;
  stage: ReviewStage;
  stageAttemptId: string;
  policyVersion: ReviewPolicy;
}

export interface ClaudeUnavailableWaiverRef {
  schema: 'claude-unavailable-waiver/v1';
  waiverId: string;
  sourceRevision: string;
  reason: string;
  producer: string;
  digest: string;
}

export interface ReviewTopology extends TopologyIdentity {
  schema: typeof TOPOLOGY_SCHEMA;
  reviewerCardinality: number;
  cardinalityConfigIdentity: string;
  requiredSlots: string[];
  claudeUnavailableWaiverRef: ClaudeUnavailableWaiverRef | null;
}

export interface LifecycleBinding {
  state: LifecycleState;
  cycleId: string;
  stageAttemptId: string;
  sourceRevision: string;
}

export interface SourceRecordIdentity extends TopologyIdentity {
  reviewerCardinality: number;
  cardinalityConfigIdentity: string;
  slot: string;
  outputId: string;
}

export interface SourceRecord extends SourceRecordIdentity {
  schema: typeof SOURCE_SCHEMA;
  eventKey: string;
  recordKey: string;
  partIndex: number;
  partCount: number;
  byteOffset: number;
  byteLength: number;
  totalByteLength: number;
  partSha256: string;
  rawOutputPartBase64: string;
  body: string;
}

export interface ParsedRecordMarker {
  schema: typeof RECORD_MARKER_SCHEMA;
  recordKind: 'topology' | 'source' | 'disposition' | 'migration';
  eventKey: string;
  recordKey: string;
  slotOrRecordKind: string;
  partIndex: number;
  partCount: number;
}

export interface AssembledSourceOutput {
  rawOutput: string;
  rawBytes: Uint8Array;
  outputId: string;
  records: SourceRecord[];
}

export interface AuthorDispositionInput {
  occurrenceIds: string[];
  distinctDefects: Array<{ defectId: string; occurrenceIds: string[] }>;
  defectDispositions: Array<{
    defectId: string;
    disposition: 'addressed' | 'rejected-as-false' | 'unresolved';
  }>;
  remedyDispositions: Array<{
    defectId: string;
    disposition: 'accepted' | 'replaced-by-cheaper-sufficient' | 'rejected-as-overengineering';
  }>;
  m4: 'keep' | 'simplify' | 'defer' | 'cut';
  unresolvedOccurrenceIds: string[];
  settlement: 'settled' | 'unresolved';
}

export interface AuthorDisposition extends TopologyIdentity {
  schema: typeof DISPOSITION_SCHEMA;
  topologyEventKey: string;
  topologyRecordKey: string;
  sourceRecordKeys: string[];
  outputIds: string[];
  occurrenceIds: string[];
  distinctDefects: AuthorDispositionInput['distinctDefects'];
  defectDispositions: AuthorDispositionInput['defectDispositions'];
  remedyDispositions: AuthorDispositionInput['remedyDispositions'];
  m4: AuthorDispositionInput['m4'];
  unresolvedOccurrenceIds: string[];
  settlement: AuthorDispositionInput['settlement'];
  eventKey: string;
  recordKey: string;
  body: string;
}

export interface AdmissionResult {
  state: AdmissionState;
  reasons: Array<ProducerReason | ObservationReason | PublicationConflictReason>;
  sourceRecords: SourceRecord[];
  output?: AssembledSourceOutput;
}

export interface TopologyRecord extends ReviewTopology {
  eventKey: string;
  recordKey: string;
  body: string;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortCanonical(value));
}

function sortCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortCanonical);
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) result[key] = sortCanonical(item);
    }
    return result;
  }
  return value;
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function identityValue(identity: TopologyIdentity): Record<string, unknown> {
  return {
    issueNumber: identity.issueNumber,
    cycleId: identity.cycleId,
    sourceRevision: identity.sourceRevision,
    stage: identity.stage,
    stageAttemptId: identity.stageAttemptId,
    policyVersion: identity.policyVersion,
  };
}

export function topologyIdentityKey(identity: TopologyIdentity): string {
  return sha256(canonicalJson(identityValue(identity)));
}

export function policyForStage(tier: ReviewTier, stage: ReviewStage): ReviewPolicy {
  if (stage === 'competitive' || stage === 'architectural-review') return 'triple-source/v1';
  return 'single-source/v1';
}

export function defaultRequiredSlots(
  tier: ReviewTier,
  stage: ReviewStage,
  reviewerCardinality: number,
  waiver: ClaudeUnavailableWaiverRef | null = null,
): string[] {
  if (stage === 'architectural-lens' && waiver) return [];
  const count = policyForStage(tier, stage) === 'single-source/v1' ? 1 : reviewerCardinality;
  return Array.from({ length: count }, (_, index) => String(index + 1).padStart(2, '0'));
}

export function isRepresentableCardinality(cardinality: number): boolean {
  return Number.isInteger(cardinality)
    && cardinality > 0
    && cardinality <= MAX_REPRESENTABLE_REVIEWER_CARDINALITY;
}

export function validateTopology(
  topology: ReviewTopology,
  tier?: ReviewTier,
): string[] {
  const errors: string[] = [];
  if (topology.schema !== TOPOLOGY_SCHEMA) errors.push('invalid topology schema');
  if (!Number.isSafeInteger(topology.issueNumber) || topology.issueNumber <= 0) errors.push('invalid issue number');
  for (const [name, value] of Object.entries(identityValue(topology))) {
    if (name !== 'issueNumber' && (typeof value !== 'string' || value.length === 0)) errors.push(`invalid ${name}`);
  }
  if (!topology.cardinalityConfigIdentity || typeof topology.cardinalityConfigIdentity !== 'string') {
    errors.push('invalid cardinality config identity');
  }
  if (!Array.isArray(topology.requiredSlots)) errors.push('required slots must be an array');
  if (topology.claudeUnavailableWaiverRef !== null
    && (!topology.claudeUnavailableWaiverRef || typeof topology.claudeUnavailableWaiverRef !== 'object')) {
    errors.push('invalid-waiver');
  }
  const waiverOnly = topology.stage === 'architectural-lens' && topology.claudeUnavailableWaiverRef !== null;
  if (waiverOnly) {
    if (topology.reviewerCardinality !== 0 || !Array.isArray(topology.requiredSlots) || topology.requiredSlots.length !== 0) {
      errors.push('waiver-only lens must have cardinality 0 and no required slots');
    }
    errors.push(...validateClaudeUnavailableWaiverRef(topology.claudeUnavailableWaiverRef, topology.sourceRevision));
  } else {
    if (!isRepresentableCardinality(topology.reviewerCardinality)) errors.push('cardinality is not representable');
    if (Array.isArray(topology.requiredSlots) && topology.requiredSlots.length * MAX_PART_COUNT > MAX_STAGE_SOURCE_RECORDS) {
      errors.push('topology exceeds stage source record bound');
    }
    if (Array.isArray(topology.requiredSlots)) {
      const expected = [...topology.requiredSlots].sort();
      if (expected.some((slot, index) => slot !== String(index + 1).padStart(2, '0'))) {
        errors.push('required slots are not exact sorted 01..N');
      }
      if (topology.requiredSlots.length !== topology.reviewerCardinality) {
        errors.push('reviewerCardinality does not equal required slot count');
      }
    }
  }
  if (tier && policyForStage(tier, topology.stage) !== topology.policyVersion) {
    errors.push('policy does not match stage');
  }
  return errors;
}

export function buildTopology(
  identity: TopologyIdentity,
  tier: ReviewTier,
  reviewerCardinality: number,
  cardinalityConfigIdentity: string,
  claudeUnavailableWaiverRef: ClaudeUnavailableWaiverRef | null = null,
): ReviewTopology {
  const topology: ReviewTopology = {
    schema: TOPOLOGY_SCHEMA,
    ...identity,
    reviewerCardinality: claudeUnavailableWaiverRef ? 0 : reviewerCardinality,
    cardinalityConfigIdentity,
    requiredSlots: defaultRequiredSlots(tier, identity.stage, reviewerCardinality, claudeUnavailableWaiverRef),
    claudeUnavailableWaiverRef,
  };
  const errors = validateTopology(topology, tier);
  if (errors.length > 0) throw new Error(errors.join('; '));
  return topology;
}

export function topologyPayloadDigest(topology: ReviewTopology): string {
  return sha256(canonicalJson({
    reviewerCardinality: topology.reviewerCardinality,
    cardinalityConfigIdentity: topology.cardinalityConfigIdentity,
    requiredSlots: topology.requiredSlots,
    claudeUnavailableWaiverRef: topology.claudeUnavailableWaiverRef,
  }));
}

export function buildTopologyRecord(topology: ReviewTopology): TopologyRecord {
  const bindingDigest = topologyPayloadDigest(topology);
  const keys = buildRecordKeys(topology, 'topology', 'topology', bindingDigest);
  const marker: ParsedRecordMarker = { schema: RECORD_MARKER_SCHEMA, recordKind: 'topology', eventKey: keys.eventKey, recordKey: keys.recordKey, slotOrRecordKind: 'topology', partIndex: 1, partCount: 1 };
  const payload = { schema: TOPOLOGY_SCHEMA, issueNumber: topology.issueNumber, cycleId: topology.cycleId, sourceRevision: topology.sourceRevision, stage: topology.stage, stageAttemptId: topology.stageAttemptId, policyVersion: topology.policyVersion, reviewerCardinality: topology.reviewerCardinality, cardinalityConfigIdentity: topology.cardinalityConfigIdentity, requiredSlots: topology.requiredSlots, claudeUnavailableWaiverRef: topology.claudeUnavailableWaiverRef, eventKey: keys.eventKey, recordKey: keys.recordKey };
  const body = jsonBody(marker, payload);
  if (Buffer.byteLength(body, 'utf8') > COMMENT_BODY_UTF8_LIMIT) throw new Error('serialized-comment-too-large');
  return { ...topology, eventKey: keys.eventKey, recordKey: keys.recordKey, body };
}

export function parseTopologyRecord(body: string): TopologyRecord | null {
  const marker = parseRecordMarker(body);
  const payload = parseJsonPayload(body);
  if (!marker || marker.recordKind !== 'topology' || marker.slotOrRecordKind !== 'topology' || !payload || payload.schema !== TOPOLOGY_SCHEMA) return null;
  const topology = { schema: TOPOLOGY_SCHEMA, issueNumber: payload.issueNumber, cycleId: payload.cycleId, sourceRevision: payload.sourceRevision, stage: payload.stage, stageAttemptId: payload.stageAttemptId, policyVersion: payload.policyVersion, reviewerCardinality: payload.reviewerCardinality, cardinalityConfigIdentity: payload.cardinalityConfigIdentity, requiredSlots: payload.requiredSlots, claudeUnavailableWaiverRef: payload.claudeUnavailableWaiverRef ?? null } as ReviewTopology;
  if (payload.eventKey !== marker.eventKey || payload.recordKey !== marker.recordKey || validateTopology(topology).length > 0) return null;
  const expected = buildTopologyRecord(topology);
  return expected.body === body ? expected : null;
}

export function buildRecordKeys(
  topology: ReviewTopology,
  recordKind: ParsedRecordMarker['recordKind'],
  slotOrRecordKind: string,
  bindingDigest: string,
  partIndex = 1,
  partCount = 1,
): { eventKey: string; recordKey: string } {
  const eventKey = sha256(canonicalJson({
    schema: 'create-issue-publication-event/v1',
    recordKind,
    ...identityValue(topology),
    reviewerCardinality: topology.reviewerCardinality,
    cardinalityConfigIdentity: topology.cardinalityConfigIdentity,
    slotOrRecordKind,
    bindingDigest,
  }));
  const recordKey = sha256(canonicalJson({
    schema: 'create-issue-publication-record/v1',
    eventKey,
    recordKind,
    slotOrRecordKind,
    partIndex,
    partCount,
  }));
  return { eventKey, recordKey };
}

export function buildRecordMarker(marker: ParsedRecordMarker): string {
  return `<!-- ${RECORD_MARKER_SCHEMA} schema=${marker.recordKind} eventKey=${marker.eventKey} recordKey=${marker.recordKey} slot=${marker.slotOrRecordKind} part=${marker.partIndex}/${marker.partCount} -->`;
}

export function parseRecordMarker(body: string): ParsedRecordMarker | null {
  const match = body.match(/<!--\s*create-issue-review-record\/v1\s+schema=([a-z-]+)\s+eventKey=([a-f0-9]+)\s+recordKey=([a-f0-9]+)\s+slot=([A-Za-z0-9_-]+)\s+part=(\d+)\/(\d+)\s*-->/);
  if (!match) return null;
  const partIndex = Number(match[5]);
  const partCount = Number(match[6]);
  if (!Number.isSafeInteger(partIndex) || !Number.isSafeInteger(partCount) || partIndex < 1 || partIndex > partCount) return null;
  if (!['topology', 'source', 'disposition', 'migration'].includes(match[1]!)) return null;
  return {
    schema: RECORD_MARKER_SCHEMA,
    recordKind: match[1] as ParsedRecordMarker['recordKind'],
    eventKey: match[2]!,
    recordKey: match[3]!,
    slotOrRecordKind: match[4]!,
    partIndex,
    partCount,
  };
}

function jsonBody(marker: ParsedRecordMarker, payload: Record<string, unknown>): string {
  return `${buildRecordMarker(marker)}\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
}

function validateClaudeUnavailableWaiverRef(
  waiver: ClaudeUnavailableWaiverRef | null,
  sourceRevision: string,
): string[] {
  if (!waiver || typeof waiver !== 'object') return ['invalid-waiver'];
  const errors: string[] = [];
  if (waiver.schema !== 'claude-unavailable-waiver/v1') errors.push('invalid-waiver-schema');
  if (!waiver.waiverId || typeof waiver.waiverId !== 'string') errors.push('invalid-waiver-id');
  if (waiver.sourceRevision !== sourceRevision) errors.push('invalid-waiver-revision');
  if (waiver.reason !== 'claude-unavailable') errors.push('invalid-waiver-reason');
  if (waiver.producer !== 'claude-cli') errors.push('invalid-waiver-producer');
  if (!SHA256_RE.test(waiver.digest)) errors.push('invalid-waiver-digest');
  else if (waiver.digest !== sha256(canonicalJson({
    schema: waiver.schema,
    waiverId: waiver.waiverId,
    sourceRevision: waiver.sourceRevision,
    reason: waiver.reason,
    producer: waiver.producer,
  }))) errors.push('invalid-waiver-digest');
  return errors;
}

export function splitRawOutput(rawOutput: string, maxBytes = MAX_RAW_PART_BYTES): Uint8Array[] {
  const bytes = new TextEncoder().encode(rawOutput);
  if (bytes.length === 0) throw new Error('empty-output');
  if (bytes.length > MAX_OUTPUT_UTF8_BYTES) throw new Error('output-too-large');
  const parts: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += maxBytes) {
    parts.push(bytes.slice(offset, Math.min(bytes.length, offset + maxBytes)));
  }
  if (parts.length > MAX_PART_COUNT) throw new Error('too-many-parts');
  return parts;
}

export function buildSourceRecords(topology: ReviewTopology, slot: string, rawOutput: string): SourceRecord[] {
  if (!topology.requiredSlots.includes(slot)) throw new Error('invalid-identity');
  if (!rawOutput) throw new Error('empty-output');
  const bytes = new TextEncoder().encode(rawOutput);
  if (bytes.length === 0) throw new Error('empty-output');
  if (bytes.length > MAX_OUTPUT_UTF8_BYTES) throw new Error('output-too-large');
  const parts = splitRawOutput(rawOutput);
  const outputId = sha256(bytes);
  return parts.map((part, index) => {
    const partIndex = index + 1;
    const byteOffset = parts.slice(0, index).reduce((sum, item) => sum + item.byteLength, 0);
    const keys = buildRecordKeys(topology, 'source', slot, outputId, partIndex, parts.length);
    const marker: ParsedRecordMarker = {
      schema: RECORD_MARKER_SCHEMA,
      recordKind: 'source',
      eventKey: keys.eventKey,
      recordKey: keys.recordKey,
      slotOrRecordKind: slot,
      partIndex,
      partCount: parts.length,
    };
    const payload = {
      schema: SOURCE_SCHEMA,
      issueNumber: topology.issueNumber,
      cycleId: topology.cycleId,
      sourceRevision: topology.sourceRevision,
      stage: topology.stage,
      stageAttemptId: topology.stageAttemptId,
      policyVersion: topology.policyVersion,
      reviewerCardinality: topology.reviewerCardinality,
      cardinalityConfigIdentity: topology.cardinalityConfigIdentity,
      slot,
      outputId,
      eventKey: keys.eventKey,
      recordKey: keys.recordKey,
      partIndex,
      partCount: parts.length,
      byteOffset,
      byteLength: part.byteLength,
      totalByteLength: bytes.byteLength,
      partSha256: sha256(part),
      rawOutputPartBase64: Buffer.from(part).toString('base64'),
    };
    const body = jsonBody(marker, payload);
    if (Buffer.byteLength(body, 'utf8') > COMMENT_BODY_UTF8_LIMIT) throw new Error('serialized-comment-too-large');
    return { ...topology, ...payload, body } as SourceRecord;
  });
}

function parseJsonPayload(body: string): Record<string, unknown> | null {
  const match = body.match(/```json\s*([\s\S]*?)\s*```/i);
  if (!match) return null;
  try {
    const value = JSON.parse(match[1] ?? '');
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function parseSourceRecord(body: string): SourceRecord | null {
  const marker = parseRecordMarker(body);
  const payload = parseJsonPayload(body);
  if (!marker || marker.recordKind !== 'source' || !payload || payload.schema !== SOURCE_SCHEMA) return null;
  const required = ['issueNumber', 'cycleId', 'sourceRevision', 'stage', 'stageAttemptId', 'policyVersion', 'slot', 'outputId', 'eventKey', 'recordKey', 'partIndex', 'partCount', 'byteOffset', 'byteLength', 'totalByteLength', 'partSha256', 'rawOutputPartBase64'];
  if (required.some((key) => payload[key] === undefined)) return null;
  if (payload.eventKey !== marker.eventKey || payload.recordKey !== marker.recordKey || payload.slot !== marker.slotOrRecordKind) return null;
  if (payload.partIndex !== marker.partIndex || payload.partCount !== marker.partCount) return null;
  if (typeof payload.rawOutputPartBase64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload.rawOutputPartBase64)) return null;
  try {
    const bytes = Buffer.from(payload.rawOutputPartBase64, 'base64');
    if (bytes.toString('base64') !== payload.rawOutputPartBase64) return null;
  } catch {
    return null;
  }
  return { ...payload, body } as unknown as SourceRecord;
}

function sourceRecordBindingError(topology: ReviewTopology, record: SourceRecord): PublicationConflictReason | null {
  if (!topology.requiredSlots.includes(record.slot)
    || !Number.isInteger(record.partIndex) || record.partIndex < 1
    || !Number.isInteger(record.partCount) || record.partCount < 1
    || !Number.isInteger(record.byteOffset) || record.byteOffset < 0
    || !Number.isInteger(record.byteLength) || record.byteLength < 1
    || !Number.isInteger(record.totalByteLength) || record.totalByteLength < record.byteLength
    || !SHA256_RE.test(record.outputId) || !SHA256_RE.test(record.partSha256)) {
    return 'incompatible-identity';
  }
  const keys = buildRecordKeys(topology, 'source', record.slot, record.outputId, record.partIndex, record.partCount);
  if (record.eventKey !== keys.eventKey || record.recordKey !== keys.recordKey) return 'incompatible-identity';
  const bytes = Buffer.from(record.rawOutputPartBase64, 'base64');
  if (bytes.byteLength !== record.byteLength || sha256(bytes) !== record.partSha256) return 'malformed-payload';
  const expectedBody = jsonBody({
    schema: RECORD_MARKER_SCHEMA,
    recordKind: 'source',
    eventKey: keys.eventKey,
    recordKey: keys.recordKey,
    slotOrRecordKind: record.slot,
    partIndex: record.partIndex,
    partCount: record.partCount,
  }, {
    schema: SOURCE_SCHEMA,
    issueNumber: record.issueNumber,
    cycleId: record.cycleId,
    sourceRevision: record.sourceRevision,
    stage: record.stage,
    stageAttemptId: record.stageAttemptId,
    policyVersion: record.policyVersion,
    reviewerCardinality: record.reviewerCardinality,
    cardinalityConfigIdentity: record.cardinalityConfigIdentity,
    slot: record.slot,
    outputId: record.outputId,
    eventKey: keys.eventKey,
    recordKey: keys.recordKey,
    partIndex: record.partIndex,
    partCount: record.partCount,
    byteOffset: record.byteOffset,
    byteLength: record.byteLength,
    totalByteLength: record.totalByteLength,
    partSha256: record.partSha256,
    rawOutputPartBase64: record.rawOutputPartBase64,
  });
  return record.body === expectedBody ? null : 'incompatible-identity';
}

export function assembleSourceRecords(
  topology: ReviewTopology,
  records: readonly SourceRecord[],
  slot: string,
): AssembledSourceOutput {
  const matching = records.filter((record) => record.slot === slot);
  if (matching.length === 0) throw new Error('missing-raw-bytes');
  const first = matching[0]!;
  if (matching.some((record) => record.partCount !== first.partCount || record.outputId !== first.outputId)) {
    throw new Error('part-count-mismatch');
  }
  const sorted = [...matching].sort((a, b) => a.partIndex - b.partIndex);
  if (sorted.length !== first.partCount) throw new Error('missing-raw-bytes');
  const chunks: Uint8Array[] = [];
  let expectedOffset = 0;
  for (const record of sorted) {
    if (record.partIndex !== chunks.length + 1) throw new Error('part-offset-mismatch');
    if (record.byteOffset !== expectedOffset) throw new Error('part-offset-mismatch');
    let bytes: Uint8Array;
    try {
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(record.rawOutputPartBase64)) throw new Error();
      bytes = new Uint8Array(Buffer.from(record.rawOutputPartBase64, 'base64'));
    } catch {
      throw new Error('invalid-base64');
    }
    if (bytes.byteLength !== record.byteLength) throw new Error('part-length-mismatch');
    if (sha256(bytes) !== record.partSha256) throw new Error('part-hash-mismatch');
    chunks.push(bytes);
    expectedOffset += bytes.byteLength;
  }
  const rawBytes = new Uint8Array(expectedOffset);
  let offset = 0;
  for (const chunk of chunks) { rawBytes.set(chunk, offset); offset += chunk.byteLength; }
  if (rawBytes.byteLength !== first.totalByteLength) throw new Error('assembled-length-mismatch');
  if (sha256(rawBytes) !== first.outputId) throw new Error('output-id-mismatch');
  const rawOutput = new TextDecoder('utf-8', { fatal: true }).decode(rawBytes);
  if (topology.requiredSlots.includes(slot) === false) throw new Error('extra-slot');
  return { rawOutput, rawBytes, outputId: first.outputId, records: sorted };
}

export function deriveAdmission(
  topology: ReviewTopology,
  lifecycle: LifecycleBinding,
  records: readonly SourceRecord[],
): AdmissionResult {
  const topologyErrors = validateTopology(topology);
  if (topologyErrors.length > 0) return { state: 'terminal-publication-conflict', reasons: ['incompatible-identity'], sourceRecords: [] };
  if (lifecycle.cycleId !== topology.cycleId || lifecycle.stageAttemptId !== topology.stageAttemptId || lifecycle.sourceRevision !== topology.sourceRevision) {
    return { state: lifecycle.state === 'cancelled' ? 'cancelled' : 'terminal-publication-conflict', reasons: ['stale-active-attempt'], sourceRecords: [] };
  }
  if (lifecycle.state === 'cancelled') return { state: 'cancelled', reasons: [], sourceRecords: [] };
  if (lifecycle.state === 'superseded') return { state: 'superseded', reasons: [], sourceRecords: [] };
  if (topology.claudeUnavailableWaiverRef) {
    if (topology.stage !== 'architectural-lens' || records.length > 0) return { state: 'terminal-publication-conflict', reasons: ['invalid-waiver'], sourceRecords: records.slice() };
    return { state: 'waived-not-required', reasons: [], sourceRecords: [] };
  }
  if (records.length === 0) return { state: 'pending-publication', reasons: ['missing-raw-bytes'], sourceRecords: [] };
  const seenKeys = new Map<string, SourceRecord>();
  for (const record of records) {
    const bindingError = sourceRecordBindingError(topology, record);
    if (bindingError) return { state: 'terminal-publication-conflict', reasons: [bindingError], sourceRecords: records.slice() };
    const prior = seenKeys.get(record.recordKey);
    if (prior && prior.body !== record.body) return { state: 'terminal-publication-conflict', reasons: ['duplicate-conflicting'], sourceRecords: records.slice() };
    seenKeys.set(record.recordKey, record);
  }
  const canonicalRecords = [...seenKeys.values()];
  if (canonicalRecords.some((record) => record.issueNumber !== topology.issueNumber || record.cycleId !== topology.cycleId || record.sourceRevision !== topology.sourceRevision || record.stage !== topology.stage || record.stageAttemptId !== topology.stageAttemptId || record.policyVersion !== topology.policyVersion || record.reviewerCardinality !== topology.reviewerCardinality || record.cardinalityConfigIdentity !== topology.cardinalityConfigIdentity)) {
    return { state: 'terminal-publication-conflict', reasons: ['incompatible-identity'], sourceRecords: canonicalRecords.slice() };
  }
  const admitted: SourceRecord[] = [];
  let output: AssembledSourceOutput | undefined;
  for (const slot of topology.requiredSlots) {
    const slotRecords = canonicalRecords.filter((record) => record.slot === slot);
    try {
      const assembled = assembleSourceRecords(topology, slotRecords, slot);
      admitted.push(...assembled.records);
      output ??= assembled;
    } catch (error) {
      const reason = String(error instanceof Error ? error.message : error);
      const known = PUBLICATION_CONFLICT_REASONS.includes(reason as PublicationConflictReason)
        ? reason as PublicationConflictReason
        : 'malformed-payload';
      return { state: 'terminal-publication-conflict', reasons: [known], sourceRecords: canonicalRecords.slice() };
    }
  }
  if (canonicalRecords.some((record) => !topology.requiredSlots.includes(record.slot))) {
    return { state: 'terminal-publication-conflict', reasons: ['extra-slot'], sourceRecords: canonicalRecords.slice() };
  }
  return { state: 'admitted', reasons: [], sourceRecords: admitted, output };
}

export function buildAuthorDisposition(
  topology: ReviewTopology,
  admission: AdmissionResult,
  input: AuthorDispositionInput,
): AuthorDisposition {
  if (admission.state !== 'admitted' || !admission.output) throw new Error('disposition requires admitted source records');
  if (input.settlement !== 'settled' || input.unresolvedOccurrenceIds.length > 0) throw new Error('unresolved disposition');
  const sourceRecordKeys = admission.sourceRecords.map((record) => record.recordKey).sort();
  const outputIds = [...new Set(admission.sourceRecords.map((record) => record.outputId))].sort();
  const topologyKeys = buildRecordKeys(topology, 'topology', 'topology', topologyPayloadDigest(topology));
  const binding = {
    ...identityValue(topology),
    topologyEventKey: topologyKeys.eventKey,
    topologyRecordKey: topologyKeys.recordKey,
    sourceRecordKeys,
    outputIds,
    occurrenceIds: [...input.occurrenceIds].sort(),
  };
  const eventKey = sha256(canonicalJson({ schema: DISPOSITION_SCHEMA, ...binding }));
  const recordKey = sha256(canonicalJson({ schema: 'create-issue-publication-record/v1', eventKey, recordKind: 'disposition', slotOrRecordKind: 'disposition', partIndex: 1, partCount: 1 }));
  const marker = buildRecordMarker({ schema: RECORD_MARKER_SCHEMA, recordKind: 'disposition', eventKey, recordKey, slotOrRecordKind: 'disposition', partIndex: 1, partCount: 1 });
  const payload = { schema: DISPOSITION_SCHEMA, ...binding, ...input, eventKey, recordKey };
  return { ...topology, ...payload, body: jsonBody({ schema: RECORD_MARKER_SCHEMA, recordKind: 'disposition', eventKey, recordKey, slotOrRecordKind: 'disposition', partIndex: 1, partCount: 1 }, payload) } as AuthorDisposition;
}


export interface RemoteAuthorityInput {
  topology: ReviewTopology | null;
  lifecycle: LifecycleBinding | null;
  sourceRecords: readonly SourceRecord[];
  disposition: AuthorDisposition | null;
  waiverAuthority?: ClaudeUnavailableWaiverRef | null;
}

export interface RemoteAuthorityResult { ok: boolean; errors: string[]; admission: AdmissionResult | null; }

export function checkRemoteAuthority(input: RemoteAuthorityInput): RemoteAuthorityResult {
  if (!input.topology) return { ok: false, errors: ['missing-topology'], admission: null };
  if (!input.lifecycle) return { ok: false, errors: ['stale-active-attempt'], admission: null };
  const topologyErrors = validateTopology(input.topology);
  if (topologyErrors.length > 0) return { ok: false, errors: topologyErrors, admission: null };
  const admission = deriveAdmission(input.topology, input.lifecycle, input.sourceRecords);
  const errors: string[] = admission.reasons.slice();
  if (admission.state !== 'admitted' && admission.state !== 'waived-not-required') errors.push(admission.state);
  if (admission.state === 'admitted') {
    errors.push(...validateAuthorDisposition(input.topology, admission, input.disposition));
  } else if (admission.state === 'waived-not-required') {
    const waiver = input.topology.claudeUnavailableWaiverRef;
    const authority = input.waiverAuthority;
    if (!authority) errors.push('waiver-authority-required');
    else if (canonicalJson(authority) !== canonicalJson(waiver)) errors.push('invalid-waiver-authority');
    else errors.push(...validateClaudeUnavailableWaiverRef(authority, input.topology.sourceRevision));
  }
  return { ok: errors.length === 0, errors, admission };
}

export function classifyRecordBody(body: string): PublicationConflictReason | null {
  const marker = parseRecordMarker(body);
  if (!marker) return null;
  if (parseSourceRecord(body) === null && marker.recordKind === 'source') return 'malformed-payload';
  return null;
}

export function foldSourceRecordBodies(topology: ReviewTopology, bodies: readonly string[]): { records: SourceRecord[]; conflicts: PublicationConflictReason[] } {
  const records: SourceRecord[] = [];
  const conflicts: PublicationConflictReason[] = [];
  const byKey = new Map<string, SourceRecord>();
  for (const body of bodies) {
    const marker = parseRecordMarker(body);
    if (!marker || marker.recordKind !== 'source') continue;
    const parsed = parseSourceRecord(body);
    if (!parsed) { conflicts.push('malformed-payload'); continue; }
    const bindingError = sourceRecordBindingError(topology, parsed);
    if (bindingError) { conflicts.push(bindingError); continue; }
    if (parsed.issueNumber !== topology.issueNumber || parsed.cycleId !== topology.cycleId || parsed.sourceRevision !== topology.sourceRevision || parsed.stageAttemptId !== topology.stageAttemptId || parsed.policyVersion !== topology.policyVersion || parsed.reviewerCardinality !== topology.reviewerCardinality || parsed.cardinalityConfigIdentity !== topology.cardinalityConfigIdentity) { conflicts.push('incompatible-identity'); continue; }
    const prior = byKey.get(parsed.recordKey);
    if (prior) { if (prior.body !== parsed.body) conflicts.push('duplicate-conflicting'); continue; }
    byKey.set(parsed.recordKey, parsed); records.push(parsed);
  }
  return { records, conflicts };
}

export function validateAuthorDisposition(topology: ReviewTopology, admission: AdmissionResult, disposition: AuthorDisposition | null): string[] {
  const errors: string[] = [];
  if (admission.state !== 'admitted') errors.push('disposition-before-admission');
  if (!disposition || disposition.schema !== DISPOSITION_SCHEMA) return [...errors, 'missing-disposition'];
  if (disposition.issueNumber !== topology.issueNumber || disposition.cycleId !== topology.cycleId || disposition.sourceRevision !== topology.sourceRevision || disposition.stageAttemptId !== topology.stageAttemptId || disposition.stage !== topology.stage || disposition.policyVersion !== topology.policyVersion) errors.push('stale-active-attempt');
  const topologyKeys = buildRecordKeys(topology, 'topology', 'topology', topologyPayloadDigest(topology));
  if (disposition.topologyEventKey !== topologyKeys.eventKey || disposition.topologyRecordKey !== topologyKeys.recordKey) errors.push('incompatible-identity');
  const expectedSourceKeys = admission.sourceRecords.map((record) => record.recordKey).sort();
  const expectedOutputIds = [...new Set(admission.sourceRecords.map((record) => record.outputId))].sort();
  if (!Array.isArray(disposition.sourceRecordKeys) || canonicalJson(disposition.sourceRecordKeys) !== canonicalJson(expectedSourceKeys)) errors.push('incompatible-identity');
  if (!Array.isArray(disposition.outputIds) || canonicalJson(disposition.outputIds) !== canonicalJson(expectedOutputIds)) errors.push('incompatible-identity');
  if (!Array.isArray(disposition.occurrenceIds) || new Set(disposition.occurrenceIds).size !== disposition.occurrenceIds.length || disposition.occurrenceIds.some((id) => typeof id !== 'string' || id.length === 0)) errors.push('incomplete-disposition');
  const defects = Array.isArray(disposition.distinctDefects) ? disposition.distinctDefects : [];
  const defectIds = defects.map((item) => item?.defectId);
  if (!Array.isArray(disposition.distinctDefects) || defectIds.some((id) => typeof id !== 'string' || id.length === 0) || new Set(defectIds).size !== defectIds.length) errors.push('incomplete-disposition');
  const coveredOccurrences = defects.flatMap((item) => Array.isArray(item?.occurrenceIds) ? item.occurrenceIds : []);
  if (coveredOccurrences.some((id) => typeof id !== 'string' || id.length === 0) || new Set(coveredOccurrences).size !== coveredOccurrences.length || canonicalJson([...coveredOccurrences].sort()) !== canonicalJson([...(disposition.occurrenceIds ?? [])].sort())) errors.push('incomplete-disposition');
  const dispositions = Array.isArray(disposition.defectDispositions) ? disposition.defectDispositions : [];
  const remedies = Array.isArray(disposition.remedyDispositions) ? disposition.remedyDispositions : [];
  if (dispositions.length !== defectIds.length || remedies.length !== defectIds.length) errors.push('incomplete-disposition');
  if (new Set(dispositions.map((item) => item?.defectId)).size !== dispositions.length || dispositions.some((item) => !defectIds.includes(item?.defectId) || item.disposition === 'unresolved')) errors.push('unresolved-disposition');
  if (new Set(remedies.map((item) => item?.defectId)).size !== remedies.length || remedies.some((item) => !defectIds.includes(item?.defectId))) errors.push('incomplete-disposition');
  if (!['keep', 'simplify', 'defer', 'cut'].includes(disposition.m4) || disposition.settlement !== 'settled' || !Array.isArray(disposition.unresolvedOccurrenceIds) || disposition.unresolvedOccurrenceIds.length > 0) errors.push('unresolved-disposition');
  if (errors.length === 0) {
    try {
      const expected = buildAuthorDisposition(topology, admission, {
        occurrenceIds: disposition.occurrenceIds,
        distinctDefects: disposition.distinctDefects,
        defectDispositions: disposition.defectDispositions,
        remedyDispositions: disposition.remedyDispositions,
        m4: disposition.m4,
        unresolvedOccurrenceIds: disposition.unresolvedOccurrenceIds,
        settlement: disposition.settlement,
      });
      if (disposition.eventKey !== expected.eventKey || disposition.recordKey !== expected.recordKey || disposition.body !== expected.body) errors.push('incompatible-identity');
    } catch {
      errors.push('incomplete-disposition');
    }
  }
  return errors;
}

export function parseAuthorDisposition(body: string): AuthorDisposition | null {
  const marker = parseRecordMarker(body);
  const payload = parseJsonPayload(body);
  if (!marker || marker.recordKind !== 'disposition' || marker.slotOrRecordKind !== 'disposition' || marker.partIndex !== 1 || marker.partCount !== 1 || !payload || payload.schema !== DISPOSITION_SCHEMA) return null;
  if (payload.eventKey !== marker.eventKey || payload.recordKey !== marker.recordKey) return null;
  return { ...payload, body } as unknown as AuthorDisposition;
}

export function checkRemoteAuthorities(inputs: readonly RemoteAuthorityInput[]): RemoteAuthorityResult {
  const results = inputs.map((input) => checkRemoteAuthority(input));
  const errors = results.flatMap((result) => result.errors);
  return { ok: errors.length === 0, errors, admission: results.at(-1)?.admission ?? null };
}

export function validateActualStageRecordBound(actualAttemptSourceRecordCount: number, newPartCount: number): ProducerReason | null {
  if (!Number.isInteger(actualAttemptSourceRecordCount) || actualAttemptSourceRecordCount < 0 || !Number.isInteger(newPartCount) || newPartCount < 1) return 'invalid-identity';
  return actualAttemptSourceRecordCount + newPartCount > MAX_STAGE_SOURCE_RECORDS ? 'too-many-stage-records' : null;
}
