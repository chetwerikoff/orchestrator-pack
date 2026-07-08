import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFER_AMBIGUOUS_ISSUE_PR_BINDING,
  DEFER_AMBIGUOUS_PR_SESSION_BINDING,
  DEFER_NO_ISSUE_BINDING,
  headRefCorrelatesToIssue,
  listIssueCorrelatedOpenPrs,
  resolvePrOwningWorkerSessionBinding,
  resolveSessionPrBinding,
} from '../docs/session-pr-binding-resolver.mjs';
import {
  resolveHeadOwningWorkerSessionId,
  resolveWorkerSessionId,
  sessionMatchesPr,
  sessionOwnsRunHead,
} from '../docs/review-trigger-reconcile.mjs';
import { planCiFailureReactionRecords } from '../docs/ci-failure-notification.mjs';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const capturesRoot = path.join(repoRoot, 'tests/external-output-references/captures/ao-0-10-cli');

function readCapture(name: string) {
  return JSON.parse(readFileSync(path.join(capturesRoot, name), 'utf8'));
}

const headSha = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
const openPr690 = {
  number: 690,
  headRefOid: headSha,
  headRefName: 'issue-690-session-pr-binding',
};

const issueOnlyListRow = {
  id: 'orchestrator-pack-45',
  sessionId: 'orchestrator-pack-45',
  name: 'orchestrator-pack-45',
  role: 'worker',
  status: 'working',
  issueId: '690',
  issue: '690',
  projectId: 'orchestrator-pack',
};

describe('session-pr-binding-resolver positive outcome', () => {
  it('resolves owner for issue-only list row with displayName corroboration', () => {
    const binding = resolveSessionPrBinding(issueOnlyListRow, [openPr690], {
      headSha,
      sessionDetail: { displayName: '690' },
    });
    expect(binding.bound).toBe(true);
    expect(binding.prNumber).toBe(690);
    expect(binding.source).toBe('display_name');

    const owner = resolveHeadOwningWorkerSessionId(
      [{ ...issueOnlyListRow, role: 'worker', status: 'working' }],
      690,
      headSha,
      [openPr690],
      { sessionDetailsById: { 'orchestrator-pack-45': { displayName: '690' } } },
    );
    expect(owner).toBe('orchestrator-pack-45');
  });

  it('resolves owner via unique issue branch correlation when displayName is non-numeric', () => {
    const session = { ...issueOnlyListRow, displayName: 'ao-0-10-cli-mig' };
    const binding = resolveSessionPrBinding(session, [openPr690], { headSha });
    expect(binding.source).toBe('issue_correlation');
    expect(binding.prNumber).toBe(690);

    const owner = resolveHeadOwningWorkerSessionId(
      [session],
      690,
      headSha,
      [openPr690],
    );
    expect(owner).toBe('orchestrator-pack-45');
  });
});

describe('session-pr-binding-resolver ambiguity axes', () => {
  it('fails closed when issue maps to multiple open PRs', () => {
    const binding = resolveSessionPrBinding(issueOnlyListRow, [
      openPr690,
      { ...openPr690, number: 691, headRefName: 'issue-690-alt' },
    ]);
    expect(binding.bound).toBe(false);
    expect(binding.deferReason).toBe(DEFER_AMBIGUOUS_ISSUE_PR_BINDING);
  });

  it('fails closed when multiple live sessions claim the same PR', () => {
    const resolution = resolvePrOwningWorkerSessionBinding(
      [
        { ...issueOnlyListRow, id: 'opk-a', sessionId: 'opk-a', name: 'opk-a', prNumber: 690 },
        { ...issueOnlyListRow, id: 'opk-b', sessionId: 'opk-b', name: 'opk-b', prNumber: 690 },
      ],
      690,
      [openPr690],
      { requireLive: true, isLive: () => true, getSessionId: (s) => String(s.sessionId) },
    );
    expect(resolution.sessionId).toBeNull();
    expect(resolution.deferReason).toBe(DEFER_AMBIGUOUS_PR_SESSION_BINDING);
  });

  it('does not first-match when multiple workers share explicit prNumber', () => {
    expect(
      resolveWorkerSessionId(
        [
          { name: 'opk-a', role: 'worker', prNumber: 55, status: 'working' },
          { name: 'opk-b', role: 'worker', prNumber: 55, status: 'working' },
        ],
        55,
      ),
    ).toBeNull();
  });
});

describe('session-pr-binding-resolver head forge guard', () => {
  it('does not auto-grant head ownership for enriched issue correlation bind', () => {
    const session = { ...issueOnlyListRow, role: 'worker' };
    expect(sessionMatchesPr(session, 690, [openPr690], { headSha })).toBe(true);
    expect(sessionOwnsRunHead(session, 690, headSha, [openPr690])).toBe(false);
  });
});

describe('session-pr-binding-resolver explicit prNumber regression', () => {
  it('keeps legacy owner and head ownership for explicit prNumber rows', () => {
    const session = {
      name: 'opk-explicit',
      role: 'worker',
      prNumber: 690,
      status: 'working',
    };
    expect(
      resolveHeadOwningWorkerSessionId([session], 690, headSha, [openPr690]),
    ).toBe('opk-explicit');
    expect(sessionOwnsRunHead(session, 690, headSha, [openPr690])).toBe(true);
  });
});

