// @vitest-ci-lane light
// @vitest-pre-topology-seconds 60

import { describe, expect, it } from 'vitest';
import {
  formatSmokeReportComment,
  parseWorkerSmokeAffectedCarrier,
  planWorkerSmokeSelectiveRetry,
  projectWorkerSmokeSelectiveReport,
  SMOKE_REPORT_PRODUCER,
  type SmokeReport,
  type SmokeScenario,
  type WorkerSmokeCommentRecord,
  type WorkerSmokeTrustedTarget,
} from '../lib/worker-smoke-core.ts';

const ISSUE = 1924;
const PR = 1930;
const ACTOR = 'pack-publisher';
const REPOSITORY = 'chetwerikoff/orchestrator-pack';
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const D = 'd'.repeat(40);

const declared = [
  { action: 'S1 action', expected: 'S1 expected' },
  { action: 'S2 action', expected: 'S2 expected' },
  { action: 'S3 action', expected: 'S3 expected' },
  { action: 'S4 action', expected: 'S4 expected' },
] as const;

function issueBody(scenarios = declared): string {
  return [
    '```behavior-kind',
    'action-producing',
    '```',
    '',
    '```smoke-test-plan',
    'scenarios:',
    ...scenarios.map((entry) => `  - action: ${entry.action} | expected: ${entry.expected}`),
    '```',
  ].join('\n');
}

function scenario(
  index: number,
  outcome: SmokeScenario['outcome'] = 'pass',
): SmokeScenario {
  const spec = declared[index - 1]!;
  return {
    action: spec.action,
    expected: spec.expected,
    observed: `${spec.action} ${outcome ?? 'unknown'}`,
    outcome,
  };
}

function report(
  headSha: string,
  scenarios: SmokeScenario[],
  result: SmokeReport['result'] = scenarios.every((row) => row.outcome === 'pass') ? 'PASS' : 'FAIL',
): SmokeReport {
  return {
    result,
    issueNumber: ISSUE,
    prNumber: PR,
    headSha,
    scenarios,
    limitations: [],
    trackedFilesUnmodified: true,
    terminalCleanup: 'closed_owned_handle',
    environmentNotes: [],
    producer: SMOKE_REPORT_PRODUCER,
    orcaExecutable: 'runtime-adapter',
    terminalHandle: `smoke-terminal-${headSha[0]}`,
  };
}

function comment(id: number, smokeReport: SmokeReport): WorkerSmokeCommentRecord {
  const createdAt = new Date(Date.UTC(2026, 8, 16, 0, 0, 0, id)).toISOString();
  return {
    id,
    body: formatSmokeReportComment(smokeReport),
    created_at: createdAt,
    updated_at: createdAt,
    user: { login: ACTOR },
  };
}

function target(headSha: string): WorkerSmokeTrustedTarget {
  return {
    repositorySlug: REPOSITORY,
    issueNumber: ISSUE,
    prNumber: PR,
    headSha,
    resolvedIssueNumber: ISSUE,
    resolvedPrNumber: PR,
    liveHeadSha: headSha,
    issueBodyMatchesTarget: true,
    trustedPublisherLogin: ACTOR,
    commentCensusComplete: true,
    commentSnapshotStable: true,
  };
}

function ancestry(edges: readonly [string, string][]) {
  const set = new Set(edges.map(([left, right]) => `${left}>${right}`));
  return (ancestor: string, descendant: string): boolean =>
    ancestor === descendant || set.has(`${ancestor}>${descendant}`);
}

function affected(headSha: string, indexes: readonly number[]): string {
  return [
    '```worker-smoke-affected',
    JSON.stringify({
      head: headSha,
      scenarios: indexes.map((index) => ({
        action: declared[index - 1]!.action,
        expected: declared[index - 1]!.expected,
      })),
    }),
    '```',
  ].join('\n');
}

function indexesOf(plan: ReturnType<typeof planWorkerSmokeSelectiveRetry>['attemptPlan']): number[] {
  return plan.scenarios.map((row) => declared.findIndex((entry) =>
    entry.action === row.action && entry.expected === row.expected) + 1);
}

