import { describe, expect, it } from 'vitest';
import {
  buildReviewLaneRouting,
  classifyReviewLaneDeclaration,
  normalizeReviewLaneDeclaration,
  reviewLaneClassifierPolicyIdentity,
  type ReviewLaneAuthorDeclaration,
} from './review-lane-routing.ts';
import { parseConsumableStageReceipt } from './create-issue-stage-record-receipt.ts';
import { validateReviewLaneRecord } from './review-lane-record.ts';
import { createMockGhState, createMockTransport, makeTempDir } from './create-issue-stage-record-test-helpers.ts';
import { publishSettledStageRecord, startReviewCycle } from './create-issue-stage-record-core.ts';
import { deriveReviewEpisodeState, validateReviewEpisodeTopology } from './stage-completeness-core.ts';

const declaration = (entries: ReviewLaneAuthorDeclaration['entries']): ReviewLaneAuthorDeclaration => ({
  schema: 'review-lane-change-set/v1',
  owner: 'issue-author',
  entries,
});

const issueBody = `revision r01

\`\`\`review-lane-change-set
schema: review-lane-change-set/v1
owner: issue-author
entries:
- kind: exact
  path: docs/review-lanes.md
  behaviors: [documentation-only]
\`\`\``;

const familyIssueBody = `revision r01

\`\`\`review-lane-change-set
schema: review-lane-change-set/v1
owner: issue-author
entries:
- kind: family
  path: scripts/lib/review-lane-*.ts
  behaviors: [pure-review-lane-selection]
\`\`\``;

function routedFixture() {
  const input = normalizeReviewLaneDeclaration(declaration([
    { kind: 'family', path: 'scripts/lib/review-lane-*.ts', behaviors: ['pure-review-lane-selection'] },
  ]));
  const classification = classifyReviewLaneDeclaration(declaration([
    { kind: 'family', path: 'scripts/lib/review-lane-*.ts', behaviors: ['pure-review-lane-selection'] },
  ]));
  if (input.status !== 'usable') throw new Error('routing fixture input must be usable');
  const routing = buildReviewLaneRouting({ ...input, identity: `r01:${input.identity}` }, classification, 'r01', 'attempt-1');
  const settlement = {
    ok: true,
    conflictDecision: 'no-conflict' as const,
    finalRequiredSlots: ['01', '02'],
    slotCensus: [
      { slot: '01', state: 'activated' as const },
      { slot: '02', state: 'activated' as const },
      { slot: '03', state: 'not-activated' as const },
    ],
    errors: [],
  };
  return {
    routing,
    finalRequiredSlots: ['01', '02'],
    sourceVerdicts: { '01': 'accept' as const, '02': 'accept' as const },
    sourceVerdictEvidence: {
      '01': { producerEvidenceIdentity: 'producer-01', captureIdentity: 'capture-01', terminalClassification: 'complete', captureVerified: true, digestMatches: true, verdictText: 'NO_FINDINGS', rawFindingCount: 0 },
      '02': { producerEvidenceIdentity: 'producer-02', captureIdentity: 'capture-02', terminalClassification: 'complete', captureVerified: true, digestMatches: true, verdictText: 'NO_FINDINGS', rawFindingCount: 0 },
    },
    conflictDecision: 'no-conflict' as const,
    settlement,
  };
}

