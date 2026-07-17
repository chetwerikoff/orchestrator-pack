import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFER_AMBIGUOUS_ISSUE_PR_BINDING,
  DEFER_AMBIGUOUS_SESSION_PRS,
  buildSessionDetailsById,
  getExplicitSessionPrNumber,
  headRefCorrelatesToIssue,
  listIssueCorrelatedOpenPrs,
  resolvePrOwningWorkerSessionBinding,
  resolveSessionPrBinding,
  sessionDetailFromSessionGetPayload,
  shouldEnrichSessionDetailFromGet,
} from '../docs/session-pr-binding-resolver.mjs';

const repoSlug = 'chetwerikoff/orchestrator-pack';
const headSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const prUrl = (number: number, slug = repoSlug) =>
  `https://github.com/${slug}/pull/${number}`;

const openPr = (
  number: number,
  headRefOid = headSha,
  headRefName = `issue-${number}`,
  state = 'OPEN',
) => ({ number, headRefOid, headRefName, state, repoSlug });

const worker = (
  id: string,
  issueNumber: number,
  prs: string[] = [],
  extra: Record<string, unknown> = {},
) => ({
  id,
  sessionId: id,
  name: id,
  role: 'worker',
  status: 'working',
  issueNumber,
  branch: `issue-${issueNumber}`,
  repoSlug,
  prs,
  ...extra,
});

describe('session-pr-binding resolver bulk-list contract', () => {
  it('parses a full GitHub PR URL from the bulk prs[] field', () => {
    const binding = resolveSessionPrBinding(
      worker('opk-1', 857, [prUrl(901)]),
      [openPr(901)],
      { repoSlug, headSha },
    ) as any;

    expect(binding).toMatchObject({
      bound: true,
      prNumber: 901,
      bindingSource: 'live_prs',
      trustRank: 400,
    });
  });

  it('scopes live PR references by repository', () => {
    const binding = resolveSessionPrBinding(
      worker('opk-1', 857, [prUrl(901), prUrl(77, 'other/repo')]),
      [openPr(901)],
      { repoSlug },
    ) as any;

    expect(binding.bound).toBe(true);
    expect(binding.prNumber).toBe(901);
  });

  it('does not silently choose index zero for multiple in-scope PRs', () => {
    const binding = resolveSessionPrBinding(
      worker('opk-1', 857, [prUrl(901), prUrl(902)]),
      [openPr(901), openPr(902)],
      { repoSlug },
    ) as any;

    expect(binding.bound).toBe(false);
    expect(binding.deferReason).toBe(DEFER_AMBIGUOUS_SESSION_PRS);
    expect(binding.diagnostic).toBe('multiple_session_pr_references');
    expect(binding.candidates).toHaveLength(2);
  });

  it('uses issue/branch correlation only as lower-ranked fallback', () => {
    const binding = resolveSessionPrBinding(
      worker('opk-1', 857, []),
      [openPr(901, headSha, 'issue-857-contract')],
      { repoSlug },
    ) as any;

    expect(binding).toMatchObject({
      bound: true,
      prNumber: 901,
      bindingSource: 'issue_correlation',
      trustRank: 200,
    });
  });

  it('fails closed for ambiguous issue/branch correlation', () => {
    const session = worker('opk-1', 857, []);
    const binding = resolveSessionPrBinding(
      session,
      [
        openPr(901, 'a', 'issue-857-a'),
        openPr(902, 'b', 'issue-857-b'),
      ],
      { repoSlug },
    );

    expect(binding.bound).toBe(false);
    expect(binding.deferReason).toBe(DEFER_AMBIGUOUS_ISSUE_PR_BINDING);
  });

  it('preserves the attributable session id on one-session ambiguity', () => {
    const resolution = resolvePrOwningWorkerSessionBinding(
      [worker('opk-1', 857, [prUrl(901), prUrl(902)])],
      901,
      [openPr(901), openPr(902)],
      { repoSlug, isLive: () => true },
    ) as any;

    expect(resolution.failClosed).toBe(true);
    expect(resolution.sessionId).toBe('opk-1');
    expect(resolution.deferReason).toBe(DEFER_AMBIGUOUS_ISSUE_PR_BINDING);
  });

  it('reports all conflicting session ids when many sessions claim one PR', () => {
    const resolution = resolvePrOwningWorkerSessionBinding(
      [
        worker('opk-1', 857, [prUrl(901)]),
        worker('opk-2', 858, [prUrl(901)]),
      ],
      901,
      [openPr(901)],
      { repoSlug, isLive: () => true },
    ) as any;

    expect(resolution.failClosed).toBe(true);
    expect(resolution.sessionId).toBeNull();
    expect(resolution.conflictingSessionIds).toEqual(['opk-1', 'opk-2']);
  });
});

