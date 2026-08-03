import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkFindingLedgerGuard, runCli as runFindingLedgerCli } from './finding-ledger-guard.mjs';
import { loadCanonicalReceiptInventory } from './stage-completeness-guard.ts';
import { stageFinalizeUsage } from './lib/create-issue-stage-record-cli.ts';
import { ACCEPTANCE_ARTIFACT_OUTPUT_NAMES, ACCEPTANCE_ARTIFACT_REQUIRED_INPUTS } from './lib/create-issue-stage-record-artifacts.ts';
import {
  deriveReviewEpisodeState,
  parseReviewerCardinalityControl,
  resolveCanonicalReviewDirectory,
  validateReviewEpisodeTopology,
  type CaptureIdentityV1,
  type ReviewEpisodeDerivationAuthorityV1,
  type ReviewerInvocationEnvelopeV1,
  type StageCompletenessReceiptV1,
  type VerifiedRelayEvidenceV1,
} from './lib/stage-completeness-core.ts';
import {
  buildAuthorDisposition,
  buildSourceRecords,
  buildTopology,
  deriveAdmission,
} from './lib/create-issue-stage-topology.ts';

const TASK = 'issue:1150';
const REVISION = 'r09';
const EPISODE = `${TASK}@${REVISION}`;
const CONFIG = 'env:OPK_GPT_REVIEWER_CARDINALITY';
const CLEAN = 'review-economics-contract: v1\nNO_FINDINGS\nSIMPLIFICATION_CLEAN\n';

function hash(text: string): string { return createHash('sha256').update(text).digest('hex'); }
function capture(id: string, name: string, text = CLEAN): CaptureIdentityV1 {
  return { captureIdentity: id, name, byteLength: Buffer.byteLength(text), sha256: hash(text), rawFindingCount: (text.match(/^id:\s*/gm) ?? []).length };
}
function receiptId(sequence: number): string { return `${EPISODE}:stage-receipt:${String(sequence).padStart(4, '0')}`; }
function reviewerSlot(ordinal: number): string { return String(ordinal).padStart(2, '0'); }
function invocation(
  stage: 'competitive' | 'architectural-review' | 'architectural',
  attemptId: string,
  ordinal: number,
  cardinality: number,
  item?: CaptureIdentityV1,
  override: Partial<ReviewerInvocationEnvelopeV1> = {},
): ReviewerInvocationEnvelopeV1 {
  const slot = reviewerSlot(ordinal);
  return {
    schema: 'reviewer-invocation-envelope/v1', reviewEpisodeId: EPISODE, stageAttemptId: attemptId,
    policyVersion: stage === 'architectural' ? 'single-source/v1' : 'triple-source/v1',
    reviewerCardinality: cardinality, cardinalityConfigIdentity: CONFIG, stage, sourceRevision: REVISION,
    invocationId: `inv-${attemptId}-${slot}-1`, terminalResultIdentity: `result-${attemptId}-${slot}-1`,
    reviewerSource: `source-${attemptId}-${slot}`, reviewerSlot: slot, reviewerOrdinal: ordinal,
    attemptOrdinal: 1, retryAttempt: false, terminal: true,
    terminalClassification: item ? 'complete' : 'quota', sendCount: item ? 1 : 0,
    retryClass: item ? 'none' : 'eligible-zero-send', revisionCheck: 'matched',
    capacityOutcome: 'admitted', capacityWaitMs: 0, ...(item ? { capture: item } : {}), ...override,
  };
}
function receipt(
  stage: StageCompletenessReceiptV1['stage'], sequence: number, attemptId: string,
  cardinality: number, captures: CaptureIdentityV1[],
  invocations?: ReviewerInvocationEnvelopeV1[], outcome: StageCompletenessReceiptV1['outcome'] = 'complete',
): StageCompletenessReceiptV1 {
  return {
    schema: 'stage-completeness-receipt/v1', tier: 'T3', taskIdentity: TASK,
    episodeFirstRevision: REVISION, reviewEpisodeId: EPISODE, stageReceiptId: receiptId(sequence),
    previousStageReceiptId: sequence === 1 ? null : receiptId(sequence - 1),
    receiptCensus: Array.from({ length: sequence }, (_, index) => receiptId(index + 1)),
    stageAttemptId: attemptId, stageSequence: sequence, stage,
    policyVersion: stage === 'competitive' || stage === 'architectural-review' ? 'triple-source/v1' : 'single-source/v1',
    reviewerCardinality: cardinality, cardinalityConfigIdentity: CONFIG, sourceRevision: REVISION, outcome,
    revisionChecks: { attemptCreation: 'matched', beforeLaunch: 'matched', settlement: 'matched' },
    settlement: { allLaunchedTerminal: true, retryState: 'none', finalRevisionMatched: true },
    ...(invocations ? { invocations } : {}),
    credentialingCaptures: outcome === 'complete' ? captures : [], relayEligibleCaptures: captures,
  };
}
function sourceStage(name: 'competitive' | 'architectural-review', sequence: number, cardinality: number, texts?: string[]) {
  const actualTexts = texts ?? Array.from({ length: cardinality }, () => CLEAN);
  const attemptId = `${name}-attempt`;
  const captures = actualTexts.map((text, index) => capture(`${attemptId}-${index + 1}`, `pass-${String(sequence).padStart(2, '0')}-${name}-${reviewerSlot(index + 1)}.capture.txt`, text));
  return { texts: actualTexts, captures, receipt: receipt(name, sequence, attemptId, cardinality, captures, captures.map((item, index) => invocation(name, attemptId, index + 1, cardinality, item))) };
}
function relay(captures: CaptureIdentityV1[]): VerifiedRelayEvidenceV1[] {
  return captures.map((item, index) => ({ relayAttemptId: `relay-${index}`, captureIdentity: item.captureIdentity, sourceLabel: `${item.name}|${item.captureIdentity}`, name: item.name, byteLength: item.byteLength, sha256: item.sha256, verified: true }));
}
function authority(receipts: StageCompletenessReceiptV1[], claudeProducerEvidence: unknown[] = []): ReviewEpisodeDerivationAuthorityV1 {
  return {
    tierIntake: { schema: 'tier-intake/v1', producer: 'flow-manager', taskIdentity: TASK, kind: 'fresh', priorTier: 'T3', firstRevision: REVISION },
    receiptInventory: { source: 'canonical-review-directory', taskIdentity: TASK, episodeFirstRevision: REVISION, reviewEpisodeId: EPISODE, stageReceiptIds: receipts.map((item) => item.stageReceiptId) },
    claudeProducerEvidence,
  };
}
function preLens(cardinality = 3, reviewTexts?: string[]) {
  const competitive = sourceStage('competitive', 1, cardinality);
  const architectural = sourceStage('architectural-review', 2, cardinality, reviewTexts);
  const receipts = [competitive.receipt, architectural.receipt];
  const captures = [...competitive.captures, ...architectural.captures];
  return { receipts, captures, texts: [...competitive.texts, ...architectural.texts], relay: relay(captures), authority: authority(receipts) };
}

