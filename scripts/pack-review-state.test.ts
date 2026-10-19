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
  PACK_REVIEW_LOGICAL_CAP_MAP_VERSION,
  acknowledgePackReviewReset,
  beginPackReviewBodyAmendmentContinuation,
  commitPackReviewAuthorityTransition,
  commitPackReviewTerminal,
  commitPackReviewTriage,
  createInitialPackReviewAuthority,
  initializePackReviewAuthority,
  observePackReviewHead,
  packReviewFindingsSatisfiedByStrictDescendant,
  PackReviewAuthorityError,
  readPackReviewAuthority,
  reconcilePackReviewTier,
  recordPackReviewPublication,
  reopenPackReviewAuthorityForExplicitExtraReview,
  retainPersistedOpenCycle,
  selectPackReviewGptSourceCardinality,
  sha256,
  stableJson,
  selectPackReviewEvidence,
  settleLogicalPackReviewFindingsByStrictDescendant,
  stagePackReviewImmutableRecord,
  terminalConsumesCapSlot,
  validateTerminalV2,
} from './pack-review-state.ts';
import {
  boundIssueSnapshotArtifactPaths,
  captureBoundIssueSnapshot,
  computeBoundIssueSnapshotHash,
  loadValidatedBoundSnapshotBody,
  resolveBoundIssueSnapshot,
} from './lib/reverify-bound-issue-snapshot.ts';
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

describe('Issue #2653 stableJson JSON-persistence parity', () => {
  it('omits unsupported object fields and encodes unsupported array entries as null', () => {
    const mapped = {
      verdict: 'findings',
      findings: [{ title: 'optional file path', filePath: undefined }],
      optional: undefined,
      ignoredFunction: () => 'not JSON',
      ignoredSymbol: Symbol('not JSON'),
      array: [undefined, () => 'not JSON', Symbol('not JSON'), NaN, Infinity],
    };
    const persisted = JSON.parse(JSON.stringify(mapped)) as Record<string, unknown>;

    const actual = stableJson(mapped);
    expect(actual).toBe(stableJson(persisted));
    expect(JSON.parse(actual)).toEqual(persisted);
    expect(JSON.parse(actual)).toMatchObject({ array: [null, null, null, null, null] });
    expect(actual).not.toContain('undefined');
    expect(actual).not.toContain('ignoredFunction');
    expect(actual).not.toContain('ignoredSymbol');
    expect((persisted.findings as Array<Record<string, unknown>>)[0]).not.toHaveProperty('filePath');
  });

  it('keeps the historic sorted bytes and hashes of persisted JSON, including integer-like keys', () => {
    const persisted = JSON.parse('{"value":null,"records":{"2":"two","10":"ten"},"empty":[]}');
    const previouslyPersistedStable = '{"empty":[],"records":{"10":"ten","2":"two"},"value":null}';

    expect(stableJson(persisted)).toBe(previouslyPersistedStable);
    expect(sha256(stableJson(persisted))).toBe(sha256(previouslyPersistedStable));
  });
});

