import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkFindingLedgerGuard } from './finding-ledger-guard.mjs';
import {
  checkStageCompletenessGuard,
  deriveReviewEpisodeState,
  validateReviewEpisodeTopology,
  type CaptureIdentityV1,
  type ReviewerInvocationEnvelopeV1,
  type ReviewStage,
  type StageCompletenessReceiptV1,
  type VerifiedRelayEvidenceV1,
} from './lib/stage-completeness-core.ts';

const T3_DRAFT = `# fixture\n\n\`\`\`complexity-tier\ntier: T3\nadvisory-prior: T3\n\`\`\`\n`;
const CLEAN = ['review-economics-contract: v1', 'NO_FINDINGS', 'SIMPLIFICATION_CLEAN'].join('\n');

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function capture(identity: string, name: string, text = CLEAN, rawFindingCount = 0): CaptureIdentityV1 {
  return {
    captureIdentity: identity,
    name,
    byteLength: Buffer.byteLength(text),
    sha256: sha(text),
    rawFindingCount,
  };
}

function invocation(
  stage: 'competitive' | 'architectural-review' | 'architectural',
  attemptId: string,
  slot: '01' | '02' | '03',
  item: CaptureIdentityV1 | undefined,
  overrides: Partial<ReviewerInvocationEnvelopeV1> = {},
): ReviewerInvocationEnvelopeV1 {
  return {
    schema: 'reviewer-invocation-envelope/v1',
    reviewEpisodeId: 'episode-1150',
    stageAttemptId: attemptId,
    policyVersion: stage === 'architectural' ? 'single-source/v1' : 'triple-source/v1',
    stage,
    sourceRevision: 'r09',
    invocationId: `invocation-${attemptId}-${slot}-1`,
    terminalResultIdentity: `result-${attemptId}-${slot}-1`,
    reviewerSource: `reviewer-${attemptId}-${slot}`,
    reviewerSlot: slot,
    reviewerOrdinal: Number(slot),
    attemptOrdinal: 1,
    terminal: true,
    terminalClassification: item ? 'complete' : 'quota',
    sendCount: item ? 1 : 0,
    retryClass: item ? 'none' : 'eligible-zero-send',
    revisionCheck: 'matched',
    capacityOutcome: 'admitted',
    capacityWaitMs: 0,
    ...(item ? { capture: item } : {}),
    ...overrides,
  };
}

type ReceiptInput = {
  stage: ReviewStage;
  sequence: number;
  attemptId: string;
  captures: CaptureIdentityV1[];
  invocations?: ReviewerInvocationEnvelopeV1[];
  outcome?: StageCompletenessReceiptV1['outcome'];
  retryState?: StageCompletenessReceiptV1['settlement']['retryState'];
  claude?: StageCompletenessReceiptV1['claude'];
};

function receipt(input: ReceiptInput): StageCompletenessReceiptV1 {
  const policyVersion = input.stage === 'competitive' || input.stage === 'architectural-review'
    ? 'triple-source/v1'
    : 'single-source/v1';
  return {
    schema: 'stage-completeness-receipt/v1',
    tier: 'T3',
    reviewEpisodeId: 'episode-1150',
    stageAttemptId: input.attemptId,
    stageSequence: input.sequence,
    stage: input.stage,
    policyVersion,
    sourceRevision: 'r09',
    outcome: input.outcome ?? 'complete',
    revisionChecks: { attemptCreation: 'matched', beforeLaunch: 'matched', settlement: 'matched' },
    settlement: {
      allLaunchedTerminal: true,
      retryState: input.retryState ?? 'none',
      finalRevisionMatched: true,
    },
    ...(input.invocations ? { invocations: input.invocations } : {}),
    ...(input.claude ? { claude: input.claude } : {}),
    credentialingCaptures: input.outcome && input.outcome !== 'complete' ? [] : input.captures,
    relayEligibleCaptures: input.captures,
  };
}

