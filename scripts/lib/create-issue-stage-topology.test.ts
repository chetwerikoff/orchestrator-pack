import { describe, expect, it } from 'vitest';
import {
  ADMISSION_STATES,
  MAX_PART_COUNT,
  MAX_REPRESENTABLE_REVIEWER_CARDINALITY,
  MAX_STAGE_SOURCE_RECORDS,
  buildSourceRecords,
  buildTopology,
  canonicalJson,
  deriveAdmission,
  buildAuthorDisposition,
  validateAuthorDisposition,
  checkRemoteAuthority,
  validateTopology,
  sha256,
  parseRecordMarker,
  parseSourceRecord,
  splitRawOutput,
  type LifecycleBinding,
} from './create-issue-stage-topology.ts';

const identity = {
  issueNumber: 1200,
  cycleId: 'cycle-1',
  sourceRevision: 'r15',
  stage: 'competitive' as const,
  stageAttemptId: 'attempt-1',
  policyVersion: 'triple-source/v1' as const,
};

function topology(cardinality = 3) {
  return buildTopology(identity, 'T3', cardinality, 'env:OPK_GPT_REVIEWER_CARDINALITY');
}

const active: LifecycleBinding = {
  state: 'active',
  cycleId: identity.cycleId,
  stageAttemptId: identity.stageAttemptId,
  sourceRevision: identity.sourceRevision,
};