describe('Issue #2565 completed findings logical reset', () => {
  function completedFindings(tier: 'T2' | 'T3' = 'T2') {
    const config = options();
    const prNumber = 2565;
    let state = initializePackReviewAuthority({
      prNumber, headSha: sha('a'), tier,
      capMapVersion: PACK_REVIEW_LOGICAL_CAP_MAP_VERSION, options: config,
    });
    // A terminal at the genuine last ordinal; T3 must first consume round one.
    if (tier === 'T3') {
      state = commitPackReviewTerminal({
        prNumber, expectedTransitionSeq: state.transitionSeq,
        terminal: { ...findingsTerminal('round-one', sha('a')),
          logicalRoundOrdinal: 1, automaticBudgetDisposition: 'consume' },
        status: 'changes_requested', findingCount: 1, options: config,
      });
      state = observePackReviewHead({
        prNumber, expectedTransitionSeq: state.transitionSeq, headSha: sha('b'), options: config,
      });
      state = settleLogicalPackReviewFindingsByStrictDescendant({
        prNumber, expectedTransitionSeq: state.transitionSeq, reviewedHeadSha: sha('a'),
        currentHeadSha: sha('b'), reviewedHeadIsAncestor: true, options: config,
      });
    }
    const terminalHead = tier === 'T2' ? sha('a') : sha('b');
    const descendant = tier === 'T2' ? sha('b') : sha('c');
    state = commitPackReviewTerminal({
      prNumber, expectedTransitionSeq: state.transitionSeq,
      terminal: { ...findingsTerminal('last-findings', terminalHead),
        logicalRoundOrdinal: tier === 'T2' ? 1 : 2, automaticBudgetDisposition: 'consume' },
      status: 'changes_requested', findingCount: 1, options: config,
    });
    state = observePackReviewHead({
      prNumber, expectedTransitionSeq: state.transitionSeq, headSha: descendant, options: config,
    });
    state = settleLogicalPackReviewFindingsByStrictDescendant({
      prNumber, expectedTransitionSeq: state.transitionSeq, reviewedHeadSha: terminalHead,
      currentHeadSha: descendant, reviewedHeadIsAncestor: true, options: config,
    });
    expect(state.cycle).toMatchObject({
      state: 'closed', reviewStageComplete: true, frozenTier: tier,
      frozenCap: tier === 'T2' ? 1 : 2,
    });
    expect(state.cycle?.atCapHash).toBeUndefined();
    return { state, config, prNumber, descendant };
  }

  it.each(['T2', 'T3'] as const)('completed logical reset without at-cap hash: %s', (tier) => {
    const { state, config, prNumber, descendant } = completedFindings(tier);
    const previous = state.cycle!.cycleId;
    const provenance = {
      priorCycleId: previous, actor: 'actual-operator', reason: 'Issue amended',
      timestampUtc: '2026-10-14T01:00:00.000Z', nonce: 'amend-1',
    };
    const reset = acknowledgePackReviewReset({
      prNumber, expectedTransitionSeq: state.transitionSeq, headSha: descendant,
      tier, capMapVersion: PACK_REVIEW_LOGICAL_CAP_MAP_VERSION,
      completedFindingsBodyAmended: true, provenance, options: config,
    });
    expect(reset.cycle).toMatchObject({
      state: 'open', frozenTier: tier, frozenCap: tier === 'T2' ? 1 : 2,
      consumedRoundOrdinals: [], resetProvenance: provenance,
    });
    expect(reset.cycle?.cycleId).not.toBe(previous);
    expect(readPackReviewAuthority(prNumber, config)?.cycle?.resetProvenance).toEqual(provenance);
  });

  it('completed reset eligibility negatives: clean, unrelated, nonlogical and unproved amendment', () => {
    const { state, config, prNumber, descendant } = completedFindings();
    const provenance = {
      priorCycleId: state.cycle!.cycleId, actor: 'operator', reason: 'amended',
      timestampUtc: '2026-10-14T01:00:00.000Z', nonce: 'amend-neg',
    };
    const input = {
      prNumber, expectedTransitionSeq: state.transitionSeq, headSha: descendant,
      tier: 'T2' as const, capMapVersion: PACK_REVIEW_LOGICAL_CAP_MAP_VERSION,
      provenance, options: config,
    };
    expect(() => acknowledgePackReviewReset(input)).toThrow(/reset_invalid/);
    expect(() => acknowledgePackReviewReset({
      ...input, completedFindingsBodyAmended: true,
      provenance: { ...provenance, priorCycleId: 'wrong-cycle' },
    })).toThrow(/reset_invalid/);
    // Completed clean T2 consumes its cap and is not a findings-bearing reset.
    const cleanOptions = options();
    let clean = initializePackReviewAuthority({
      prNumber: 2566, headSha: sha('d'), tier: 'T2',
      capMapVersion: PACK_REVIEW_LOGICAL_CAP_MAP_VERSION, options: cleanOptions,
    });
    clean = commitPackReviewTerminal({
      prNumber: 2566, expectedTransitionSeq: clean.transitionSeq,
      terminal: { schemaVersion: 1, terminalContractVersion: 2,
        terminalSource: 'normal', runId: 'clean-last', targetSha: sha('d'),
        logicalRoundOrdinal: 1, automaticBudgetDisposition: 'consume',
        reviewVerdict: 'clean', findingCount: 0, findingsDigest: 'clean' },
      status: 'clean', findingCount: 0, options: cleanOptions,
    });
    expect(() => acknowledgePackReviewReset({
      ...input, prNumber: 2566, expectedTransitionSeq: clean.transitionSeq,
      headSha: sha('d'), completedFindingsBodyAmended: true,
      provenance: { ...provenance, priorCycleId: clean.cycle!.cycleId },
      options: cleanOptions,
    })).toThrow(/reset_invalid/);
    expect(readPackReviewAuthority(2566, cleanOptions)?.cycle?.reviewStageComplete).toBe(true);
  });

  it('does not introduce hashless completed-cycle reset for T1', () => {
    const config = options();
    const prNumber = 2567;
    let state = initializePackReviewAuthority({
      prNumber, headSha: sha('a'), tier: 'T1',
      capMapVersion: PACK_REVIEW_LOGICAL_CAP_MAP_VERSION, options: config,
    });
    state = commitPackReviewTerminal({
      prNumber, expectedTransitionSeq: state.transitionSeq,
      terminal: { ...findingsTerminal('t1-last', sha('a')),
        logicalRoundOrdinal: 1, automaticBudgetDisposition: 'consume' },
      status: 'changes_requested', findingCount: 1, options: config,
    });
    state = observePackReviewHead({
      prNumber, expectedTransitionSeq: state.transitionSeq, headSha: sha('b'), options: config,
    });
    state = settleLogicalPackReviewFindingsByStrictDescendant({
      prNumber, expectedTransitionSeq: state.transitionSeq,
      reviewedHeadSha: sha('a'), currentHeadSha: sha('b'),
      reviewedHeadIsAncestor: true, options: config,
    });
    expect(state.cycle).toMatchObject({ state: 'closed', frozenTier: 'T1',
      reviewStageComplete: true, consumedRoundOrdinals: [1] });
    expect(() => acknowledgePackReviewReset({
      prNumber, expectedTransitionSeq: state.transitionSeq,
      headSha: sha('b'), tier: 'T1',
      capMapVersion: PACK_REVIEW_LOGICAL_CAP_MAP_VERSION,
      completedFindingsBodyAmended: true,
      provenance: {
        priorCycleId: state.cycle!.cycleId, actor: 'owner', reason: 'amended',
        timestampUtc: '2026-10-14T01:00:00.000Z', nonce: 't1-not-eligible',
      },
      options: config,
    })).toThrow(/reset_invalid/);
    expect(readPackReviewAuthority(prNumber, config)?.cycle?.cycleId).toBe(state.cycle?.cycleId);
  });

  it('reset validates optional at-cap hash on pending and completed cycles', () => {
    const { state, config, prNumber, descendant } = completedFindings();
    const provenance = {
      priorCycleId: state.cycle!.cycleId, actor: 'operator', reason: 'amended',
      timestampUtc: '2026-10-14T01:00:00.000Z', nonce: 'amend-hash',
    };
    expect(() => acknowledgePackReviewReset({
      prNumber, expectedTransitionSeq: state.transitionSeq, headSha: descendant,
      tier: 'T2', capMapVersion: PACK_REVIEW_LOGICAL_CAP_MAP_VERSION,
      completedFindingsBodyAmended: true,
      provenance: { ...provenance, priorAtCapHash: 'a'.repeat(64) },
      options: config,
    })).toThrow(/reset_invalid/);
    expect(readPackReviewAuthority(prNumber, config)?.cycle?.cycleId).toBe(state.cycle!.cycleId);
  });
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

describe('Issue #1417 explicit extra-review legacy helper', () => {
  it('cannot supersede same-head findings with non-consuming clean evidence', () => {
    const storeOptions = options();
    const head = sha('a');
    let state = initializePackReviewAuthority({
      prNumber: 1417,
      headSha: head,
      tier: 'T1',
      options: storeOptions,
    });
    state = commitPackReviewTerminal({
      prNumber: 1417,
      expectedTransitionSeq: state.transitionSeq,
      terminal: {
        ...findingsTerminal('auto-run', head),
        automaticBudgetDisposition: 'consume',
      },
      status: 'changes_requested',
      findingCount: 1,
      options: storeOptions,
    });
    expect(state.cycle).toMatchObject({
      state: 'at_cap_open_findings',
      consumedHeadShas: [head],
    });
    state = recordPackReviewPublication({
      prNumber: 1417,
      expectedTransitionSeq: state.transitionSeq,
      publication: {
        headSha: head,
        terminalRunId: 'auto-run',
        status: 'succeeded',
        publicationDigest: 'pub-auto',
        recordedAtUtc: '2026-08-03T00:00:00.000Z',
      },
      options: storeOptions,
    });
    expect(state.phase).toBe('external_published');
    const cycleBefore = structuredClone(state.cycle);
    const triageBefore = structuredClone(state.triage);

    state = reopenPackReviewAuthorityForExplicitExtraReview({
      prNumber: 1417,
      expectedTransitionSeq: state.transitionSeq,
      headSha: head,
      options: storeOptions,
    });
    expect(state.phase).toBe('head_observed');
    expect(state.cycle).toEqual(cycleBefore);
    expect(state.triage).toEqual(triageBefore);

    expect(() => commitPackReviewTerminal({
      prNumber: 1417,
      expectedTransitionSeq: state.transitionSeq,
      terminal: {
        schemaVersion: 1,
        terminalContractVersion: 2,
        terminalSource: 'normal',
        runId: 'explicit-run',
        targetSha: head,
        reviewVerdict: 'clean',
        findingCount: 0,
        findingsDigest: 'clean-explicit',
        automaticBudgetDisposition: 'non_consuming_explicit',
      },
      status: 'clean',
      findingCount: 0,
      options: storeOptions,
    })).toThrow(/terminal_precedence_conflict/);

    const persisted = readPackReviewAuthority(1417, storeOptions);
    expect(persisted?.phase).toBe('head_observed');
    expect(persisted?.cycle).toEqual(cycleBefore);
    expect(persisted?.triage).toEqual(triageBefore);
    expect(persisted?.terminal?.runId).toBe('auto-run');

    expect(() => reopenPackReviewAuthorityForExplicitExtraReview({
      prNumber: 1417,
      expectedTransitionSeq: persisted!.transitionSeq,
      headSha: sha('b'),
      options: storeOptions,
    })).toThrow(PackReviewAuthorityError);
    expect(() => reopenPackReviewAuthorityForExplicitExtraReview({
      prNumber: 1417,
      expectedTransitionSeq: persisted!.transitionSeq,
      headSha: sha('b'),
      options: storeOptions,
    })).toThrow(/exact current head/);
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


describe('Issue #1887 strict-descendant findings settlement', () => {
  it('requires different heads and positive ancestry', () => {
    const head = sha('a');
    const next = sha('b');
    expect(packReviewFindingsSatisfiedByStrictDescendant({
      reviewedHeadSha: head,
      currentHeadSha: head,
      reviewedHeadIsAncestor: true,
    })).toBe(false);
    expect(packReviewFindingsSatisfiedByStrictDescendant({
      reviewedHeadSha: head,
      currentHeadSha: next,
      reviewedHeadIsAncestor: false,
    })).toBe(false);
    expect(packReviewFindingsSatisfiedByStrictDescendant({
      reviewedHeadSha: head,
      currentHeadSha: next,
      reviewedHeadIsAncestor: true,
    })).toBe(true);
  });

  it('closes a T2 findings round after one strict descendant without triage evidence', () => {
    const storeOptions = options();
    const reviewed = sha('c');
    const current = sha('d');
    let state = initializePackReviewAuthority({
      prNumber: 1887,
      headSha: reviewed,
      tier: 'T2',
      options: storeOptions,
    });
    state = commitPackReviewTerminal({
      prNumber: 1887,
      expectedTransitionSeq: state.transitionSeq,
      terminal: {
        ...findingsTerminal('issue-1887-t2', reviewed),
        logicalRoundOrdinal: 1,
      },
      status: 'changes_requested',
      findingCount: 1,
      options: storeOptions,
    });
    expect(state.cycle).toMatchObject({
      state: 'at_cap_open_findings',
      consumedRoundOrdinals: [1],
    });

    state = observePackReviewHead({
      prNumber: 1887,
      expectedTransitionSeq: state.transitionSeq,
      headSha: current,
      options: storeOptions,
    });
    expect(state.cycle?.state).toBe('at_cap_continuation_required');

    state = settleLogicalPackReviewFindingsByStrictDescendant({
      prNumber: 1887,
      expectedTransitionSeq: state.transitionSeq,
      reviewedHeadSha: reviewed,
      currentHeadSha: current,
      reviewedHeadIsAncestor: true,
      options: storeOptions,
    });
    expect(state.cycle).toMatchObject({
      state: 'closed',
      consumedRoundOrdinals: [1],
      reviewStageComplete: true,
    });
    expect(state.triage).toBeUndefined();
  });

  it('latches a clean T2 terminal without publication evidence', () => {
    const storeOptions = options();
    const head = sha('a');
    let state = initializePackReviewAuthority({
      prNumber: 1889,
      headSha: head,
      tier: 'T2',
      options: storeOptions,
    });
    state = commitPackReviewTerminal({
      prNumber: 1889,
      expectedTransitionSeq: state.transitionSeq,
      terminal: {
        schemaVersion: 1,
        terminalContractVersion: 2,
        terminalSource: 'normal',
        runId: 'issue-1887-t2-clean',
        targetSha: head,
        reviewVerdict: 'clean',
        findingCount: 0,
        findingsDigest: 'clean',
        logicalRoundOrdinal: 1,
      },
      status: 'clean',
      findingCount: 0,
      options: storeOptions,
    });
    expect(state.cycle).toMatchObject({
      state: 'closed',
      consumedRoundOrdinals: [1],
      reviewStageComplete: true,
    });
    expect(state.publication).toBeUndefined();
  });

  it('settles T3 round one on a descendant but leaves round two required', () => {
    const storeOptions = options();
    const reviewed = sha('e');
    const current = sha('f');
    let state = initializePackReviewAuthority({
      prNumber: 1888,
      headSha: reviewed,
      tier: 'T3',
      options: storeOptions,
    });
    state = commitPackReviewTerminal({
      prNumber: 1888,
      expectedTransitionSeq: state.transitionSeq,
      terminal: {
        ...findingsTerminal('issue-1887-t3-round1', reviewed),
        logicalRoundOrdinal: 1,
      },
      status: 'changes_requested',
      findingCount: 1,
      options: storeOptions,
    });
    state = observePackReviewHead({
      prNumber: 1888,
      expectedTransitionSeq: state.transitionSeq,
      headSha: current,
      options: storeOptions,
    });
    state = settleLogicalPackReviewFindingsByStrictDescendant({
      prNumber: 1888,
      expectedTransitionSeq: state.transitionSeq,
      reviewedHeadSha: reviewed,
      currentHeadSha: current,
      reviewedHeadIsAncestor: true,
      options: storeOptions,
    });
    expect(state.cycle).toMatchObject({
      state: 'open',
      consumedRoundOrdinals: [1],
    });
    expect(state.cycle?.reviewStageComplete).not.toBe(true);

    state = observePackReviewHead({
      prNumber: 1888,
      expectedTransitionSeq: state.transitionSeq,
      headSha: current,
      options: storeOptions,
    });
    expect(state.terminal).toBeUndefined();
  });
});


describe('Issue #1887 logical triage is diagnostic only', () => {
  it('does not settle final-cap findings on the same head through architect DEFER or publication', () => {
    const storeOptions = options();
    const head = sha('7');
    let state = initializePackReviewAuthority({
      prNumber: 18970,
      headSha: head,
      tier: 'T2',
      capMapVersion: PACK_REVIEW_LOGICAL_CAP_MAP_VERSION,
      options: storeOptions,
    });
    state = commitPackReviewTerminal({
      prNumber: 18970,
      expectedTransitionSeq: state.transitionSeq,
      terminal: {
        ...findingsTerminal('issue-1887-triage-final', head),
        logicalRoundOrdinal: 1,
      },
      status: 'changes_requested',
      findingCount: 1,
      options: storeOptions,
    });
    expect(state.cycle).toMatchObject({
      state: 'at_cap_open_findings',
      consumedRoundOrdinals: [1],
    });

    state = commitPackReviewTriage({
      prNumber: 18970,
      expectedTransitionSeq: state.transitionSeq,
      triage: {
        verdict: 'DEFER',
        source: 'architect',
        findingSnapshotDigest: 'same-head-final',
        committedAtUtc: '2026-09-02T00:00:00.000Z',
      },
      options: storeOptions,
    });
    expect(state.cycle?.state).toBe('at_cap_open_findings');
    expect(state.cycle?.reviewStageComplete).not.toBe(true);

    state = recordPackReviewPublication({
      prNumber: 18970,
      expectedTransitionSeq: state.transitionSeq,
      publication: {
        headSha: head,
        terminalRunId: 'issue-1887-triage-final',
        status: 'succeeded',
        publicationDigest: 'same-head-publication',
        recordedAtUtc: '2026-09-02T00:01:00.000Z',
      },
      options: storeOptions,
    });
    expect(state.cycle?.state).toBe('at_cap_open_findings');
    expect(state.cycle?.reviewStageComplete).not.toBe(true);
  });

  it('does not reopen a pre-cap logical round on same-head architect DEFER', () => {
    const storeOptions = options();
    const head = sha('8');
    let state = initializePackReviewAuthority({
      prNumber: 18971,
      headSha: head,
      tier: 'T3',
      capMapVersion: PACK_REVIEW_LOGICAL_CAP_MAP_VERSION,
      options: storeOptions,
    });
    state = commitPackReviewTerminal({
      prNumber: 18971,
      expectedTransitionSeq: state.transitionSeq,
      terminal: {
        ...findingsTerminal('issue-1887-triage-round1', head),
        logicalRoundOrdinal: 1,
      },
      status: 'changes_requested',
      findingCount: 1,
      options: storeOptions,
    });
    expect(state.cycle?.state).toBe('open_findings');

    state = commitPackReviewTriage({
      prNumber: 18971,
      expectedTransitionSeq: state.transitionSeq,
      triage: {
        verdict: 'DEFER',
        source: 'architect',
        findingSnapshotDigest: 'same-head-round1',
        committedAtUtc: '2026-09-02T00:02:00.000Z',
      },
      options: storeOptions,
    });
    expect(state.cycle?.state).toBe('open_findings');
    expect(state.cycle?.reviewStageComplete).not.toBe(true);
  });
});

describe('Issue #2250 smoke-ordering no longer governs pack-review authority', () => {
  it('preserves historical smoke facts without vetoing tier reconciliation or changing them on new heads', () => {
    const storeOptions = options();
    const oldHead = sha('a');
    const nextHead = sha('b');
    let authority = initializePackReviewAuthority({
      prNumber: 2250, headSha: oldHead, tier: 'T1', options: storeOptions,
    });
    authority = commitPackReviewAuthorityTransition({
      prNumber: 2250,
      expectedTransitionSeq: authority.transitionSeq,
      nextPhase: authority.phase,
      options: storeOptions,
      mutate(current) {
        current.smokeOrdering = {
          independent: {
            startedEver: true,
            headSha: oldHead,
            status: 'started',
            updatedAtUtc: '2026-09-30T00:00:00.000Z',
          },
        };
        return current;
      },
    });
    const oldOrdering = authority.smokeOrdering;
    authority = reconcilePackReviewTier({ prNumber: 2250, tier: 'T2', options: storeOptions });
    expect(authority.cycle?.frozenTier).toBe('T2');
    expect(authority.smokeOrdering).toEqual(oldOrdering);
    authority = observePackReviewHead({
      prNumber: 2250,
      expectedTransitionSeq: authority.transitionSeq,
      headSha: nextHead,
      options: storeOptions,
    });
    expect(authority.currentHeadSha).toBe(nextHead);
    expect(authority.smokeOrdering).toEqual(oldOrdering);
  });
});


describe('Issue #2537 monotonic linked-Issue tier promotion', () => {
  it('promotes consumed T2 findings to a second required T3 round without rewriting its first terminal', () => {
    const opts = options();
    const old = sha('a');
    const next = sha('b');
    let authority = initializePackReviewAuthority({
      prNumber: 2537, headSha: old, tier: 'T2',
      capMapVersion: PACK_REVIEW_LOGICAL_CAP_MAP_VERSION, options: opts,
    });
    const cycleId = authority.cycle!.cycleId;
    authority = commitPackReviewTerminal({
      prNumber: 2537, expectedTransitionSeq: authority.transitionSeq,
      terminal: { ...findingsTerminal('old-tier-first-round', old), logicalRoundOrdinal: 1 },
      status: 'changes_requested', findingCount: 1, options: opts,
    });
    expect(authority.cycle).toMatchObject({
      frozenTier: 'T2', frozenCap: 1, state: 'at_cap_open_findings',
      consumedRoundOrdinals: [1],
    });
    const historicalTerminal = authority.terminal;

    authority = reconcilePackReviewTier({
      prNumber: 2537, tier: 'T3', startedRunExists: true, options: opts,
    });
    expect(authority.cycle).toMatchObject({
      cycleId, frozenTier: 'T3', frozenCap: 2,
      state: 'open_findings', consumedRoundOrdinals: [1],
    });
    expect(authority.terminal).toEqual(historicalTerminal);
    expect(authority.cycle!.atCapHash).toMatch(/^[0-9a-f]{64}$/);
    expect(authority.cycle!.reviewStageComplete).not.toBe(true);

    authority = observePackReviewHead({
      prNumber: 2537, expectedTransitionSeq: authority.transitionSeq,
      headSha: next, options: opts,
    });
    authority = settleLogicalPackReviewFindingsByStrictDescendant({
      prNumber: 2537, expectedTransitionSeq: authority.transitionSeq,
      reviewedHeadSha: old, currentHeadSha: next,
      reviewedHeadIsAncestor: true, options: opts,
    });
    expect(authority.cycle).toMatchObject({ state: 'open', consumedRoundOrdinals: [1] });
    expect(authority.cycle!.reviewStageComplete).not.toBe(true);

    authority = observePackReviewHead({
      prNumber: 2537, expectedTransitionSeq: authority.transitionSeq,
      headSha: next, options: opts,
    });
    authority = commitPackReviewTerminal({
      prNumber: 2537, expectedTransitionSeq: authority.transitionSeq,
      terminal: {
        schemaVersion: 1, terminalContractVersion: 2, terminalSource: 'normal',
        runId: 'raised-tier-second-round', targetSha: next,
        reviewVerdict: 'clean', findingCount: 0, findingsDigest: 'clean',
        logicalRoundOrdinal: 2,
      },
      status: 'clean', findingCount: 0, options: opts,
    });
    expect(authority.cycle).toMatchObject({
      cycleId, frozenTier: 'T3', frozenCap: 2,
      state: 'closed', consumedRoundOrdinals: [1, 2],
      reviewStageComplete: true,
    });
  });

  it('keeps an already started zero-consumed run in the same cycle when its tier rises', () => {
    const opts = options();
    let authority = initializePackReviewAuthority({
      prNumber: 2538, headSha: sha('a'), tier: 'T2',
      capMapVersion: PACK_REVIEW_LOGICAL_CAP_MAP_VERSION, options: opts,
    });
    const cycleId = authority.cycle!.cycleId;
    authority = reconcilePackReviewTier({
      prNumber: 2538, tier: 'T3', startedRunExists: true, options: opts,
    });
    expect(authority.cycle).toMatchObject({
      cycleId, frozenTier: 'T3', frozenCap: 2, consumedRoundOrdinals: [],
    });
    authority = reconcilePackReviewTier({
      prNumber: 2538, tier: 'T1', startedRunExists: true, options: opts,
    });
    expect(authority.cycle).toMatchObject({ cycleId, frozenTier: 'T3', frozenCap: 2 });
  });

  it('does not promote a merged or durably completed T2 cycle', () => {
    const opts = options();
    let authority = initializePackReviewAuthority({
      prNumber: 2539, headSha: sha('a'), tier: 'T2',
      capMapVersion: PACK_REVIEW_LOGICAL_CAP_MAP_VERSION, options: opts,
    });
    const cycleId = authority.cycle!.cycleId;
    authority = reconcilePackReviewTier({
      prNumber: 2539, tier: 'T3', prMerged: true, options: opts,
    });
    expect(authority.cycle).toMatchObject({ cycleId, frozenTier: 'T2', frozenCap: 1 });
    authority = commitPackReviewTerminal({
      prNumber: 2539, expectedTransitionSeq: authority.transitionSeq,
      terminal: {
        schemaVersion: 1, terminalContractVersion: 2, terminalSource: 'normal',
        runId: 'settled-first', targetSha: sha('a'), reviewVerdict: 'clean',
        findingCount: 0, findingsDigest: 'clean', logicalRoundOrdinal: 1,
      },
      status: 'clean', findingCount: 0, options: opts,
    });
    expect(authority.cycle?.reviewStageComplete).toBe(true);
    authority = reconcilePackReviewTier({
      prNumber: 2539, tier: 'T3', startedRunExists: true, options: opts,
    });
    expect(authority.cycle).toMatchObject({ cycleId, frozenTier: 'T2', frozenCap: 1 });
  });
});

describe('Issue #2659 immutable same-head body-amendment authority', () => {
  const digest = (digit: string) => `sha256:${digit.repeat(64)}`;
  it('starts one cap-one continuation, preserves original verdict, and serializes a second amendment', () => {
    const opts = options();
    const prNumber = 2659;
    const first = initializePackReviewAuthority({
      prNumber, headSha: sha('a'), tier: 'T2',
      capMapVersion: PACK_REVIEW_LOGICAL_CAP_MAP_VERSION, options: opts,
    });
    const final = commitPackReviewTerminal({
      prNumber, expectedTransitionSeq: first.transitionSeq,
      terminal: { ...findingsTerminal('original-final', sha('a')),
        logicalRoundOrdinal: 1, automaticBudgetDisposition: 'consume' },
      status: 'changes_requested', findingCount: 1, options: opts,
    });
    expect(final.cycle).toMatchObject({
      frozenCap: 1, state: 'at_cap_open_findings', consumedRoundOrdinals: [1],
    });
    const original = structuredClone(final.terminal);
    const continuation = beginPackReviewBodyAmendmentContinuation({
      prNumber, expectedTransitionSeq: final.transitionSeq,
      headSha: sha('a'), closingIssueNumber: 2659,
      priorTerminalRunId: 'original-final',
      reviewedBodyDigest: digest('0'), amendedBodyDigest: digest('1'),
      options: opts,
    });
    expect(continuation.cycle).toMatchObject({
      frozenTier: 'T2', frozenCap: 1, consumedRoundOrdinals: [], state: 'open',
      amendmentOrigin: {
        originalCycleId: final.cycle!.cycleId,
        originalTerminalRunId: 'original-final',
        previousTerminalRunId: 'original-final',
        reviewedBodyDigest: digest('0'), amendedBodyDigest: digest('1'),
        previouslyAdmittedBodyDigests: [digest('0')],
      },
    });
    expect(continuation.cycle!.cycleId).not.toBe(final.cycle!.cycleId);
    expect(continuation.terminal).toBeUndefined();
    expect(original?.runId).toBe('original-final');
    expect(readPackReviewAuthority(prNumber, opts)?.cycle!.cycleId).toBe(continuation.cycle!.cycleId);
    expect(() => beginPackReviewBodyAmendmentContinuation({
      prNumber, expectedTransitionSeq: continuation.transitionSeq,
      headSha: sha('a'), closingIssueNumber: 2659,
      priorTerminalRunId: 'original-final',
      reviewedBodyDigest: digest('0'), amendedBodyDigest: digest('1'),
      options: opts,
    })).toThrow(/eligible|unverified/);
    const cleanB1 = commitPackReviewTerminal({
      prNumber, expectedTransitionSeq: continuation.transitionSeq,
      terminal: {
        schemaVersion: 1, terminalContractVersion: 2, terminalSource: 'normal',
        runId: 'first-amendment', targetSha: sha('a'),
        reviewVerdict: 'clean', findingCount: 0,
        findingsDigest: 'clean-first', logicalRoundOrdinal: 1,
        automaticBudgetDisposition: 'consume',
      },
      status: 'up_to_date', findingCount: 0, options: opts,
    });
    expect(cleanB1.cycle).toMatchObject({
      state: 'closed', reviewStageComplete: true, frozenCap: 1,
      consumedRoundOrdinals: [1],
    });
    const continuation2 = beginPackReviewBodyAmendmentContinuation({
      prNumber, expectedTransitionSeq: cleanB1.transitionSeq,
      headSha: sha('a'), closingIssueNumber: 2659,
      priorTerminalRunId: 'first-amendment',
      reviewedBodyDigest: digest('1'), amendedBodyDigest: digest('2'),
      options: opts,
    });
    expect(continuation2.cycle?.amendmentOrigin).toMatchObject({
      originalTerminalRunId: 'original-final',
      originalCycleId: final.cycle!.cycleId,
      previousCycleId: cleanB1.cycle!.cycleId,
      previousTerminalRunId: 'first-amendment',
      previouslyAdmittedBodyDigests: [digest('0'), digest('1')],
      amendedBodyDigest: digest('2'),
    });
    expect(continuation2.cycle?.frozenCap).toBe(1);
    const cleanB2 = commitPackReviewTerminal({
      prNumber, expectedTransitionSeq: continuation2.transitionSeq,
      terminal: {
        schemaVersion: 1, terminalContractVersion: 2, terminalSource: 'normal',
        runId: 'second-amendment', targetSha: sha('a'),
        reviewVerdict: 'clean', findingCount: 0,
        findingsDigest: 'clean-second', logicalRoundOrdinal: 1,
        automaticBudgetDisposition: 'consume',
      },
      status: 'up_to_date', findingCount: 0, options: opts,
    });
    expect(() => beginPackReviewBodyAmendmentContinuation({
      prNumber, expectedTransitionSeq: cleanB2.transitionSeq,
      headSha: sha('a'), closingIssueNumber: 2659,
      priorTerminalRunId: 'second-amendment',
      reviewedBodyDigest: digest('2'), amendedBodyDigest: digest('0'),
      options: opts,
    })).toThrow(/reversion|already admitted/);
  });

  it('opens a same-H1 B1 review after a completed clean B0 without audited reset', () => {
    const opts = options();
    const prNumber = 2661;
    const base = initializePackReviewAuthority({
      prNumber, headSha: sha('a'), tier: 'T2',
      capMapVersion: PACK_REVIEW_LOGICAL_CAP_MAP_VERSION, options: opts,
    });
    const cleanB0 = commitPackReviewTerminal({
      prNumber, expectedTransitionSeq: base.transitionSeq,
      terminal: {
        schemaVersion: 1, terminalContractVersion: 2, terminalSource: 'normal',
        runId: 'original-clean', targetSha: sha('a'),
        reviewVerdict: 'clean', findingCount: 0, findingsDigest: 'clean-B0',
        logicalRoundOrdinal: 1, automaticBudgetDisposition: 'consume',
      },
      status: 'up_to_date', findingCount: 0, options: opts,
    });
    expect(cleanB0.cycle).toMatchObject({
      reviewStageComplete: true, state: 'closed', frozenCap: 1,
      consumedRoundOrdinals: [1],
    });
    const next = beginPackReviewBodyAmendmentContinuation({
      prNumber, expectedTransitionSeq: cleanB0.transitionSeq,
      headSha: sha('a'), closingIssueNumber: 2661,
      priorTerminalRunId: 'original-clean',
      reviewedBodyDigest: digest('0'), amendedBodyDigest: digest('1'),
      options: opts,
    });
    expect(next.currentHeadSha).toBe(cleanB0.currentHeadSha);
    expect(next.cycle).toMatchObject({
      frozenCap: 1, state: 'open', consumedRoundOrdinals: [],
      amendmentOrigin: {
        originalCycleId: cleanB0.cycle!.cycleId,
        originalTerminalRunId: 'original-clean',
        reviewedBodyDigest: digest('0'), amendedBodyDigest: digest('1'),
      },
    });
    expect(next.cycle!.cycleId).not.toBe(cleanB0.cycle!.cycleId);
    expect(next.cycle!.resetProvenance).toBeUndefined();
    expect(next.terminal).toBeUndefined();
    expect(() => beginPackReviewBodyAmendmentContinuation({
      prNumber, expectedTransitionSeq: next.transitionSeq,
      headSha: sha('a'), closingIssueNumber: 2661,
      priorTerminalRunId: 'original-clean',
      reviewedBodyDigest: digest('0'), amendedBodyDigest: digest('1'),
      options: opts,
    })).toThrow(/eligible|unverified/);
  });

  it('retains ordinary T3 cap two and fails closed for unaccepted origin/head', () => {
    const opts = options();
    const initial = initializePackReviewAuthority({
      prNumber: 2660, headSha: sha('c'), tier: 'T3',
      capMapVersion: PACK_REVIEW_LOGICAL_CAP_MAP_VERSION, options: opts,
    });
    expect(initial.cycle!.frozenCap).toBe(2);
    expect(() => beginPackReviewBodyAmendmentContinuation({
      prNumber: 2660, expectedTransitionSeq: initial.transitionSeq,
      headSha: sha('d'), closingIssueNumber: 2660,
      priorTerminalRunId: 'invented', reviewedBodyDigest: digest('0'),
      amendedBodyDigest: digest('1'), options: opts,
    })).toThrow(/eligible|unverified/);
    expect(readPackReviewAuthority(2660, opts)?.cycle!.frozenCap).toBe(2);
  });
});

describe('Issue #2659 H1/B0 and H1/B1 digest-qualified snapshots', () => {
  it('preserves the original body, selects both exact digests and rejects ambiguous head-only recovery', () => {
    const stateBaseDir = mkdtempSync(join(tmpdir(), 'pack-review-amendment-snapshot-'));
    roots.push(stateBaseDir);
    const key = { projectId: 'orchestrator-pack', prNumber: 2659,
      prHeadSha: sha('b'), issueNumber: 2659, stateBaseDir };
    const oldBody = '## Acceptance criteria\n- old behavior\n';
    const newBody = '## Acceptance criteria\n- amended behavior\n';
    const b0 = captureBoundIssueSnapshot({ ...key, issueBody: oldBody });
    const newDigest = computeBoundIssueSnapshotHash(newBody);
    const b1 = captureBoundIssueSnapshot({
      ...key, issueBody: newBody, snapshotDigest: newDigest,
    });
    expect(b1.created).toBe(true);
    expect(b1.snapshotPath).not.toBe(b0.snapshotPath);
    expect(readFileSync(b0.snapshotPath, 'utf8')).toBe(oldBody);
    expect(readFileSync(b1.snapshotPath, 'utf8')).toBe(newBody);
    expect(resolveBoundIssueSnapshot(key).status).toBe('corrupted');
    const old = resolveBoundIssueSnapshot({ ...key, snapshotDigest: b0.snapshotHash });
    const fresh = resolveBoundIssueSnapshot({ ...key, snapshotDigest: newDigest });
    expect(old).toMatchObject({ status: 'found', snapshotPath: b0.snapshotPath });
    expect(fresh).toMatchObject({ status: 'found', snapshotPath: b1.snapshotPath });
    expect(loadValidatedBoundSnapshotBody({
      ...key, snapshotDigest: newDigest, snapshotFilePath: b1.snapshotPath,
    }).body).toBe(newBody);
    expect(captureBoundIssueSnapshot({
      ...key, issueBody: oldBody, snapshotDigest: b0.snapshotHash,
    }).created).toBe(false);
    expect(captureBoundIssueSnapshot({
      ...key, issueBody: newBody, snapshotDigest: newDigest,
    }).created).toBe(false);
    expect(() => captureBoundIssueSnapshot({ ...key, issueBody: newBody })).toThrow();
    expect(() => captureBoundIssueSnapshot({
      ...key, issueBody: newBody, snapshotDigest: b0.snapshotHash,
    })).toThrow(/digest differs/);
    const paths = boundIssueSnapshotArtifactPaths({ ...key, snapshotDigest: newDigest });
    expect(paths.snapshotPath).toBe(b1.snapshotPath);
  });
});

describe('Issue #2659 shared run-store and authority lock regression', () => {
  it('updates a run with missing and existing authority without reacquiring its held .store-lock', () => {
    const config = options();
    const storeOptions = { projectId: 'orchestrator-pack', storeRoot: config.storeRoot };
    const prNumber = 26591;
    const headSha = sha('a');
    const run = createPackReviewRun({
      ...storeOptions, prNumber, headSha,
      trustedPackRoot: repoRoot, sourceRepoRoot: repoRoot,
    }).run;

    // Both paths require the normal validated authority lookup, but the
    // run-store writer already owns the shared non-reentrant directory lock.
    expect(updatePackReviewRun(run.id, { status: 'preparing' }, storeOptions).status).toBe('preparing');
    const authority = initializePackReviewAuthority({
      prNumber, headSha, tier: 'T2',
      capMapVersion: PACK_REVIEW_LOGICAL_CAP_MAP_VERSION, options: config,
    });
    expect(authority.currentHeadSha).toBe(headSha);
    expect(updatePackReviewRun(run.id, { status: 'running' }, storeOptions).status).toBe('running');
    expect(readPackReviewAuthority(prNumber, config)?.transitionSeq).toBe(authority.transitionSeq);
    expect(getPackReviewRun(run.id, storeOptions)?.status).toBe('running');
  });
});
