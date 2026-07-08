import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { planReconcileActions } from '../docs/review-trigger-reconcile.mjs';
import { evaluateOrchestratorTurnGate } from '../docs/orchestrator-claimed-review-run.mjs';
import { evaluateWakeReviewTrigger } from '../docs/review-wake-trigger.mjs';
import { planDeferredWatchTick } from '../docs/review-trigger-reeval.mjs';
import {
  buildReviewCycleCapCurrentHead,
  buildReviewCycleCapPriorHeadRuns,
  buildReviewCycleCapWorkerSession,
  REVIEW_CYCLE_CAP_T1_ISSUE_BODY,
  REVIEW_CYCLE_CAP_T2_ISSUE_BODY,
} from './_review-cycle-cap-tier-fixture.js';
import {
  REVIEW_CYCLE_CAP_BUDGET_EXHAUSTED,
  TERMINAL_AT_CAP_OPEN_FINDINGS,
  TERMINAL_CLEAN_EARLY_STOP,
  TIER_CAP_BY_TIER,
  buildAtCapOpenFindingsRecord,
  classifyTerminalRun,
  deriveDistinctHeadBudget,
  evaluateReviewCycleCapGate,
  parseComplexityTierFromIssueBody,
  resolveTierAndCap,
  syncReviewCycleCapState,
} from '../docs/review-cycle-cap.mjs';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const capModuleSource = readFileSync(path.join(repoRoot, 'docs/review-cycle-cap.mjs'), 'utf8');
const capPsHelperSource = readFileSync(
  path.join(repoRoot, 'scripts/lib/Review-CycleCap.ps1'),
  'utf8',
);

function run(prNumber: number, headSha: string, reviewRuns: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) {
  return evaluateReviewCycleCapGate({
    prNumber,
    currentHeadSha: headSha,
    openPrs: [{ number: prNumber, headRefOid: headSha }],
    reviewRuns,
    capState: (extra.capState ?? {}) as Record<string, unknown>,
    issueBody: extra.issueBody as string | undefined,
    nowMs: extra.nowMs as number | undefined,
    producer: extra.producer as string | undefined,
  });
}


describe('cap state persistence on later denials', () => {
  it('orchestrator turn denial after cap sync returns capCycleState', () => {
    const pr = 646;
    const head = 'turn-deny'.padEnd(40, 't');
    const runs = [
      { prNumber: pr, targetSha: head, status: 'changes_requested', openFindingCount: 1, completedAt: '2026-07-01T00:00:00Z' },
    ];
    const result = evaluateOrchestratorTurnGate({
      prNumber: pr,
      eventHeadSha: head,
      openPrs: [{ number: pr, headRefOid: head }],
      reviewRuns: runs,
      sessions: [{ sessionId: 'opk-646', role: 'worker', prNumber: pr }],
      ciChecks: [{ name: 'verify', state: 'pending' }],
      requiredCheckNames: ['verify'],
      sessionId: 'opk-646',
      provenanceAutonomous: true,
      claimWindow: 'free',
      capCycleState: {},
    });
    expect(result.launch).toBe(false);
    expect(result.stage).toBe('review_ready');
    expect((result.capCycleState?.[String(pr)] as { cycleOpenedAtUtc?: string } | undefined)?.cycleOpenedAtUtc).toBeTruthy();
  });

  it('wake denial after cap sync returns capCycleState', () => {
    const pr = 646;
    const current = buildReviewCycleCapCurrentHead('wake');
    const runs = buildReviewCycleCapPriorHeadRuns(pr);
    const session = buildReviewCycleCapWorkerSession(pr, 'opk-646');
    const result = evaluateWakeReviewTrigger({
      wakeKind: 'merge.ready',
      sessionId: 'opk-646',
      prNumber: pr,
      openPrs: [{ number: pr, headRefOid: current, headCommittedAt: '2026-07-03T00:00:00Z' }],
      reviewRuns: runs,
      sessions: [session],
      ciChecks: [
        { name: 'verify', state: 'FAILURE', conclusion: 'failure' },
        { name: 'scope', state: 'SUCCESS', conclusion: 'success' },
      ],
      requiredCheckNames: ['verify', 'scope'],
      capCycleState: {},
    });
    expect(result.triggerReviewRun).toBe(false);
    expect(result.reason).toBe('ci_red_defer');
    expect((result.capCycleState?.[String(pr)] as { cycleOpenedAtUtc?: string } | undefined)?.cycleOpenedAtUtc).toBeTruthy();
  });
});

