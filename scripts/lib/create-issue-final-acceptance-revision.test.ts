import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseCanonicalSourceRevisionMarker,
  validateFinalAcceptanceReadbackHead,
  validateCanonicalReceiptPathSet,
} from './create-issue-final-acceptance.ts';
import { buildCanonicalLineage } from './create-issue-stage-record-lineage.ts';
import { validateHistoricalReceiptsAgainstLineage } from './create-issue-stage-record-receipt.ts';
import {
  CYCLE_SCHEMA,
  STAGE_SCHEMA,
  type CycleEventLogical,
  type JournalLogical,
  type ParsedJournalEvent,
  type StageEventLogical,
} from './create-issue-stage-record-types.ts';
import { logicalFingerprint } from './create-issue-stage-record-marker.ts';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function journalEvent(logical: JournalLogical, commentId: number, createdAt: string): ParsedJournalEvent {
  return {
    schema: logical.schema,
    eventKey: logical['event-key'],
    logical,
    fingerprint: logicalFingerprint(logical),
    commentId,
    createdAt,
  };
}

function cycle(
  cycleId: string,
  predecessor: string,
  sourceRevision: string,
  commentId: number,
): ParsedJournalEvent {
  const logical: CycleEventLogical = {
    schema: CYCLE_SCHEMA,
    'event-key': cycleId,
    'cycle-id': cycleId,
    'predecessor-cycle-id': predecessor,
    'source-revision': sourceRevision,
    tier: 'T3',
    'public-actor': 'cursor-flow-manager',
  };
  return journalEvent(logical, commentId, `2026-08-02T00:0${commentId}:00.000Z`);
}

function receipt(
  cycleId: string,
  sourceRevision: string,
  stageSequence: number,
  stage: 'competitive' | 'architectural-review' | 'architectural-lens' | 'architectural',
  outcome: 'complete' | 'partial' = 'complete',
): Record<string, unknown> {
  const stageAttemptId = `attempt-${stageSequence}`;
  const reviewEpisodeId = '1202@r09';
  const stageReceiptId = `${reviewEpisodeId}:stage-receipt:${String(stageSequence).padStart(4, '0')}`;
  return {
    schema: 'stage-completeness-receipt/v1',
    tier: 'T3',
    taskIdentity: '1202',
    episodeFirstRevision: 'r09',
    reviewEpisodeId,
    stageReceiptId,
    previousStageReceiptId: stageSequence === 1
      ? null
      : `${reviewEpisodeId}:stage-receipt:${String(stageSequence - 1).padStart(4, '0')}`,
    receiptCensus: Array.from({ length: stageSequence }, (_, index) => (
      `${reviewEpisodeId}:stage-receipt:${String(index + 1).padStart(4, '0')}`
    )),
    stageAttemptId,
    stageSequence,
    stage,
    cycleId,
    cycleBinding: { cycleId, sourceRevision, boundBeforeLaunch: true },
    policyVersion: 'single-source/v1',
    reviewerCardinality: 1,
    completedSourceCount: 1,
    sourceRevision,
    outcome,
    producerEvidence: 'not-applicable',
    tierTransition: 'none',
  };
}

function stageEvent(value: Record<string, unknown>): ParsedJournalEvent {
  const logical: StageEventLogical = {
    schema: STAGE_SCHEMA,
    'event-key': `${String(value.cycleId)}:${String(value.stage)}:${String(value.stageAttemptId)}`,
    'cycle-id': String(value.cycleId),
    stage: String(value.stage),
    tier: String(value.tier),
    'source-revision': String(value.sourceRevision),
    'stage-attempt-id': String(value.stageAttemptId),
    'policy-version': String(value.policyVersion) as StageEventLogical['policy-version'],
    'settled-outcome': String(value.outcome) as StageEventLogical['settled-outcome'],
    'source-count': Number(value.completedSourceCount),
    'required-source-count': Number(value.reviewerCardinality),
    'producer-evidence': String(value.producerEvidence) as StageEventLogical['producer-evidence'],
    'tier-transition': String(value.tierTransition),
  };
  return journalEvent(logical, Number(value.stageSequence) + 10, `2026-08-02T01:0${String(value.stageSequence)}:00.000Z`);
}

function validHistoricalInput(): {
  receipts: Record<string, unknown>[];
  lineage: ReturnType<typeof buildCanonicalLineage>;
} {
  const receipts = [
    receipt('cycle-r09', 'r09', 1, 'competitive'),
    receipt('cycle-r10', 'r10', 2, 'architectural-review'),
    receipt('cycle-r100', 'r100', 3, 'architectural-lens'),
    receipt('cycle-r100', 'r100', 4, 'architectural'),
  ];
  const events = [
    cycle('cycle-r09', 'none', 'r09', 1),
    cycle('cycle-r10', 'cycle-r09', 'r10', 2),
    cycle('cycle-r100', 'cycle-r10', 'r100', 3),
    ...receipts.map(stageEvent),
  ];
  return { receipts, lineage: buildCanonicalLineage(events) };
}

