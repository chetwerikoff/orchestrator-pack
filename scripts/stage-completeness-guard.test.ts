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

const TASK_IDENTITY = 'issue:1150';
const FIRST_REVISION = 'r09';
const EPISODE_ID = `${TASK_IDENTITY}@${FIRST_REVISION}`;
const T3_DRAFT = `# fixture\n\n\`\`\`complexity-tier\ntier: T3\nadvisory-prior: T3\n\`\`\`\n`;
const CLEAN = ['review-economics-contract: v1', 'NO_FINDINGS', 'SIMPLIFICATION_CLEAN'].join('\n');

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function receiptId(sequence: number, episode = EPISODE_ID): string {
  return `${episode}:stage-receipt:${String(sequence).padStart(4, '0')}`;
}

function sourceLabel(item: CaptureIdentityV1): string {
  return `${item.name}|${item.captureIdentity}`;
}

function rawFindingCount(text: string): number {
  return (text.match(/^id:\s*/gm) ?? []).length;
}

function capture(identity: string, name: string, text = CLEAN): CaptureIdentityV1 {
  return {
    captureIdentity: identity,
    name,
    byteLength: Buffer.byteLength(text),
    sha256: sha(text),
    rawFindingCount: rawFindingCount(text),
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
    reviewEpisodeId: EPISODE_ID,
    stageAttemptId: attemptId,
    policyVersion: stage === 'architectural' ? 'single-source/v1' : 'triple-source/v1',
    stage,
    sourceRevision: FIRST_REVISION,
    invocationId: `invocation-${attemptId}-${slot}-1`,
    terminalResultIdentity: `result-${attemptId}-${slot}-1`,
    reviewerSource: `reviewer-${attemptId}-${slot}`,
    reviewerSlot: slot,
    reviewerOrdinal: Number(slot),
    attemptOrdinal: 1,
    retryAttempt: false,
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
  sourceRevision?: string;
  episodeFirstRevision?: string;
};

function receipt(input: ReceiptInput): StageCompletenessReceiptV1 {
  const episodeFirstRevision = input.episodeFirstRevision ?? FIRST_REVISION;
  const reviewEpisodeId = `${TASK_IDENTITY}@${episodeFirstRevision}`;
  const policyVersion = input.stage === 'competitive' || input.stage === 'architectural-review'
    ? 'triple-source/v1'
    : 'single-source/v1';
  return {
    schema: 'stage-completeness-receipt/v1',
    tier: 'T3',
    taskIdentity: TASK_IDENTITY,
    episodeFirstRevision,
    reviewEpisodeId,
    stageReceiptId: receiptId(input.sequence, reviewEpisodeId),
    previousStageReceiptId: input.sequence === 1 ? null : receiptId(input.sequence - 1, reviewEpisodeId),
    receiptCensus: Array.from({ length: input.sequence }, (_, index) => receiptId(index + 1, reviewEpisodeId)),
    stageAttemptId: input.attemptId,
    stageSequence: input.sequence,
    stage: input.stage,
    policyVersion,
    sourceRevision: input.sourceRevision ?? FIRST_REVISION,
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
  return captures.map((item, index) => ({
    relayAttemptId: `relay-${item.captureIdentity}-${index + 1}`,
    captureIdentity: item.captureIdentity,
    sourceLabel: sourceLabel(item),
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

function claudeCaptureBranch(item: CaptureIdentityV1): NonNullable<StageCompletenessReceiptV1['claude']> {
  return {
    kind: 'capture',
    provider: 'claude-cli',
    invocationId: 'claude-invocation',
    producingRunIdentity: 'claude-run',
    terminalResultIdentity: 'claude-result',
    terminal: true,
    terminalClassification: 'complete',
    exitCode: 0,
    capture: item,
    m3Status: 'recorded',
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

  it('separates retry-attempt identity from future retry eligibility', () => {
    const stage = tripleStage('competitive', 1, 'retry-attempt');
    const successful = stage.receipt.invocations![0]!;
    const first = invocation('competitive', 'retry-attempt', '01', undefined);
    const retry = invocation('competitive', 'retry-attempt', '01', successful.capture, {
      attemptOrdinal: 2,
      retryAttempt: true,
      retryClass: 'none',
      invocationId: 'retry-invocation',
      terminalResultIdentity: 'retry-result',
      reviewerSource: first.reviewerSource,
    });
    stage.receipt.invocations!.splice(0, 1, first, retry);
    stage.receipt.settlement.retryState = 'exhausted';
    expect(deriveReviewEpisodeState([stage.receipt], relay(stage.captures)).errors).toEqual([]);

    const failedRetry = structuredClone(stage.receipt);
    const failed = failedRetry.invocations![1]!;
    delete failed.capture;
    failed.terminalClassification = 'post-send-failure';
    failed.sendCount = 1;
    failed.retryClass = 'retry-forbidden';
    failedRetry.outcome = 'blocked';
    failedRetry.credentialingCaptures = [];
    failedRetry.relayEligibleCaptures = failedRetry.invocations!
      .flatMap((item) => item.capture ? [item.capture] : []);
    const state = deriveReviewEpisodeState([failedRetry], relay(failedRetry.relayEligibleCaptures));
    expect(state.errors, state.errors.join('\n')).toEqual([]);
    expect(failedRetry.settlement.retryState).toBe('exhausted');
  });

  it('binds the episode to one cumulative no-overwrite receipt chain', () => {
    const fixture = preLensFixture();
    const omitted = deriveReviewEpisodeState([fixture.receipts[1]!], relay(fixture.captures.slice(3)));
    expect(omitted.errors.join('\n')).toMatch(/sequence is incomplete|previousStageReceiptId|receiptCensus/);

    const restarted = receipt({
      stage: 'competitive',
      sequence: 1,
      attemptId: 'restarted-attempt',
      captures: [],
      invocations: [],
      outcome: 'blocked',
      sourceRevision: 'r10',
      episodeFirstRevision: 'r10',
    });
    const mixed = deriveReviewEpisodeState([fixture.receipts[0]!, restarted], relay(fixture.captures.slice(0, 3)));
    expect(mixed.errors.join('\n')).toMatch(/mix episodeFirstRevision|duplicate stageSequence|duplicate stageReceiptId/);
  });

  it('accepts only the latest verified corrected relay attempt with canonical labels', () => {
    const stage = tripleStage('competitive', 1, 'relay-attempt');
    const [firstCapture] = stage.captures;
    const evidence = relay(stage.captures);
    evidence[0] = {
      ...evidence[0]!,
      relayAttemptId: 'relay-original',
      verified: false,
    };
    evidence.push({
      ...evidence[0]!,
      relayAttemptId: 'relay-corrected',
      supersedes: 'relay-original',
      verified: true,
    });
    expect(deriveReviewEpisodeState([stage.receipt], evidence).errors).toEqual([]);

    const unknown = structuredClone(evidence);
    unknown.at(-1)!.supersedes = 'missing-attempt';
    expect(deriveReviewEpisodeState([stage.receipt], unknown).errors.join('\n'))
      .toMatch(/supersedes unknown attempt/);

    const mislabeled = relay(stage.captures);
    mislabeled[0]!.sourceLabel = firstCapture!.name;
    expect(deriveReviewEpisodeState([stage.receipt], mislabeled).errors.join('\n'))
      .toMatch(/sourceLabel does not match canonical source/);
  });

  it('preserves incomplete-attempt captures while one later complete attempt credentials the stage', () => {
    const retained = capture('retained-partial', 'pass-01-competitive-01.capture.txt');
    const partialInvocations = [
      invocation('competitive', 'partial-attempt', '01', retained),
      invocation('competitive', 'partial-attempt', '02', undefined, { retryClass: 'eligible-zero-send' }),
      invocation('competitive', 'partial-attempt', '03', undefined, { retryClass: 'eligible-zero-send' }),
    ];
    const partial = receipt({
      stage: 'competitive', sequence: 1, attemptId: 'partial-attempt', captures: [retained],
      invocations: partialInvocations, outcome: 'partial', retryState: 'abandoned',
    });
    const complete = tripleStage('competitive', 2, 'complete-attempt');
    const architecture = tripleStage('architectural-review', 3, 'architecture-attempt');
    const receipts = [partial, complete.receipt, architecture.receipt];
    const captures = [retained, ...complete.captures, ...architecture.captures];
    const state = deriveReviewEpisodeState(receipts, relay(captures));
    expect(state.errors, state.errors.join('\n')).toEqual([]);
    expect(validateReviewEpisodeTopology(state, 'pre-lens')).toEqual([]);
    expect(state.governedCaptureUnion).toContain(retained.captureIdentity);
    expect(state.credentialingCapturesByStage.competitive).toHaveLength(3);
  });

  it('requires producing Claude CLI run/result provenance', () => {
    const preLens = preLensFixture();
    const claudeCapture = capture('claude-capture', 'pass-03-architectural-lens.capture.txt');
    const valid = receipt({
      stage: 'architectural-lens', sequence: 3, attemptId: 'claude-attempt', captures: [claudeCapture],
      claude: claudeCaptureBranch(claudeCapture),
    });
    expect(deriveReviewEpisodeState([...preLens.receipts, valid], relay([...preLens.captures, claudeCapture])).errors)
      .toEqual([]);

    const invalid = structuredClone(valid);
    if (invalid.claude?.kind === 'capture') invalid.claude.producingRunIdentity = '';
    expect(deriveReviewEpisodeState([...preLens.receipts, invalid], relay([...preLens.captures, claudeCapture])).errors.join('\n'))
      .toMatch(/immutable producing-run/);
  });

  it('fails fresh T3 closed without stage receipts and keeps #1123 final activation blocked', () => {
    expect(checkStageCompletenessGuard(T3_DRAFT).errors.join('\n'))
      .toMatch(/fresh T3 requires explicit stage-completeness-receipt\/v1/);

    const preLens = preLensFixture();
    const terminalCapture = capture('terminal-capture', 'pass-04-architectural.capture.txt');
    const terminalReceipt = receipt({
      stage: 'architectural', sequence: 4, attemptId: 'terminal-attempt', captures: [terminalCapture],
      invocations: [invocation('architectural', 'terminal-attempt', '01', terminalCapture)],
    });
    const claudeCapture = capture('claude-capture', 'pass-03-architectural-lens.capture.txt');
    const claudeReceipt = receipt({
      stage: 'architectural-lens', sequence: 3, attemptId: 'claude-attempt', captures: [claudeCapture],
      claude: claudeCaptureBranch(claudeCapture),
    });
    const allReceipts = [...preLens.receipts, claudeReceipt, terminalReceipt];
    const allCaptures = [...preLens.captures, claudeCapture, terminalCapture];
    const finalState = deriveReviewEpisodeState(allReceipts, relay(allCaptures));
    expect(validateReviewEpisodeTopology(finalState, 'final-acceptance').join('\n'))
      .toMatch(/blocked until #1123/);
  });
});

describe('Issue #1150 occurrence economics', () => {
  const finding = (
    type: 'quality' | 'security' | 'scope-violation',
    evidence: string,
    persistent = false,
  ) => [
    'review-economics-contract: v1',
    'id: REUSED-ID',
    `type: ${type}`,
    'severity: P1',
    `evidence: ${evidence}`,
    'recommendation: use the cheapest sufficient correction',
    `persistent-machinery: ${persistent ? 'yes' : 'no'}`,
    ...(persistent ? [
      'cheapest-sufficient-alternative: one bounded field',
      'stakes-price: low',
      'trade-in: remove the field when no longer needed',
    ] : []),
    'SIMPLIFICATION_CLEAN',
  ].join('\n');

  function options(fixture: ReturnType<typeof preLensFixture>) {
    return {
      phase: 'pre-lens' as const,
      reviewEconomics: true,
      stageTerminalConfirmed: true,
      adoptionTimestampMs: 1_000,
      issueRevision: FIRST_REVISION,
      captureMetadata: fixture.captures.map((item, index) => ({
        name: item.name, timestampMs: 2_000 + index, captureIdentity: item.captureIdentity,
      })),
      stageReceipts: fixture.receipts,
      verifiedRelayEvidence: fixture.relayEvidence,
    };
  }

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
          proposalReason: 'the second observation is false',
          'persistent-machinery': 'no',
        },
      ],
    };
    const result = checkFindingLedgerGuard(fixture.texts, JSON.stringify(ledger), options(fixture));
    expect(result.ok, result.errors.join('\n')).toBe(true);
    expect(result.economicsCounts).toEqual({ rawFindingCount: 2, distinctFindingCount: 2, processedDistinctCount: 2 });
  });

  it('binds accepted persistent machinery to every mapped raw occurrence', () => {
    const fixture = preLensFixture([finding('quality', 'persistent proposal', true), CLEAN, CLEAN]);
    const ledger = {
      version: 2,
      counts: { rawFindingCount: 1, distinctFindingCount: 1, processedDistinctCount: 1 },
      findings: [{
        id: 'DEFECT', summary: 'persistent mismatch', type: 'quality',
        occurrences: ['architectural-attempt-1:1'],
        defectDisposition: 'addressed', remedyDisposition: 'accepted',
        'persistent-machinery': 'no',
      }],
    };
    const result = checkFindingLedgerGuard(fixture.texts, JSON.stringify(ledger), options(fixture));
    expect(result.errors.join('\n')).toMatch(/accepted persistent-machinery occurrence.*must preserve/);
  });

  it('keeps grouped same-type protected M3 state occurrence-local', () => {
    const fixture = preLensFixture([
      finding('security', 'This is a security issue.'),
      finding('security', 'This is another security issue.'),
      CLEAN,
    ]);
    const ledger = {
      version: 2,
      counts: { rawFindingCount: 2, distinctFindingCount: 1, processedDistinctCount: 1 },
      findings: [{
        id: 'SECURITY-GROUP', summary: 'same defect', type: 'security',
        occurrences: ['architectural-attempt-1:1', 'architectural-attempt-2:1'],
        defectDisposition: 'addressed', remedyDisposition: 'accepted',
        'persistent-machinery': 'no',
        protectedOccurrences: [
          { occurrenceId: 'architectural-attempt-1:1', architectPending: true },
          {
            occurrenceId: 'architectural-attempt-2:1', architectPending: false,
            protectedActivation: {
              authority: 'author', signal: 'This is another security issue.', whyNow: 'present in current revision',
            },
          },
        ],
      }],
    };
    const result = checkFindingLedgerGuard(fixture.texts, JSON.stringify(ledger), options(fixture));
    expect(result.ok, result.errors.join('\n')).toBe(true);

    delete ledger.findings[0]!.protectedOccurrences[0];
    const missing = checkFindingLedgerGuard(fixture.texts, JSON.stringify(ledger), options(fixture));
    expect(missing.errors.join('\n')).toMatch(/requires explicit occurrence-level M3 state/);
  });

  it('blocks protected-type erasure', () => {
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
    const result = checkFindingLedgerGuard(fixture.texts, JSON.stringify(ledger), options(fixture));
    expect(result.errors.join('\n')).toMatch(/mixes protected occurrence identities\/types/);
  });

  it('aggregates clean/no-findings across all sources independent of order', () => {
    const fixture = preLensFixture();
    const result = checkFindingLedgerGuard([...fixture.texts].reverse(), JSON.stringify({
      version: 2,
      counts: { rawFindingCount: 0, distinctFindingCount: 0, processedDistinctCount: 0 },
      findings: [],
    }), {
      ...options(fixture),
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
