import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  NOT_READY_COMPONENT_PRECEDENCE,
  choosePrimaryNotReadyComponent,
} from '../docs/review-head-ready.mjs';
import {
  planReconcileActions,
  type PlanReconcileInput,
  type ReconcileAction,
} from '../docs/review-trigger-reconcile.mjs';

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../tests/fixtures/review-trigger-reconcile',
);

const greenChecks = [
  { name: 'Verify orchestrator-pack structure', state: 'SUCCESS' },
  { name: 'PR scope guard', state: 'SUCCESS' },
  { name: 'Run pack contract tests', state: 'SUCCESS' },
  { name: 'Self-architect lint', state: 'SUCCESS' },
];

type FixturePayload = PlanReconcileInput & {
  expect?: {
    startReviewCount?: number;
    skipReason?: string;
    record?: {
      branch?: string;
      primary?: string;
      failedComponents?: string[];
    };
  };
};

function loadFixture(name: string): FixturePayload {
  return JSON.parse(readFileSync(path.join(fixturesDir, name), 'utf8')) as FixturePayload;
}

function skipActions(actions: ReconcileAction[]) {
  return actions.filter((a): a is Extract<ReconcileAction, { type: 'skip' }> => a.type === 'skip');
}

function startReviewActions(actions: ReconcileAction[]) {
  return actions.filter(
    (a): a is Extract<ReconcileAction, { type: 'start_review' }> => a.type === 'start_review',
  );
}