function tripleStage(
  stage: 'competitive' | 'architectural-review',
  sequence: number,
  attemptId: string,
  texts: readonly string[] = [CLEAN, CLEAN, CLEAN],
): { receipt: StageCompletenessReceiptV1; captures: CaptureIdentityV1[] } {
  const captures = texts.map((text, index) => capture(
    `${attemptId}-${index + 1}`,
    `pass-${String(sequence).padStart(2, '0')}-${stage}-0${index + 1}.capture.txt`,
    text,
    text === CLEAN ? 0 : 1,
  ));
  const invocations = captures.map((item, index) => invocation(
    stage,
    attemptId,
    `0${index + 1}` as '01' | '02' | '03',
    item,
  ));
  return { receipt: receipt({ stage, sequence, attemptId, captures, invocations }), captures };
}

function relay(captures: readonly CaptureIdentityV1[]): VerifiedRelayEvidenceV1[] {
  return captures.map((item) => ({
    captureIdentity: item.captureIdentity,
    name: item.name,
    byteLength: item.byteLength,
    sha256: item.sha256,
    verified: true,
  }));
}

function preLensFixture(
  architecturalTexts: readonly string[] = [CLEAN, CLEAN, CLEAN],
): {
  texts: string[];
  captures: CaptureIdentityV1[];
  receipts: StageCompletenessReceiptV1[];
  relayEvidence: VerifiedRelayEvidenceV1[];
} {
  const competitive = tripleStage('competitive', 1, 'competitive-attempt', [CLEAN, CLEAN, CLEAN]);
  const architectural = tripleStage('architectural-review', 2, 'architectural-attempt', architecturalTexts);
  const captures = [...competitive.captures, ...architectural.captures];
  return {
    texts: [CLEAN, CLEAN, CLEAN, ...architecturalTexts],
    captures,
    receipts: [competitive.receipt, architectural.receipt],
    relayEvidence: relay(captures),
  };
}

