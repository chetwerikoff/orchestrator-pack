// @vitest-ci-lane light
// @vitest-pre-topology-seconds 120
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PACK_REVIEW_CAP_MAP_VERSION,
  PACK_REVIEW_LEGACY_CAP_MAP_VERSION,
  acknowledgePackReviewReset,
  commitPackReviewTerminal,
  createInitialPackReviewAuthority,
  initializePackReviewAuthority,
  observePackReviewHead,
  readPackReviewAuthority,
  retainPersistedOpenCycle,
  selectPackReviewGptSourceCardinality,
  selectPackReviewEvidence,
  stagePackReviewImmutableRecord,
  terminalConsumesCapSlot,
  validateTerminalV2,
} from './pack-review-state.ts';
import {
  createPackReviewRun,
  getPackReviewRun,
  setPackReviewRunTerminal,
  updatePackReviewRun,
  validatePersistedPackReviewGptAggregate,
  type PackReviewGptRoundRecord,
} from './lib/pack-review-run-store.ts';

const roots: string[] = [];
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sha = (char: string) => char.repeat(40);
const options = () => {
  const storeRoot = mkdtempSync(join(tmpdir(), 'pack-review-state-test-'));
  roots.push(storeRoot);
  return { storeRoot, now: new Date('2026-08-03T00:00:00.000Z') };
};
const findingsTerminal = (runId: string, targetSha: string) => ({
  schemaVersion: 1 as const,
  terminalContractVersion: 2 as const,
  terminalSource: 'normal' as const,
  runId,
  targetSha,
  reviewVerdict: 'findings' as const,
  findingCount: 1,
  findingsDigest: `findings-${runId}`,
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Issue #898 authority and cap state', () => {
  it('preserves issue 1063 caps for new cycles and retains open frozen cap without retroactive rewrite', () => {
    const current = createInitialPackReviewAuthority({
      prNumber: 898,
      headSha: sha('a'),
      tier: 'T3',
      options: options(),
    });
    expect(current.cycle).toMatchObject({
      frozenTier: 'T3',
      frozenCap: 4,
      capMapVersion: PACK_REVIEW_CAP_MAP_VERSION,
    });

    const retained = retainPersistedOpenCycle({
      cycleId: 'legacy-cycle',
      state: 'open',
      frozenTier: 'T1',
      frozenCap: 2,
      openedAtUtc: '2026-08-01T00:00:00.000Z',
      consumedHeadShas: [sha('b')],
    });
    expect(retained).toMatchObject({
      frozenCap: 2,
      capMapVersion: PACK_REVIEW_LEGACY_CAP_MAP_VERSION,
      frozenMapOrigin: 'persisted-open-cycle',
      consumedHeadShas: [sha('b')],
    });
  });

  it('opens a fresh cycle when a clean head changes', () => {
    const storeOptions = options();
    let state = initializePackReviewAuthority({
      prNumber: 898,
      headSha: sha('a'),
      tier: 'T1',
      options: storeOptions,
    });
    state = commitPackReviewTerminal({
      prNumber: 898,
      expectedTransitionSeq: state.transitionSeq,
      terminal: {
        schemaVersion: 1,
        terminalContractVersion: 2,
        terminalSource: 'normal',
        runId: 'clean-run-a',
        targetSha: sha('a'),
        reviewVerdict: 'clean',
        findingCount: 0,
        findingsDigest: 'clean',
      },
      status: 'clean',
      findingCount: 0,
      options: storeOptions,
    });
    const closedCycleId = state.cycle!.cycleId;
    expect(state.cycle?.state).toBe('closed');

    state = observePackReviewHead({
      prNumber: 898,
      expectedTransitionSeq: state.transitionSeq,
      headSha: sha('b'),
      options: storeOptions,
    });

    expect(state.cycle).toMatchObject({
      state: 'open',
      frozenTier: 'T1',
      frozenCap: 1,
      consumedHeadShas: [],
    });
    expect(state.cycle?.cycleId).not.toBe(closedCycleId);
  });

  it('latches at cap, denies an extra consuming terminal, and keeps the latch after head shift', () => {
    const storeOptions = options();
    let state = initializePackReviewAuthority({
      prNumber: 898,
      headSha: sha('a'),
      tier: 'T1',
      options: storeOptions,
    });
    state = commitPackReviewTerminal({
      prNumber: 898,
      expectedTransitionSeq: state.transitionSeq,
      terminal: findingsTerminal('run-a', sha('a')),
      status: 'changes_requested',
      findingCount: 1,
      options: storeOptions,
    });
    expect(state.cycle).toMatchObject({
      frozenCap: 1,
      state: 'at_cap_open_findings',
      consumedHeadShas: [sha('a')],
    });
    expect(state.cycle?.atCapHash).toMatch(/^[0-9a-f]{64}$/);

    state = observePackReviewHead({
      prNumber: 898,
      expectedTransitionSeq: state.transitionSeq,
      headSha: sha('b'),
      options: storeOptions,
    });
    expect(state.cycle).toMatchObject({
      state: 'at_cap_continuation_required',
      frozenCap: 1,
      consumedHeadShas: [sha('a')],
    });
    expect(() => commitPackReviewTerminal({
      prNumber: 898,
      expectedTransitionSeq: state.transitionSeq,
      terminal: findingsTerminal('run-b', sha('b')),
      status: 'changes_requested',
      findingCount: 1,
      options: storeOptions,
    })).toThrow(/cap_exhausted/);
  });

  it('ACK_RESET is the audited at-cap empty-cycle boundary and adopts live 1/2/4', () => {
    const storeOptions = options();
    let state = initializePackReviewAuthority({
      prNumber: 898,
      headSha: sha('a'),
      tier: 'T1',
      options: storeOptions,
    });
    state = commitPackReviewTerminal({
      prNumber: 898,
      expectedTransitionSeq: state.transitionSeq,
      terminal: findingsTerminal('run-a', sha('a')),
      status: 'changes_requested',
      findingCount: 1,
      options: storeOptions,
    });
    const priorCycleId = state.cycle!.cycleId;
    const priorAtCapHash = state.cycle!.atCapHash!;
    state = acknowledgePackReviewReset({
      prNumber: 898,
      expectedTransitionSeq: state.transitionSeq,
      headSha: sha('b'),
      tier: 'T2',
      provenance: {
        priorCycleId,
        priorAtCapHash,
        actor: 'operator',
        reason: 'audited reset',
        timestampUtc: '2026-08-03T00:01:00.000Z',
        nonce: 'nonce-1',
      },
      options: storeOptions,
    });
    expect(state.cycle).toMatchObject({
      state: 'open',
      frozenTier: 'T2',
      frozenCap: 2,
      capMapVersion: PACK_REVIEW_CAP_MAP_VERSION,
      consumedHeadShas: [],
    });
    expect(state.cycle?.cycleId).not.toBe(priorCycleId);
  });

  it('uses transitionSeq compare-and-swap and persists one canonical authority document', () => {
    const storeOptions = options();
    const initial = initializePackReviewAuthority({
      prNumber: 898,
      headSha: sha('a'),
      tier: 'T2',
      options: storeOptions,
    });
    const next = observePackReviewHead({
      prNumber: 898,
      expectedTransitionSeq: initial.transitionSeq,
      headSha: sha('b'),
      options: storeOptions,
    });
    expect(next.transitionSeq).toBe(1);
    expect(() => observePackReviewHead({
      prNumber: 898,
      expectedTransitionSeq: initial.transitionSeq,
      headSha: sha('c'),
      options: storeOptions,
    })).toThrow(/authority_transition_conflict/);
    expect(readPackReviewAuthority(898, storeOptions)?.currentHeadSha).toBe(sha('b'));
  });

  it('keeps timeout/no-verdict and malformed execution failures non-consuming', () => {
    expect(terminalConsumesCapSlot({ status: 'timed_out', failureClass: 'timeout_no_verdict' })).toBe(false);
    expect(terminalConsumesCapSlot({ status: 'failed', failureClass: 'parse_error' })).toBe(false);
    expect(terminalConsumesCapSlot({ status: 'failed', findingCount: 0 })).toBe(false);
    expect(terminalConsumesCapSlot({ status: 'failed', findingCount: 2 })).toBe(true);
    expect(terminalConsumesCapSlot({ status: 'changes_requested', findingCount: 2 })).toBe(true);
  });

  it('only selects an immutable evidence row matching its ID, key, and digest', () => {
    const storeOptions = options();
    let state = initializePackReviewAuthority({
      prNumber: 898,
      headSha: sha('a'),
      tier: 'T1',
      options: storeOptions,
    });
    state = commitPackReviewTerminal({
      prNumber: 898,
      expectedTransitionSeq: state.transitionSeq,
      terminal: findingsTerminal('run-a', sha('a')),
      status: 'changes_requested',
      findingCount: 1,
      options: storeOptions,
    });
    const staged = stagePackReviewImmutableRecord({
      kind: 'evidence',
      key: 'mte-key-a',
      value: {
        schema: 'merge-triage-evidence/v1',
        evidenceId: 'mte-key-a',
        expectedEvidenceKey: 'key-a',
        pathId: 'scope-denylist-current-head/v1',
        producer: 'scripts/merge-triage-evidence.ts',
        tuple: { prNumber: 898, cycleId: state.cycle!.cycleId, currentHeadSha: sha('a') },
        changedPaths: [],
        denylistPatterns: ['packages/core/**'],
        matchedPaths: [],
        predicateResult: 'no_intersection',
      },
      options: storeOptions,
    });
    expect(() => selectPackReviewEvidence({
      prNumber: 898,
      expectedTransitionSeq: state.transitionSeq,
      expectedEvidenceKey: 'key-a',
      selectedEvidenceId: 'mte-key-a',
      selectedEvidenceDigest: 'forged',
      options: storeOptions,
    })).toThrow(/evidence_selection_invalid/);

    state = selectPackReviewEvidence({
      prNumber: 898,
      expectedTransitionSeq: state.transitionSeq,
      expectedEvidenceKey: 'key-a',
      selectedEvidenceId: 'mte-key-a',
      selectedEvidenceDigest: staged.digest,
      options: storeOptions,
    });
    expect(state.evidence).toMatchObject({
      expectedEvidenceKey: 'key-a',
      selectedEvidenceId: 'mte-key-a',
      selectedEvidenceDigest: staged.digest,
    });
  });

  it('requires complete composite terminal-v2 authority under schema-v1 storage', () => {
    const row = validateTerminalV2({
      schemaVersion: 1,
      terminalContractVersion: 2,
      terminalSource: 'merge_composite',
      runId: 'focused-terminal',
      targetSha: sha('c'),
      reviewVerdict: 'clean',
      findingCount: 0,
      findingsDigest: 'none',
      sourceCleanRunId: 'source-clean',
      sourceHeadSha: sha('a'),
      mergeBaseSha: sha('d'),
      mainSha: sha('b'),
      orderedParentShas: [sha('a'), sha('b')],
      replayDigest: 'replay',
      bundleDigest: 'bundle',
      helperVersion: 'pack-review-carryover/v2',
      focusedResolutionRunId: 'focused-run',
      focusedResolutionVerdict: 'clean',
    });
    expect(row.terminalContractVersion).toBe(2);
    expect(() => validateTerminalV2({ ...row, focusedResolutionVerdict: undefined })).toThrow(
      /focused resolution is not clean/,
    );
    expect(() => validateTerminalV2({ ...row, terminalContractVersion: 3 })).toThrow(
      /terminal_contract_invalid/,
    );
  });
});