describe('selective smoke retry planning', () => {
  it('reuses prior exact PASS tuples and retries only non-PASS plus unexecuted tuples', () => {
    const selection = planWorkerSmokeSelectiveRetry({
      issueBody: issueBody(),
      prBody: '',
      comments: [comment(1, report(A, [scenario(1), scenario(2), scenario(3, 'fail')], 'FAIL'))],
      target: target(B),
      isAncestor: ancestry([[A, B]]),
    });

    expect(selection.fallbackReason).toBeUndefined();
    expect(indexesOf(selection.attemptPlan)).toEqual([3, 4]);
    expect(selection.carried.map((entry) => entry.scenario.action)).toEqual([
      declared[0].action,
      declared[1].action,
    ]);
  });

  it('treats omitted, empty, stale, and malformed affected carriers as local empty input', () => {
    const baseComments = [comment(1, report(A, [scenario(1), scenario(2), scenario(3, 'fail')], 'FAIL'))];
    const bodies = [
      '',
      affected(B, []),
      affected(A, [2]),
      '```worker-smoke-affected\n{not-json}\n```',
      `\`\`\`worker-smoke-affected\n${JSON.stringify({ head: B, scenarios: [{ action: declared[1].action }] })}\n\`\`\``,
    ];

    for (const prBody of bodies) {
      const selection = planWorkerSmokeSelectiveRetry({
        issueBody: issueBody(),
        prBody,
        comments: baseComments,
        target: target(B),
        isAncestor: ancestry([[A, B]]),
      });
      expect(selection.fallbackReason).toBeUndefined();
      expect(indexesOf(selection.attemptPlan)).toEqual([3, 4]);
    }
  });

  it('invalidates only the exact current-head affected tuple', () => {
    const selection = planWorkerSmokeSelectiveRetry({
      issueBody: issueBody(),
      prBody: affected(B, [2]),
      comments: [comment(1, report(A, [scenario(1), scenario(2), scenario(3, 'fail')], 'FAIL'))],
      target: target(B),
      isAncestor: ancestry([[A, B]]),
    });

    expect(indexesOf(selection.attemptPlan)).toEqual([2, 3, 4]);
    expect(selection.carried.map((entry) => entry.scenario.action)).toEqual([declared[0].action]);
  });

  it('lets a fresh same-head PASS supersede current-head affected invalidation', () => {
    const selection = planWorkerSmokeSelectiveRetry({
      issueBody: issueBody([declared[1]]),
      prBody: affected(B, [2]),
      comments: [
        comment(1, report(A, [scenario(2)])),
        comment(2, report(B, [scenario(2)])),
      ],
      target: target(B),
      isAncestor: ancestry([[A, B]]),
    });

    expect(selection.attemptPlan.scenarios).toHaveLength(0);
    expect(selection.carried).toHaveLength(1);
    expect(selection.carried[0]!.sourceHeadSha).toBe(B);
  });

  it('uses descendant precedence and never resurrects an older PASS after a newer FAIL', () => {
    const selection = planWorkerSmokeSelectiveRetry({
      issueBody: issueBody([declared[1]]),
      prBody: '',
      comments: [
        comment(1, report(A, [scenario(2)])),
        comment(2, report(B, [scenario(2, 'fail')], 'FAIL')),
      ],
      target: target(C),
      isAncestor: ancestry([[A, B], [A, C], [B, C]]),
    });

    expect(selection.attemptPlan.scenarios).toHaveLength(1);
    expect(selection.carried).toHaveLength(0);
  });

  it('reruns only the tuple whose maximal ancestor observations are incomparable', () => {
    const selection = planWorkerSmokeSelectiveRetry({
      issueBody: issueBody([declared[0], declared[1]]),
      prBody: '',
      comments: [
        comment(1, report(A, [scenario(1), scenario(2)])),
        comment(2, report(B, [scenario(2)])),
      ],
      target: target(D),
      isAncestor: ancestry([[A, D], [B, D]]),
    });

    expect(selection.attemptPlan.scenarios.map((row) => row.action)).toEqual([declared[1].action]);
    expect(selection.carried.map((entry) => entry.scenario.action)).toEqual([declared[0].action]);
  });

  it('falls back to the full plan only for enumerated whole-attempt conditions', () => {
    const noHistory = planWorkerSmokeSelectiveRetry({
      issueBody: issueBody(),
      prBody: '',
      comments: [],
      target: target(B),
      isAncestor: ancestry([]),
    });
    expect(noHistory.fallbackReason).toBe('no_prior_canonical_observation');
    expect(indexesOf(noHistory.attemptPlan)).toEqual([1, 2, 3, 4]);

    const unreadable = planWorkerSmokeSelectiveRetry({
      issueBody: issueBody(),
      prBody: '',
      comments: [],
      target: target(B),
      isAncestor: ancestry([]),
      historyReadable: false,
    });
    expect(unreadable.fallbackReason).toBe('history_unreadable');

    const untrusted = planWorkerSmokeSelectiveRetry({
      issueBody: issueBody(),
      prBody: '',
      comments: [],
      target: target(B),
      isAncestor: ancestry([]),
      historyBindingTrusted: false,
    });
    expect(untrusted.fallbackReason).toBe('history_binding_untrusted');

    const rewritten = planWorkerSmokeSelectiveRetry({
      issueBody: issueBody(),
      prBody: '',
      comments: [comment(1, report(A, [scenario(1)]))],
      target: target(B),
      isAncestor: ancestry([]),
    });
    expect(rewritten.fallbackReason).toBe('history_non_descendant');
  });

  it('projects carried and fresh rows into one current-head report without claiming carried execution', () => {
    const selection = planWorkerSmokeSelectiveRetry({
      issueBody: issueBody(),
      prBody: '',
      comments: [comment(1, report(A, [scenario(1), scenario(2), scenario(3, 'fail')], 'FAIL'))],
      target: target(B),
      isAncestor: ancestry([[A, B]]),
    });
    const projected = projectWorkerSmokeSelectiveReport({
      selection,
      partial: {
        result: 'PASS',
        scenarios: [scenario(3), scenario(4)],
        environmentNotes: [],
      },
    });

    expect(projected.result).toBe('PASS');
    expect(projected.scenarios).toHaveLength(4);
    expect(projected.scenarios?.[0]?.observed).toContain('carried PASS from head');
    expect(projected.scenarios?.[0]?.observed).toContain('not freshly executed');
    expect(projected.environmentNotes).toContain('smoke-carried=2');
    expect(projected.environmentNotes).toContain('smoke-fresh=2');
  });
});

describe('worker-smoke-affected parser', () => {
  it('unions and deduplicates exact trimmed tuples from matching current-head blocks', () => {
    const body = [affected(B, [1, 2]), affected(A, [3]), affected(B, [2, 3])].join('\n\n');
    const parsed = parseWorkerSmokeAffectedCarrier(body, B);
    expect(parsed.tupleKeys).toHaveLength(3);
    expect(parsed.diagnostics).toEqual([]);
  });
});
