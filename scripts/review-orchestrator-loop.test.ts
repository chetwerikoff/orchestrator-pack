import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isHeadCovered } from '../docs/review-trigger-reconcile.mjs';
import {
  evaluatePrNumberLessMergedRun,
  evaluateReviewRunWithRecheck,
  hasFailedOrCancelledOnHead,
  shouldOrchestratorActOnRun,
  shouldStartReviewRunOnUncoveredPath,
} from '../docs/review-orchestrator-loop.mjs';

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../tests/fixtures/review-orchestrator-loop',
);

function loadFixture<T>(name: string): T {
  const raw = readFileSync(path.join(fixturesDir, name), 'utf8');
  return JSON.parse(raw) as T;
}

describe('coverage predicate (no drift vs reconciler)', () => {
  const head = 'abc123def';
  const pr = 42;
  const otherPr = 99;

  it('same SHA different PR does not count as covered', () => {
    expect(
      isHeadCovered(
        [{ prNumber: otherPr, targetSha: head, status: 'clean' }],
        pr,
        head,
      ),
    ).toBe(false);
  });

  it('same PR different SHA does not count as covered', () => {
    expect(
      isHeadCovered(
        [{ prNumber: pr, targetSha: 'otherhead', status: 'clean' }],
        pr,
        head,
      ),
    ).toBe(false);
  });

  it('same PR and SHA with clean status is covered', () => {
    expect(
      isHeadCovered(
        [{ prNumber: pr, targetSha: head, status: 'clean' }],
        pr,
        head,
      ),
    ).toBe(true);
  });
});

describe('shouldStartReviewRunOnUncoveredPath', () => {
  const head = 'deadbeef';
  const pr = 77;

  it('AC1: does not start when head has covered terminal clean', () => {
    const fixture = loadFixture<{
      runs: Parameters<typeof shouldStartReviewRunOnUncoveredPath>[0];
    }>('covered-clean-no-third-run.json');
    const result = shouldStartReviewRunOnUncoveredPath(fixture.runs, pr, head);
    expect(result.start).toBe(false);
    expect(result.reason).toBe('head_covered');
  });

  it('AC8: two covered runs on one head — no third run', () => {
    const fixture = loadFixture<{
      runs: Parameters<typeof shouldStartReviewRunOnUncoveredPath>[0];
    }>('two-covered-runs-one-head.json');
    const result = shouldStartReviewRunOnUncoveredPath(fixture.runs, pr, head);
    expect(result.start).toBe(false);
  });

  it.each(['clean', 'needs_triage', 'waiting_update'])(
    'blocks on covered terminal %s',
    (status) => {
      const result = shouldStartReviewRunOnUncoveredPath(
        [{ prNumber: pr, targetSha: head, status }],
        pr,
        head,
      );
      expect(result).toEqual({ start: false, reason: 'head_covered' });
    },
  );

  it('allows start when only outdated runs exist on head', () => {
    const result = shouldStartReviewRunOnUncoveredPath(
      [{ prNumber: pr, targetSha: head, status: 'outdated' }],
      pr,
      head,
    );
    expect(result).toEqual({ start: true, reason: 'uncovered_head' });
  });

  it('AC3: failed on current head uses retry discipline, not plain uncovered', () => {
    const fixture = loadFixture<{
      runs: Parameters<typeof shouldStartReviewRunOnUncoveredPath>[0];
    }>('failed-on-current-head.json');
    expect(hasFailedOrCancelledOnHead(fixture.runs, pr, head)).toBe(true);
    const result = shouldStartReviewRunOnUncoveredPath(fixture.runs, pr, head);
    expect(result.start).toBe(false);
    expect(result.reason).toBe('failed_or_cancelled_use_retry_discipline');
  });

  it('AC3: cancelled on current head uses retry discipline', () => {
    const fixture = loadFixture<{
      runs: Parameters<typeof shouldStartReviewRunOnUncoveredPath>[0];
    }>('cancelled-on-current-head.json');
    const result = shouldStartReviewRunOnUncoveredPath(fixture.runs, pr, head);
    expect(result.start).toBe(false);
    expect(result.reason).toBe('failed_or_cancelled_use_retry_discipline');
  });
});