function ledgerOptions(fixture: ReturnType<typeof preLens>) {
  let textOffset = 0;
  const remoteAuthorities = fixture.receipts.map((receipt) => {
    const topology = buildTopology({
      issueNumber: 1150,
      cycleId: 'cycle-1150',
      sourceRevision: REVISION,
      stage: receipt.stage,
      stageAttemptId: receipt.stageAttemptId,
      policyVersion: receipt.policyVersion,
    }, 'T3', receipt.reviewerCardinality, CONFIG);
    const lifecycle = {
      state: 'active' as const,
      cycleId: topology.cycleId,
      stageAttemptId: topology.stageAttemptId,
      sourceRevision: topology.sourceRevision,
    };
    const texts = fixture.texts.slice(textOffset, textOffset + receipt.reviewerCardinality);
    textOffset += receipt.reviewerCardinality;
    const sourceRecords = receipt.relayEligibleCaptures.flatMap((capture, index) => buildSourceRecords(topology, String(index + 1).padStart(2, '0'), texts[index] ?? CLEAN));
    const admission = deriveAdmission(topology, lifecycle, sourceRecords);
    const disposition = buildAuthorDisposition(topology, admission, {
      occurrenceIds: [],
      distinctDefects: [],
      defectDispositions: [],
      remedyDispositions: [],
      m4: 'keep',
      unresolvedOccurrenceIds: [],
      settlement: 'settled',
    });
    return { topology, lifecycle, sourceRecords, disposition };
  });
  return {
    reviewEconomics: true, phase: 'pre-lens' as const, issueRevision: REVISION,
    stageTerminalConfirmed: true,
    captureMetadata: fixture.captures.map((item, index) => ({ name: item.name, timestampMs: index + 1, captureIdentity: item.captureIdentity })),
    stageReceipts: fixture.receipts, verifiedRelayEvidence: fixture.relay, episodeAuthority: fixture.authority, remoteAuthorities,
  };
}