describe('Issue #1276 GPT source cardinality', () => {
  it.each([
    ['T1', 1, 3],
    ['T2', 1, 3],
    ['T3', 1, 3],
    ['T1', 2, 1],
    ['T2', 2, 1],
    ['T3', 2, 3],
  ] as const)('selects %s round %s as %s source(s)', (tier, roundOrdinal, expected) => {
    expect(selectPackReviewGptSourceCardinality({ reviewer: 'gpt', tier, roundOrdinal })).toBe(expected);
  });

  it('keeps non-GPT reviewers single-source', () => {
    expect(selectPackReviewGptSourceCardinality({ reviewer: 'codex', tier: 'T3', roundOrdinal: 1 })).toBe(1);
  });

  it('rejects persisted cardinality and ordinal outside the frozen tier policy', () => {
    const cases: Array<{ name: string; round: PackReviewGptRoundRecord; pattern: RegExp }> = [];

    const t2Round2Wrong = plannedAggregateTestRound();
    t2Round2Wrong.tier = 'T2';
    t2Round2Wrong.roundOrdinal = 2;
    cases.push({ name: 'T2 round 2 with three sources', round: t2Round2Wrong, pattern: /cardinality violates tier\/round policy/ });

    const t3Round2Wrong = plannedAggregateTestRound();
    t3Round2Wrong.tier = 'T3';
    t3Round2Wrong.roundOrdinal = 2;
    t3Round2Wrong.cardinality = 1;
    t3Round2Wrong.sourceSlots = [t3Round2Wrong.sourceSlots[0]!];
    cases.push({ name: 'T3 round 2 with one source', round: t3Round2Wrong, pattern: /cardinality violates tier\/round policy/ });

    const t1Round2 = plannedAggregateTestRound();
    t1Round2.tier = 'T1';
    t1Round2.roundOrdinal = 2;
    t1Round2.cardinality = 1;
    t1Round2.sourceSlots = [t1Round2.sourceSlots[0]!];
    cases.push({ name: 'T1 round 2 beyond cap', round: t1Round2, pattern: /ordinal exceeds tier cap/ });

    for (const item of cases) {
      const storeRoot = aggregateTestStoreRoot();
      expect(() => createPackReviewRun({
        projectId: 'orchestrator-pack',
        storeRoot,
        prNumber: 1276,
        headSha: sha('a'),
        trustedPackRoot: repoRoot,
        sourceRepoRoot: repoRoot,
        reviewRound: item.round,
      }), item.name).toThrow(item.pattern);
    }
  });

  it('accepts persisted later-round cardinality only for valid T2 and T3 policy rows', () => {
    const validT2 = plannedAggregateTestRound();
    validT2.tier = 'T2';
    validT2.roundOrdinal = 2;
    validT2.cardinality = 1;
    validT2.sourceSlots = [validT2.sourceSlots[0]!];
    expect(createPackReviewRun({
      projectId: 'orchestrator-pack',
      storeRoot: aggregateTestStoreRoot(),
      prNumber: 1276,
      headSha: sha('b'),
      trustedPackRoot: repoRoot,
      sourceRepoRoot: repoRoot,
      reviewRound: validT2,
    }).created).toBe(true);

    const validT3 = plannedAggregateTestRound();
    validT3.tier = 'T3';
    validT3.roundOrdinal = 2;
    expect(createPackReviewRun({
      projectId: 'orchestrator-pack',
      storeRoot: aggregateTestStoreRoot(),
      prNumber: 1276,
      headSha: sha('c'),
      trustedPackRoot: repoRoot,
      sourceRepoRoot: repoRoot,
      reviewRound: validT3,
    }).created).toBe(true);
  });
});

