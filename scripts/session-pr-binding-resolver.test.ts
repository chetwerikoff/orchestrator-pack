import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFER_AMBIGUOUS_ISSUE_PR_BINDING,
  DEFER_AMBIGUOUS_PR_SESSION_BINDING,
  DEFER_AMBIGUOUS_SESSION_PRS,
  DEFER_NO_ISSUE_BINDING,
  buildSessionDetailsById,
  headRefCorrelatesToIssue,
  listIssueCorrelatedOpenPrs,
  resolvePrOwningWorkerSessionBinding,
  resolveSessionPrBinding,
  sessionDetailFromSessionGetPayload,
  shouldEnrichSessionDetailFromGet,
} from '../docs/session-pr-binding-resolver.mjs';
import {
  resolveHeadOwningWorkerSessionId,
  resolveWorkerSessionId,
  sessionMatchesPr,
  sessionOwnsRunHead,
} from '../docs/review-trigger-reconcile.mjs';
import { planCiFailureReactionRecords } from '../docs/ci-failure-notification.mjs';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoSlug = 'chetwerikoff/orchestrator-pack';
const headSha = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
const prUrl = (number: number) => `https://github.com/${repoSlug}/pull/${number}`;
const openPr690 = {
  number: 690,
  headRefOid: headSha,
  headRefName: 'issue-690-session-pr-binding',
  repoSlug,
  state: 'OPEN',
};

let isolatedBindingCachePath = '';

beforeEach(() => {
  isolatedBindingCachePath = path.join(
    mkdtempSync(path.join(tmpdir(), 'session-pr-binding-cache-')),
    'cache.json',
  );
  process.env.AO_PR_SESSION_BINDING_CACHE = isolatedBindingCachePath;
});

function headOwnerOptions(extra: Record<string, unknown> = {}) {
  return {
    cachePath: isolatedBindingCachePath,
    repoSlug,
    ...extra,
  };
}

const issueOnlyListRow = {
  id: 'orchestrator-pack-45',
  sessionId: 'orchestrator-pack-45',
  name: 'orchestrator-pack-45',
  role: 'worker',
  status: 'working',
  issueId: '690',
  issue: '690',
  projectId: 'orchestrator-pack',
  repoSlug,
};

describe('session-pr-binding-resolver positive outcome', () => {
  it('resolves owner for a bulk-list row with direct prs[] evidence', () => {
    const session = {
      ...issueOnlyListRow,
      prs: [prUrl(690)],
      ownedHeadSha: headSha,
    };
    const binding = resolveSessionPrBinding(session, [openPr690], { headSha, repoSlug });
    expect(binding.bound).toBe(true);
    expect(binding.prNumber).toBe(690);
    expect(binding.bindingSource).toBe('live_prs');

    const owner = resolvePrOwningWorkerSessionBinding(
      [session],
      690,
      [openPr690],
      {
        headSha,
        repoSlug,
        isLive: () => true,
        getSessionId: (row) => String(row.sessionId ?? row.id ?? row.name),
      },
    );
    expect(owner.sessionId).toBe('orchestrator-pack-45');
    expect(
      resolveHeadOwningWorkerSessionId(
        [session],
        690,
        headSha,
        [openPr690],
        headOwnerOptions(),
      ),
    ).toBe('orchestrator-pack-45');
  });

  it('resolves owner via unique issue branch correlation while displayName is ignored', () => {
    const session = {
      ...issueOnlyListRow,
      displayName: '690',
      branch: 'issue-690-session-pr-binding',
    };
    const binding = resolveSessionPrBinding(session, [openPr690], { headSha, repoSlug });
    expect(binding.source).toBe('issue_correlation');
    expect(binding.bindingSource).toBe('issue_correlation');
    expect(binding.prNumber).toBe(690);

    const owner = resolvePrOwningWorkerSessionBinding(
      [session],
      690,
      [openPr690],
      {
        headSha,
        repoSlug,
        isLive: () => true,
        getSessionId: (row) => String(row.sessionId ?? row.id ?? row.name),
      },
    );
    expect(owner.sessionId).toBe('orchestrator-pack-45');
    expect(resolveHeadOwningWorkerSessionId([session], 690, headSha, [openPr690], headOwnerOptions())).toBeNull();
  });
});