describe('session-pr-binding-resolver scenario matrix', () => {
  it('scenario 1: missing issueId does not bind', () => {
    const binding = resolveSessionPrBinding({ role: 'worker' }, [openPr690]);
    expect(binding.bound).toBe(false);
    expect(binding.deferReason).toBe(DEFER_NO_ISSUE_BINDING);
  });

  it('scenario 2: unique issue/head corroboration binds', () => {
    const binding = resolveSessionPrBinding(issueOnlyListRow, [openPr690], { headSha });
    expect(binding.bound).toBe(true);
  });

  it('scenario 3: issue with many open PRs defers', () => {
    const binding = resolveSessionPrBinding(issueOnlyListRow, [
      openPr690,
      { number: 691, headRefOid: headSha, headRefName: 'issue-690-dup' },
    ]);
    expect(binding.deferReason).toBe(DEFER_AMBIGUOUS_ISSUE_PR_BINDING);
  });

  it('scenario 4: many live sessions for one PR defers', () => {
    const resolution = resolvePrOwningWorkerSessionBinding(
      [
        { name: 'a', role: 'worker', prNumber: 690, status: 'working' },
        { name: 'b', role: 'worker', prNumber: 690, status: 'working' },
      ],
      690,
      [openPr690],
      { isLive: () => true, getSessionId: (s) => String(s.name) },
    );
    expect(resolution.deferReason).toBe(DEFER_AMBIGUOUS_PR_SESSION_BINDING);
  });

  it('scenario 5: reopened PR resolves to currently open PR only', () => {
    const binding = resolveSessionPrBinding(issueOnlyListRow, [openPr690], { headSha });
    expect(binding.prNumber).toBe(690);
  });

  it('scenario 6: enriched bind allows ownership listing but not head forge', () => {
    const session = { ...issueOnlyListRow, role: 'worker' };
    expect(resolveSessionPrBinding(session, [openPr690], { headSha }).bound).toBe(true);
    expect(sessionOwnsRunHead(session, 690, headSha, [openPr690])).toBe(false);
  });

  it('scenario 7: terminated session can still resolve PR without live requirement', () => {
    const session = { ...issueOnlyListRow, status: 'terminated', prNumber: undefined };
    const resolution = resolvePrOwningWorkerSessionBinding(
      [session],
      690,
      [openPr690],
      {
        requireLive: false,
        getSessionId: () => 'orchestrator-pack-45',
        isLive: () => false,
      },
    );
    expect(resolution.sessionId).toBe('orchestrator-pack-45');
  });

  it('scenario 8: non-numeric displayName is not PR evidence', () => {
    const preClaim = readCapture('session-get-worker.raw.json');
    const displayName = String(preClaim.session.displayName);
    expect(displayName).toBe('ao-0-10-cli-mig');
    const binding = resolveSessionPrBinding(issueOnlyListRow, [openPr690], {
      headSha,
      sessionDetail: { displayName },
    });
    expect(binding.source).toBe('issue_correlation');
  });
});

describe('session-pr-binding-resolver branch patterns', () => {
  it('recognizes issue-<N>-* branch prefix', () => {
    expect(headRefCorrelatesToIssue('issue-683-harness-pn-post-submit', 683)).toBe(true);
    expect(
      listIssueCorrelatedOpenPrs(683, [
        { number: 683, headRefOid: 'abc', headRefName: 'issue-683-harness-pn-post-submit' },
      ]),
    ).toHaveLength(1);
  });
});

describe('ci-failure reaction owner non-null', () => {
  it('records pending episode when issue-only owner resolves', () => {
    const sessions = [{ ...issueOnlyListRow, role: 'worker', status: 'working' }];
    const openPrs = [openPr690];
    const records = planCiFailureReactionRecords({
      repo: 'chetwerikoff/orchestrator-pack',
      sessions,
      openPrs,
      ciChecksByPr: [
        {
          prNumber: 690,
          checks: [{ name: 'Run pack contract tests', state: 'FAILURE' }],
        },
      ],
      requiredCheckNamesByPr: [{ prNumber: 690, requiredCheckNames: ['Run pack contract tests'] }],
    });
    expect(records.records.length).toBeGreaterThanOrEqual(1);
    expect(records.records[0]?.episode?.targetId).toBe('orchestrator-pack-45');
  });
});

describe('session-pr-binding sole-path contract', () => {
  const consumerModules = [
    'docs/ci-failure-notification.mjs',
    'docs/ci-green-wake-reconcile.mjs',
    'docs/review-trigger-reconcile.mjs',
    'docs/review-trigger-reeval.mjs',
    'docs/review-ready-report-state-seed.mjs',
    'docs/review-ready-stuck-guard.mjs',
    'docs/review-finding-delivery-confirm.mjs',
    'docs/review-wake-trigger.mjs',
    'docs/worker-nudge-gate.mjs',
  ];

  const forbiddenPatterns = [
    /issueLinkedWorkerBranchLiterals/,
    /headRefCorrelatesToIssue/,
    /listIssueCorrelatedOpenPrs/,
    /feat\/\$\{/,
    /issue-\$\{/,
  ];

  it('keeps issue→PR correlation inside the binding boundary module', () => {
    for (const rel of consumerModules) {
      const text = readFileSync(path.join(repoRoot, rel), 'utf8');
      for (const pattern of forbiddenPatterns) {
        expect(pattern.test(text), `${rel} must not contain ${pattern}`).toBe(false);
      }
    }
  });
});