describe('cap gate uses review status reader', () => {
  it('cap gate module imports review run rows only (no ao review list argv)', () => {
    expect(capModuleSource).not.toMatch(/\bao\s+review\s+list\b/i);
    expect(capModuleSource).toMatch(/reviewRuns/);
    expect(capModuleSource).toMatch(/review-reconcile-primitives\.mjs/);
  });

  it('Review-CycleCap.ps1 routes through mechanical node CLI, not ao review list', () => {
    expect(capPsHelperSource).toMatch(/review-cycle-cap\.mjs/);
    expect(capPsHelperSource).not.toMatch(/\bao\s+review\s+list\b/i);
  });
});

describe('tier default T2 cap 4', () => {
  it('defaults to T2 cap 4 when tier is unresolvable', () => {
    const resolved = resolveTierAndCap({});
    expect(resolved.tier).toBe('T2');
    expect(resolved.cap).toBe(4);
  });

  it('issue fence T3 wins over default T2', () => {
    const body = '```complexity-tier\ntier: T3\nadvisory-prior: T3\n```';
    const resolved = resolveTierAndCap({ issueBody: body });
    expect(resolved.tier).toBe('T3');
    expect(resolved.cap).toBe(8);
  });

  it('freezes tier at cycle open — relabel does not change active cap', () => {
    const t2Body = '```complexity-tier\ntier: T2\n```';
    const t3Body = '```complexity-tier\ntier: T3\n```';
    const headA = 'a'.repeat(40);
    const runs = [
      { prNumber: 646, targetSha: headA, status: 'changes_requested', openFindingCount: 1, completedAt: '2026-07-01T00:00:00.000Z' },
    ];
    const first = syncReviewCycleCapState({
      capState: {},
      prNumber: 646,
      currentHeadSha: headA,
      reviewRuns: runs,
      issueBody: t2Body,
      nowMs: Date.parse('2026-07-01T00:00:00.000Z'),
    });
    expect(first.prState.tier).toBe('T2');
    expect(first.prState.cap).toBe(4);

    const second = syncReviewCycleCapState({
      capState: first.capState,
      prNumber: 646,
      currentHeadSha: headA,
      reviewRuns: runs,
      issueBody: t3Body,
      nowMs: Date.parse('2026-07-02T00:00:00.000Z'),
    });
    expect(second.prState.tier).toBe('T2');
    expect(second.prState.cap).toBe(4);
  });
});