describe('session-pr-binding-resolver ambiguity axes', () => {
  it('fails closed when issue maps to multiple open PRs', () => {
    const binding = resolveSessionPrBinding(issueOnlyListRow, [
      openPr690,
      { ...openPr690, number: 691, headRefName: 'issue-690-alt' },
    ], { repoSlug });
    expect(binding.bound).toBe(false);
    expect(binding.deferReason).toBe(DEFER_AMBIGUOUS_ISSUE_PR_BINDING);
  });

  it('surfaces issue ambiguity defer instead of no_worker_session', () => {
    const resolution = resolvePrOwningWorkerSessionBinding(
      [{ ...issueOnlyListRow, role: 'worker', status: 'working' }],
      690,
      [openPr690, { ...openPr690, number: 691, headRefName: 'issue-690-alt' }],
      {
        repoSlug,
        isLive: () => true,
        getSessionId: (row) => String(row.sessionId ?? row.id ?? row.name),
      },
    );
    expect(resolution.sessionId).toBeNull();
    expect(resolution.failClosed).toBe(true);
    expect(resolution.deferReason).toBe(DEFER_AMBIGUOUS_ISSUE_PR_BINDING);
    expect(resolution.reason).toBe('ambiguous_issue_pr_binding');
  });

  it('fails closed when multiple live sessions claim the same PR through prs[]', () => {
    const resolution = resolvePrOwningWorkerSessionBinding(
      [
        { ...issueOnlyListRow, id: 'opk-a', sessionId: 'opk-a', name: 'opk-a', prs: [prUrl(690)] },
        { ...issueOnlyListRow, id: 'opk-b', sessionId: 'opk-b', name: 'opk-b', prs: [prUrl(690)] },
      ],
      690,
      [openPr690],
      { repoSlug, requireLive: true, isLive: () => true, getSessionId: (row) => String(row.sessionId) },
    );
    expect(resolution.sessionId).toBeNull();
    expect(resolution.deferReason).toBe(DEFER_AMBIGUOUS_PR_SESSION_BINDING);
  });

  it('does not first-match when multiple workers share the same prs[] URL', () => {
    expect(
      resolveWorkerSessionId(
        [
          { name: 'opk-a', role: 'worker', prs: [prUrl(55)], status: 'working', repoSlug },
          { name: 'opk-b', role: 'worker', prs: [prUrl(55)], status: 'working', repoSlug },
        ],
        55,
        {
          openPrs: [{ number: 55, headRefOid: headSha, headRefName: 'issue-55', repoSlug }],
          headSha,
        },
      ),
    ).toBeNull();
  });
});

describe('session-pr-binding-resolver direct PR head ownership', () => {
  it('grants head ownership only when prs[] binding has explicit head evidence', () => {
    const session = {
      ...issueOnlyListRow,
      role: 'worker',
      branch: 'unrelated-branch',
      prs: [prUrl(690)],
      ownedHeadSha: headSha,
    };
    expect(sessionOwnsRunHead(session, 690, headSha, [openPr690])).toBe(true);
    expect(
      resolveHeadOwningWorkerSessionId(
        [session],
        690,
        headSha,
        [openPr690],
        headOwnerOptions(),
      ),
    ).toBe('orchestrator-pack-45');
  });
});

describe('session-pr-binding-resolver head forge guard', () => {
  it('does not auto-grant head ownership for enriched live binding', () => {
    const session = {
      ...issueOnlyListRow,
      role: 'worker',
      prs: [prUrl(690)],
    };
    expect(sessionMatchesPr(session, 690, [openPr690], { headSha })).toBe(true);
    expect(sessionOwnsRunHead(session, 690, headSha, [openPr690])).toBe(false);
  });
});