describe('revision-aware final acceptance', () => {
  it('accepts opaque historical revisions on one canonical predecessor lineage', () => {
    const input = validHistoricalInput();
    const errors = validateHistoricalReceiptsAgainstLineage({
      receiptValues: input.receipts,
      receiptPaths: input.receipts.map((_, index) => `/canonical/receipt-${index + 1}.json`),
      cycleId: 'cycle-r100',
      issueRevision: 'r100',
      lineage: input.lineage,
    });

    expect(errors).toEqual([]);
  });

  it('rejects a receipt from an unrelated cycle and names its evidence', () => {
    const input = validHistoricalInput();
    const foreign = receipt('foreign-cycle', 'r09', 2, 'architectural-review');
    input.receipts[1] = foreign;
    input.lineage = buildCanonicalLineage([
      ...input.lineage.eventsByKey.values(),
      stageEvent(foreign),
      cycle('foreign-cycle', 'none', 'r09', 20),
    ]);

    const errors = validateHistoricalReceiptsAgainstLineage({
      receiptValues: input.receipts,
      receiptPaths: ['competitive.json', 'foreign-review.json', 'lens.json', 'terminal.json'],
      cycleId: 'cycle-r100',
      issueRevision: 'r100',
      lineage: input.lineage,
    });

    expect(errors.join('\n')).toContain('foreign-review.json');
    expect(errors.join('\n')).toContain('cycle is not on the canonical predecessor lineage');
  });

  it('rejects backward lineage order and duplicate stage publication', () => {
    const input = validHistoricalInput();
    const backward = [
      { ...input.receipts[0]!, stageSequence: 2 },
      { ...input.receipts[1]!, stageSequence: 1 },
      input.receipts[2]!,
      input.receipts[3]!,
    ];
    const duplicateEvents = [
      ...input.lineage.eventsByKey.values(),
      input.lineage.eventsByKey.get('cycle-r09:competitive:attempt-1')!,
    ];
    const lineage = buildCanonicalLineage(duplicateEvents);
    const errors = validateHistoricalReceiptsAgainstLineage({
      receiptValues: backward,
      receiptPaths: ['review.json', 'competitive.json', 'lens.json', 'terminal.json'],
      cycleId: 'cycle-r100',
      issueRevision: 'r100',
      lineage,
    });

    expect(errors.join('\n')).toContain('stage order moves backward');
    expect(errors.join('\n')).toContain('published stage event cycle-r09:competitive:attempt-1 is duplicated');
  });

  it('requires exactly one canonical source-revision marker', () => {
    expect(parseCanonicalSourceRevisionMarker('<!-- source-revision: r100 -->\nbody')).toEqual({
      revision: 'r100',
      errors: [],
    });
    expect(parseCanonicalSourceRevisionMarker(
      '<!-- source-revision: r09 -->\n<!-- source-revision: r10 -->',
    ).errors.join('\n')).toContain('duplicate');
    expect(parseCanonicalSourceRevisionMarker('source-revision: r10').errors.join('\n')).toContain('malformed');
    expect(parseCanonicalSourceRevisionMarker(
      '```markdown\n<!-- source-revision: r10 -->\n```',
    ).errors.join('\n')).toContain('missing');
    expect(parseCanonicalSourceRevisionMarker(
      '```markdown\n<!-- source-revision: r10 -->\n```\n<!-- source-revision: r11 -->',
    )).toEqual({ revision: 'r11', errors: [] });
  });

  it('rejects a same-revision successor cycle during final readback', () => {
    const input = validHistoricalInput();
    const successor = cycle('cycle-r101', 'cycle-r100', 'r100', 4);
    const refreshedLineage = buildCanonicalLineage([
      ...input.lineage.eventsByKey.values(),
      successor,
    ]);

    const errors = validateFinalAcceptanceReadbackHead(
      refreshedLineage,
      'cycle-r100',
      'r100',
    );

    expect(errors.join('\n')).toContain('expected cycle-r100, got cycle-r101');
  });

  it('requires the requested receipt set to equal canonical real paths', () => {
    const directory = mkdtempSync(join(tmpdir(), 'issue-1202-receipts-'));
    temporaryDirectories.push(directory);
    const first = join(directory, 'first.json');
    const second = join(directory, 'second.json');
    const alias = join(directory, 'first-alias.json');
    const extra = join(directory, 'extra.json');
    for (const path of [first, second, extra]) writeFileSync(path, '{}');
    symlinkSync(first, alias);

    expect(validateCanonicalReceiptPathSet([first, second], [second, first])).toEqual([]);
    expect(validateCanonicalReceiptPathSet([first, second], [first])).toEqual(
      expect.arrayContaining([expect.stringContaining('omitted')]),
    );
    expect(validateCanonicalReceiptPathSet([first, second], [first, second, extra])).toEqual(
      expect.arrayContaining([expect.stringContaining('non-canonical')]),
    );
    expect(validateCanonicalReceiptPathSet([first, second], [first, alias, second])).toEqual(
      expect.arrayContaining([expect.stringContaining('duplicate')]),
    );
  });
});
