import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFER_AMBIGUOUS_ISSUE_PR_BINDING,
  DEFER_AMBIGUOUS_PR_SESSION_BINDING,
  DEFER_AMBIGUOUS_SESSION_PRS,
  DEFER_NO_ISSUE_BINDING,
  buildSessionDetailsById,
  getExplicitSessionPrNumber,
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
const capturesRoot = path.join(
  repoRoot,
  'tests/external-output-references/captures/ao-0-10-cli',
);
const repoSlug = 'chetwerikoff/orchestrator-pack';
const headSha = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

const prUrl = (number: number, slug = repoSlug) =>
  `https://github.com/${slug}/pull/${number}`;

function openPr(
  number: number,
  headRefOid = headSha,
  headRefName = `issue-${number}`,
  state = 'OPEN',
) {
  return { number, headRefOid, headRefName, state, repoSlug };
}

function worker(
  id: string,
  issueNumber: number,
  prs: string[] = [],
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    sessionId: id,
    name: id,
    role: 'worker',
    status: 'working',
    issueNumber,
    issueId: String(issueNumber),
    issue: String(issueNumber),
    projectId: 'orchestrator-pack',
    repoSlug,
    branch: `issue-${issueNumber}`,
    prs,
    ...extra,
  };
}

const openPr690 = openPr(690, headSha, 'issue-690-session-pr-binding');
const issueOnlyListRow = worker(
  'orchestrator-pack-45',
  690,
  [],
  { branch: 'issue-690-session-pr-binding' },
);

let isolatedBindingCachePath = '';
let isolatedBindingCacheDir = '';

beforeEach(() => {
  isolatedBindingCacheDir = mkdtempSync(path.join(tmpdir(), 'session-pr-binding-cache-'));
  isolatedBindingCachePath = path.join(isolatedBindingCacheDir, 'cache.json');
  process.env.AO_PR_SESSION_BINDING_CACHE = isolatedBindingCachePath;
});

afterEach(() => {
  delete process.env.AO_PR_SESSION_BINDING_CACHE;
  if (isolatedBindingCacheDir) {
    rmSync(isolatedBindingCacheDir, { recursive: true, force: true });
  }
  isolatedBindingCacheDir = '';
  isolatedBindingCachePath = '';
});

function headOwnerOptions(extra: Record<string, unknown> = {}) {
  return {
    cachePath: isolatedBindingCachePath,
    repoSlug,
    ...extra,
  };
}

function failedCiInput(sessions: Array<Record<string, unknown>>) {
  return {
    repo: repoSlug,
    sessions,
    openPrs: [openPr690],
    ciChecksByPr: [
      { prNumber: 690, checks: [{ name: 'Run pack contract tests', state: 'FAILURE' }] },
    ],
    requiredCheckNamesByPr: [
      { prNumber: 690, requiredCheckNames: ['Run pack contract tests'] },
    ],
  };
}

describe('session-pr-binding-resolver positive outcome', () => {
  it('resolves owner for bulk list row with direct prs[] corroboration', () => {
    const session = worker('orchestrator-pack-45', 690, [prUrl(690)], {
      branch: 'unrelated-branch',
    });
    const binding = resolveSessionPrBinding(session, [openPr690], { repoSlug, headSha });
    expect(binding).toMatchObject({
      bound: true,
      prNumber: 690,
      bindingSource: 'live_prs',
      trustRank: 400,
    });

    const owner = resolvePrOwningWorkerSessionBinding(
      [session],
      690,
      [openPr690],
      { headSha, repoSlug, isLive: () => true },
    );
    expect(owner.sessionId).toBe('orchestrator-pack-45');
  });

  it('resolves owner via unique issue branch correlation while retired fields are ignored', () => {
    const session = {
      ...issueOnlyListRow,
      displayName: 'ao-0-10-cli-mig',
      prNumber: 999,
      pr: '#999',
    };
    const binding = resolveSessionPrBinding(session, [openPr690], { repoSlug, headSha });
    expect(binding.bindingSource).toBe('issue_correlation');
    expect(binding.prNumber).toBe(690);
    expect(
      resolvePrOwningWorkerSessionBinding(
        [session],
        690,
        [openPr690],
        { headSha, repoSlug, isLive: () => true },
      ).sessionId,
    ).toBe('orchestrator-pack-45');
  });
});