describe('review-lane production activation', () => {
  it('routes before cycle publication and returns the immutable evidence', () => {
    const state = createMockGhState({ issue: { title: 't', body: issueBody, labels: [] } });
    const result = startReviewCycle(createMockTransport(state), {
      repo: 'chetwerikoff/orchestrator-pack',
      issueNumber: 1201,
      sourceRevision: 'r01',
      tier: 'T2',
      publicActor: 'cursor-flow-manager',
      stageAttemptId: 'attempt-1',
      workdir: makeTempDir(),
    });
    expect(result.ok).toBe(true);
    expect(result.reviewLaneRouting?.stageAttemptId).toBe('attempt-1');
    expect(state.comments[0]?.body).toContain('routed-lane');
  });

  it('retries the bounded freeze after inconsistent live Issue reads', () => {
    const state = createMockGhState({ issue: { title: 't', body: issueBody, labels: [] } });
    const base = createMockTransport(state);
    let issueReads = 0;
    const transport = {
      runGh(argv: string[]) {
        if (argv[1] === 'api' && argv.includes('--jq') && (argv[2] ?? '').includes('/issues/')) {
          issueReads += 1;
          if (issueReads === 1) {
            return { exitCode: 0, stdout: JSON.stringify({ title: 't', body: issueBody, labels: [] }), stderr: '' };
          }
          if (issueReads === 2) {
            const changed = issueBody.replace('revision r01', 'revision r02');
            return { exitCode: 0, stdout: JSON.stringify({ title: 't', body: changed, labels: [] }), stderr: '' };
          }
        }
        return base.runGh(argv);
      },
    };
    const result = startReviewCycle(transport, {
      repo: 'chetwerikoff/orchestrator-pack', issueNumber: 1201, sourceRevision: 'r01', tier: 'T2',
      publicActor: 'cursor-flow-manager', stageAttemptId: 'attempt-1', workdir: makeTempDir(),
    });
    expect(result.ok).toBe(true);
    expect(issueReads).toBeGreaterThanOrEqual(4);
  });

  it('rejects a stale caller revision before publishing any cycle', () => {
    const state = createMockGhState({ issue: { title: 't', body: familyIssueBody, labels: [] } });
    const result = startReviewCycle(createMockTransport(state), {
      repo: 'chetwerikoff/orchestrator-pack',
      issueNumber: 1201,
      sourceRevision: 'r00',
      tier: 'T2',
      publicActor: 'cursor-flow-manager',
      stageAttemptId: 'attempt-1',
      workdir: makeTempDir(),
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((item) => item.message).join('\n')).toContain('disagrees with live Issue revision');
    expect(state.comments).toHaveLength(0);
  });

  it('passes a permitted lane override through start-cycle routing', () => {
    const state = createMockGhState({ issue: { title: 't', body: issueBody, labels: [] } });
    const result = startReviewCycle(createMockTransport(state), {
      repo: 'chetwerikoff/orchestrator-pack',
      issueNumber: 1201,
      sourceRevision: 'r01',
      tier: 'T2',
      publicActor: 'cursor-flow-manager',
      stageAttemptId: 'attempt-1',
      permittedLaneOverride: 'disputed',
      workdir: makeTempDir(),
    });
    expect(result.ok).toBe(true);
    expect(result.reviewLaneRouting).toMatchObject({ lane: 'disputed', reviewerCardinality: 3 });
    expect(result.reviewLaneRouting?.classifierIdentity).toBe(reviewLaneClassifierPolicyIdentity());
  });

  it('does not publish a cycle when pre-attempt routing cannot be produced', () => {
    const state = createMockGhState({ issue: { title: 't', body: 'revision r01 without declaration', labels: [] } });
    const result = startReviewCycle(createMockTransport(state), {
      repo: 'chetwerikoff/orchestrator-pack',
      issueNumber: 1201,
      sourceRevision: 'r01',
      tier: 'T2',
      publicActor: 'cursor-flow-manager',
      stageAttemptId: 'attempt-1',
      workdir: makeTempDir(),
    });
    expect(result.ok).toBe(false);
    expect(state.comments).toHaveLength(0);
  });

  it('rejects a new-policy receipt with no routed evidence', () => {
    const receipt = {
      tier: 'T2',
      stage: 'architectural',
      cycleId: 'cycle-1',
      stageAttemptId: 'attempt-1',
      policyVersion: 'review-lane-routing/v1',
      sourceRevision: 'r01',
      outcome: 'complete',
      reviewerCardinality: 1,
      completedSourceCount: 1,
      cycleBinding: { cycleId: 'cycle-1', sourceRevision: 'r01', boundBeforeLaunch: true },
      producerEvidence: 'not-applicable',
      tierTransition: 'none',
    };
    expect(parseConsumableStageReceipt(receipt).receipt).toBeNull();
  });

  it('rejects a claimed successful settlement when a source is blocked', () => {
    const routed = routedFixture();
    expect(validateReviewLaneRecord({
      ...routed,
      sourceVerdicts: { '01': 'blocked' as const, '02': 'accept' as const },
    })).toMatchObject({ ok: false });
  });

  it('collapses identical declaration entries before blast-radius counting', () => {
    const duplicateEntries = Array.from({ length: 7 }, () => ({
      kind: 'exact' as const,
      path: 'docs/review-lanes.md',
      behaviors: ['documentation-only'],
    }));
    const normalized = normalizeReviewLaneDeclaration(declaration(duplicateEntries));
    expect(normalized.status).toBe('usable');
    if (normalized.status === 'usable') expect(normalized.blastRadius).toBe('low');
  });

  it('requires the immutable route on every invocation envelope of a routed receipt', () => {
    const routed = routedFixture();
    const capture = (slot: string) => ({
      captureIdentity: `capture-${slot}`,
      name: `pass-1-competitive-${slot}.capture.txt`,
      byteLength: 1,
      sha256: '0'.repeat(64),
      rawFindingCount: 0,
    });
    const invocations = ['01', '02'].map((slot) => ({
      schema: 'reviewer-invocation-envelope/v1',
      reviewEpisodeId: 'task@r00',
      stageAttemptId: 'attempt-1',
      policyVersion: 'review-lane-routing/v1',
      reviewerCardinality: 3,
      cardinalityConfigIdentity: routed.routing.cardinalityConfigIdentity,
      stage: 'competitive',
      sourceRevision: 'r01',
      invocationId: `invocation-${slot}`,
      terminalResultIdentity: `terminal-${slot}`,
      reviewerSource: `source-${slot}`,
      reviewerSlot: slot,
      reviewerOrdinal: Number(slot),
      attemptOrdinal: 1,
      retryAttempt: false,
      terminal: true,
      terminalClassification: 'complete',
      sendCount: 1,
      retryClass: 'none',
      revisionCheck: 'matched',
      capacityOutcome: 'admitted',
      capacityWaitMs: 0,
      capture: capture(slot),
      reviewLaneRouting: routed.routing,
    }));
    const receipt = {
      schema: 'stage-completeness-receipt/v1',
      tier: 'T3',
      taskIdentity: 'task',
      episodeFirstRevision: 'r00',
      reviewEpisodeId: 'task@r00',
      stageReceiptId: 'task@r00:stage-receipt:0001',
      previousStageReceiptId: null,
      receiptCensus: ['task@r00:stage-receipt:0001'],
      stageAttemptId: 'attempt-1',
      stageSequence: 1,
      stage: 'competitive',
      policyVersion: 'review-lane-routing/v1',
      reviewerCardinality: 3,
      cardinalityConfigIdentity: routed.routing.cardinalityConfigIdentity,
      sourceRevision: 'r01',
      outcome: 'complete',
      revisionChecks: { attemptCreation: 'matched', beforeLaunch: 'matched', settlement: 'matched' },
      settlement: { allLaunchedTerminal: true, retryState: 'none', finalRevisionMatched: true },
      invocations,
      credentialingCaptures: invocations.map((invocation) => invocation.capture),
      relayEligibleCaptures: invocations.map((invocation) => invocation.capture),
      reviewLane: routed,
    };
    const withoutRoute = { ...receipt, invocations: invocations.map((invocation, index) => index === 0 ? (() => {
      const { reviewLaneRouting: _ignored, ...legacy } = invocation;
      return legacy;
    })() : invocation) };
    const result = deriveReviewEpisodeState([withoutRoute], [], {
      tierIntake: { schema: 'tier-intake/v1', producer: 'test', taskIdentity: 'task', kind: 'fresh', priorTier: 'T3', firstRevision: 'r00' },
      receiptInventory: { source: 'canonical-review-directory', taskIdentity: 'task', episodeFirstRevision: 'r00', reviewEpisodeId: 'task@r00', stageReceiptIds: ['task@r00:stage-receipt:0001'] },
    });
    expect(result.errors.join('\n')).toContain('missing immutable reviewLaneRouting evidence');
    expect(deriveReviewEpisodeState([receipt], [], {
      tierIntake: { schema: 'tier-intake/v1', producer: 'test', taskIdentity: 'task', kind: 'fresh', priorTier: 'T3', firstRevision: 'r00' },
      receiptInventory: { source: 'canonical-review-directory', taskIdentity: 'task', episodeFirstRevision: 'r00', reviewEpisodeId: 'task@r00', stageReceiptIds: ['task@r00:stage-receipt:0001'] },
    }).errors.join('\n')).not.toContain('reviewLaneRouting');
  });

  it('keeps a legacy cycle and triple-source receipt publishable', () => {
    const state = createMockGhState({ issue: { title: 't', body: issueBody, labels: [] } });
    const transport = createMockTransport(state);
    const cycle = startReviewCycle(transport, {
      repo: 'chetwerikoff/orchestrator-pack',
      issueNumber: 1201,
      sourceRevision: 'r01',
      tier: 'T3',
      publicActor: 'cursor-flow-manager',
      workdir: makeTempDir(),
    });
    expect(cycle.ok).toBe(true);
    const published = publishSettledStageRecord(transport, {
      repo: 'chetwerikoff/orchestrator-pack',
      issueNumber: 1201,
      receipt: {
        tier: 'T3',
        stage: 'competitive',
        cycleId: cycle.cycleId,
        stageAttemptId: 'legacy-attempt-1',
        policyVersion: 'triple-source/v1',
        sourceRevision: 'r01',
        outcome: 'complete',
        reviewerCardinality: 3,
        completedSourceCount: 3,
        cycleBinding: { cycleId: cycle.cycleId, sourceRevision: 'r01', boundBeforeLaunch: true },
        producerEvidence: 'not-applicable',
        tierTransition: 'none',
      },
      workdir: makeTempDir(),
    });
    expect(published.ok).toBe(true);
    expect(state.comments.some((comment) => comment.body.includes('create-issue-stage-record/v1'))).toBe(true);
  });

  it('accepts one full routed receipt through both parsers and publishes the stage event', () => {
    const state = createMockGhState({ issue: { title: 't', body: familyIssueBody, labels: [] } });
    const transport = createMockTransport(state);
    const cycle = startReviewCycle(transport, {
      repo: 'chetwerikoff/orchestrator-pack',
      issueNumber: 1201,
      sourceRevision: 'r01',
      tier: 'T3',
      publicActor: 'cursor-flow-manager',
      stageAttemptId: 'attempt-1',
      workdir: makeTempDir(),
    });
    expect(cycle.ok).toBe(true);
    const routed = routedFixture();
    const capture = (slot: string) => ({
      captureIdentity: `capture-${slot}`,
      name: `pass-1-competitive-${slot}.capture.txt`,
      byteLength: 1,
      sha256: '0'.repeat(64),
      rawFindingCount: 0,
    });
    const invocations = ['01', '02'].map((slot) => ({
      schema: 'reviewer-invocation-envelope/v1',
      reviewEpisodeId: 'task@r00',
      stageAttemptId: 'attempt-1',
      policyVersion: 'review-lane-routing/v1',
      reviewerCardinality: 3,
      cardinalityConfigIdentity: routed.routing.cardinalityConfigIdentity,
      stage: 'competitive',
      sourceRevision: 'r01',
      invocationId: `end-to-end-invocation-${slot}`,
      terminalResultIdentity: `end-to-end-terminal-${slot}`,
      reviewerSource: `source-${slot}`,
      reviewerSlot: slot,
      reviewerOrdinal: Number(slot),
      attemptOrdinal: 1,
      retryAttempt: false,
      terminal: true,
      terminalClassification: 'complete',
      sendCount: 1,
      retryClass: 'none',
      revisionCheck: 'matched',
      capacityOutcome: 'admitted',
      capacityWaitMs: 0,
      capture: capture(slot),
      reviewLaneRouting: routed.routing,
    }));
    const stageReceipt = {
      schema: 'stage-completeness-receipt/v1',
      tier: 'T3',
      taskIdentity: 'task',
      episodeFirstRevision: 'r00',
      reviewEpisodeId: 'task@r00',
      stageReceiptId: 'task@r00:stage-receipt:0001',
      previousStageReceiptId: null,
      receiptCensus: ['task@r00:stage-receipt:0001'],
      stageAttemptId: 'attempt-1',
      stageSequence: 1,
      stage: 'competitive',
      policyVersion: 'review-lane-routing/v1',
      reviewerCardinality: 3,
      cardinalityConfigIdentity: routed.routing.cardinalityConfigIdentity,
      sourceRevision: 'r01',
      outcome: 'complete',
      revisionChecks: { attemptCreation: 'matched', beforeLaunch: 'matched', settlement: 'matched' },
      settlement: { allLaunchedTerminal: true, retryState: 'none', finalRevisionMatched: true },
      invocations,
      credentialingCaptures: invocations.map((invocation) => invocation.capture),
      relayEligibleCaptures: invocations.map((invocation) => invocation.capture),
      reviewLane: routed,
    };
    const authority = {
      tierIntake: { schema: 'tier-intake/v1' as const, producer: 'test', taskIdentity: 'task', kind: 'fresh' as const, priorTier: 'T3' as const, firstRevision: 'r00' },
      receiptInventory: { source: 'canonical-review-directory' as const, taskIdentity: 'task', episodeFirstRevision: 'r00', reviewEpisodeId: 'task@r00', stageReceiptIds: ['task@r00:stage-receipt:0001'] },
    };
    const episode = deriveReviewEpisodeState([stageReceipt], [], authority);
    expect(episode.errors.join('\n')).not.toContain('reviewLane');
    expect(episode.activationReady).toBe(false);
    expect(validateReviewEpisodeTopology({ ...episode, activationReady: false }, 'final-acceptance').join('\n')).toContain('review-lane-routing/v1 final acceptance is blocked');
    const published = publishSettledStageRecord(transport, {
      repo: 'chetwerikoff/orchestrator-pack',
      issueNumber: 1201,
      receipt: {
        tier: 'T3',
        stage: 'competitive',
        cycleId: cycle.cycleId,
        stageAttemptId: 'attempt-1',
        policyVersion: 'review-lane-routing/v1',
        sourceRevision: 'r01',
        outcome: 'complete',
        reviewerCardinality: 3,
        completedSourceCount: 2,
        cycleBinding: { cycleId: cycle.cycleId, sourceRevision: 'r01', boundBeforeLaunch: true },
        producerEvidence: 'not-applicable',
        tierTransition: 'none',
        reviewLane: routed,
      },
      workdir: makeTempDir(),
    });
    expect(published.ok).toBe(true);
    expect(state.comments.some((comment) => comment.body.includes('create-issue-stage-record/v1'))).toBe(true);
  });

  it('rejects full reviewLane evidence on a legacy policy receipt', () => {
    const routed = routedFixture();
    const parsed = parseConsumableStageReceipt({
      tier: 'T3',
      stage: 'competitive',
      cycleId: 'cycle-1',
      stageAttemptId: 'attempt-1',
      policyVersion: 'triple-source/v1',
      sourceRevision: 'r01',
      outcome: 'complete',
      reviewerCardinality: 3,
      completedSourceCount: 2,
      cycleBinding: { cycleId: 'cycle-1', sourceRevision: 'r01', boundBeforeLaunch: true },
      producerEvidence: 'not-applicable',
      tierTransition: 'none',
      reviewLane: routed,
    });
    expect(parsed.receipt).toBeNull();
    expect(parsed.errors.join('\n')).toContain('legacy');
  });

  it('rejects a routed receipt when the cycle has no immutable route', () => {
    const state = createMockGhState({ issue: { title: 't', body: familyIssueBody, labels: [] } });
    const transport = createMockTransport(state);
    const cycle = startReviewCycle(transport, {
      repo: 'chetwerikoff/orchestrator-pack',
      issueNumber: 1201,
      sourceRevision: 'r01',
      tier: 'T3',
      publicActor: 'cursor-flow-manager',
      workdir: makeTempDir(),
    });
    expect(cycle.ok).toBe(true);
    const routed = routedFixture();
    const published = publishSettledStageRecord(transport, {
      repo: 'chetwerikoff/orchestrator-pack',
      issueNumber: 1201,
      receipt: {
        tier: 'T3',
        stage: 'competitive',
        cycleId: cycle.cycleId,
        stageAttemptId: 'attempt-1',
        policyVersion: 'review-lane-routing/v1',
        sourceRevision: 'r01',
        outcome: 'complete',
        reviewerCardinality: 3,
        completedSourceCount: 2,
        cycleBinding: { cycleId: cycle.cycleId, sourceRevision: 'r01', boundBeforeLaunch: true },
        producerEvidence: 'not-applicable',
        tierTransition: 'none',
        reviewLane: routed,
      },
      workdir: makeTempDir(),
    });
    expect(published.ok).toBe(false);
    expect(published.diagnostics.map((item) => item.message).join('\n')).toContain('requires an immutable routed cycle');
  });

  it('rejects source verdicts that disagree with independently supplied producer evidence', () => {
    const routed = routedFixture();
    const evidence = {
      '01': { producerEvidenceIdentity: 'producer-01', captureIdentity: 'capture-01', terminalClassification: 'complete', captureVerified: true, digestMatches: true, verdictText: 'NO_FINDINGS', rawFindingCount: 0 },
      '02': { producerEvidenceIdentity: 'producer-02', captureIdentity: 'capture-02', terminalClassification: 'complete', captureVerified: true, digestMatches: true, verdictText: 'NO_FINDINGS', rawFindingCount: 0 },
    };
    const parsed = parseConsumableStageReceipt({
      tier: 'T3', stage: 'competitive', cycleId: 'cycle-1', stageAttemptId: 'attempt-1',
      policyVersion: 'review-lane-routing/v1', sourceRevision: 'r01', outcome: 'complete',
      reviewerCardinality: 3, completedSourceCount: 2,
      cycleBinding: { cycleId: 'cycle-1', sourceRevision: 'r01', boundBeforeLaunch: true },
      producerEvidence: 'not-applicable', tierTransition: 'none',
      reviewLane: { ...routed, sourceVerdicts: { '01': 'material-findings', '02': 'material-findings' }, sourceVerdictEvidence: evidence },
    });
    expect(parsed.receipt).toBeNull();
    expect(parsed.errors.join('\n')).toContain('producer evidence');
  });

  it('rejects a routed receipt whose outer stage attempt disagrees with routing evidence', () => {
    const routed = routedFixture();
    const parsed = parseConsumableStageReceipt({
      tier: 'T3', stage: 'competitive', cycleId: 'cycle-1', stageAttemptId: 'attempt-2',
      policyVersion: 'review-lane-routing/v1', sourceRevision: 'r01', outcome: 'complete',
      reviewerCardinality: 3, completedSourceCount: 2,
      cycleBinding: { cycleId: 'cycle-1', sourceRevision: 'r01', boundBeforeLaunch: true },
      producerEvidence: 'not-applicable', tierTransition: 'none', reviewLane: routed,
    });
    expect(parsed.receipt).toBeNull();
    expect(parsed.errors.join('\n')).toContain('stageAttemptId');
  });

  it('rejects a legacy receipt on a routed cycle head', () => {
    const state = createMockGhState({ issue: { title: 't', body: issueBody, labels: [] } });
    const transport = createMockTransport(state);
    const cycle = startReviewCycle(transport, {
      repo: 'chetwerikoff/orchestrator-pack',
      issueNumber: 1201,
      sourceRevision: 'r01',
      tier: 'T2',
      publicActor: 'cursor-flow-manager',
      stageAttemptId: 'attempt-1',
      workdir: makeTempDir(),
    });
    expect(cycle.ok).toBe(true);
    const publication = publishSettledStageRecord(transport, {
      repo: 'chetwerikoff/orchestrator-pack',
      issueNumber: 1201,
      receipt: {
        tier: 'T2',
        stage: 'architectural',
        cycleId: cycle.cycleId,
        stageAttemptId: 'attempt-1',
        policyVersion: 'single-source/v1',
        sourceRevision: 'r01',
        outcome: 'complete',
        reviewerCardinality: 1,
        completedSourceCount: 1,
        cycleBinding: { cycleId: cycle.cycleId, sourceRevision: 'r01', boundBeforeLaunch: true },
        producerEvidence: 'not-applicable',
        tierTransition: 'none',
      },
      workdir: makeTempDir(),
    });
    expect(publication.ok).toBe(false);
    expect(publication.diagnostics.map((item) => item.message).join('\n')).toMatch(/routed cycle head requires/);
  });

  it('rejects publication when receipt routing disagrees with the cycle route', () => {
    const state = createMockGhState({ issue: { title: 't', body: issueBody, labels: [] } });
    const transport = createMockTransport(state);
    const cycle = startReviewCycle(transport, {
      repo: 'chetwerikoff/orchestrator-pack',
      issueNumber: 1201,
      sourceRevision: 'r01',
      tier: 'T2',
      publicActor: 'cursor-flow-manager',
      stageAttemptId: 'attempt-1',
      workdir: makeTempDir(),
    });
    expect(cycle.ok).toBe(true);
    const routed = routedFixture();
    const publication = publishSettledStageRecord(transport, {
      repo: 'chetwerikoff/orchestrator-pack',
      issueNumber: 1201,
      receipt: {
        tier: 'T2',
        stage: 'architectural',
        cycleId: cycle.cycleId,
        stageAttemptId: 'attempt-1',
        policyVersion: 'review-lane-routing/v1',
        sourceRevision: 'r01',
        outcome: 'complete',
        reviewerCardinality: 3,
        completedSourceCount: 2,
        cycleBinding: { cycleId: cycle.cycleId, sourceRevision: 'r01', boundBeforeLaunch: true },
        producerEvidence: 'not-applicable',
        tierTransition: 'none',
        reviewLane: routed,
      },
      workdir: makeTempDir(),
    });
    expect(publication.ok).toBe(false);
    expect(publication.diagnostics.map((item) => item.message).join('\n')).toContain('immutable cycle route');
  });

  it('requires capture identity on completed source verdict evidence', () => {
    const routed = routedFixture();
    const evidence = { ...routed.sourceVerdictEvidence, '01': { ...routed.sourceVerdictEvidence['01'], captureIdentity: undefined } };
    expect(validateReviewLaneRecord({ ...routed, sourceVerdictEvidence: evidence })).toMatchObject({ ok: false });
  });

  it('rejects partial routed evidence and contradictory source counts', () => {
    const routed = routedFixture();
    expect(validateReviewLaneRecord({ routing: routed.routing })).toMatchObject({ ok: false });
    expect(validateReviewLaneRecord({
      ...routed,
      routing: {
        ...routed.routing,
        initiallyActivatedSlots: ['01', '03'],
      },
    })).toMatchObject({ ok: false });
    const valid = parseConsumableStageReceipt({
      tier: 'T2',
      stage: 'architectural',
      cycleId: 'cycle-1',
      stageAttemptId: 'attempt-1',
      policyVersion: 'review-lane-routing/v1',
      sourceRevision: 'r01',
      outcome: 'complete',
      reviewerCardinality: 3,
      completedSourceCount: 2,
      cycleBinding: { cycleId: 'cycle-1', sourceRevision: 'r01', boundBeforeLaunch: true },
      producerEvidence: 'not-applicable',
      tierTransition: 'none',
      reviewLane: routed,
    });
    expect(valid.receipt).not.toBeNull();
    const parsed = parseConsumableStageReceipt({
      tier: 'T2',
      stage: 'architectural',
      cycleId: 'cycle-1',
      stageAttemptId: 'attempt-1',
      policyVersion: 'review-lane-routing/v1',
      sourceRevision: 'r01',
      outcome: 'complete',
      reviewerCardinality: 3,
      completedSourceCount: 3,
      cycleBinding: { cycleId: 'cycle-1', sourceRevision: 'r01', boundBeforeLaunch: true },
      producerEvidence: 'not-applicable',
      tierTransition: 'none',
      reviewLane: routed,
    });
    expect(parsed.receipt).toBeNull();
    expect(parsed.errors.join('\n')).toMatch(/completed source count|review-lane/);
  });
});