describe('distinct head counting matrix', () => {
  const pr = 646;

  it('(a) two terminal runs same targetSha consume one budget unit', () => {
    const sha = 'same'.padEnd(40, '1');
    const runs = [
      { prNumber: pr, targetSha: sha, status: 'changes_requested', openFindingCount: 2, completedAt: '2026-07-01T00:00:00Z' },
      { prNumber: pr, targetSha: sha, status: 'changes_requested', openFindingCount: 1, completedAt: '2026-07-01T01:00:00Z' },
    ];
    const budget = deriveDistinctHeadBudget(runs, pr, sha);
    expect(budget).toHaveLength(1);
    expect(budget[0]?.targetSha).toBe(sha);
  });

  it('(b) failed/cancelled zero-finding consumes zero units', () => {
    const sha = 'zero'.padEnd(40, '2');
    const runs = [{ prNumber: pr, targetSha: sha, status: 'failed', findingCount: 0, completedAt: '2026-07-01T00:00:00Z' }];
    expect(classifyTerminalRun(runs[0], sha).kind).toBe('excluded');
    expect(deriveDistinctHeadBudget(runs, pr, sha)).toHaveLength(0);
  });

  it('(c) failed/cancelled with findings consumes one unit', () => {
    const sha = 'fail'.padEnd(40, '3');
    const runs = [{ prNumber: pr, targetSha: sha, status: 'failed', openFindingCount: 2, completedAt: '2026-07-01T00:00:00Z' }];
    expect(classifyTerminalRun(runs[0], sha).kind).toBe('open_findings');
    expect(deriveDistinctHeadBudget(runs, pr, sha)).toHaveLength(1);
  });

  it('(d) waiting_update completed reviewer pass consumes one unit', () => {
    const sha = 'wait'.padEnd(40, '4');
    const runs = [{ prNumber: pr, targetSha: sha, status: 'waiting_update', sentFindingCount: 1, completedAt: '2026-07-01T00:00:00Z' }];
    expect(classifyTerminalRun(runs[0], sha).kind).toBe('open_findings');
    expect(deriveDistinctHeadBudget(runs, pr, sha)).toHaveLength(1);
  });

  it('(e) reaper-killed mid-flight without verdict consumes zero units', () => {
    const sha = 'reap'.padEnd(40, '5');
    const runs = [{ prNumber: pr, targetSha: sha, status: 'failed', reaperKilled: true, completedAt: '2026-07-01T00:00:00Z' }];
    expect(classifyTerminalRun(runs[0], sha).kind).toBe('excluded');
    expect(deriveDistinctHeadBudget(runs, pr, sha)).toHaveLength(0);
  });

  it('(f) four distinct terminal heads on T2 exhausts budget', () => {
    const heads = ['h1', 'h2', 'h3', 'h4'].map((h) => h.padEnd(40, 'f'));
    const runs = heads.map((sha, idx) => ({
      prNumber: pr,
      targetSha: sha,
      status: 'changes_requested',
      openFindingCount: 1,
      completedAt: `2026-07-0${idx + 1}T00:00:00Z`,
    }));
    const current = heads[3]!;
    const budget = deriveDistinctHeadBudget(runs, pr, current);
    expect(budget).toHaveLength(4);
    const gate = run(pr, current, runs, { issueBody: '```complexity-tier\ntier: T2\n```' });
    expect(gate.prState?.terminal).toBe(TERMINAL_AT_CAP_OPEN_FINDINGS);
  });

  it('(g) two distinct terminal heads on T1 exhausts budget', () => {
    const heads = ['a1', 'a2'].map((h) => h.padEnd(40, '1'));
    const runs = heads.map((sha, idx) => ({
      prNumber: pr,
      targetSha: sha,
      status: 'changes_requested',
      openFindingCount: 1,
      completedAt: `2026-07-0${idx + 1}T00:00:00Z`,
    }));
    const gate = run(pr, heads[1]!, runs, { issueBody: '```complexity-tier\ntier: T1\n```' });
    expect(gate.prState?.cap).toBe(TIER_CAP_BY_TIER.T1);
    expect(gate.prState?.terminal).toBe(TERMINAL_AT_CAP_OPEN_FINDINGS);
  });

  it('reconcile plan honors per-PR tier via issueBodiesByPr (not T2 fallback)', () => {
    const prior = ['a1', 'a2'].map((h) => h.padEnd(40, '1'));
    const current = 'a3'.padEnd(40, '1');
    const runs = [
      ...prior.map((sha, idx) => ({
        prNumber: pr,
        targetSha: sha,
        status: 'changes_requested',
        openFindingCount: 1,
        completedAt: `2026-07-0${idx + 1}T00:00:00Z`,
      })),
    ];
    const t1Body = '```complexity-tier\ntier: T1\n```';
    const t2Body = '```complexity-tier\ntier: T2\n```';
    const base = {
      openPrs: [{ number: pr, headRefOid: current, headCommittedAt: '2026-07-03T00:00:00Z' }],
      reviewRuns: runs,
      sessions: [
        {
          sessionId: 'opk-646',
          role: 'worker',
          prNumber: pr,
          status: 'working',
          reports: [{ reportState: 'ready_for_review', reportedAt: '2026-07-03T01:00:00Z' }],
        },
      ],
      ciChecksByPr: {
        [pr]: [
          { name: 'verify', state: 'SUCCESS' },
        ],
      },
      requiredCheckNamesByPr: { [pr]: ['verify'] },
      capCycleState: {},
    };
    const t2Plan = planReconcileActions({ ...base, issueBodiesByPr: { [String(pr)]: REVIEW_CYCLE_CAP_T2_ISSUE_BODY } });
    expect(t2Plan.actions.some((a) => a.type === 'start_review')).toBe(true);

    const t1Plan = planReconcileActions({ ...base, issueBodiesByPr: { [String(pr)]: REVIEW_CYCLE_CAP_T1_ISSUE_BODY } });
    expect(t1Plan.actions.some((a) => a.type === 'start_review')).toBe(false);
    expect(t1Plan.actions.some((a) => a.type === 'skip' && a.reason === REVIEW_CYCLE_CAP_BUDGET_EXHAUSTED)).toBe(true);
  });

  it('(h) eight distinct terminal heads on T3 exhausts budget', () => {
    const heads = Array.from({ length: 8 }, (_, i) => `t3-${i}`.padEnd(40, '8'));
    const runs = heads.map((sha, idx) => ({
      prNumber: pr,
      targetSha: sha,
      status: 'changes_requested',
      openFindingCount: 1,
      completedAt: `2026-06-${String(idx + 1).padStart(2, '0')}T00:00:00Z`,
    }));
    const gate = run(pr, heads[7]!, runs, { issueBody: '```complexity-tier\ntier: T3\n```' });
    expect(gate.prState?.cap).toBe(8);
    expect(gate.prState?.terminal).toBe(TERMINAL_AT_CAP_OPEN_FINDINGS);
  });
});

