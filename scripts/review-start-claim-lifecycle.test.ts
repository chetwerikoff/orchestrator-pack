import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  classifyClaimHolderLiveness,
  evaluateHoldBudget,
  evaluateLaunchPending,
  evaluateMatchingRunEvidenceForKey,
  findCoveringRunForKey,
  hasInFlightCoveringRun,
  evaluateReadinessEnvelope,
  evaluateReclaimDecision,
  evaluateSweep,
  evaluateVisibilityFence,
  resolveClaimLifecycleConfig,
} from '../docs/review-start-claim-lifecycle.mjs';

const fullSha = 'fd2fdb6600000000000000000000000000000000000';

function fakeHolder(overrides: Record<string, unknown> = {}) {
  return {
    surface: 'fixture',
    pid: 424242,
    host: 'test-host',
    processGuid: 'guid-1',
    startTimeTicks: '100',
    bootIdHash: 'boot-a',
    ...overrides,
  };
}

describe('review-start-claim-lifecycle predicates', () => {
  it('does not treat stale prReviewStatus running as covering when latestRun failed', () => {
    const runs = [
      {
        id: 'run-stale',
        prNumber: 266,
        targetSha: fullSha,
        prReviewStatus: 'running',
        latestRunStatus: 'failed',
      },
    ];
    expect(findCoveringRunForKey(runs, 266, fullSha)).toBeNull();
    expect(hasInFlightCoveringRun(runs, 266, fullSha)).toBe(false);
    expect(evaluateMatchingRunEvidenceForKey(runs, 266, fullSha).corruptEvidence).toBe(false);
  });

  it('resolves bounded lifecycle config within the readiness envelope', () => {
    const config = resolveClaimLifecycleConfig({ readinessEnvelopeMs: 30_000 });
    expect(config.readinessEnvelopeMs).toBe(30_000);
    expect(config.holdBudgetMs).toBeLessThanOrEqual(30_000);
    expect(config.reaperPeriodSeconds).toBe(30);
  });

  it('caps readiness envelope operator override at 30 seconds', () => {
    const config = resolveClaimLifecycleConfig(
      { readinessEnvelopeMs: 60_000 },
      { AO_REVIEW_CLAIM_READINESS_ENVELOPE_MS: '90000' },
    );
    expect(config.readinessEnvelopeMs).toBe(30_000);
  });

  it('caps reaper period operator override at 30 seconds', () => {
    const config = resolveClaimLifecycleConfig(
      {},
      { AO_REVIEW_CLAIM_REAPER_PERIOD_SECONDS: '120' },
    );
    expect(config.reaperPeriodSeconds).toBe(30);
  });

  it('blocks reclaim when matching run records have ambiguous status', () => {
    const decision = evaluateReclaimDecision({
      claim: {
        state: 'active',
        key: `pr-266-${fullSha}`,
        prNumber: 266,
        headSha: fullSha,
        holder: fakeHolder(),
        acquiredAtUtc: '2026-06-24T12:00:00.000Z',
        holdStartedAtUtc: '2026-06-24T12:00:00.000Z',
      },
      holderLiveness: { outcome: 'provably_not_alive', reason: 'proc_entry_missing' },
      reviewRuns: [{ id: 'run-ambiguous', prNumber: 266, targetSha: fullSha, status: 'mystery' }],
      nowMs: Date.parse('2026-06-24T12:00:05.000Z'),
    });
    expect(decision.action).toBe('block');
    expect(decision.reason).toBe('corrupt_run_store_evidence');
  });

  it('treats outdated review runs as known non-covering evidence', () => {
    const evidence = evaluateMatchingRunEvidenceForKey(
      [{ id: 'run-old', prNumber: 266, targetSha: fullSha, status: 'outdated' }],
      266,
      fullSha,
    );
    expect(evidence.corruptEvidence).toBe(false);
    expect(evidence.ambiguousRuns).toEqual([]);
  });

  it('reclaims dead local holder when only outdated runs match the key', () => {
    const decision = evaluateReclaimDecision({
      claim: {
        state: 'active',
        key: `pr-266-${fullSha}`,
        prNumber: 266,
        headSha: fullSha,
        holder: fakeHolder({ host: 'local-host' }),
        acquiredAtUtc: '2026-06-24T11:00:00.000Z',
        holdStartedAtUtc: '2026-06-24T11:00:00.000Z',
      },
      holderLiveness: { outcome: 'provably_not_alive', reason: 'proc_entry_missing' },
      reviewRuns: [{ id: 'run-old', prNumber: 266, targetSha: fullSha, status: 'outdated' }],
      nowMs: Date.parse('2026-06-24T12:00:00.000Z'),
    });
    expect(decision.action).toBe('terminalize');
    expect(decision.outcome).toBe('recovered_orphan_liveness');
  });

  it('fences dead legacy holders with invoke evidence instead of reclaiming', () => {
    const acquired = '2026-06-24T12:00:00.000Z';
    const decision = evaluateReclaimDecision({
      claim: {
        state: 'active',
        prNumber: 266,
        headSha: fullSha,
        holder: fakeHolder({ startTimeTicks: '', bootIdHash: '' }),
        acquiredAtUtc: acquired,
        holdStartedAtUtc: acquired,
        boundRunId: 'opk-rev-old',
      },
      holderLiveness: { outcome: 'provably_not_alive', reason: 'proc_entry_missing' },
      reviewRuns: [],
      nowMs: Date.parse('2026-06-24T12:00:05.000Z'),
    });
    expect(decision.action).toBe('terminalize');
    expect(decision.outcome).toBe('run_not_visible_fenced');
    expect(decision.reason).toBe('bound_run_id_present');
  });

  it('reclaims dead local holder without waiting for stale age', () => {
    const nowMs = Date.parse('2026-06-24T12:00:00.000Z');
    const claim = {
      schemaVersion: 1,
      key: `pr-266-${fullSha}`,
      prNumber: 266,
      headSha: fullSha,
      state: 'active',
      holder: fakeHolder({ host: 'local-host' }),
      acquiredAtUtc: '2026-06-24T11:00:00.000Z',
      holdStartedAtUtc: '2026-06-24T11:00:00.000Z',
    };
    const decision = evaluateReclaimDecision({
      claim,
      holderLiveness: { outcome: 'provably_not_alive', reason: 'proc_entry_missing' },
      reviewRuns: [],
      nowMs,
      localHost: 'local-host',
    });
    expect(decision.action).toBe('terminalize');
    expect(decision.outcome).toBe('recovered_orphan_liveness');
  });

  it('does not reclaim when launch-pending intent is active', () => {
    const nowMs = Date.parse('2026-06-24T12:00:05.000Z');
    const claim = {
      state: 'active',
      prNumber: 266,
      headSha: fullSha,
      holder: fakeHolder(),
      acquiredAtUtc: '2026-06-24T12:00:00.000Z',
      launchPending: { atUtc: '2026-06-24T12:00:00.000Z', budgetMs: 15_000 },
    };
    const decision = evaluateReclaimDecision({
      claim,
      holderLiveness: { outcome: 'provably_not_alive', reason: 'proc_entry_missing' },
      reviewRuns: [],
      nowMs,
    });
    expect(decision.action).toBe('skip');
    expect(decision.reason).toBe('launch_pending_active');
  });

  it('fences launch-pending after budget expiry', () => {
    const nowMs = Date.parse('2026-06-24T12:00:20.000Z');
    const claim = {
      state: 'active',
      prNumber: 266,
      headSha: fullSha,
      holder: fakeHolder(),
      acquiredAtUtc: '2026-06-24T12:00:00.000Z',
      launchPending: { atUtc: '2026-06-24T12:00:00.000Z', budgetMs: 15_000 },
    };
    const decision = evaluateReclaimDecision({
      claim,
      holderLiveness: { outcome: 'provably_not_alive', reason: 'proc_entry_missing' },
      reviewRuns: [],
      nowMs,
    });
    expect(decision.action).toBe('terminalize');
    expect(decision.outcome).toBe('launch_pending_budget_exceeded');
  });

  it('detects PID reuse as provably dead for the original holder', () => {
    const liveness = classifyClaimHolderLiveness(fakeHolder({ startTimeTicks: '100', bootIdHash: 'boot-a' }), {
      localHost: 'test-host',
      bootIdHash: 'boot-a',
      procStartTimeTicks: '999',
      allowNonLinuxProc: true,
    });
    expect(liveness.outcome).toBe('provably_not_alive');
    expect(liveness.reason).toBe('pid_reused_or_wrong_instance');
  });

  it('evaluates hold budget expiry for alive holders after launch gate', () => {
    const nowMs = Date.parse('2026-06-24T12:00:20.000Z');
    const hold = evaluateHoldBudget({
      claim: {
        acquiredAtUtc: '2026-06-24T12:00:00.000Z',
        holdStartedAtUtc: '2026-06-24T12:00:00.000Z',
        launchPending: { atUtc: '2026-06-24T12:00:00.000Z', budgetMs: 15_000 },
      },
      nowMs,
      config: resolveClaimLifecycleConfig({ holdBudgetMs: 15_000 }),
    });
    expect(hold.exceeded).toBe(true);
    expect(hold.phase).toBe('post_launch_gate');
  });

  it('fences post-run visibility after budget when run stays invisible', () => {
    const nowMs = Date.parse('2026-06-24T12:00:20.000Z');
    const fence = evaluateVisibilityFence({
      claim: {
        prNumber: 266,
        headSha: fullSha,
        visibilityPendingAtUtc: '2026-06-24T12:00:00.000Z',
      },
      reviewRuns: [],
      nowMs,
      config: resolveClaimLifecycleConfig({ visibilityBudgetMs: 15_000 }),
    });
    expect(fence.shouldFence).toBe(true);
  });

  it('sweep uses one batch run-store read and no per-claim gh fetches', () => {
    const sweep = evaluateSweep({
      activeClaims: [
        { key: 'a', state: 'active', prNumber: 1, headSha: fullSha, holder: fakeHolder() },
        { key: 'b', state: 'active', prNumber: 2, headSha: fullSha, holder: fakeHolder() },
      ],
      reviewRuns: [],
      nowMs: Date.now(),
      localHost: 'test-host',
    });
    expect(sweep.runStoreBatchReads).toBe(1);
    expect(sweep.actions).toHaveLength(2);
  });


  it('keeps legacy holders blocking when pid evidence is still present', () => {
    const acquired = '2026-06-24T12:00:00.000Z';
    const liveness = classifyClaimHolderLiveness(fakeHolder({ startTimeTicks: '', bootIdHash: '' }), {
      localHost: 'test-host',
      procStartTimeTicks: '123',
      allowNonLinuxProc: true,
    });
    expect(liveness.outcome).toBe('legacy');
    const decision = evaluateReclaimDecision({
      claim: {
        state: 'active',
        prNumber: 266,
        headSha: fullSha,
        holder: fakeHolder({ startTimeTicks: '', bootIdHash: '' }),
        acquiredAtUtc: acquired,
        holdStartedAtUtc: acquired,
      },
      holderLiveness: liveness,
      reviewRuns: [],
      nowMs: Date.parse('2026-06-24T12:00:05.000Z'),
      localHost: 'test-host',
    });
    expect(decision.action).toBe('skip');
    expect(decision.reason).toBe('legacy_holder_unverified');
  });

  it('does not reclaim legacy live holders when the readiness envelope expires', () => {
    const acquired = '2026-06-24T12:00:00.000Z';
    const liveness = classifyClaimHolderLiveness(fakeHolder({ startTimeTicks: '', bootIdHash: '' }), {
      localHost: 'test-host',
      procStartTimeTicks: '123',
      allowNonLinuxProc: true,
    });
    expect(liveness.outcome).toBe('legacy');
    const decision = evaluateReclaimDecision({
      claim: {
        state: 'active',
        prNumber: 266,
        headSha: fullSha,
        holder: fakeHolder({ startTimeTicks: '', bootIdHash: '' }),
        acquiredAtUtc: acquired,
        holdStartedAtUtc: acquired,
      },
      holderLiveness: liveness,
      reviewRuns: [],
      nowMs: Date.parse('2026-06-24T12:00:31.000Z'),
      config: resolveClaimLifecycleConfig({ readinessEnvelopeMs: 30_000 }),
      localHost: 'test-host',
    });
    expect(decision.action).toBe('skip');
    expect(decision.reason).toBe('legacy_holder_unverified');
  });

  it('reclaims legacy holder when local pid is absent', () => {
    const acquired = '2026-06-24T12:00:00.000Z';
    const decision = evaluateReclaimDecision({
      claim: {
        state: 'active',
        prNumber: 266,
        headSha: fullSha,
        holder: fakeHolder({ startTimeTicks: '', bootIdHash: '' }),
        acquiredAtUtc: acquired,
        holdStartedAtUtc: acquired,
      },
      holderLiveness: { outcome: 'provably_not_alive', reason: 'proc_entry_missing' },
      reviewRuns: [],
      nowMs: Date.parse('2026-06-24T12:00:05.000Z'),
      localHost: 'test-host',
    });
    expect(decision.action).toBe('terminalize');
    expect(decision.outcome).toBe('recovered_orphan_liveness');
  });

  it('enforces shared readiness envelope across stacked lifecycle phases', () => {
    const acquired = '2026-06-24T12:00:00.000Z';
    const nowMs = Date.parse('2026-06-24T12:00:31.000Z');
    const decision = evaluateReclaimDecision({
      claim: {
        state: 'active',
        prNumber: 266,
        headSha: fullSha,
        holder: fakeHolder(),
        acquiredAtUtc: acquired,
        holdStartedAtUtc: acquired,
        launchPending: { atUtc: '2026-06-24T12:00:15.000Z', budgetMs: 15_000 },
        visibilityPendingAtUtc: '2026-06-24T12:00:20.000Z',
        invokeCompletedAtUtc: '2026-06-24T12:00:20.000Z',
      },
      holderLiveness: { outcome: 'alive', reason: 'alive' },
      reviewRuns: [],
      nowMs,
      config: resolveClaimLifecycleConfig({ readinessEnvelopeMs: 30_000 }),
    });
    expect(decision.action).toBe('terminalize');
    expect(decision.outcome).toBe('run_not_visible_fenced');
  });

  it('caps hold budget by the shared readiness envelope', () => {
    const envelope = evaluateReadinessEnvelope({
      claim: { acquiredAtUtc: '2026-06-24T12:00:00.000Z', holdStartedAtUtc: '2026-06-24T12:00:00.000Z' },
      nowMs: Date.parse('2026-06-24T12:00:31.000Z'),
      config: resolveClaimLifecycleConfig({ readinessEnvelopeMs: 30_000, holdBudgetMs: 15_000 }),
    });
    expect(envelope.exceeded).toBe(true);
  });

  it('fences post-invoke visibility before launch-pending expiry', () => {
    const nowMs = Date.parse('2026-06-24T12:00:20.000Z');
    const decision = evaluateReclaimDecision({
      claim: {
        state: 'active',
        prNumber: 266,
        headSha: fullSha,
        holder: fakeHolder(),
        acquiredAtUtc: '2026-06-24T12:00:00.000Z',
        invokeCompletedAtUtc: '2026-06-24T12:00:01.000Z',
        visibilityPendingAtUtc: '2026-06-24T12:00:01.000Z',
      },
      holderLiveness: { outcome: 'alive', reason: 'alive' },
      reviewRuns: [],
      nowMs,
      config: resolveClaimLifecycleConfig({ visibilityBudgetMs: 15_000 }),
    });
    expect(decision.action).toBe('terminalize');
    expect(decision.outcome).toBe('run_not_visible_fenced');
  });

  it('marks non-local holders for manual resolution', () => {
    const decision = evaluateReclaimDecision({
      claim: {
        state: 'active',
        prNumber: 266,
        headSha: fullSha,
        holder: fakeHolder({ host: 'remote-host' }),
        acquiredAtUtc: '2026-06-24T11:00:00.000Z',
      },
      holderLiveness: { outcome: 'foreign_host', reason: 'non_local_holder' },
      reviewRuns: [],
      nowMs: Date.now(),
    });
    expect(decision.action).toBe('mark_manual');
    expect(decision.outcome).toBe('foreign_holder_manual');
  });

  it('skips foreign-holder marking when manual resolution is already pending', () => {
    const decision = evaluateReclaimDecision({
      claim: {
        state: 'active',
        prNumber: 266,
        headSha: fullSha,
        holder: fakeHolder({ host: 'remote-host' }),
        acquiredAtUtc: '2026-06-24T11:00:00.000Z',
        manualResolutionRequired: {
          outcome: 'foreign_holder_manual',
          reason: 'non_local_holder',
          decisionSource: 'reaper',
          atUtc: '2026-06-24T11:05:00.000Z',
        },
      },
      holderLiveness: { outcome: 'foreign_host', reason: 'non_local_holder' },
      reviewRuns: [],
      nowMs: Date.now(),
    });
    expect(decision.action).toBe('skip');
    expect(decision.reason).toBe('foreign_holder_manual_pending');
  });

  it('terminalizes dead holder when a terminal covering run exists', () => {
    const decision = evaluateReclaimDecision({
      claim: {
        state: 'active',
        prNumber: 266,
        headSha: fullSha,
        holder: fakeHolder(),
        acquiredAtUtc: '2026-06-24T11:00:00.000Z',
        holdStartedAtUtc: '2026-06-24T11:00:00.000Z',
      },
      holderLiveness: { outcome: 'provably_not_alive', reason: 'proc_entry_missing' },
      reviewRuns: [{ id: 'run-done', prNumber: 266, targetSha: fullSha, status: 'up_to_date' }],
      nowMs: Date.parse('2026-06-24T12:00:05.000Z'),
    });
    expect(decision.action).toBe('terminalize');
    expect(decision.outcome).toBe('orphan_covered_run_unbound');
    expect(decision.reason).toBe('dead_holder_terminal_covered_run');
  });

  it('fences dead legacy holder when post-acquire side-effect audit exists', () => {
    const decision = evaluateReclaimDecision({
      claim: {
        state: 'active',
        prNumber: 266,
        headSha: fullSha,
        holder: fakeHolder({ startTimeTicks: '', bootIdHash: '' }),
        acquiredAtUtc: '2026-06-24T11:00:00.000Z',
        holdStartedAtUtc: '2026-06-24T11:00:00.000Z',
      },
      holderLiveness: { outcome: 'provably_not_alive', reason: 'proc_entry_missing' },
      reviewRuns: [],
      nowMs: Date.parse('2026-06-24T12:00:05.000Z'),
      postAcquireSideEffectAudit: true,
    });
    expect(decision.action).toBe('terminalize');
    expect(decision.outcome).toBe('run_not_visible_fenced');
    expect(decision.reason).toBe('side_effect_audit_present');
  });
});