describe('session-pr-binding-resolver retired prNumber regression', () => {
  it('ignores explicit prNumber rows and uses prs[] plus head evidence instead', () => {
    const retiredOnly = {
      name: 'opk-explicit',
      role: 'worker',
      prNumber: 690,
      displayName: '690',
      status: 'working',
      repoSlug,
    };
    expect(
      resolveHeadOwningWorkerSessionId([retiredOnly], 690, headSha, [openPr690], headOwnerOptions()),
    ).toBeNull();
    expect(sessionOwnsRunHead(retiredOnly, 690, headSha, [openPr690])).toBe(false);

    const live = { ...retiredOnly, prs: [prUrl(690)], ownedHeadSha: headSha };
    expect(resolveHeadOwningWorkerSessionId([live], 690, headSha, [openPr690], headOwnerOptions())).toBe('opk-explicit');
    expect(sessionOwnsRunHead(live, 690, headSha, [openPr690])).toBe(true);
  });
});

describe('session-pr-binding-resolver scenario matrix', () => {
  it('scenario 1: missing issueId does not bind', () => {
    const binding = resolveSessionPrBinding({ role: 'worker', repoSlug }, [openPr690], { repoSlug });
    expect(binding.bound).toBe(false);
    expect(binding.deferReason).toBe(DEFER_NO_ISSUE_BINDING);
  });

  it('scenario 2: unique issue/head corroboration binds', () => {
    const binding = resolveSessionPrBinding(issueOnlyListRow, [openPr690], { headSha, repoSlug });
    expect(binding.bound).toBe(true);
  });

  it('scenario 3: issue with many open PRs defers', () => {
    const binding = resolveSessionPrBinding(issueOnlyListRow, [
      openPr690,
      { ...openPr690, number: 691, headRefName: 'issue-690-dup' },
    ], { repoSlug });
    expect(binding.deferReason).toBe(DEFER_AMBIGUOUS_ISSUE_PR_BINDING);
  });

  it('scenario 3b: direct prs[] disambiguates multiple issue-correlated PRs', () => {
    const binding = resolveSessionPrBinding(
      { ...issueOnlyListRow, prs: [prUrl(690)] },
      [
        openPr690,
        { ...openPr690, number: 691, headRefName: 'issue-690-dup' },
      ],
      { repoSlug },
    );
    expect(binding.bound).toBe(true);
    expect(binding.prNumber).toBe(690);
    expect(binding.bindingSource).toBe('live_prs');
  });

  it('does not return PR-bound session as head owner when headSha is stale', () => {
    const currentHead = 'cccccccccccccccccccccccccccccccccccccccc';
    const staleHead = 'dddddddddddddddddddddddddddddddddddddddd';
    const session = {
      sessionId: 'orchestrator-pack-1',
      role: 'worker',
      status: 'working',
      prs: [prUrl(1)],
      ownedHeadSha: currentHead,
      repoSlug,
    };
    const openPrs = [{ number: 1, headRefOid: currentHead, headRefName: 'issue-1', repoSlug }];

    expect(resolveHeadOwningWorkerSessionId([session], 1, staleHead, openPrs, headOwnerOptions())).toBeNull();
    expect(
      resolveWorkerSessionId([session], 1, {
        openPrs,
        headSha: staleHead,
        ownsHead: (row) => sessionOwnsRunHead(row, 1, staleHead, openPrs),
      }),
    ).toBeNull();
    expect(
      resolvePrOwningWorkerSessionBinding([session], 1, openPrs, {
        headSha: staleHead,
        repoSlug,
        isLive: () => true,
        getSessionId: (row) => String(row.sessionId ?? row.id ?? row.name),
      }).sessionId,
    ).toBe('orchestrator-pack-1');
  });

  it('scenario 4: many live sessions for one PR defers', () => {
    const resolution = resolvePrOwningWorkerSessionBinding(
      [
        { name: 'a', sessionId: 'a', role: 'worker', prs: [prUrl(690)], status: 'working', repoSlug },
        { name: 'b', sessionId: 'b', role: 'worker', prs: [prUrl(690)], status: 'working', repoSlug },
      ],
      690,
      [openPr690],
      { repoSlug, isLive: () => true, getSessionId: (row) => String(row.name) },
    );
    expect(resolution.deferReason).toBe(DEFER_AMBIGUOUS_PR_SESSION_BINDING);
  });

  it('scenario 5: reopened PR resolves to currently open PR only', () => {
    const binding = resolveSessionPrBinding(
      { ...issueOnlyListRow, prs: [prUrl(690)] },
      [
        { ...openPr690, number: 689, state: 'MERGED', headRefName: 'issue-690-old' },
        openPr690,
      ],
      { headSha, repoSlug, openListAuthoritative: true },
    );
    expect(binding.prNumber).toBe(690);
  });

  it('scenario 6: live bind allows ownership listing but not head forge', () => {
    const session = { ...issueOnlyListRow, role: 'worker', prs: [prUrl(690)] };
    expect(resolveSessionPrBinding(session, [openPr690], { headSha, repoSlug }).bound).toBe(true);
    expect(sessionOwnsRunHead(session, 690, headSha, [openPr690])).toBe(false);
  });

  it('scenario 7: terminated session can still resolve PR without live requirement', () => {
    const session = { ...issueOnlyListRow, status: 'terminated', prs: [prUrl(690)] };
    const resolution = resolvePrOwningWorkerSessionBinding(
      [session],
      690,
      [openPr690],
      {
        repoSlug,
        requireLive: false,
        getSessionId: () => 'orchestrator-pack-45',
        isLive: () => false,
      },
    );
    expect(resolution.sessionId).toBe('orchestrator-pack-45');
  });

  it('scenario 8: non-numeric displayName is not PR evidence', () => {
    const session = {
      ...issueOnlyListRow,
      displayName: 'ao-0-10-cli-mig',
      branch: 'issue-690-session-pr-binding',
    };
    const binding = resolveSessionPrBinding(session, [openPr690], { headSha, repoSlug });
    expect(binding.source).toBe('issue_correlation');
    expect(binding.bindingSource).toBe('issue_correlation');
  });

  it('scenario 8b: stale numeric displayName cannot override prs[]', () => {
    const binding = resolveSessionPrBinding(
      { ...issueOnlyListRow, displayName: '704', prs: [prUrl(690)] },
      [openPr690, { number: 704, headRefOid: 'bbbbbbbb', headRefName: 'issue-704-other', repoSlug }],
      { headSha, repoSlug },
    );
    expect(binding.bound).toBe(true);
    expect(binding.prNumber).toBe(690);
    expect(binding.bindingSource).toBe('live_prs');
  });

  it('scenario 8c: numeric displayName alone fails closed', () => {
    const retiredOnly = {
      id: 'retired-only',
      sessionId: 'retired-only',
      role: 'worker',
      status: 'working',
      displayName: '690',
      repoSlug,
    };
    const binding = resolveSessionPrBinding(retiredOnly, [openPr690], {
      headSha: 'cccccccccccccccccccccccccccccccccccccccc',
      repoSlug,
    });
    expect(binding.bound).toBe(false);
    expect(binding.deferReason).toBe(DEFER_NO_ISSUE_BINDING);
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

  it('recognizes AO namespaced issue branches', () => {
    const branch = 'ao/orchestrator-pack-98/issue-731-vitest-history-delivery';
    expect(headRefCorrelatesToIssue(branch, 731)).toBe(true);
    expect(
      listIssueCorrelatedOpenPrs(731, [
        { number: 738, headRefOid: 'd47c931', headRefName: branch },
      ]),
    ).toHaveLength(1);
  });
});

describe('ci-failure reaction owner non-null', () => {
  it('records pending episode when head-owning worker resolves', () => {
    const sessions = [
      {
        ...issueOnlyListRow,
        role: 'worker',
        status: 'working',
        prs: [prUrl(690)],
        ownedHeadSha: headSha,
      },
    ];
    const records = planCiFailureReactionRecords({
      repo: repoSlug,
      sessions,
      openPrs: [openPr690],
      ciChecksByPr: [{ prNumber: 690, checks: [{ name: 'Run pack contract tests', state: 'FAILURE' }] }],
      requiredCheckNamesByPr: [{ prNumber: 690, requiredCheckNames: ['Run pack contract tests'] }],
    });
    expect(records.records).toBeDefined();
    expect(records.records!.length).toBeGreaterThanOrEqual(1);
    expect(records.records![0]?.episode?.targetId).toBe('orchestrator-pack-45');
  });

  it('does not record episode for live binding without explicit head evidence', () => {
    const sessions = [{ ...issueOnlyListRow, role: 'worker', status: 'working', prs: [prUrl(690)] }];
    const records = planCiFailureReactionRecords({
      repo: repoSlug,
      sessions,
      openPrs: [openPr690],
      ciChecksByPr: [{ prNumber: 690, checks: [{ name: 'Run pack contract tests', state: 'FAILURE' }] }],
      requiredCheckNamesByPr: [{ prNumber: 690, requiredCheckNames: ['Run pack contract tests'] }],
    });
    expect(records.records).toEqual([]);
  });

  it('records episode when prs[] binding and owned head resolve as owner', () => {
    const sessions = [
      {
        ...issueOnlyListRow,
        role: 'worker',
        status: 'working',
        branch: 'unrelated-branch',
        prs: [prUrl(690)],
        ownedHeadSha: headSha,
      },
    ];
    const records = planCiFailureReactionRecords({
      repo: repoSlug,
      sessions,
      openPrs: [openPr690],
      ciChecksByPr: [{ prNumber: 690, checks: [{ name: 'Run pack contract tests', state: 'FAILURE' }] }],
      requiredCheckNamesByPr: [{ prNumber: 690, requiredCheckNames: ['Run pack contract tests'] }],
    });
    expect(records.records).toHaveLength(1);
    expect(records.records![0]?.episode?.targetId).toBe('orchestrator-pack-45');
  });

  it('does not let session-get displayName create a head owner', () => {
    const sessions = [
      {
        id: 'orchestrator-pack-45',
        sessionId: 'orchestrator-pack-45',
        role: 'worker',
        status: 'working',
        issueId: '690',
        branch: 'unrelated-branch',
        repoSlug,
      },
    ];
    const common = {
      repo: repoSlug,
      sessions,
      openPrs: [openPr690],
      ciChecksByPr: [{ prNumber: 690, checks: [{ name: 'Run pack contract tests', state: 'FAILURE' }] }],
      requiredCheckNamesByPr: [{ prNumber: 690, requiredCheckNames: ['Run pack contract tests'] }],
    };
    expect(planCiFailureReactionRecords(common).records).toEqual([]);
    expect(
      planCiFailureReactionRecords({
        ...common,
        sessionDetailsById: { 'orchestrator-pack-45': { displayName: '690' } },
      }).records,
    ).toEqual([]);
  });
});

describe('retired session-get enrichment', () => {
  it('returns no details and resolves from bulk prs[] instead', () => {
    expect(sessionDetailFromSessionGetPayload()).toBeNull();
    expect(shouldEnrichSessionDetailFromGet()).toBe(false);
    expect(buildSessionDetailsById()).toEqual({});
    const binding = resolveSessionPrBinding(
      { ...issueOnlyListRow, prs: [prUrl(690)] },
      [openPr690],
      { headSha, repoSlug },
    );
    expect(binding.bindingSource).toBe('live_prs');
    expect(binding.prNumber).toBe(690);
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