describe('Issue #1150 stage authority', () => {
  it('uses one configurable cardinality control and accepts non-three source sets', () => {
    expect(parseReviewerCardinalityControl(undefined)).toEqual({ T1: 1, T2: 1, T3: 3 });
    expect(parseReviewerCardinalityControl('2').T3).toBe(2);
    expect(parseReviewerCardinalityControl('{"T3":4}').T3).toBe(4);
    for (const cardinality of [2, 4]) {
      const fixture = preLens(cardinality);
      const state = deriveReviewEpisodeState(fixture.receipts, fixture.relay, fixture.authority);
      expect(state.errors, state.errors.join('\n')).toEqual([]);
      expect(state.credentialingCapturesByStage.competitive).toHaveLength(cardinality);
    }
  });

  it('rejects missing slots, mismatched snapshots, and later-root re-anchoring', () => {
    const fixture = preLens(4);
    const missing = structuredClone(fixture.receipts);
    missing[0]!.invocations!.pop(); missing[0]!.credentialingCaptures.pop(); missing[0]!.relayEligibleCaptures.pop();
    expect(deriveReviewEpisodeState(missing, relay([...missing[0]!.relayEligibleCaptures, ...missing[1]!.relayEligibleCaptures]), authority(missing)).errors.join('\n')).toMatch(/missing reviewer slot 04/);
    const mismatch = structuredClone(fixture.receipts); mismatch[0]!.invocations![0]!.reviewerCardinality = 3;
    expect(deriveReviewEpisodeState(mismatch, fixture.relay, authority(mismatch)).errors.join('\n')).toMatch(/reviewerCardinality mismatch/);
    const reroot = structuredClone(fixture.receipts);
    for (const item of reroot) { item.episodeFirstRevision = 'r10'; item.reviewEpisodeId = `${TASK}@r10`; item.sourceRevision = 'r10'; }
    expect(deriveReviewEpisodeState(reroot, fixture.relay, fixture.authority).errors.join('\n')).toMatch(/outside the authoritative episode root|inventory root|not canonical/);
  });

  it('validates every attempt order, including partial attempts', () => {
    const architecture = sourceStage('architectural-review', 1, 3);
    architecture.receipt.outcome = 'partial'; architecture.receipt.credentialingCaptures = [];
    const competitive = sourceStage('competitive', 2, 3);
    const receipts = [architecture.receipt, competitive.receipt];
    const state = deriveReviewEpisodeState(receipts, relay([...architecture.captures, ...competitive.captures]), authority(receipts));
    expect(validateReviewEpisodeTopology(state, 'pre-lens').join('\n')).toMatch(/started before competitive credentialed/);
  });

  it('does not allow a distinct attempt after a settled incomplete round', () => {
    const first = sourceStage('competitive', 1, 3);
    const firstInvocations = first.receipt.invocations!.map((item) => ({ ...item }));
    firstInvocations[0] = {
      ...firstInvocations[0]!,
      terminalClassification: 'quota',
      sendCount: 0,
      retryClass: 'eligible-zero-send',
      capture: undefined,
    };
    first.receipt.invocations = firstInvocations;
    first.receipt.outcome = 'partial';
    first.receipt.credentialingCaptures = [];
    first.receipt.relayEligibleCaptures = first.captures.slice(1);
    first.receipt.settlement.retryState = 'abandoned';

    const second = sourceStage('competitive', 2, 3);
    second.receipt.stageAttemptId = 'competitive-attempt-2';
    second.captures.forEach((capture, index) => {
      capture.captureIdentity = `competitive-attempt-2-${index + 1}`;
    });
    second.receipt.invocations = second.receipt.invocations!.map((item, index) => ({
      ...item,
      stageAttemptId: 'competitive-attempt-2',
      invocationId: `inv-competitive-attempt-2-${item.reviewerSlot}`,
      terminalResultIdentity: `result-competitive-attempt-2-${item.reviewerSlot}`,
      reviewerSource: `source-competitive-attempt-2-${item.reviewerSlot}`,
      capture: second.captures[index],
    }));
    const receipts = [first.receipt, second.receipt];
    const state = deriveReviewEpisodeState(
      receipts,
      relay([...first.receipt.relayEligibleCaptures, ...second.captures]),
      authority(receipts),
    );

    expect(state.errors.join('\n')).toMatch(/reopened logical round/);
  });

  it('activates configured plural-source rounds instead of rejecting triple-source policy', () => {
    const fixture = preLens(3);
    const state = deriveReviewEpisodeState(fixture.receipts, fixture.relay, fixture.authority);
    expect(state.errors, state.errors.join('\n')).toEqual([]);
    expect(state.activationReady).toBe(true);
    expect(state.logicalRoundIds).toEqual(['competitive-attempt', 'architectural-review-attempt']);
  });

  it('rejects routed policy for a terminal architectural stage', () => {
    const captures = [
      capture('architectural-routed-01', 'pass-01-architectural.capture.txt'),
      capture('architectural-routed-02', 'pass-02-architectural.capture.txt'),
    ];
    const attemptId = 'architectural-routed-attempt';
    const routing = {
      schema: 'review-lane-routing/v1' as const,
      routingPolicyIdentity: 'review-lane-routing/v1' as const,
      lane: 'disputed' as const,
      topology: 'conditional-third/v1' as const,
      policyVersion: 'review-lane-routing/v1' as const,
      reviewerCardinality: 3,
      cardinalityConfigIdentity: 'routed-config',
      possibleSlots: ['01', '02', '03'],
      initiallyActivatedSlots: ['01', '02'],
      conditionalActivationRule: 'material-verdict-conflict/v1' as const,
      sourceRevision: REVISION,
      stageAttemptId: attemptId,
      laneInputIdentity: 'routed-input',
      classifierIdentity: 'routed-classifier',
      permittedLaneOverride: null,
    };
    const evidence = (slot: string) => ({
      producerEvidenceIdentity: `producer-${slot}`,
      captureIdentity: `architectural-routed-${slot}`,
      terminalClassification: 'complete' as const,
      captureVerified: true,
      digestMatches: true,
      verdictText: 'NO_FINDINGS',
      rawFindingCount: 0,
    });
    const reviewLane = {
      routing,
      finalRequiredSlots: ['01', '02'],
      sourceVerdicts: { '01': 'accept' as const, '02': 'accept' as const },
      sourceVerdictEvidence: { '01': evidence('01'), '02': evidence('02') },
      conflictDecision: 'no-conflict' as const,
      settlement: {
        ok: true,
        conflictDecision: 'no-conflict' as const,
        finalRequiredSlots: ['01', '02'],
        slotCensus: [
          { slot: '01', state: 'activated' as const },
          { slot: '02', state: 'activated' as const },
          { slot: '03', state: 'not-activated' as const },
        ],
        errors: [],
      },
    };
    const invocations = captures.map((item, index) => invocation(
      'architectural',
      attemptId,
      index + 1,
      3,
      item,
      { policyVersion: 'review-lane-routing/v1', cardinalityConfigIdentity: 'routed-config', reviewLaneRouting: routing },
    ));
    const routedReceipt = {
      ...receipt('architectural', 1, attemptId, 3, captures, invocations),
      policyVersion: 'review-lane-routing/v1' as const,
      cardinalityConfigIdentity: 'routed-config',
      reviewLane,
    };
    const state = deriveReviewEpisodeState([routedReceipt], relay(captures), authority([routedReceipt]));
    expect(state.errors.join('\n')).toContain('review-lane-routing/v1 is limited to lane-controlled T3 stages');
  });

  it('binds receipt inventory to the canonical Issue root and blocks external receipts', () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'opk-canonical-review-'));
    const previousHome = process.env.HOME;
    try {
      process.env.HOME = tempHome;
      const fixture = preLens();
      const canonical = join(tempHome, '.local', 'state', 'create-issue-draft', '.review', '1150');
      const external = join(tempHome, 'other-workdir', '.review', 'issue-1150');
      mkdirSync(canonical, { recursive: true });
      mkdirSync(external, { recursive: true });
      const intakePath = join(canonical, 'tier-intake.json');
      writeFileSync(intakePath, JSON.stringify(fixture.authority.tierIntake));
      fixture.receipts.forEach((item, index) => {
        writeFileSync(join(canonical, `stage-completeness-receipt-${index + 1}.json`), JSON.stringify(item));
      });

      const loaded = loadCanonicalReceiptInventory({ tierIntakePath: intakePath, receiptDirectory: canonical });
      expect(loaded.receipts).toHaveLength(2);
      expect(() => loadCanonicalReceiptInventory({
        tierIntakePath: intakePath,
        receiptDirectory: external,
      })).toThrow(/legacy_receipt_location_blocked/);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('rejects an external intake path even when its contents resolve to the canonical directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'opk-intake-path-'));
    const previousStateRoot = process.env.OPK_CREATE_ISSUE_DRAFT_STATE_ROOT;
    const stateRoot = join(dir, 'state');
    const canonical = join(stateRoot, '.review', '1150');
    const external = join(dir, 'external');
    try {
      process.env.OPK_CREATE_ISSUE_DRAFT_STATE_ROOT = stateRoot;
      const fixture = preLens();
      mkdirSync(canonical, { recursive: true });
      mkdirSync(external, { recursive: true });
      writeFileSync(join(canonical, 'tier-intake.json'), JSON.stringify(fixture.authority.tierIntake));
      fixture.receipts.forEach((item, index) => writeFileSync(join(canonical, `stage-completeness-receipt-${index + 1}.json`), JSON.stringify(item)));
      fixture.captures.forEach((item, index) => writeFileSync(join(external, item.name), fixture.texts[index]!));
      writeFileSync(join(external, 'ledger.json'), JSON.stringify({ version: 2, counts: { rawFindingCount: 0, distinctFindingCount: 0, processedDistinctCount: 0 }, findings: [] }));
      writeFileSync(join(external, 'relay.json'), JSON.stringify(fixture.relay));
      const externalIntakePath = join(external, 'tier-intake.json');
      writeFileSync(externalIntakePath, JSON.stringify(fixture.authority.tierIntake));

      expect(runFindingLedgerCli([
        'node', 'scripts/finding-ledger-guard.mjs',
        '--ledger', join(external, 'ledger.json'),
        '--captures-dir', external,
        '--phase', 'pre-lens',
        '--stage-terminal',
        '--receipt-directory', canonical,
        '--tier-intake', externalIntakePath,
        '--verified-relay-evidence', join(external, 'relay.json'),
      ])).toBe(1);
    } finally {
      if (previousStateRoot === undefined) delete process.env.OPK_CREATE_ISSUE_DRAFT_STATE_ROOT;
      else process.env.OPK_CREATE_ISSUE_DRAFT_STATE_ROOT = previousStateRoot;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a valid receipt left in a finite legacy workdir layout', () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'opk-legacy-receipt-'));
    const previousHome = process.env.HOME;
    try {
      process.env.HOME = tempHome;
      const fixture = preLens();
      const stateRoot = join(tempHome, '.local', 'state', 'create-issue-draft');
      const canonical = join(stateRoot, '.review', '1150');
      const legacy = join(stateRoot, '1150-replay', 'docs', 'issues_drafts', '.review', '1150-replay');
      mkdirSync(canonical, { recursive: true });
      mkdirSync(legacy, { recursive: true });
      const intakePath = join(canonical, 'tier-intake.json');
      writeFileSync(intakePath, JSON.stringify(fixture.authority.tierIntake));
      writeFileSync(join(canonical, 'stage-completeness-receipt-1.json'), JSON.stringify(fixture.receipts[0]));
      writeFileSync(join(legacy, 'stage-completeness-receipt-legacy.json'), JSON.stringify(fixture.receipts[0]));

      expect(() => loadCanonicalReceiptInventory({
        tierIntakePath: intakePath,
        receiptDirectory: canonical,
      })).toThrow(/legacy_receipt_location_blocked/);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('preserves array-backed stage receipts as parsed values for final acceptance', () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'opk-array-receipts-'));
    const previousHome = process.env.HOME;
    try {
      process.env.HOME = tempHome;
      const fixture = preLens();
      const canonical = join(tempHome, '.local', 'state', 'create-issue-draft', '.review', '1150');
      mkdirSync(canonical, { recursive: true });
      const intakePath = join(canonical, 'tier-intake.json');
      writeFileSync(intakePath, JSON.stringify(fixture.authority.tierIntake));
      writeFileSync(join(canonical, 'stage-completeness-receipts.json'), JSON.stringify(fixture.receipts));

      const loaded = loadCanonicalReceiptInventory({ tierIntakePath: intakePath, receiptDirectory: canonical });
      expect(loaded.receiptValues).toEqual(fixture.receipts);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('derives the Issue number from supported replay workdir identities', () => {
    expect(resolveCanonicalReviewDirectory({ taskIdentity: '1142-replay' }).issueNumber).toBe('1142');
  });

  it('requires independent immutable Claude producer evidence', () => {
    const fixture = preLens();
    const text = 'm3-protected: id=x | revision=r09 | contest=none | outcome=non-activate\n';
    const item = capture('claude-capture', 'pass-03-architectural-lens.capture.txt', text);
    const lens = receipt('architectural-lens', 3, 'claude-attempt', 1, [item]);
    lens.claude = { kind: 'capture', provider: 'claude-cli', invocationId: 'claude-inv', producingRunIdentity: 'claude-run', terminalResultIdentity: 'claude-result', producerEvidenceIdentity: 'claude-evidence', terminal: true, terminalClassification: 'complete', exitCode: 0, capture: item, m3Status: 'recorded' };
    const receipts = [...fixture.receipts, lens]; const relays = relay([...fixture.captures, item]);
    expect(deriveReviewEpisodeState(receipts, relays, authority(receipts)).errors.join('\n')).toMatch(/not independently supplied/);
    const producer = { schema: 'claude-producer-evidence/v1', evidenceIdentity: 'claude-evidence', reviewEpisodeId: EPISODE, stageAttemptId: 'claude-attempt', sourceRevision: REVISION, invocationId: 'claude-inv', producingRunIdentity: 'claude-run', terminalResultIdentity: 'claude-result', terminal: true, terminalClassification: 'complete', exitCode: 0, capture: item, m3Status: 'recorded' };
    expect(deriveReviewEpisodeState(receipts, relays, authority(receipts, [producer])).errors).toEqual([]);
  });

  it('accepts a failed bounded retry and a verified corrected relay head', () => {
    const fixture = sourceStage('competitive', 1, 3);
    const first = invocation('competitive', 'competitive-attempt', 1, 3, undefined);
    const retry = invocation('competitive', 'competitive-attempt', 1, 3, undefined, { invocationId: 'retry-inv', terminalResultIdentity: 'retry-result', attemptOrdinal: 2, retryAttempt: true, retryClass: 'retry-forbidden', terminalClassification: 'quota' });
    fixture.receipt.invocations!.splice(0, 1, first, retry);
    fixture.receipt.outcome = 'blocked';
    fixture.receipt.credentialingCaptures = [];
    fixture.receipt.settlement.retryState = 'exhausted';
    fixture.receipt.relayEligibleCaptures = fixture.receipt.invocations!.flatMap((item) => item.capture ? [item.capture] : []);
    const relayEvidence = relay(fixture.receipt.relayEligibleCaptures);
    relayEvidence[0] = { ...relayEvidence[0]!, relayAttemptId: 'bad-relay', verified: false };
    relayEvidence.push({ ...relayEvidence[0]!, relayAttemptId: 'fixed-relay', supersedes: 'bad-relay', verified: true });
    expect(deriveReviewEpisodeState([fixture.receipt], relayEvidence, authority([fixture.receipt])).errors).toEqual([]);
  });
});

describe('Issue #1150 receipt-backed ledger', () => {
  const finding = 'review-economics-contract: v1\nid: LOCAL\ntype: security\nseverity: P1\nevidence: This is a security issue.\nrecommendation: fix\npersistent-machinery: no\nSIMPLIFICATION_CLEAN\n';

  it('binds immutable bytes/counts and rejects protected reclassification or decoy rows', () => {
    const fixture = preLens(3, [finding, CLEAN, CLEAN]);
    const good = { version: 2, counts: { rawFindingCount: 1, distinctFindingCount: 1, processedDistinctCount: 1 }, findings: [{ id: 'SEC', type: 'security', occurrences: ['architectural-review-attempt-1:1'], defectDisposition: 'addressed', remedyDisposition: 'accepted', 'persistent-machinery': 'no', architectPending: true }] };
    expect(checkFindingLedgerGuard(fixture.texts, JSON.stringify(good), ledgerOptions(fixture)).ok).toBe(true);
    const { remoteAuthorities, ...withoutRemoteAuthority } = ledgerOptions(fixture);
    void remoteAuthorities;
    expect(checkFindingLedgerGuard(fixture.texts, JSON.stringify(good), withoutRemoteAuthority).ok).toBe(true);
    const truncated = [...fixture.texts]; truncated[3] += 'x';
    expect(checkFindingLedgerGuard(truncated, JSON.stringify(good), ledgerOptions(fixture)).errors.join('\n')).toMatch(/byteLength mismatch|sha256 mismatch/);
    const bad = { version: 2, counts: { rawFindingCount: 1, distinctFindingCount: 2, processedDistinctCount: 2 }, findings: [{ ...good.findings[0], type: 'quality' }, { id: 'DECOY', type: 'security', occurrences: [], defectDisposition: 'addressed', remedyDisposition: 'accepted', 'persistent-machinery': 'no' }] };
    const errors = checkFindingLedgerGuard(fixture.texts, JSON.stringify(bad), ledgerOptions(fixture)).errors.join('\n');
    expect(errors).toMatch(/cannot be reclassified/); expect(errors).toMatch(/has no mapped occurrence/);
  });

  it('executes the documented receipt-backed CLI', () => {
    const dir = mkdtempSync(join(tmpdir(), 'opk-1150-'));
    const previousStateRoot = process.env.OPK_CREATE_ISSUE_DRAFT_STATE_ROOT;
    const stateRoot = join(dir, 'state');
    const canonical = join(stateRoot, '.review', '1150');
    try {
      process.env.OPK_CREATE_ISSUE_DRAFT_STATE_ROOT = stateRoot;
      const fixture = preLens();
      mkdirSync(canonical, { recursive: true });
      writeFileSync(join(canonical, 'tier-intake.json'), JSON.stringify(fixture.authority.tierIntake));
      fixture.receipts.forEach((item, index) => writeFileSync(join(canonical, `stage-completeness-receipt-${index + 1}.json`), JSON.stringify(item)));
      writeFileSync(join(dir, 'verified-relay-evidence.json'), JSON.stringify(fixture.relay));
      fixture.captures.forEach((item, index) => writeFileSync(join(dir, item.name), fixture.texts[index]!));
      writeFileSync(join(dir, 'ledger.json'), JSON.stringify({ version: 2, counts: { rawFindingCount: 0, distinctFindingCount: 0, processedDistinctCount: 0 }, findings: [] }));
      expect(runFindingLedgerCli(['node', 'scripts/finding-ledger-guard.mjs', '--ledger', join(dir, 'ledger.json'), '--captures-dir', dir, '--phase', 'pre-lens', '--stage-terminal', '--receipt-directory', canonical, '--tier-intake', join(canonical, 'tier-intake.json'), '--verified-relay-evidence', join(dir, 'verified-relay-evidence.json')])).toBe(0);
    } finally {
      if (previousStateRoot === undefined) delete process.env.OPK_CREATE_ISSUE_DRAFT_STATE_ROOT;
      else process.env.OPK_CREATE_ISSUE_DRAFT_STATE_ROOT = previousStateRoot;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});


describe('Issue #1287 acceptance inventory parity', () => {
  it('keeps the Skill inventory aligned with acceptance inputs and outputs', () => {
    const skill = readFileSync(join(process.cwd(), '.claude/skills/create-issue-draft/SKILL.md'), 'utf8');
    const start = skill.indexOf('## Review artifacts');
    const end = skill.indexOf('## GitHub issue journal', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const inventory = skill.slice(start, end);
    const producerOutputs = inventory.slice(inventory.indexOf('### Producer outputs'), inventory.indexOf('### Conditional evidence/waiver'));

    for (const input of ACCEPTANCE_ARTIFACT_REQUIRED_INPUTS) {
      expect(inventory).toContain(input.file);
      expect(inventory).toContain(`(\`${input.schema}\`)`);
      expect(inventory).toContain(input.classification);
      expect(stageFinalizeUsage()).toContain(input.flag);
    }
    expect(producerOutputs).toContain('stage-completeness-receipt-<stageAttemptId>.json');
    for (const output of ACCEPTANCE_ARTIFACT_OUTPUT_NAMES) expect(producerOutputs).toContain(output);
    expect(inventory).toContain('Do not persist an episode receipt or consolidated reviewer output.');
  });
});