describe('session-pr-binding-resolver ambiguity axes', () => {
  it('fails closed when issue maps to multiple open PRs', () => {
    const session = worker('orchestrator-pack-45', 690, [], { branch: '' });
    const binding = resolveSessionPrBinding(
      session,
      [openPr690, openPr(691, headSha, 'issue-690-alt')],
      { repoSlug },
    );
    expect(binding.bound).toBe(false);
    expect(binding.deferReason).toBe(DEFER_AMBIGUOUS_ISSUE_PR_BINDING);
  });

  it('surfaces issue ambiguity defer instead of no_worker_session', () => {
    const session = worker('orchestrator-pack-45', 690, [], { branch: '' });
    const resolution = resolvePrOwningWorkerSessionBinding(
      [session],
      690,
      [openPr690, openPr(691, headSha, 'issue-690-alt')],
      { repoSlug, isLive: () => true },
    );
    expect(resolution.sessionId).toBe('orchestrator-pack-45');
    expect(resolution.failClosed).toBe(true);
    expect(resolution.deferReason).toBe(DEFER_AMBIGUOUS_ISSUE_PR_BINDING);
    expect(resolution.reason).toBe('ambiguous_issue_pr_binding');
  });

  it('fails closed when multiple live sessions claim the same PR through prs[]', () => {
    const resolution = resolvePrOwningWorkerSessionBinding(
      [
        worker('opk-a', 690, [prUrl(690)]),
        worker('opk-b', 691, [prUrl(690)]),
      ],
      690,
      [openPr690],
      { repoSlug, requireLive: true, isLive: () => true },
    );
    expect(resolution.sessionId).toBeNull();
    expect(resolution.conflictingSessionIds).toEqual(['opk-a', 'opk-b']);
    expect(resolution.deferReason).toBe(DEFER_AMBIGUOUS_PR_SESSION_BINDING);
  });

  it('does not first-match when multiple workers share a direct prs[] claim', () => {
    expect(
      resolveWorkerSessionId(
        [worker('opk-a', 55, [prUrl(55)]), worker('opk-b', 56, [prUrl(55)])],
        55,
        { openPrs: [openPr(55)] },
      ),
    ).toBeNull();
  });
});