describe('clean early stop terminal', () => {
  const pr = 646;
  const head = 'clean'.padEnd(40, 'c');

  it('records clean_early_stop and blocks further automated starts on same head', () => {
    const runs = [{ prNumber: pr, targetSha: head, status: 'up_to_date', openFindingCount: 0, completedAt: '2026-07-01T00:00:00Z' }];
    const gate = run(pr, head, runs);
    expect(gate.allowStart).toBe(false);
    expect(gate.terminal).toBe(TERMINAL_CLEAN_EARLY_STOP);
    expect(gate.mergeEligible).toBe(true);

    const reconcile = planReconcileActions({
      openPrs: [{ number: pr, headRefOid: head }],
      reviewRuns: runs,
      sessions: [{ name: 'opk-646', role: 'worker', prNumber: pr, ownedHeadSha: head, reports: [{ reportState: 'ready_for_review', prHeadSha: head }] }],
      ciChecksByPr: { [pr]: [{ name: 'verify', state: 'success', conclusion: 'success' }] },
      requiredCheckNamesByPr: { [pr]: ['verify'] },
      capCycleState: gate.capState,
    });
    const startActions = reconcile.actions.filter((a) => a.type === 'start_review');
    expect(startActions).toHaveLength(0);

    const turn = evaluateOrchestratorTurnGate({
      prNumber: pr,
      eventHeadSha: head,
      openPrs: [{ number: pr, headRefOid: head }],
      reviewRuns: runs,
      sessions: [{ sessionId: 'opk-646', role: 'worker', prNumber: pr }],
      ciChecks: [{ name: 'verify', state: 'success', conclusion: 'success' }],
      requiredCheckNames: ['verify'],
      sessionId: 'opk-646',
      provenanceAutonomous: true,
      claimWindow: 'free',
      capCycleState: gate.capState,
    });
    expect(turn.launch).toBe(false);
    expect(turn.reason).toBe(TERMINAL_CLEAN_EARLY_STOP);

    const wake = evaluateWakeReviewTrigger({
      wakeKind: 'ready_for_review',
      prNumber: pr,
      admittedHeadSha: head,
      admittedBaseRef: 'refs/heads/feature',
      openPrs: [{ number: pr, headRefOid: head }],
      reviewRuns: runs,
      sessions: [{ name: 'opk-646', role: 'worker', prNumber: pr, reports: [{ reportState: 'ready_for_review', prHeadSha: head }] }],
      ciChecks: [{ name: 'verify', state: 'success', conclusion: 'success' }],
      requiredCheckNames: ['verify'],
      sessionId: 'opk-646',
      capCycleState: gate.capState,
    });
    expect(wake.triggerReviewRun).toBe(false);
    expect(wake.reason).toBe(TERMINAL_CLEAN_EARLY_STOP);

    const reeval = planDeferredWatchTick({
      watchEntries: {
        [`${pr}:${head}`]: {
          prNumber: pr,
          prHeadSha: head,
          status: 'watching',
          windowExpiresMs: Date.now() + 60_000,
        },
      },
      openPrs: [{ number: pr, headRefOid: head }],
      reviewRuns: runs,
      sessions: [{ name: 'opk-646', role: 'worker', prNumber: pr, reports: [{ reportState: 'ready_for_review', prHeadSha: head }] }],
      ciChecksByPr: { [pr]: [{ name: 'verify', state: 'success', conclusion: 'success' }] },
      requiredCheckNamesByPr: { [pr]: ['verify'] },
      capCycleState: gate.capState,
    });
    expect(reeval.actions.some((a) => a.type === 'start_review')).toBe(false);
  });
});