describe('Issue #212 defer subreason records', () => {
  it('AC1: documents stable primary precedence order', () => {
    expect(NOT_READY_COMPONENT_PRECEDENCE.indexOf('no_ready_for_review')).toBeLessThan(
      NOT_READY_COMPONENT_PRECEDENCE.indexOf('ci_red'),
    );
    expect(choosePrimaryNotReadyComponent(['ci_red', 'no_ready_for_review'])).toBe(
      'no_ready_for_review',
    );
  });

  it('AC1: no ready_for_review records no_ready_for_review primary', () => {
    const fixture = loadFixture('uncovered-no-report.json');
    const actions = planReconcileActions(fixture);
    const skip = skipActions(actions).find((a) => a.prNumber === 99);
    expect(skip?.reason).toBe('uncovered_not_ready');
    expect(skip?.record?.primary).toBe('no_ready_for_review');
    expect(skip?.record?.failedComponents).toContain('no_ready_for_review');
    expect(skip?.record?.observed?.reportRoute).toBe('none');
  });

  it('AC1: stale report binding records stale_report_binding', () => {
    const fixture = loadFixture('intermediate-commit.json');
    const skip = skipActions(planReconcileActions(fixture))[0];
    expect(skip?.record?.primary).toBe('no_ready_for_review');
    expect(skip?.record?.failedComponents).toContain('stale_report_binding');
    expect(skip?.record?.observed?.reportBoundHeadSha).toBe('newhead55');
    expect(skip?.record?.observed?.reportRoute).toBe('addressing_reviews');
  });

  it('AC1: ci_red_defer records ci_red subreason', () => {
    const fixture = loadFixture('defer-ci-red.json');
    const skip = skipActions(planReconcileActions(fixture))[0];
    expect(skip?.reason).toBe('ci_red_defer');
    expect(skip?.record?.primary).toBe('ci_red');
    expect(skip?.record?.failedComponents).toEqual(['ci_red']);
  });

  it('AC1: failed/cancelled records failed_or_cancelled branch', () => {
    const fixture = loadFixture('defer-failed-cancelled.json');
    const skip = skipActions(planReconcileActions(fixture))[0];
    expect(skip?.reason).toBe('failed_or_cancelled_on_head');
    expect(skip?.record?.branch).toBe('failed_or_cancelled');
    expect(skip?.record?.observed).toMatchObject({
      runId: 'run-fail-71',
      status: 'failed',
      terminationReason: 'codex exec review exited 1',
    });
  });

  it('AC1: head_covered is distinct from uncovered-not-ready subreasons', () => {
    const fixture = loadFixture('covered-clean.json');
    const skip = skipActions(planReconcileActions(fixture))[0];
    expect(skip?.reason).toBe('head_covered');
    expect(skip?.record?.branch).toBe('head_covered');
    expect(skip?.record?.primary).toBe('head_covered');
    expect(skip?.record?.observed).toMatchObject({
      coveringRunStatus: 'clean',
      headMatch: true,
      prMatch: true,
    });
  });

  it('AC2: mixed failure records every failed component and deterministic primary', () => {
    const fixture = loadFixture('defer-mixed-failure.json');
    const skip = skipActions(planReconcileActions(fixture))[0];
    expect(skip?.record?.primary).toBe(fixture.expect?.record?.primary);
    expect(skip?.record?.failedComponents).toEqual(fixture.expect?.record?.failedComponents);
  });

  it('AC3: report/CI defer carries branch-complete reproducing fields', () => {
    const fixture = loadFixture('uncovered-no-report.json');
    const skip = skipActions(planReconcileActions(fixture))[0];
    expect(skip?.record?.observed).toMatchObject({
      prNumber: 99,
      currentHeadSha: 'deadbeef',
      reportBoundHeadSha: 'none',
      reportRoute: 'none',
      ciLevel: 'green',
      requiredCheckSource: 'pack_merge_contract_fallback',
    });
  });

  it('AC4: degraded-CI handoff is distinct from no hand-off yet', () => {
    const degraded = loadFixture('degraded-ci-worker-handoff.json');
    const degradedSkip = skipActions(planReconcileActions(degraded)).find((a) => a.record);
    expect(degradedSkip?.reason).not.toBe('uncovered_not_ready');
    expect(degradedSkip?.record?.failedComponents).toContain('degraded_ci_handoff');
    expect(degradedSkip?.record?.observed?.reportRoute).toBe('degraded_ci');

    const noHandoff = loadFixture('uncovered-no-report.json');
    const noHandoffSkip = skipActions(planReconcileActions(noHandoff))[0];
    expect(noHandoffSkip?.record?.observed?.reportRoute).toBe('none');
    expect(noHandoffSkip?.record?.failedComponents).not.toContain('degraded_ci_handoff');
  });

  it('AC5: ready uncovered head starts review on reconciler tick alone', () => {
    const fixture = loadFixture('ready-head-triggers.json');
    const actions = planReconcileActions(fixture);
    expect(startReviewActions(actions)).toHaveLength(1);
  });

  it('AC6: PR #211 shape — prior defer does not block next tick when head becomes ready', () => {
    const prNumber = 211;
    const headSha = '1607071';
    const base = {
      openPrs: [{ number: prNumber, headRefOid: headSha }],
      reviewRuns: [] as [],
      ciChecksByPr: { [String(prNumber)]: greenChecks },
    };

    const tick1 = planReconcileActions({
      ...base,
      sessions: [
        {
          name: 'opk-16',
          role: 'worker',
          prNumber,
          status: 'working',
          reports: [],
        },
      ],
    });
    const defer = skipActions(tick1)[0];
    expect(defer?.reason).toBe('uncovered_not_ready');
    expect(defer?.record?.primary).toBe('no_ready_for_review');
    expect(startReviewActions(tick1)).toHaveLength(0);

    const tick2 = planReconcileActions({
      ...base,
      sessions: [
        {
          name: 'opk-16',
          role: 'worker',
          prNumber,
          status: 'ready_for_review',
          reports: [
            {
              reportState: 'ready_for_review',
              headRefOid: headSha,
              reportedAt: '2026-06-06T01:45:00.000Z',
            },
          ],
        },
      ],
    });
    expect(startReviewActions(tick2)).toHaveLength(1);
    expect(skipActions(tick2)).toHaveLength(0);
  });

  it('AC7: gating outcomes unchanged across existing #195 fixtures', () => {
    const cases: Array<{ fixture: string; starts: number; skipReason?: string }> = [
      { fixture: 'ready-head-triggers.json', starts: 1 },
      { fixture: 'uncovered-no-report.json', starts: 0, skipReason: 'uncovered_not_ready' },
      { fixture: 'intermediate-commit.json', starts: 0, skipReason: 'uncovered_not_ready' },
      { fixture: 'red-ci-defer.json', starts: 0, skipReason: 'ci_red_defer' },
      { fixture: 'pending-ci-triggers.json', starts: 1 },
      { fixture: 'covered-clean.json', starts: 0, skipReason: 'head_covered' },
      { fixture: 'uncovered-only-outdated.json', starts: 1 },
    ];

    for (const { fixture, starts, skipReason } of cases) {
      const payload = loadFixture(fixture);
      const actions = planReconcileActions(payload);
      expect(startReviewActions(actions), fixture).toHaveLength(starts);
      if (skipReason) {
        expect(skipActions(actions).some((a) => a.reason === skipReason), fixture).toBe(true);
      }
    }
  });
});