describe('retired per-session enrichment surface', () => {
  it('never requests ao session get detail for binding', () => {
    const row = worker('opk-1', 857, [prUrl(901)], {
      displayName: '901',
      prNumber: 901,
      pr: '#901',
    });

    expect(shouldEnrichSessionDetailFromGet(row)).toBe(false);
    expect(sessionDetailFromSessionGetPayload({ session: row })).toBeNull();
    expect(buildSessionDetailsById([row], { 'opk-1': { session: row } })).toEqual({});
    expect(getExplicitSessionPrNumber(row)).toBe(0);
  });

  it('dead fields cannot override the live prs[] signal', () => {
    const binding = resolveSessionPrBinding(
      worker('opk-1', 857, [prUrl(901)], {
        displayName: '999',
        prNumber: 999,
        pr: '#999',
      }),
      [openPr(901), openPr(999, 'b', 'issue-999')],
      { repoSlug },
    ) as any;

    expect(binding.prNumber).toBe(901);
    expect(binding.bindingSource).toBe('live_prs');
  });
});

describe('branch pattern compatibility', () => {
  it('keeps established issue branch patterns inside the resolver boundary', () => {
    expect(headRefCorrelatesToIssue('issue-857-contract', 857)).toBe(true);
    expect(headRefCorrelatesToIssue('ao/orchestrator-pack-98/issue-857-contract', 857)).toBe(true);
    expect(headRefCorrelatesToIssue('opk-857', 857)).toBe(true);
    expect(
      listIssueCorrelatedOpenPrs(857, [openPr(901, headSha, 'issue-857-contract')]),
    ).toHaveLength(1);
  });
});

describe('dead-field and N+1 removal guard', () => {
  const bindingConsumers = [
    'docs/session-pr-binding-resolver.mjs',
    'docs/worker-report-store.mjs',
    'scripts/lib/Invoke-AoCliJson.ps1',
    'scripts/lib/WorkerReportStore.ps1',
    'scripts/lib/Worker-Recovery.ps1',
    'scripts/lib/worker-status-store.mjs',
    'scripts/lib/WorkerStatusStore.ps1',
  ];

  it('contains no live predicates on retired daemon binding fields', () => {
    const forbidden = [
      /session\?*\.displayName/i,
      /session\?*\.prNumber/i,
      /session\?*\.pr\b/i,
      /\$Session\.displayName/i,
      /\$Session\.prNumber/i,
      /\$Session\.pr\b/i,
      /\$Row\.displayName/i,
      /\$Row\.prNumber/i,
      /\$Row\.pr\b/i,
    ];

    for (const relative of bindingConsumers) {
      const text = readFileSync(path.join(repoRoot, relative), 'utf8');
      for (const pattern of forbidden) {
        expect(pattern.test(text), `${relative} must not contain ${pattern}`).toBe(false);
      }
    }
  });

  it('keeps Build-AoSessionDetailsById bounded and free of session-get calls', () => {
    const text = readFileSync(
      path.join(repoRoot, 'scripts/lib/Invoke-AoCliJson.ps1'),
      'utf8',
    );
    const start = text.indexOf('function Build-AoSessionDetailsById');
    const end = text.indexOf('\nfunction ', start + 1);
    const body = text.slice(start, end > start ? end : undefined);
    expect(body).not.toMatch(/Get-AoSessionGetJson/);
    expect(body).not.toMatch(/foreach\s*\(/i);
  });
});