describe('at cap open findings terminal', () => {
  const pr = 646;

  it('emits brief-B consumable record and suppresses every automated start surface', () => {
    const heads = ['c1', 'c2', 'c3', 'c4'].map((h) => h.padEnd(40, 'a'));
    const current = heads[3]!;
    const runs = heads.map((sha, idx) => ({
      prNumber: pr,
      targetSha: sha,
      status: 'changes_requested',
      openFindingCount: 1,
      completedAt: `2026-07-0${idx + 1}T00:00:00Z`,
    }));
    const gate = run(pr, current, runs, { issueBody: '```complexity-tier\ntier: T2\n```', producer: 'reconcile' });
    expect(gate.terminal).toBe(TERMINAL_AT_CAP_OPEN_FINDINGS);
    expect(gate.atCapRecord).toMatchObject({
      schema_version: 1,
      terminal: TERMINAL_AT_CAP_OPEN_FINDINGS,
      pr_number: pr,
      head_sha: current,
      tier: 'T2',
      cap: 4,
      open_finding_count: 1,
      distinct_heads_reviewed: heads,
      producer: 'reconcile',
    });

    const reconcile = planReconcileActions({
      openPrs: [{ number: pr, headRefOid: current }],
      reviewRuns: runs,
      sessions: [{ name: 'opk-646', role: 'worker', prNumber: pr, ownedHeadSha: current, reports: [{ reportState: 'ready_for_review', prHeadSha: current }] }],
      ciChecksByPr: { [pr]: [{ name: 'verify', state: 'success', conclusion: 'success' }] },
      requiredCheckNamesByPr: { [pr]: ['verify'] },
      capCycleState: gate.capState,
    });
    expect(reconcile.actions.some((a) => a.type === 'start_review')).toBe(false);

    const turn = evaluateOrchestratorTurnGate({
      prNumber: pr,
      eventHeadSha: current,
      openPrs: [{ number: pr, headRefOid: current }],
      reviewRuns: runs,
      sessions: [{ sessionId: 'opk-646', role: 'worker', prNumber: pr }],
      ciChecks: [{ name: 'verify', state: 'success', conclusion: 'success' }],
      requiredCheckNames: ['verify'],
      sessionId: 'opk-646',
      provenanceAutonomous: true,
      claimWindow: 'free',
      capCycleState: gate.capState,
    });
    expect(turn.launch).toBe(false);
    expect(turn.reason).toBe(TERMINAL_AT_CAP_OPEN_FINDINGS);
  });

  it('validates at_cap_open_findings record against brief-B schema checklist', () => {
    const record = buildAtCapOpenFindingsRecord({
      prNumber: 646,
      headSha: 'abc',
      tier: 'T2',
      cap: 4,
      distinctHeadsReviewed: ['a', 'b', 'c', 'd'],
      openFindingCount: 3,
      cycleOpenedAtUtc: '2026-07-01T00:00:00.000Z',
      terminatedAtUtc: '2026-07-02T00:00:00.000Z',
      producer: 'reconcile',
    });
    expect(record.schema_version).toBe(1);
    expect(record.terminal).toBe(TERMINAL_AT_CAP_OPEN_FINDINGS);
    expect(record.pr_number).toBe(646);
    expect(record.distinct_heads_reviewed).toHaveLength(4);
    expect(record.open_finding_count).toBeGreaterThan(0);
    expect(record.cycle_opened_at_utc).toBeTruthy();
    expect(record.terminated_at_utc).toBeTruthy();
    expect(record.producer).toBe('reconcile');
  });
});