function aggregateTestRound(terminalClass: 'complete_findings' | 'reviewer_output_malformed'): PackReviewGptRoundRecord {
  const sourceSlots = Array.from({ length: 3 }, (_, index) => {
    const ordinal = index + 1;
    const slotId = `source-${String(ordinal).padStart(2, '0')}`;
    const invocationId = `aggregate-inv-${ordinal}`;
    return {
      slotId,
      ordinal,
      lifecycle: 'terminal' as const,
      invocationId,
      attemptOrdinal: 1,
      terminalClass: 'complete_clean',
      terminalResult: {
        schema: 'turn-result/v1',
        state: 'ok',
        scope: 'invocation',
        cause: 'completed_page_only',
        invocation_id: invocationId,
        send_count: 1,
      },
      payload: { verdict: 'clean', findingCount: 0, findings: [] },
    };
  });
  if (terminalClass === 'complete_findings') {
    sourceSlots[0] = {
      ...sourceSlots[0]!,
      terminalClass,
      payload: {
        verdict: 'findings',
        findingCount: 2,
        findings: [
          { title: 'same occurrence', severity: 'blocking' },
          { title: 'same occurrence', severity: 'blocking' },
        ],
      },
    };
  } else {
    sourceSlots[1] = {
      ...sourceSlots[1]!,
      terminalClass,
      terminalResult: { exitCode: 1, stderr: 'invalid reviewer output' },
      payload: undefined,
    };
  }
  return {
    schema: 'pack-review-gpt-round/v1',
    reviewer: 'gpt',
    tier: 'T1',
    roundOrdinal: 1,
    cardinality: 3,
    issueNumber: 1276,
    boundIssueSnapshotDigest: 'aggregate-fixture',
    sourceSlots,
  };
}