describe('create-issue remote review topology', () => {
  it('uses stable canonical JSON and exact representability bounds', () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(MAX_REPRESENTABLE_REVIEWER_CARDINALITY * MAX_PART_COUNT).toBe(MAX_STAGE_SOURCE_RECORDS);
    expect(() => topology(MAX_REPRESENTABLE_REVIEWER_CARDINALITY)).not.toThrow();
    expect(() => topology(MAX_REPRESENTABLE_REVIEWER_CARDINALITY + 1)).toThrow(/not representable|bound/);
  });

  it('assembles exact bytes, including Unicode and embedded NUL', () => {
    const raw = `LF\nCRLF\r\nNUL\0 combining e\u0301 astral \u{1F680}`;
    const records = ['01', '02', '03'].flatMap((slot) => buildSourceRecords(topology(), slot, raw));
    expect(records).toHaveLength(3);
    const parsed = records.map((record) => parseSourceRecord(record.body)).filter(Boolean);
    const admission = deriveAdmission(topology(), active, parsed as typeof records);
    expect(admission.state).toBe('admitted');
    expect(admission.output?.rawOutput).toBe(raw);
    expect(admission.output?.outputId).toBe(records[0]!.outputId);
  });

  it('makes the outer marker independently parseable and rejects altered part identity', () => {
    const record = buildSourceRecords(topology(), '01', 'x')[0]!;
    const marker = parseRecordMarker(record.body);
    expect(marker).toMatchObject({ recordKind: 'source', slotOrRecordKind: '01', partIndex: 1, partCount: 1 });
    const altered = record.body.replace('part=1/1', 'part=2/1');
    expect(parseSourceRecord(altered)).toBeNull();
  });

  it('keeps cancelled and superseded attempts historical', () => {
    const records = buildSourceRecords(topology(), '01', 'done');
    expect(deriveAdmission(topology(), { ...active, state: 'cancelled' }, records).state).toBe('cancelled');
    expect(deriveAdmission(topology(), { ...active, state: 'superseded' }, records).state).toBe('superseded');
  });

  it('exposes a closed admission algebra and does not credit missing sources', () => {
    expect(ADMISSION_STATES).toContain('pending-publication');
    expect(deriveAdmission(topology(), active, []).state).toBe('pending-publication');
  });

  it('does not admit a source from an unrequired slot', () => {
    const records = buildSourceRecords(topology(), '01', 'done');
    const altered = records.map((record) => ({ ...record, slot: '04' }));
    expect(deriveAdmission(topology(), active, altered).state).toBe('terminal-publication-conflict');
  });

  it('binds disposition/M4 to the exact admitted source set', () => {
    const single = buildTopology({
      ...identity,
      stage: 'architectural',
      policyVersion: 'single-source/v1',
    }, 'T2', 1, 'env:OPK_GPT_REVIEWER_CARDINALITY');
    const records = buildSourceRecords(single, '01', 'review');
    const admission = deriveAdmission(single, { ...active }, records);
    const disposition = buildAuthorDisposition(single, admission, {
      occurrenceIds: [],
      distinctDefects: [],
      defectDispositions: [],
      remedyDispositions: [],
      m4: 'keep',
      unresolvedOccurrenceIds: [],
      settlement: 'settled',
    });
    expect(validateAuthorDisposition(single, admission, disposition)).toEqual([]);
    expect(validateAuthorDisposition(single, { ...admission, sourceRecords: [] }, disposition)).toContain('incompatible-identity');
  });

  it('requires a complete disposition in the default remote authority path', () => {
    const single = buildTopology({
      ...identity,
      stage: 'architectural',
      policyVersion: 'single-source/v1',
    }, 'T2', 1, 'env:OPK_GPT_REVIEWER_CARDINALITY');
    const records = buildSourceRecords(single, '01', 'review');
    const admission = deriveAdmission(single, active, records);
    const missing = checkRemoteAuthority({
      topology: single,
      lifecycle: active,
      sourceRecords: records,
      disposition: null,
    });
    expect(missing.ok).toBe(false);
    expect(missing.errors).toContain('missing-disposition');
    const disposition = buildAuthorDisposition(single, admission, {
      occurrenceIds: [],
      distinctDefects: [],
      defectDispositions: [],
      remedyDispositions: [],
      m4: 'keep',
      unresolvedOccurrenceIds: [],
      settlement: 'settled',
    });
    expect(checkRemoteAuthority({
      topology: single,
      lifecycle: active,
      sourceRecords: records,
      disposition,
    }).ok).toBe(true);
  });

  it('rejects a source record whose identity or canonical body was edited', () => {
    const records = buildSourceRecords(topology(), '01', 'review');
    const altered = { ...records[0]!, recordKey: 'f'.repeat(64) };
    const result = deriveAdmission(topology(), active, [altered]);
    expect(result.state).toBe('terminal-publication-conflict');
    expect(result.reasons).toContain('incompatible-identity');
  });

  it('rejects incomplete or edited remote disposition data', () => {
    const single = buildTopology({
      ...identity,
      stage: 'architectural',
      policyVersion: 'single-source/v1',
    }, 'T2', 1, 'env:OPK_GPT_REVIEWER_CARDINALITY');
    const records = buildSourceRecords(single, '01', 'review');
    const admission = deriveAdmission(single, active, records);
    const disposition = buildAuthorDisposition(single, admission, {
      occurrenceIds: ['O1'],
      distinctDefects: [{ defectId: 'D1', occurrenceIds: ['O1'] }],
      defectDispositions: [{ defectId: 'D1', disposition: 'addressed' }],
      remedyDispositions: [{ defectId: 'D1', disposition: 'accepted' }],
      m4: 'keep',
      unresolvedOccurrenceIds: [],
      settlement: 'settled',
    });
    expect(validateAuthorDisposition(single, admission, { ...disposition, body: disposition.body.replace('"m4": "keep"', '"m4": "cut"') })).toContain('incompatible-identity');
    expect(validateAuthorDisposition(single, admission, { ...disposition, remedyDispositions: [] })).toContain('incomplete-disposition');
  });

  it('requires and verifies the complete Claude-unavailable waiver authority', () => {
    const waiver = {
      schema: 'claude-unavailable-waiver/v1' as const,
      waiverId: 'waiver-1',
      sourceRevision: identity.sourceRevision,
      reason: 'claude-unavailable',
      producer: 'claude-cli',
      digest: '',
    };
    waiver.digest = sha256(canonicalJson({
      schema: waiver.schema,
      waiverId: waiver.waiverId,
      sourceRevision: waiver.sourceRevision,
      reason: waiver.reason,
      producer: waiver.producer,
    }));
    const lens = buildTopology({
      ...identity,
      stage: 'architectural-lens',
      policyVersion: 'single-source/v1',
    }, 'T3', 1, 'env:OPK_GPT_REVIEWER_CARDINALITY', waiver);
    const noAuthority = checkRemoteAuthority({
      topology: lens,
      lifecycle: active,
      sourceRecords: [],
      disposition: null,
    });
    expect(noAuthority.ok).toBe(false);
    expect(noAuthority.errors).toContain('waiver-authority-required');
    expect(checkRemoteAuthority({
      topology: lens,
      lifecycle: active,
      sourceRecords: [],
      disposition: null,
      waiverAuthority: waiver,
    }).ok).toBe(true);
    expect(checkRemoteAuthority({
      topology: lens,
      lifecycle: active,
      sourceRecords: [],
      disposition: null,
      waiverAuthority: { ...waiver, sourceRevision: 'r14' },
    }).ok).toBe(false);
  });

  it('turns malformed topology payloads into validation errors instead of throwing', () => {
    expect(() => validateTopology({ ...topology(), requiredSlots: null as unknown as string[] })).not.toThrow();
    expect(validateTopology({ ...topology(), requiredSlots: null as unknown as string[] })).toContain('required slots must be an array');
  });

  it('splits and reassembles at byte boundaries without changing the output', () => {
    const raw = '🚀'.repeat(20_000);
    const parts = splitRawOutput(raw, 32_000);
    expect(parts.length).toBeGreaterThan(1);
    const rebuilt = Buffer.concat(parts.map((part) => Buffer.from(part))).toString('utf8');
    expect(rebuilt).toBe(raw);
  });
});