describe('evaluateReviewRunWithRecheck', () => {
  const pr = 88;
  const head = 'cafe00';

  it('AC4: no run when head becomes covered before pre-run re-check', () => {
    const fixture = loadFixture<{
      runsAtTurnStart: Parameters<typeof evaluateReviewRunWithRecheck>[0]['runsAtTurnStart'];
      runsImmediatelyBeforeRun: Parameters<
        typeof evaluateReviewRunWithRecheck
      >[0]['runsImmediatelyBeforeRun'];
    }>('became-covered-before-prerun.json');
    const result = evaluateReviewRunWithRecheck({
      runsAtTurnStart: fixture.runsAtTurnStart,
      runsImmediatelyBeforeRun: fixture.runsImmediatelyBeforeRun,
      prNumber: pr,
      headSha: head,
    });
    expect(result.emitReviewRun).toBe(false);
    expect(result.reason).toMatch(/^pre_run_recheck_/);
  });

  it('emits run when still uncovered after re-check', () => {
    const result = evaluateReviewRunWithRecheck({
      runsAtTurnStart: [],
      runsImmediatelyBeforeRun: [],
      prNumber: pr,
      headSha: head,
    });
    expect(result.emitReviewRun).toBe(true);
  });
});

describe('evaluatePrNumberLessMergedRun', () => {
  it('AC5: terminal when merged PR via linked session without prNumber', () => {
    const fixture = loadFixture<{
      run: Parameters<typeof evaluatePrNumberLessMergedRun>[0];
      sessions: Parameters<typeof evaluatePrNumberLessMergedRun>[1];
      mergedPrNumbers: number[];
    }>('merged-pr-session-restored-no-prnumber.json');
    const result = evaluatePrNumberLessMergedRun(
      fixture.run,
      fixture.sessions,
      fixture.mergedPrNumbers,
    );
    expect(result.terminal).toBe(true);
    expect(result.action).toBe('inaction_merged_terminal');
  });

  it('AC6: inaction when linked session missing', () => {
    const fixture = loadFixture<{
      run: Parameters<typeof evaluatePrNumberLessMergedRun>[0];
      sessions: Parameters<typeof evaluatePrNumberLessMergedRun>[1];
      mergedPrNumbers: number[];
    }>('linked-session-missing.json');
    const result = evaluatePrNumberLessMergedRun(
      fixture.run,
      fixture.sessions,
      fixture.mergedPrNumbers,
    );
    expect(result.terminal).toBe(false);
    expect(result.action).toBe('inaction_fail_closed');
    expect(result.reason).toBe('linked_session_missing');
  });

  it('AC6: inaction on restored session id mismatch', () => {
    const fixture = loadFixture<{
      run: Parameters<typeof evaluatePrNumberLessMergedRun>[0];
      sessions: Parameters<typeof evaluatePrNumberLessMergedRun>[1];
      mergedPrNumbers: number[];
    }>('restored-session-id-mismatch.json');
    const result = evaluatePrNumberLessMergedRun(
      fixture.run,
      fixture.sessions,
      fixture.mergedPrNumbers,
    );
    expect(result.action).toBe('inaction_fail_closed');
    expect(result.reason).toBe('restored_session_id_mismatch');
  });

  it('AC6: inaction on ambiguous PR metadata', () => {
    const fixture = loadFixture<{
      run: Parameters<typeof evaluatePrNumberLessMergedRun>[0];
      sessions: Parameters<typeof evaluatePrNumberLessMergedRun>[1];
      mergedPrNumbers: number[];
    }>('ambiguous-pr-metadata.json');
    const result = evaluatePrNumberLessMergedRun(
      fixture.run,
      fixture.sessions,
      fixture.mergedPrNumbers,
    );
    expect(result.action).toBe('inaction_fail_closed');
    expect(result.reason).toBe('ambiguous_pr_metadata');
  });
});

describe('shouldOrchestratorActOnRun', () => {
  it('does not act on terminal merged prNumber-less run', () => {
    const fixture = loadFixture<{
      run: Parameters<typeof shouldOrchestratorActOnRun>[0];
      sessions: Parameters<typeof shouldOrchestratorActOnRun>[1];
      mergedPrNumbers: number[];
    }>('merged-pr-session-restored-no-prnumber.json');
    const result = shouldOrchestratorActOnRun(
      fixture.run,
      fixture.sessions,
      fixture.mergedPrNumbers,
    );
    expect(result.act).toBe(false);
    expect(result.terminal).toBe(true);
  });
});
