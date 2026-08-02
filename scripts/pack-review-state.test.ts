import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  terminalConsumesCapSlot,
  validateTerminalV2,
} from './pack-review-state.ts';

const roots: string[] = [];
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