describe('review cycle cap scenario matrix', () => {
  const pr = 646;

  it('head churn: stale-A terminal after B is current does not consume budget', () => {
    const headA = 'sha-a'.padEnd(40, 'a');
    const headB = 'sha-b'.padEnd(40, 'b');
    const runs = [
      {
        prNumber: pr,
        targetSha: headA,
        status: 'up_to_date',
        openFindingCount: 0,
        terminalHeadSha: headB,
        completedAt: '2026-07-02T00:00:00Z',
      },
    ];
    expect(classifyTerminalRun(runs[0], headB).kind).toBe('excluded');
    expect(deriveDistinctHeadBudget(runs, pr, headB)).toHaveLength(0);
    const gate = run(pr, headB, runs);
    expect(gate.allowStart).toBe(true);
  });

  it('persists cycle state across restart and keeps independent budgets per PR', () => {
    const head1 = 'pr1-head'.padEnd(40, '1');
    const head2 = 'pr2-head'.padEnd(40, '2');
    const runs = [
      { prNumber: 101, targetSha: head1, status: 'changes_requested', openFindingCount: 1, completedAt: '2026-07-01T00:00:00Z' },
      { prNumber: 202, targetSha: head2, status: 'changes_requested', openFindingCount: 1, completedAt: '2026-07-01T00:00:00Z' },
    ];
    const first = syncReviewCycleCapState({
      capState: {},
      prNumber: 101,
      currentHeadSha: head1,
      reviewRuns: runs,
    });
    const second = syncReviewCycleCapState({
      capState: first.capState,
      prNumber: 202,
      currentHeadSha: head2,
      reviewRuns: runs,
    });
    expect(second.capState['101']).toBeTruthy();
    expect(second.capState['202']).toBeTruthy();
    expect((second.capState['101'] as { distinctHeadsReviewed?: string[] }).distinctHeadsReviewed).toEqual([head1]);
    expect((second.capState['202'] as { distinctHeadsReviewed?: string[] }).distinctHeadsReviewed).toEqual([head2]);
  });

  it('superseded run excluded and same-sha retry after open_findings does not add budget', () => {
    const sha = 'retry'.padEnd(40, 'r');
    const runs = [
      { prNumber: pr, targetSha: sha, status: 'outdated', superseded: true, completedAt: '2026-07-01T00:00:00Z' },
      { prNumber: pr, targetSha: sha, status: 'changes_requested', openFindingCount: 1, completedAt: '2026-07-01T01:00:00Z' },
      { prNumber: pr, targetSha: sha, status: 'changes_requested', openFindingCount: 1, completedAt: '2026-07-01T02:00:00Z' },
    ];
    expect(deriveDistinctHeadBudget(runs, pr, sha)).toHaveLength(1);
  });

  it('post clean_early_stop new head opens fresh cycle', () => {
    const oldHead = 'old-clean'.padEnd(40, 'o');
    const newHead = 'new-head'.padEnd(40, 'n');
    const oldRuns = [{ prNumber: pr, targetSha: oldHead, status: 'up_to_date', openFindingCount: 0, completedAt: '2026-07-01T00:00:00Z' }];
    const stopped = run(pr, oldHead, oldRuns);
    expect(stopped.terminal).toBe(TERMINAL_CLEAN_EARLY_STOP);

    const historicalRuns = [
      ...oldRuns,
      { prNumber: pr, targetSha: 'hist1'.padEnd(40, 'h'), status: 'changes_requested', openFindingCount: 1, completedAt: '2026-06-01T00:00:00Z' },
      { prNumber: pr, targetSha: 'hist2'.padEnd(40, 'i'), status: 'changes_requested', openFindingCount: 1, completedAt: '2026-06-02T00:00:00Z' },
    ];
    const gate = run(pr, newHead, historicalRuns, {
      capState: stopped.capState,
      nowMs: Date.parse('2026-07-02T00:00:00Z'),
    });
    expect(gate.terminal).not.toBe(TERMINAL_CLEAN_EARLY_STOP);
    expect(gate.allowStart).toBe(true);
    expect(gate.prState?.distinctHeadsReviewed).toEqual([]);
    expect(gate.prState?.cycleOpenedAtUtc).toBeTruthy();
  });


  it('blocks new unreviewed head when distinct-head cap is spent (zero findings on head)', () => {
    const heads = ['c1', 'c2'].map((h) => h.padEnd(40, 'x'));
    const newHead = 'new-head'.padEnd(40, 'n');
    const runs = heads.map((sha, idx) => ({
      prNumber: pr,
      targetSha: sha,
      status: 'changes_requested',
      openFindingCount: 1,
      completedAt: `2026-07-0${idx + 1}T00:00:00Z`,
    }));
    const gate = run(pr, newHead, runs, { issueBody: '```complexity-tier\ntier: T1\n```' });
    expect(gate.allowStart).toBe(false);
    expect(gate.reason).toBe(REVIEW_CYCLE_CAP_BUDGET_EXHAUSTED);
    expect(gate.terminal).toBeNull();
    expect(gate.atCapRecord).toBeUndefined();
    expect(gate.prState?.distinctHeadsReviewed).toHaveLength(2);
    expect(gate.prState?.terminal).toBeNull();
    expect(gate.prState?.atCapRecord).toBeNull();
  });

  it('wake honors issue tier via issueBody', () => {
    const current = buildReviewCycleCapCurrentHead();
    const runs = buildReviewCycleCapPriorHeadRuns(pr);
    const session = buildReviewCycleCapWorkerSession(pr, 'opk-646');
    const base = {
      wakeKind: 'ready_for_review' as const,
      prNumber: pr,
      admittedHeadSha: current,
      admittedBaseRef: 'refs/heads/feature',
      openPrs: [{ number: pr, headRefOid: current, headCommittedAt: '2026-07-03T00:00:00Z' }],
      reviewRuns: runs,
      sessions: [session],
      ciChecks: [{ name: 'verify', state: 'SUCCESS' }],
      requiredCheckNames: ['verify'],
      sessionId: 'opk-646',
      capCycleState: {},
    };
    const t2Wake = evaluateWakeReviewTrigger({ ...base, issueBody: REVIEW_CYCLE_CAP_T2_ISSUE_BODY });
    expect(t2Wake.triggerReviewRun).toBe(true);

    const t1Wake = evaluateWakeReviewTrigger({ ...base, issueBody: REVIEW_CYCLE_CAP_T1_ISSUE_BODY });
    expect(t1Wake.triggerReviewRun).toBe(false);
    expect(t1Wake.reason).toBe(REVIEW_CYCLE_CAP_BUDGET_EXHAUSTED);
  });

  it('reeval deferred watch honors per-PR tier via issueBodiesByPr', () => {
    const current = buildReviewCycleCapCurrentHead();
    const runs = buildReviewCycleCapPriorHeadRuns(pr);
    const base = {
      watchEntries: {
        [`${pr}:${current}`]: {
          prNumber: pr,
          headSha: current,
          status: 'watching',
          windowExpiresMs: Date.now() + 60_000,
        },
      },
      openPrs: [{ number: pr, headRefOid: current, headCommittedAt: '2026-07-03T00:00:00Z' }],
      reviewRuns: runs,
      sessions: [buildReviewCycleCapWorkerSession(pr, 'opk-646')],
      ciChecksByPr: { [pr]: [{ name: 'verify', state: 'SUCCESS' }] },
      requiredCheckNamesByPr: { [pr]: ['verify'] },
      capCycleState: {},
    };
    const t2Plan = planDeferredWatchTick({ ...base, issueBodiesByPr: { [String(pr)]: REVIEW_CYCLE_CAP_T2_ISSUE_BODY } });
    expect(t2Plan.actions.some((a) => a.type === 'start_review')).toBe(true);

    const t1Plan = planDeferredWatchTick({ ...base, issueBodiesByPr: { [String(pr)]: REVIEW_CYCLE_CAP_T1_ISSUE_BODY } });
    expect(t1Plan.actions.some((a) => a.type === 'start_review')).toBe(false);
    expect(t1Plan.actions.some((a) => a.type === 'skip' && a.reason === REVIEW_CYCLE_CAP_BUDGET_EXHAUSTED)).toBe(true);
  });
  it('at-cap head advance without clearance keeps terminal and suppresses starts', () => {
    const heads = ['c1', 'c2', 'c3', 'c4'].map((h) => h.padEnd(40, 'x'));
    const newHead = 'new-after-cap'.padEnd(40, 'z');
    const runs = heads.map((sha, idx) => ({
      prNumber: pr,
      targetSha: sha,
      status: 'changes_requested',
      openFindingCount: 1,
      completedAt: `2026-07-0${idx + 1}T00:00:00Z`,
    }));
    const capped = run(pr, heads[3]!, runs, { issueBody: '```complexity-tier\ntier: T2\n```' });
    expect(capped.terminal).toBe(TERMINAL_AT_CAP_OPEN_FINDINGS);

    const afterPush = run(pr, newHead, runs, { capState: capped.capState });
    expect(afterPush.allowStart).toBe(false);
    expect(afterPush.terminal).toBe(TERMINAL_AT_CAP_OPEN_FINDINGS);
    expect(afterPush.prState?.distinctHeadsReviewed).toHaveLength(4);
  });
});

describe('parseComplexityTierFromIssueBody', () => {
  it('parses tier fence lines', () => {
    const parsed = parseComplexityTierFromIssueBody('```complexity-tier\ntier: T3\n```');
    expect(parsed).toEqual({ kind: 'tier', tier: 'T3' });
  });
});