describe('session-pr-binding-resolver direct-pr head ownership', () => {
  it('grants head ownership only when direct prs[] is paired with current head evidence', () => {
    const session = worker('orchestrator-pack-45', 690, [prUrl(690)], {
      branch: 'unrelated-branch',
      ownedHeadSha: headSha,
    });
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
  it('does not auto-grant head ownership for issue correlation without explicit head evidence', () => {
    const session = { ...issueOnlyListRow, role: 'worker' };
    expect(sessionMatchesPr(session, 690, [openPr690], { headSha })).toBe(true);
    expect(sessionOwnsRunHead(session, 690, headSha, [openPr690])).toBe(false);
  });
});

describe('session-pr-binding-resolver retired prNumber regression', () => {
  it('ignores legacy prNumber rows rather than treating them as live ownership evidence', () => {
    const session = worker('opk-retired', 999, [], {
      branch: 'unrelated-branch',
      prNumber: 690,
      displayName: '690',
      pr: '#690',
      ownedHeadSha: headSha,
    });
    const binding = resolveSessionPrBinding(session, [openPr690], { repoSlug, headSha });
    expect(binding.bound).toBe(false);
    expect(getExplicitSessionPrNumber()).toBe(0);
    expect(
      resolveHeadOwningWorkerSessionId(
        [session],
        690,
        headSha,
        [openPr690],
        headOwnerOptions(),
      ),
    ).toBeNull();
  });
});

describe('session-pr-binding-resolver scenario matrix', () => {
  it('scenario 1: missing issueId and prs[] does not bind', () => {
    const binding = resolveSessionPrBinding({ role: 'worker', prs: [] }, [openPr690]);
    expect(binding.bound).toBe(false);
    expect(binding.deferReason).toBe(DEFER_NO_ISSUE_BINDING);
  });

  it('scenario 2: unique issue/head corroboration binds', () => {
    const binding = resolveSessionPrBinding(issueOnlyListRow, [openPr690], { repoSlug, headSha });
    expect(binding.bound).toBe(true);
    expect(binding.prNumber).toBe(690);
  });

  it('scenario 3: issue with many open PRs defers', () => {
    const session = worker('orchestrator-pack-45', 690, [], { branch: '' });
    const binding = resolveSessionPrBinding(
      session,
      [openPr690, openPr(691, headSha, 'issue-690-dup')],
      { repoSlug },
    );
    expect(binding.deferReason).toBe(DEFER_AMBIGUOUS_ISSUE_PR_BINDING);
  });

  it('scenario 3b: headSha filters issue correlation to the matching live PR', () => {
    const session = worker('orchestrator-pack-45', 690, [], { branch: '' });
    const binding = resolveSessionPrBinding(
      session,
      [
        openPr690,
        openPr(691, 'cccccccccccccccccccccccccccccccccccccccc', 'issue-690-dup'),
      ],
      { repoSlug, headSha },
    );
    expect(binding.bound).toBe(true);
    expect(binding.prNumber).toBe(690);
  });

  it('does not return PR-bound session as head owner when headSha is stale', () => {
    const currentHead = 'cccccccccccccccccccccccccccccccccccccccc';
    const staleHead = 'dddddddddddddddddddddddddddddddddddddddd';
    const session = worker('orchestrator-pack-1', 1, [prUrl(1)], { ownedHeadSha: currentHead });
    const openPrs = [openPr(1, currentHead, 'issue-1')];

    expect(
      resolveHeadOwningWorkerSessionId(
        [session],
        1,
        staleHead,
        openPrs,
        headOwnerOptions(),
      ),
    ).toBeNull();
    expect(
      resolveWorkerSessionId([session], 1, {
        openPrs,
        headSha: staleHead,
        ownsHead: (row: Record<string, unknown>) => sessionOwnsRunHead(row, 1, staleHead, openPrs),
      }),
    ).toBeNull();
    expect(
      resolvePrOwningWorkerSessionBinding([session], 1, openPrs, {
        headSha: staleHead,
        repoSlug,
        isLive: () => true,
      }).sessionId,
    ).toBe('orchestrator-pack-1');
  });

  it('scenario 4: many live sessions for one PR defers', () => {
    const resolution = resolvePrOwningWorkerSessionBinding(
      [worker('a', 690, [prUrl(690)]), worker('b', 691, [prUrl(690)])],
      690,
      [openPr690],
      { repoSlug, isLive: () => true },
    );
    expect(resolution.deferReason).toBe(DEFER_AMBIGUOUS_PR_SESSION_BINDING);
  });

  it('scenario 5: reopened PR resolves to the currently open row only', () => {
    const session = worker('opk-reopened', 690, [], { branch: 'issue-690-session-pr-binding' });
    const binding = resolveSessionPrBinding(
      session,
      [
        openPr(689, headSha, 'issue-690-old', 'MERGED'),
        openPr690,
      ],
      { repoSlug, headSha },
    );
    expect(binding.prNumber).toBe(690);
  });

  it('scenario 6: direct prs[] allows ownership listing but not head forge', () => {
    const session = worker('opk-direct', 690, [prUrl(690)], { branch: 'unrelated-branch' });
    expect(resolveSessionPrBinding(session, [openPr690], { repoSlug }).bound).toBe(true);
    expect(sessionOwnsRunHead(session, 690, headSha, [openPr690])).toBe(false);
  });

  it('scenario 7: terminated session can still resolve PR without live requirement', () => {
    const session = worker('orchestrator-pack-45', 690, [prUrl(690)], { status: 'terminated' });
    const resolution = resolvePrOwningWorkerSessionBinding(
      [session],
      690,
      [openPr690],
      { repoSlug, requireLive: false, isLive: () => false },
    );
    expect(resolution.sessionId).toBe('orchestrator-pack-45');
  });

  it('scenario 8: non-numeric displayName is not PR evidence', () => {
    const capture = JSON.parse(
      readFileSync(path.join(capturesRoot, 'session-get-worker.raw.json'), 'utf8'),
    );
    expect(String(capture.session.displayName)).toBe('ao-0-10-cli-mig');
    const binding = resolveSessionPrBinding(
      worker('orchestrator-pack-45', 690, [], {
        branch: 'issue-690-session-pr-binding',
        displayName: capture.session.displayName,
      }),
      [openPr690],
      { repoSlug, headSha },
    );
    expect(binding.bindingSource).toBe('issue_correlation');
  });

  it('scenario 8b: stale numeric displayName cannot override branch correlation', () => {
    const binding = resolveSessionPrBinding(
      worker('orchestrator-pack-45', 690, [], {
        branch: 'issue-690-session-pr-binding',
        displayName: '704',
        prNumber: 704,
      }),
      [openPr690, openPr(704, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'issue-704-other')],
      { repoSlug, headSha },
    );
    expect(binding.bound).toBe(true);
    expect(binding.prNumber).toBe(690);
    expect(binding.bindingSource).toBe('issue_correlation');
  });

  it('scenario 8c: numeric displayName cannot bypass contradictory head evidence', () => {
    const binding = resolveSessionPrBinding(
      worker('orchestrator-pack-45', 690, [], {
        branch: 'issue-690-session-pr-binding',
        displayName: '690',
        prNumber: 690,
      }),
      [openPr690],
      { repoSlug, headSha: 'cccccccccccccccccccccccccccccccccccccccc' },
    );
    expect(binding.bound).toBe(false);
    expect(binding.source).toBe('none');
  });

  it('scenario 9: multiple in-scope prs[] references fail closed without index-zero selection', () => {
    const binding = resolveSessionPrBinding(
      worker('opk-many', 690, [prUrl(690), prUrl(691)]),
      [openPr690, openPr(691)],
      { repoSlug },
    );
    expect(binding.bound).toBe(false);
    expect(binding.deferReason).toBe(DEFER_AMBIGUOUS_SESSION_PRS);
    expect(binding.candidates).toHaveLength(2);
  });

  it('scenario 10: cross-repository prs[] references are filtered before ambiguity', () => {
    const binding = resolveSessionPrBinding(
      worker('opk-repo', 690, [prUrl(690), prUrl(777, 'other/repo')]),
      [openPr690],
      { repoSlug },
    );
    expect(binding.bound).toBe(true);
    expect(binding.prNumber).toBe(690);
  });
});

describe('session-pr-binding-resolver branch patterns', () => {
  it('recognizes issue-<N>-* branch prefix', () => {
    expect(headRefCorrelatesToIssue('issue-683-harness-pn-post-submit', 683)).toBe(true);
    expect(
      listIssueCorrelatedOpenPrs(683, [
        openPr(683, 'abcdef1', 'issue-683-harness-pn-post-submit'),
      ]),
    ).toHaveLength(1);
  });

  it('recognizes AO namespaced issue branches', () => {
    const branch = 'ao/orchestrator-pack-98/issue-731-vitest-history-delivery';
    expect(headRefCorrelatesToIssue(branch, 731)).toBe(true);
    expect(
      listIssueCorrelatedOpenPrs(731, [openPr(738, 'd47c931', branch)]),
    ).toHaveLength(1);
  });
});

describe('ci-failure reaction owner non-null', () => {
  it('records pending episode when head-owning worker resolves', () => {
    const sessions = [worker('orchestrator-pack-45', 690, [prUrl(690)], { ownedHeadSha: headSha })];
    const records = planCiFailureReactionRecords(failedCiInput(sessions));
    expect(records.records).toBeDefined();
    expect(records.records!.length).toBeGreaterThanOrEqual(1);
    expect(records.records![0]?.episode?.targetId).toBe('orchestrator-pack-45');
  });

  it('does not record episode for issue-correlation bind without explicit head evidence', () => {
    const records = planCiFailureReactionRecords(failedCiInput([issueOnlyListRow]));
    expect(records.records).toEqual([]);
  });

  it('records episode when direct prs[] and PR head resolve as owner', () => {
    const sessions = [
      worker('orchestrator-pack-45', 690, [prUrl(690)], {
        branch: 'unrelated-branch',
        ownedHeadSha: headSha,
      }),
    ];
    const records = planCiFailureReactionRecords(failedCiInput(sessions));
    expect(records.records).toHaveLength(1);
    expect(records.records![0]?.episode?.targetId).toBe('orchestrator-pack-45');
  });

  it('bulk prs[] replaces session-get enrichment without weakening the head fence', () => {
    const withoutHead = worker('orchestrator-pack-45', 690, [prUrl(690)], {
      branch: 'unrelated-branch',
    });
    expect(planCiFailureReactionRecords(failedCiInput([withoutHead])).records).toEqual([]);

    const withHead = { ...withoutHead, ownedHeadSha: headSha };
    const records = planCiFailureReactionRecords(failedCiInput([withHead]));
    expect(records.records).toHaveLength(1);
    expect(records.records![0]?.episode?.targetId).toBe('orchestrator-pack-45');
  });
});

describe('retired session-get displayName enrichment', () => {
  it('returns no details and leaves binding to the already-fetched bulk row', () => {
    const getPayload = JSON.parse(
      readFileSync(path.join(capturesRoot, 'session-get-numeric-displayname.raw.json'), 'utf8'),
    );
    expect(sessionDetailFromSessionGetPayload()).toBeNull();
    expect(shouldEnrichSessionDetailFromGet()).toBe(false);
    expect(buildSessionDetailsById()).toEqual({});
    expect(getExplicitSessionPrNumber()).toBe(0);

    const binding = resolveSessionPrBinding(
      worker('orchestrator-pack-45', 690, [prUrl(690)]),
      [openPr690],
      { repoSlug, headSha },
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
