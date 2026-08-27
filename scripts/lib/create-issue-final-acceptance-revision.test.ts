import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseCanonicalSourceRevisionMarker,
  validateTerminalSourceRevision,
  validateFinalAcceptanceReadbackHead,
  validateCanonicalReceiptPathSet,
} from './create-issue-final-acceptance.ts';
import {
  executeFinalAcceptanceGuards,
  validateTerminalOneShotBodyBinding,
} from './create-issue-final-acceptance-contract.ts';
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
import { evaluateStageCredentialingSettlement } from './create-issue-stage-lifecycle-acceptance.ts';
import { validateReviewLaneRecord } from './review-lane-record.ts';

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
  it('preserves the existing grandfathered smoke-plan exemption at final acceptance', () => {
    const grandfatheredBody = [
      '<!-- source-revision: r09 -->',
      '```behavior-kind',
      'action-producing',
      '```',
      '```smoke-plan-floor',
      'grandfathered: true',
      '```',
    ].join('\n');
    const run = (body: string) => executeFinalAcceptanceGuards({
      issueBody: body,
      terminalSourceBody: body,
      currentIssueBody: body,
      issueRevision: 'r09',
      cycleId: 'cycle-r09',
      reviewDir: '/fixture/review',
      stageReceiptPaths: [],
      stageReceiptValues: [],
      capturePaths: [],
    });

    const grandfathered = run(grandfatheredBody);
    expect(grandfathered.errors.filter((error) => error.startsWith('smoke-test-plan:'))).toEqual([]);

    const nonGrandfathered = run(grandfatheredBody.replace(
      '```smoke-plan-floor\ngrandfathered: true\n```',
      '',
    ));
    expect(nonGrandfathered.errors).toContain(
      'smoke-test-plan: action-producing task lacks a ```smoke-test-plan``` block',
    );
  });

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

  it('accepts a canonical predecessor receipt without a republished stage event', () => {
    const input = validHistoricalInput();
    const predecessorEventKey = 'cycle-r09:competitive:attempt-1';
    const events = [...input.lineage.eventsByKey.values()].filter(
      (event) => event.eventKey !== predecessorEventKey,
    );
    const lineage = buildCanonicalLineage(events);

    const errors = validateHistoricalReceiptsAgainstLineage({
      receiptValues: input.receipts,
      receiptPaths: input.receipts.map((_, index) => `/canonical/receipt-${index + 1}.json`),
      cycleId: 'cycle-r100',
      issueRevision: 'r100',
      lineage,
    });

    expect(errors).toEqual([]);
  });

  it('still requires a published stage event for the current cycle terminal receipt', () => {
    const input = validHistoricalInput();
    const terminalEventKey = 'cycle-r100:architectural:attempt-4';
    const lineage = buildCanonicalLineage(
      [...input.lineage.eventsByKey.values()].filter((event) => event.eventKey !== terminalEventKey),
    );

    const errors = validateHistoricalReceiptsAgainstLineage({
      receiptValues: input.receipts,
      receiptPaths: input.receipts.map((_, index) => `/canonical/receipt-${index + 1}.json`),
      cycleId: 'cycle-r100',
      issueRevision: 'r100',
      lineage,
    });

    expect(errors).toContain(
      '/canonical/receipt-4.json (stage=architectural, attempt=attempt-4, cycle=cycle-r100, revision=r100): no canonical published stage event cycle-r100:architectural:attempt-4',
    );
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

  it('accepts a later source revision on the same canonical cycle during final readback', () => {
    const input = validHistoricalInput();

    const errors = validateFinalAcceptanceReadbackHead(
      input.lineage,
      'cycle-r100',
      'r101',
    );

    expect(errors).toEqual([]);
  });

  it('accepts a residual terminal marker when the canonical cycle has advanced', () => {
    const canonicalBody = '<!-- source-revision: r07 -->\ncanonical published author state';
    const terminalBody = '<!-- source-revision: r01 -->\nresidual terminal source';
    const canonicalRevision = parseCanonicalSourceRevisionMarker(canonicalBody).revision!;
    const terminalRevision = parseCanonicalSourceRevisionMarker(terminalBody).revision!;

    expect(validateTerminalSourceRevision(canonicalRevision, terminalRevision, canonicalRevision)).toEqual([]);
    expect(validateTerminalSourceRevision('r06', terminalRevision, canonicalRevision)).toEqual([
      'terminal source revision r01 does not match original canonical cycle head r06',
    ]);
  });

  it('allows exactly one post-terminal source revision step and rejects rN+2 drift', () => {
    const terminalBody = '<!-- source-revision: r07 -->\nterminal-reviewed bytes';
    const r08Body = '<!-- source-revision: r08 -->\nbounded corrected bytes';
    const r09Body = '<!-- source-revision: r09 -->\nunrelated later bytes';
    const terminalReceipt = {
      stage: 'architectural',
      outcome: 'complete',
      sourceRevision: 'r07',
    };
    const allowedErrors: string[] = [];
    validateTerminalOneShotBodyBinding(
      terminalBody,
      r08Body,
      'r08',
      [terminalReceipt],
      allowedErrors,
    );
    expect(allowedErrors).toEqual([]);

    const driftErrors: string[] = [];
    validateTerminalOneShotBodyBinding(
      terminalBody,
      r09Body,
      'r09',
      [terminalReceipt],
      driftErrors,
    );
    expect(driftErrors).toContain(
      'post-terminal correction must advance exactly one source revision: reviewed=r07 current=r09',
    );
  });

  it('does not use historical cycle lineage or cycleId as a final completion credential', () => {
    const input = validHistoricalInput();
    const body = [
      '<!-- source-revision: r100 -->',
      '```behavior-kind',
      'action-producing',
      '```',
      '```smoke-plan-floor',
      'grandfathered: true',
      '```',
    ].join('\n');
    const errors = executeFinalAcceptanceGuards({
      issueBody: body,
      terminalSourceBody: body,
      currentIssueBody: body,
      issueRevision: 'r100',
      cycleId: '',
      reviewDir: '/fixture/review',
      stageReceiptPaths: input.receipts.map((_, index) => `/fixture/receipt-${index + 1}.json`),
      stageReceiptValues: input.receipts,
      capturePaths: [],
      canonicalLineage: input.lineage,
    }).errors;

    expect(errors.some((error) => error.startsWith('cycle-binding:'))).toBe(false);
    expect(errors).not.toContain('cycleId is required');
  });
  it('treats partial witness invocation/result identity as audit-only at final acceptance', () => {
    const partialReceipt = {
      outcome: 'partial',
      producerEvidence: 'not-applicable',
      invocations: [
        { reviewerSlot: '01', attemptOrdinal: 1, terminal: true, terminalClassification: 'complete', sendCount: 1, retryClass: 'none', capture: { captureIdentity: 'capture-01' } },
        { reviewerSlot: '02', attemptOrdinal: 1, terminal: true, terminalClassification: 'complete', sendCount: 1, retryClass: 'none', capture: { captureIdentity: 'capture-02' } },
        { reviewerSlot: '03', attemptOrdinal: 1, invocationId: 'actual-invocation', terminalResultIdentity: 'actual-result', terminal: true, terminalClassification: 'incident', sendCount: 1, retryClass: 'retry-forbidden' },
      ],
      partialMissingSources: [
        { reviewerSlot: '03', invocationId: 'historical-other-invocation', evidenceIdentity: 'historical-other-result', reason: 'post-send result unavailable' },
      ],
    };
    const stageTime = evaluateStageCredentialingSettlement(partialReceipt, 3, 'architectural-review');
    expect(stageTime.credentialed).toBe(false);
    expect(stageTime.errors.join('\n')).toContain('lacks a journal witness naming invocation actual-invocation');

    const finalAcceptance = evaluateStageCredentialingSettlement(partialReceipt, 3, 'architectural-review', 'final-acceptance');
    expect(finalAcceptance.credentialed, finalAcceptance.errors.join('\n')).toBe(true);
  });

  it('ignores routed producer identity equality at final acceptance but still forbids one result satisfying multiple slots', () => {
    const routed = {
      routing: {
        schema: 'review-lane-routing/v1',
        routingPolicyIdentity: 'review-lane-routing/v1',
        lane: 'disputed',
        topology: 'fixed/v1',
        policyVersion: 'review-lane-routing/v1',
        reviewerCardinality: 3,
        cardinalityConfigIdentity: 'fixture-cardinality',
        sourceRevision: 'r08',
        stageAttemptId: 'attempt-routed',
        laneInputIdentity: 'fixture-input',
        classifierIdentity: 'fixture-classifier',
        permittedLaneOverride: null,
        conditionalActivationRule: null,
        possibleSlots: ['01', '02', '03'],
        initiallyActivatedSlots: ['01', '02', '03'],
      },
      finalRequiredSlots: ['01', '02', '03'],
      sourceVerdicts: { '01': 'accept', '02': 'accept', '03': 'accept' },
      sourceVerdictEvidence: {
        '01': { producerEvidenceIdentity: 'same-producer', terminalClassification: 'complete', captureVerified: true, digestMatches: true, captureIdentity: 'capture-01', rawFindingCount: 0, materialFindingBlocks: 0 },
        '02': { producerEvidenceIdentity: 'same-producer', terminalClassification: 'complete', captureVerified: true, digestMatches: true, captureIdentity: 'capture-02', rawFindingCount: 0, materialFindingBlocks: 0 },
        '03': { producerEvidenceIdentity: 'same-producer', terminalClassification: 'complete', captureVerified: true, digestMatches: true, captureIdentity: 'capture-03', rawFindingCount: 0, materialFindingBlocks: 0 },
      },
      conflictDecision: 'no-conflict',
      settlement: {
        ok: true,
        finalRequiredSlots: ['01', '02', '03'],
        slotCensus: [
          { slot: '01', state: 'activated' },
          { slot: '02', state: 'activated' },
          { slot: '03', state: 'activated' },
        ],
        errors: [],
        conflictDecision: 'no-conflict',
      },
    };
    expect(validateReviewLaneRecord(routed).ok).toBe(false);
    expect(validateReviewLaneRecord(routed, [], 'final-acceptance').ok).toBe(true);

    const doubleCounted = structuredClone(routed);
    doubleCounted.sourceVerdictEvidence['02'].captureIdentity = 'capture-01';
    expect(validateReviewLaneRecord(doubleCounted, [], 'final-acceptance').ok).toBe(false);
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