function plannedAggregateTestRound(): PackReviewGptRoundRecord {
  const round = aggregateTestRound('complete_findings');
  return {
    ...round,
    sourceSlots: round.sourceSlots.map((slot) => ({
      slotId: slot.slotId,
      ordinal: slot.ordinal,
      lifecycle: 'planned' as const,
    })),
  };
}

function aggregateTestStoreRoot(): string {
  const storeRoot = mkdtempSync(join(tmpdir(), 'pack-review-gpt-aggregate-test-'));
  roots.push(storeRoot);
  return storeRoot;
}

function createAggregateTestRun(storeRoot: string) {
  return createPackReviewRun({
    projectId: 'orchestrator-pack',
    storeRoot,
    prNumber: 1276,
    headSha: sha('a'),
    trustedPackRoot: repoRoot,
    sourceRepoRoot: repoRoot,
    reviewRound: plannedAggregateTestRound(),
  }).run;
}

const attributedAggregateFindings = [
  { title: 'same occurrence', severity: 'blocking', sourceSlotId: 'source-01' },
  { title: 'same occurrence', severity: 'blocking', sourceSlotId: 'source-01' },
];

describe('Issue #1276 GPT aggregate/source census settlement', () => {
  it('rejects update, terminal, journal, and resume divergence while preserving every occurrence', () => {
    const storeRoot = aggregateTestStoreRoot();
    const run = createAggregateTestRun(storeRoot);
    const reviewRound = aggregateTestRound('complete_findings');
    const storeOptions = { projectId: 'orchestrator-pack', storeRoot };

    expect(() => updatePackReviewRun(run.id, {
      reviewRound,
      reviewVerdict: 'clean',
      findingCount: 0,
      findings: [],
    }, storeOptions)).toThrow(/reviewVerdict does not match terminal source census/);

    expect(() => setPackReviewRunTerminal(run.id, 'commented', {
      reviewRound,
      reviewVerdict: 'findings',
      findingCount: 1,
      findings: [attributedAggregateFindings[0]],
    }, storeOptions)).toThrow(/findingCount does not match terminal source census/);

    expect(() => updatePackReviewRun(run.id, {
      reviewRound,
      reviewVerdict: 'findings',
      findingCount: 2,
      findings: attributedAggregateFindings.map(({ sourceSlotId: _sourceSlotId, ...finding }) => finding),
      journalOutcome: {
        state: 'persisted',
        recordedAtUtc: '2026-08-05T00:00:00.000Z',
        reason: 'fixture',
        idempotencyKey: 'aggregate-fixture',
        attempts: 1,
      },
    }, storeOptions)).toThrow(/findings do not match terminal source census/);

    const persisted = updatePackReviewRun(run.id, {
      reviewRound,
      reviewVerdict: 'findings',
      findingCount: 2,
      findings: attributedAggregateFindings,
      journalOutcome: {
        state: 'persisted',
        recordedAtUtc: '2026-08-05T00:00:00.000Z',
        reason: 'fixture',
        idempotencyKey: 'aggregate-fixture',
        attempts: 1,
      },
    }, storeOptions);
    expect(persisted.findings).toEqual(attributedAggregateFindings);
    expect(persisted.findings).toHaveLength(2);

    const recordPath = join(storeRoot, 'runs', `${run.id}.json`);
    const raw = JSON.parse(readFileSync(recordPath, 'utf8')) as Record<string, unknown>;
    raw.reviewVerdict = 'clean';
    raw.findingCount = 0;
    raw.findings = [];
    writeFileSync(recordPath, `${JSON.stringify(raw)}\n`, 'utf8');
    expect(() => getPackReviewRun(run.id, storeOptions)).toThrow(
      /reviewVerdict does not match terminal source census/,
    );
  });

  it('reloads and validates the persisted aggregate before settlement authority can consume it', () => {
    const storeRoot = aggregateTestStoreRoot();
    const run = createAggregateTestRun(storeRoot);
    const storeOptions = { projectId: 'orchestrator-pack', storeRoot };
    updatePackReviewRun(run.id, { reviewRound: aggregateTestRound('complete_findings') }, storeOptions);

    const validated = validatePersistedPackReviewGptAggregate(run.id, {
      reviewVerdict: 'findings',
      findingCount: 2,
      findings: attributedAggregateFindings,
    }, storeOptions);
    expect(validated).toEqual({
      reviewVerdict: 'findings',
      findingCount: 2,
      findings: attributedAggregateFindings,
    });

    expect(() => validatePersistedPackReviewGptAggregate(run.id, {
      reviewVerdict: 'clean',
      findingCount: 0,
      findings: [],
    }, storeOptions)).toThrow(/reviewVerdict does not match terminal source census/);
  });

  it('closes the successful-sent terminal class matrix and preserves the malformed-output class', () => {
    const invalidCases: Array<{ name: string; mutate: (round: PackReviewGptRoundRecord) => void; pattern: RegExp }> = [
      {
        name: 'generic ok class',
        mutate: (round) => {
          const slot = round.sourceSlots[0]!;
          slot.terminalClass = 'ok:completed_page_only';
          slot.payload = undefined;
        },
        pattern: /unsupported terminal class/,
      },
      {
        name: 'possible delivery with ok result',
        mutate: (round) => {
          const slot = round.sourceSlots[0]!;
          slot.terminalClass = 'possible_delivery';
          slot.payload = undefined;
        },
        pattern: /possible_delivery requires a non-ok sent terminalResult/,
      },
      {
        name: 'collision exhausted on first attempt',
        mutate: (round) => {
          const slot = round.sourceSlots[0]!;
          slot.terminalClass = 'explicit_refusal:zero_send_collision_exhausted';
          slot.payload = undefined;
          slot.attemptOrdinal = 1;
          slot.terminalResult = {
            schema: 'turn-result/v1',
            state: 'profile_busy',
            scope: 'profile',
            cause: 'profile_busy',
            invocation_id: slot.invocationId,
            send_count: 0,
          };
        },
        pattern: /exhausted collision class is terminalResult-inconsistent/,
      },
    ];

    for (const item of invalidCases) {
      const round = aggregateTestRound('complete_findings');
      item.mutate(round);
      expect(() => createPackReviewRun({
        projectId: 'orchestrator-pack',
        storeRoot: aggregateTestStoreRoot(),
        prNumber: 1276,
        headSha: sha('d'),
        trustedPackRoot: repoRoot,
        sourceRepoRoot: repoRoot,
        reviewRound: round,
      }), item.name).toThrow(item.pattern);
    }

    const malformed = aggregateTestRound('complete_findings');
    const malformedSlot = malformed.sourceSlots[0]!;
    malformedSlot.terminalClass = 'reviewer_output_malformed';
    malformedSlot.payload = undefined;
    expect(createPackReviewRun({
      projectId: 'orchestrator-pack',
      storeRoot: aggregateTestStoreRoot(),
      prNumber: 1276,
      headSha: sha('e'),
      trustedPackRoot: repoRoot,
      sourceRepoRoot: repoRoot,
      reviewRound: malformed,
    }).created).toBe(true);
  });

  it('forbids a clean aggregate when any frozen source is non-complete', () => {
    const storeRoot = aggregateTestStoreRoot();
    const run = createAggregateTestRun(storeRoot);
    expect(() => updatePackReviewRun(run.id, {
      reviewRound: aggregateTestRound('reviewer_output_malformed'),
      reviewVerdict: 'clean',
      findingCount: 0,
      findings: [],
    }, { projectId: 'orchestrator-pack', storeRoot })).toThrow(
      /reviewVerdict does not match terminal source census/,
    );
  });
});
