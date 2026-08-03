// @vitest-ci-lane heavy
// @vitest-pre-topology-seconds 120

import { describe, expect, it } from 'vitest';
import {
  classifyWorktree,
  decideContinuation,
  normalizeExpectedIdentity,
  parseGitWorktreePorcelain,
  parseOrcaWorktreePayload,
  type CensusEvidence,
  type ExpectedWorktreeIdentity,
} from './core.ts';

const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);
const PATH = '/tmp/orca/workspaces/orchestrator-pack/issue-1298';
const BRANCH = 'agent/issue-1298';

const expected = (overrides: Partial<ExpectedWorktreeIdentity> = {}): ExpectedWorktreeIdentity => ({
  repositoryRoot: '/tmp/orchestrator-pack',
  path: PATH,
  headSha: HEAD,
  mode: 'branch-bound',
  branchName: BRANCH,
  bindingKind: 'issue',
  bindingNumber: 1298,
  ...overrides,
});

const git = (input: { path?: string; head?: string; branch?: string; detached?: boolean } = {}) =>
  parseGitWorktreePorcelain([
    `worktree ${input.path ?? PATH}`,
    `HEAD ${input.head ?? HEAD}`,
    ...(input.detached ? ['detached'] : [`branch refs/heads/${input.branch ?? BRANCH}`]),
    '',
  ].join('\n'));

const orca = (input: {
  path?: string;
  head?: string;
  branch?: string;
  linkedIssue?: number | null;
  linkedPR?: number | null;
} = {}) => parseOrcaWorktreePayload({
  ok: true,
  result: {
    worktrees: [{
      path: input.path ?? PATH,
      head: input.head ?? HEAD,
      branch: input.branch === '' ? '' : `refs/heads/${input.branch ?? BRANCH}`,
      linkedIssue: input.linkedIssue === undefined ? 1298 : input.linkedIssue,
      linkedPR: input.linkedPR,
      isMainWorktree: false,
      isArchived: false,
      repoId: 'repo-1',
    }],
  },
});

const evidence = (
  gitRows = git(),
  orcaRows = orca(),
  statuses: Partial<{ git: CensusEvidence['git']['status']; orca: CensusEvidence['orca']['status'] }> = {},
): CensusEvidence => ({
  git: { status: statuses.git ?? 'ok', rows: gitRows },
  orca: { status: statuses.orca ?? 'ok', rows: orcaRows },
});

describe('worktree lifecycle classifier', () => {
  it('classifies exact issue-bound Git and Orca agreement', () => {
    const report = classifyWorktree({ expected: expected(), evidence: evidence() });
    expect(report.classification).toBe('exact_dual');
    expect(report.exactGitRows).toHaveLength(1);
    expect(report.exactOrcaRows).toHaveLength(1);
  });

  it('classifies the incident shape as exact Git-only', () => {
    const report = classifyWorktree({ expected: expected(), evidence: evidence(git(), []) });
    expect(report.classification).toBe('exact_git_only');
    expect(report.conflictingGitRows).toHaveLength(0);
    expect(report.conflictingOrcaRows).toHaveLength(0);
  });

  it('classifies Orca-only and absent states separately', () => {
    expect(classifyWorktree({ expected: expected(), evidence: evidence([], orca()) }).classification)
      .toBe('orca_only');
    expect(classifyWorktree({ expected: expected(), evidence: evidence([], []) }).classification)
      .toBe('absent');
  });

  it('rejects the right path/head/branch when Orca links another issue', () => {
    const report = classifyWorktree({
      expected: expected(),
      evidence: evidence(git(), orca({ linkedIssue: 1299 })),
    });
    expect(report.classification).toBe('conflict');
    expect(report.disagreeingFields).toContain('orca.linkedIssue');
  });

  it('accepts optional exact linkedPR but rejects a conflicting linkedPR', () => {
    const prExpected = expected({ bindingKind: 'pr', bindingNumber: 1300 });
    expect(classifyWorktree({
      expected: prExpected,
      evidence: evidence(git(), orca({ linkedIssue: null, linkedPR: 1300 })),
    }).classification).toBe('exact_dual');
    expect(classifyWorktree({
      expected: prExpected,
      evidence: evidence(git(), orca({ linkedIssue: null, linkedPR: 1301 })),
    }).classification).toBe('conflict');
  });

  it('fails closed on stale, duplicate, and unavailable evidence', () => {
    const stale = classifyWorktree({
      expected: expected(),
      evidence: evidence(git({ head: OTHER_HEAD }), orca()),
    });
    expect(stale.classification).toBe('conflict');
    expect(stale.disagreeingFields).toContain('git.head');

    const duplicate = classifyWorktree({
      expected: expected(),
      evidence: evidence(git(), [...orca(), ...orca()]),
    });
    expect(duplicate.classification).toBe('conflict');

    const unavailable = classifyWorktree({
      expected: expected(),
      evidence: evidence(git(), [], { orca: 'unavailable' }),
    });
    expect(unavailable.classification).toBe('conflict');
  });

  it('does not authorize detached identity without the exact expected SHA', () => {
    const detachedExpected = expected({ mode: 'detached-confirmed', branchName: undefined });
    expect(classifyWorktree({
      expected: detachedExpected,
      evidence: evidence(git({ detached: true }), orca({ branch: '' })),
    }).classification).toBe('exact_dual');

    expect(classifyWorktree({
      expected: detachedExpected,
      evidence: evidence(git({ detached: true, head: OTHER_HEAD }), orca({ branch: '' })),
    }).classification).toBe('conflict');
  });

  it('rejects partial SHAs and branch/detached ambiguity', () => {
    expect(() => normalizeExpectedIdentity(expected({ headSha: 'abc123' }))).toThrow(/40-hex/);
    expect(() => normalizeExpectedIdentity(expected({ mode: 'detached-confirmed' }))).toThrow(/must not carry/);
  });
});

describe('continuation policy', () => {
  it('authorizes terminal spawn only after exact dual post-create read-back', () => {
    const exact = decideContinuation('exact_dual', 'post-create');
    expect(exact.action).toBe('continue_existing');
    expect(exact.terminalSpawnAuthorized).toBe(true);
    expect(exact.globalPipelineContinues).toBe(true);

    for (const classification of ['exact_git_only', 'orca_only', 'conflict', 'absent'] as const) {
      const decision = decideContinuation(classification, 'post-create');
      expect(decision.terminalSpawnAuthorized).toBe(false);
      expect(decision.globalPipelineContinues).toBe(true);
    }
  });

  it('keeps completed merge work successful while unsafe cleanup is deferred', () => {
    for (const classification of ['orca_only', 'conflict'] as const) {
      expect(decideContinuation(classification, 'post-merge-cleanup')).toMatchObject({
        action: 'cleanup_deferred',
        globalPipelineContinues: true,
        targetMutationAuthorized: false,
      });
    }
  });

  it('routes exact Git-only state to guarded recovery and absent state to a no-op', () => {
    expect(decideContinuation('exact_git_only', 'post-merge-cleanup').action)
      .toBe('try_guarded_git_only_recovery');
    expect(decideContinuation('absent', 'post-merge-cleanup').action).toBe('already_absent');
  });
});