describe('Issue #1150 stage receipts', () => {
  it('credentials exact independent 01/02/03 sources as one logical round', () => {
    const stage = tripleStage('competitive', 1, 'competitive-attempt');
    const state = deriveReviewEpisodeState([stage.receipt], relay(stage.captures));
    expect(state.errors, state.errors.join('\n')).toEqual([]);
    expect(state.logicalRoundIds).toEqual(['competitive-attempt']);
    expect(state.credentialingCapturesByStage.competitive).toHaveLength(3);
  });

  it('rejects missing, duplicate-source, mislabeled, or cross-pass siblings', () => {
    const stage = tripleStage('competitive', 1, 'competitive-attempt');
    stage.receipt.invocations!.pop();
    stage.receipt.credentialingCaptures.pop();
    stage.receipt.relayEligibleCaptures.pop();
    expect(deriveReviewEpisodeState([stage.receipt], relay(stage.receipt.relayEligibleCaptures)).errors.join('\n'))
      .toMatch(/missing reviewer slot 03/);

    const duplicate = tripleStage('competitive', 1, 'duplicate-attempt');
    duplicate.receipt.invocations![1]!.reviewerSource = duplicate.receipt.invocations![0]!.reviewerSource;
    expect(deriveReviewEpisodeState([duplicate.receipt], relay(duplicate.captures)).errors.join('\n'))
      .toMatch(/reviewer sources must be independent/);

    const crossPass = tripleStage('competitive', 1, 'cross-pass-attempt');
    crossPass.captures[2]!.name = 'pass-02-competitive-03.capture.txt';
    crossPass.receipt.invocations![2]!.capture = crossPass.captures[2];
    expect(deriveReviewEpisodeState([crossPass.receipt], relay(crossPass.captures)).errors.join('\n'))
      .toMatch(/share one pass-NN prefix/);
  });

  it('permits one retry only after a proven zero-send pre-send failure', () => {
    const stage = tripleStage('competitive', 1, 'retry-attempt');
    const successful = stage.receipt.invocations![0]!;
    const first = invocation('competitive', 'retry-attempt', '01', undefined);
    const retry = invocation('competitive', 'retry-attempt', '01', successful.capture, {
      attemptOrdinal: 2,
      retryClass: 'retry',
      invocationId: 'retry-invocation',
      terminalResultIdentity: 'retry-result',
      reviewerSource: first.reviewerSource,
    });
    stage.receipt.invocations!.splice(0, 1, first, retry);
    stage.receipt.settlement.retryState = 'exhausted';
    expect(deriveReviewEpisodeState([stage.receipt], relay(stage.captures)).errors).toEqual([]);

    const forbidden = structuredClone(stage.receipt);
    forbidden.invocations![0]!.sendCount = 1;
    forbidden.invocations![0]!.retryClass = 'retry-forbidden';
    expect(deriveReviewEpisodeState([forbidden], relay(stage.captures)).errors.join('\n'))
      .toMatch(/retry requires a proven retryable zero-send/);
  });

  it('requires exact relay equality and preserves Claude waiver zero-capture semantics', () => {
    const preLens = preLensFixture();
    const state = deriveReviewEpisodeState(preLens.receipts, preLens.relayEvidence.slice(1));
    expect(state.errors.join('\n')).toMatch(/relayedCaptureUnion must equal governedCaptureUnion/);

    const waiverReceipt = receipt({
      stage: 'architectural-lens',
      sequence: 3,
      attemptId: 'claude-attempt',
      captures: [],
      claude: {
        kind: 'waiver',
        waiver: {
          reason: 'claude-unavailable',
          unavailability: 'quota',
          evidenceIdentity: 'quota-evidence',
        },
      },
    });
    const withWaiver = deriveReviewEpisodeState([...preLens.receipts, waiverReceipt], preLens.relayEvidence);
    expect(withWaiver.errors, withWaiver.errors.join('\n')).toEqual([]);
    expect(withWaiver.rawFindingCountByStage['architectural-lens']).toBe(0);
  });

  it('keeps T3 final acceptance fail-closed until #1123 while allowing pre-lens', () => {
    const preLens = preLensFixture();
    const pre = checkStageCompletenessGuard(T3_DRAFT, {
      stageReceipts: preLens.receipts,
      verifiedRelayEvidence: preLens.relayEvidence,
      phase: 'pre-lens',
    });
    expect(pre.ok, pre.errors.join('\n')).toBe(true);

    const terminalText = CLEAN;
    const terminalCapture = capture('terminal-capture', 'pass-04-architectural.capture.txt', terminalText, 0);
    const terminalReceipt = receipt({
      stage: 'architectural',
      sequence: 4,
      attemptId: 'terminal-attempt',
      captures: [terminalCapture],
      invocations: [invocation('architectural', 'terminal-attempt', '01', terminalCapture)],
    });
    const claudeCapture = capture('claude-capture', 'pass-03-architectural-lens.capture.txt', CLEAN, 0);
    const claudeReceipt = receipt({
      stage: 'architectural-lens',
      sequence: 3,
      attemptId: 'claude-attempt',
      captures: [claudeCapture],
      claude: { kind: 'capture', terminal: true, capture: claudeCapture, m3Status: 'recorded' },
    });
    const allReceipts = [...preLens.receipts, claudeReceipt, terminalReceipt];
    const allCaptures = [...preLens.captures, claudeCapture, terminalCapture];
    const finalState = deriveReviewEpisodeState(allReceipts, relay(allCaptures));
    expect(validateReviewEpisodeTopology(finalState, 'final-acceptance').join('\n'))
      .toMatch(/blocked until #1123/);
  });
});

describe('Issue #1150 occurrence economics', () => {
  const finding = (type: 'quality' | 'security' | 'scope-violation', evidence: string) => [
    'review-economics-contract: v1',
    'id: REUSED-ID',
    `type: ${type}`,
    'severity: P1',
    `evidence: ${evidence}`,
    'recommendation: use the cheapest sufficient correction',
    'persistent-machinery: no',
    'SIMPLIFICATION_CLEAN',
  ].join('\n');

  it('maps duplicate reviewer-local ids by occurrence and derives exact counts', () => {
    const texts = [finding('quality', 'first defect'), finding('quality', 'second defect'), CLEAN];
    const fixture = preLensFixture(texts);
    const ledger = {
      version: 2,
      counts: { rawFindingCount: 2, distinctFindingCount: 2, processedDistinctCount: 2 },
      findings: [
        {
          id: 'DEFECT-1', summary: 'first', type: 'quality',
          occurrences: ['architectural-attempt-1:1'],
          defectDisposition: 'addressed', remedyDisposition: 'accepted',
          'persistent-machinery': 'no',
        },
        {
          id: 'DEFECT-2', summary: 'second', type: 'quality',
          occurrences: ['architectural-attempt-2:1'],
          defectDisposition: 'rejected-as-false', remedyDisposition: 'rejected-as-overengineering',
          'persistent-machinery': 'no',
        },
      ],
    };
    const result = checkFindingLedgerGuard(fixture.texts, JSON.stringify(ledger), {
      phase: 'pre-lens', reviewEconomics: true, stageTerminalConfirmed: true,
      adoptionTimestampMs: 1_000, issueRevision: 'r09',
      captureMetadata: fixture.captures.map((item, index) => ({
        name: item.name, timestampMs: 2_000 + index, captureIdentity: item.captureIdentity,
      })),
      stageReceipts: fixture.receipts,
      verifiedRelayEvidence: fixture.relayEvidence,
    });
    expect(result.ok, result.errors.join('\n')).toBe(true);
    expect(result.economicsCounts).toEqual({ rawFindingCount: 2, distinctFindingCount: 2, processedDistinctCount: 2 });
  });

  it('blocks unresolved/missing mappings and protected-type erasure', () => {
    const texts = [
      finding('security', 'This is a security issue.'),
      finding('scope-violation', 'This path is out of scope under allowed_roots.'),
      CLEAN,
    ];
    const fixture = preLensFixture(texts);
    const ledger = {
      version: 2,
      counts: { rawFindingCount: 2, distinctFindingCount: 1, processedDistinctCount: 1 },
      findings: [{
        id: 'MIXED', summary: 'invalid grouping', type: 'security',
        occurrences: ['architectural-attempt-1:1', 'architectural-attempt-2:1'],
        defectDisposition: 'addressed', remedyDisposition: 'accepted', architectPending: true,
        'persistent-machinery': 'no',
      }],
    };
    const result = checkFindingLedgerGuard(fixture.texts, JSON.stringify(ledger), {
      phase: 'pre-lens', reviewEconomics: true, stageTerminalConfirmed: true,
      adoptionTimestampMs: 1_000, issueRevision: 'r09',
      captureMetadata: fixture.captures.map((item, index) => ({
        name: item.name, timestampMs: 2_000 + index, captureIdentity: item.captureIdentity,
      })),
      stageReceipts: fixture.receipts,
      verifiedRelayEvidence: fixture.relayEvidence,
    });
    expect(result.errors.join('\n')).toMatch(/mixes protected occurrence identities\/types/);
  });

  it('aggregates clean/no-findings across all sources independent of order', () => {
    const fixture = preLensFixture();
    const result = checkFindingLedgerGuard([...fixture.texts].reverse(), JSON.stringify({
      version: 2,
      counts: { rawFindingCount: 0, distinctFindingCount: 0, processedDistinctCount: 0 },
      findings: [],
    }), {
      phase: 'pre-lens', reviewEconomics: true, stageTerminalConfirmed: true,
      adoptionTimestampMs: 1_000, issueRevision: 'r09',
      captureMetadata: [...fixture.captures].reverse().map((item, index) => ({
        name: item.name, timestampMs: 2_000 + index, captureIdentity: item.captureIdentity,
      })),
      stageReceipts: [...fixture.receipts].reverse(),
      verifiedRelayEvidence: [...fixture.relayEvidence].reverse(),
    });
    expect(result.ok, result.errors.join('\n')).toBe(true);
    expect(result.simplificationAggregate).toEqual({
      simplificationClean: true,
      noFindings: true,
      candidateOccurrences: [],
    });
  });
});

describe('Issue #1120 transport boundary remains unchanged', () => {
  it('does not add a second monitor or legacy admission authority', () => {
    const source = readFileSync(resolve(process.cwd(), 'scripts/chatgpt-browser-turn/state-light-turn.ts'), 'utf8');
    for (const forbidden of [
      'acquireDomainLock(', 'reserveDestination(', 'blockerBeforeSend(',
      'statusList(', 'capabilityStatus(', 'runtimeWitnessSurfaceAvailable(',
    ]) expect(source).not.toContain(forbidden);
    expect(source.match(/sendButton\.click\(/g) ?? []).toHaveLength(1);
  });
});
