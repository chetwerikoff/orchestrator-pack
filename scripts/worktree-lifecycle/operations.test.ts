// @vitest-ci-lane heavy
// @vitest-pre-topology-seconds 120

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProcessResult } from '../kernel/subprocess.ts';
import {
  collectCensus,
  runLifecycle,
  type CommandInvocation,
  type CommandRunner,
  type LifecycleOperations,
} from './operations.ts';
import type { ExpectedWorktreeIdentity } from './core.ts';

const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);
const BRANCH = 'agent/issue-1298';
const REPOSITORY_ID = 'repo-1298';
const roots: string[] = [];

function result(input: Partial<ProcessResult> & { stdout?: string } = {}): ProcessResult {
  return {
    outcome: input.outcome ?? 'exit',
    ok: input.ok ?? true,
    exitCode: input.exitCode ?? 0,
    signal: input.signal ?? null,
    stdout: input.stdout ?? '',
    stderr: input.stderr ?? '',
    timedOut: input.timedOut ?? false,
    cancelled: input.cancelled ?? false,
    ...(input.error ? { error: input.error } : {}),
  };
}

interface Paths {
  root: string;
  repo: string;
  worktree: string;
  common: string;
  expected: ExpectedWorktreeIdentity;
}

function fixture(): Paths {
  const root = mkdtempSync(join(tmpdir(), 'opk-worktree-lifecycle-'));
  roots.push(root);
  const repo = join(root, 'repo');
  const worktree = join(root, 'worktrees', 'issue-1298');
  const common = join(repo, '.git');
  const gitdir = join(common, 'worktrees', 'issue-1298');
  mkdirSync(gitdir, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(worktree, '.git'), `gitdir: ${gitdir}\n`, 'utf8');
  return {
    root,
    repo,
    worktree,
    common,
    expected: {
      repositoryRoot: repo,
      path: worktree,
      headSha: HEAD,
      mode: 'branch-bound',
      branchName: BRANCH,
      bindingKind: 'pr',
      bindingNumber: 1300,
    },
  };
}

interface RunnerState {
  gitPresent: boolean;
  orcaPresent: boolean;
  linkedIssue?: number;
  dirty?: boolean;
  ignoredSequence?: string[];
  terminals?: unknown[];
  agents?: unknown[];
  openPrs?: Array<{ number: number; headRefName: string }>;
  removalResult?: ProcessResult;
  standardTeardownResult?: ProcessResult;
  standardTeardownEffect?: 'both-absent' | 'git-only-absent' | 'none';
  removeCount: number;
  ignoredReads: number;
  invocations: CommandInvocation[];
}

function targetOrca(paths: Paths, state: RunnerState, includeAgents: boolean): object[] {
  if (!state.orcaPresent) return [];
  return [{
    path: paths.worktree,
    head: HEAD,
    branch: `refs/heads/${BRANCH}`,
    ...(state.linkedIssue === undefined ? { linkedPR: 1300 } : { linkedIssue: state.linkedIssue }),
    repoId: REPOSITORY_ID,
    isMainWorktree: false,
    isArchived: false,
    ...(includeAgents ? { agents: state.agents ?? [] } : {}),
  }];
}

function orcaPayload(paths: Paths, state: RunnerState, includeAgents = false): string {
  return JSON.stringify({
    ok: true,
    result: {
      worktrees: [
        {
          path: paths.repo,
          head: OTHER_HEAD,
          branch: 'refs/heads/main',
          repoId: REPOSITORY_ID,
          isMainWorktree: true,
          isArchived: false,
        },
        ...targetOrca(paths, state, includeAgents),
      ],
    },
  });
}

function gitPayload(paths: Paths, state: RunnerState): string {
  return [
    `worktree ${paths.repo}`,
    `HEAD ${OTHER_HEAD}`,
    'branch refs/heads/main',
    '',
    ...(state.gitPresent ? [
      `worktree ${paths.worktree}`,
      `HEAD ${HEAD}`,
      `branch refs/heads/${BRANCH}`,
      '',
    ] : []),
  ].join('\n');
}

function runner(paths: Paths, state: RunnerState): CommandRunner {
  return (invocation) => {
    state.invocations.push(invocation);
    const args = [...invocation.args];
    if (invocation.command === 'git' && args.includes('worktree') && args.includes('list')) {
      return result({ stdout: gitPayload(paths, state) });
    }
    if (invocation.command.endsWith('/scripts/gh') && args[0] === 'pr' && args[1] === 'view') {
      return result({
        stdout: JSON.stringify({
          headRefName: BRANCH,
          state: 'MERGED',
          headRefOid: HEAD,
          mergeCommit: { oid: OTHER_HEAD },
          headRepository: { nameWithOwner: 'chetwerikoff/orchestrator-pack' },
          baseRefName: 'main',
        }),
      });
    }
    if (invocation.command.endsWith('/scripts/gh') && args[0] === 'pr' && args[1] === 'list') {
      return result({ stdout: JSON.stringify(state.openPrs ?? []) });
    }
    if (invocation.command === 'git' && args.includes('rev-parse') && args.includes('--git-common-dir')) {
      return result({ stdout: `${paths.common}\n` });
    }
    if (invocation.command === 'git' && args.includes('status') && args.includes('--untracked-files=all')) {
      return result({ stdout: state.dirty ? ' M tracked.txt\n' : '' });
    }
    if (invocation.command === 'git' && args.includes('status') && args.includes('--ignored=matching')) {
      const sequence = state.ignoredSequence ?? [''];
      const value = sequence[Math.min(state.ignoredReads, sequence.length - 1)] ?? '';
      state.ignoredReads += 1;
      return result({ stdout: value });
    }
    if (invocation.command === 'git' && (args.includes('merge-base') || args.includes('fetch'))) {
      return result();
    }
    if (invocation.command === 'git' && args.includes('worktree') && args.includes('remove')) {
      expect(args).not.toContain('--force');
      state.removeCount += 1;
      state.gitPresent = false;
      return state.removalResult ?? result();
    }
    if (invocation.command === 'git' && args.includes('branch') && args.includes('--list')) {
      return result({ stdout: `${BRANCH}\n` });
    }
    if (invocation.command === 'git' && args.includes('branch') && args.includes('-d')) {
      expect(args).not.toContain('-D');
      return result();
    }
    if (args[0] === 'worktree' && args[1] === 'list') {
      return result({ stdout: orcaPayload(paths, state) });
    }
    if (args[0] === 'worktree' && args[1] === 'ps') {
      return result({ stdout: orcaPayload(paths, state, true) });
    }
    if (args[0] === 'terminal' && args[1] === 'list') {
      return result({ stdout: JSON.stringify({ ok: true, result: { terminals: state.terminals ?? [] } }) });
    }
    if (invocation.command === process.execPath) {
      if (state.standardTeardownEffect === 'both-absent') {
        state.gitPresent = false;
        state.orcaPresent = false;
      } else if (state.standardTeardownEffect === 'git-only-absent') {
        state.gitPresent = false;
      }
      return state.standardTeardownResult ?? result({ stdout: JSON.stringify({ outcome: 'reaped_clean' }) });
    }
    throw new Error(`unexpected invocation: ${invocation.command} ${args.join(' ')}`);
  };
}

function state(overrides: Partial<RunnerState> = {}): RunnerState {
  return {
    gitPresent: true,
    orcaPresent: false,
    removeCount: 0,
    ignoredReads: 0,
    invocations: [],
    ...overrides,
  };
}

function operations(paths: Paths, value: RunnerState, processCensus: LifecycleOperations['processCensus'] = () => []): LifecycleOperations {
  return {
    runner: runner(paths, value),
    orcaExecutable: 'orca-fixture',
    lockPath: join(paths.root, 'lifecycle.lock'),
    processCensus,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('dual census authority', () => {
  it('derives repository identity from the active main Orca row', () => {
    const paths = fixture();
    const value = state({ orcaPresent: true });
    const census = collectCensus(paths.expected, operations(paths, value));

    expect(census.classification).toMatchObject({
      classification: 'exact_dual',
      expected: { repositoryId: REPOSITORY_ID },
    });
  });

  it('classifies the production incident as exact Git-only', () => {
    const paths = fixture();
    const census = collectCensus(paths.expected, operations(paths, state()));
    expect(census.classification.classification).toBe('exact_git_only');
  });

  it('fails closed when repository authority cannot be proven', () => {
    const paths = fixture();
    const value = state();
    const base = runner(paths, value);
    const census = collectCensus(paths.expected, {
      ...operations(paths, value),
      runner: (invocation) => invocation.args[0] === 'worktree' && invocation.args[1] === 'list'
        ? result({ stdout: JSON.stringify({ ok: true, result: { worktrees: [] } }) })
        : base(invocation),
    });
    expect(census.classification.classification).toBe('conflict');
    expect(census.errors.join(' ')).toMatch(/repository identity/);
  });
});

describe('guarded Git-only recovery', () => {
  it('runs every gate twice and reports dry-run eligibility', () => {
    const paths = fixture();
    const value = state();
    const report = runLifecycle({
      expected: paths.expected,
      context: 'explicit-recovery',
      apply: false,
      operations: operations(paths, value),
    });

    expect(report).toMatchObject({
      outcome: 'git_only_recovery_eligible',
      gates: {
        identity: true,
        gitLink: true,
        clean: true,
        ignoredData: true,
        merged: true,
        branchOwnership: true,
        runtimeAgentsAbsent: true,
        terminalsAbsent: true,
        processesAbsent: true,
        freshRecheck: true,
      },
      effects: [],
    });
    expect(value.ignoredReads).toBe(2);
    expect(value.removeCount).toBe(0);
  });

  it('blocks when ignored data appears between initial and pre-effect snapshots', () => {
    const paths = fixture();
    const value = state({ ignoredSequence: ['', '!! private-cache/\n'] });
    const report = runLifecycle({
      expected: paths.expected,
      context: 'explicit-recovery',
      apply: true,
      operations: operations(paths, value),
    });

    expect(report).toMatchObject({
      outcome: 'cleanup_deferred',
      gates: { ignoredData: false, freshRecheck: false },
      effects: [],
    });
    expect(value.removeCount).toBe(0);
  });

  it('treats process-census failure as unavailable evidence', () => {
    const paths = fixture();
    const value = state();
    const report = runLifecycle({
      expected: paths.expected,
      context: 'explicit-recovery',
      apply: true,
      operations: operations(paths, value, () => { throw new Error('proc unavailable'); }),
    });

    expect(report).toMatchObject({
      outcome: 'cleanup_deferred',
      gates: { processesAbsent: false, freshRecheck: false },
      effects: [],
    });
    expect(report.error).toMatch(/proc unavailable/);
    expect(value.removeCount).toBe(0);
  });

  it('blocks dirty, active-terminal, residual-process, and branch-reuse states', () => {
    const paths = fixture();
    const cases: Array<{
      value: RunnerState;
      processCensus?: LifecycleOperations['processCensus'];
    }> = [
      { value: state({ dirty: true }) },
      { value: state({ terminals: [{ handle: 't1', worktreePath: paths.worktree, tabId: 'tab-1' }] }) },
      { value: state(), processCensus: () => [{ pid: 99, ppid: 1, starttime: '1', cwd: paths.worktree }] },
      { value: state({ openPrs: [{ number: 1301, headRefName: BRANCH }] }) },
    ];
    for (const item of cases) {
      const report = runLifecycle({
        expected: paths.expected,
        context: 'explicit-recovery',
        apply: true,
        operations: operations(paths, item.value, item.processCensus ?? (() => [])),
      });
      expect(report.outcome).toBe('cleanup_deferred');
      expect(item.value.removeCount).toBe(0);
    }
  });

  it('uses non-force removal, proves dual absence, and becomes idempotent', () => {
    const paths = fixture();
    const value = state();
    const opts = operations(paths, value);
    const applied = runLifecycle({
      expected: paths.expected,
      context: 'explicit-recovery',
      apply: true,
      operations: opts,
    });

    expect(applied).toMatchObject({
      outcome: 'git_only_recovered',
      branchDeletion: 'deleted',
      postClassification: { classification: 'absent' },
    });
    expect(value.removeCount).toBe(1);
    expect(runLifecycle({
      expected: paths.expected,
      context: 'explicit-recovery',
      apply: true,
      operations: opts,
    })).toMatchObject({ outcome: 'already_absent', effects: [] });
  });

  it('settles effect-before-receipt removal from authoritative read-back', () => {
    const paths = fixture();
    const value = state({
      removalResult: result({
        outcome: 'timeout',
        ok: false,
        exitCode: null,
        timedOut: true,
        stderr: 'receipt lost',
      }),
    });
    const report = runLifecycle({
      expected: paths.expected,
      context: 'explicit-recovery',
      apply: true,
      operations: operations(paths, value),
    });

    expect(report).toMatchObject({ outcome: 'git_only_recovered', postClassification: { classification: 'absent' } });
    expect(value.removeCount).toBe(1);
  });
});

describe('standard teardown post-effect settlement', () => {
  it('reports complete only after dual absence is proven', () => {
    const paths = fixture();
    const value = state({ orcaPresent: true, standardTeardownEffect: 'both-absent' });
    const report = runLifecycle({
      expected: paths.expected,
      context: 'post-merge-cleanup',
      apply: true,
      operations: operations(paths, value),
    });

    expect(report).toMatchObject({
      outcome: 'cleanup_complete',
      postClassification: { classification: 'absent' },
    });
  });

  it('degrades when the child succeeds but Orca still retains the target', () => {
    const paths = fixture();
    const value = state({ orcaPresent: true, standardTeardownEffect: 'git-only-absent' });
    const report = runLifecycle({
      expected: paths.expected,
      context: 'post-merge-cleanup',
      apply: true,
      operations: operations(paths, value),
    });

    expect(report).toMatchObject({
      outcome: 'task_degraded',
      postClassification: { classification: 'orca_only' },
    });
    expect(report.error).toMatch(/did not prove absence/);
  });

  it('accepts effect-before-receipt only when dual read-back proves completion', () => {
    const paths = fixture();
    const value = state({
      orcaPresent: true,
      standardTeardownEffect: 'both-absent',
      standardTeardownResult: result({
        outcome: 'timeout',
        ok: false,
        exitCode: null,
        timedOut: true,
        stderr: 'child receipt lost',
      }),
    });
    const report = runLifecycle({
      expected: paths.expected,
      context: 'post-merge-cleanup',
      apply: true,
      operations: operations(paths, value),
    });

    expect(report).toMatchObject({
      outcome: 'cleanup_complete',
      postClassification: { classification: 'absent' },
    });
  });
});

describe('post-create observation', () => {
  it('reports exact dual without exporting terminal authority', () => {
    const paths = fixture();
    const value = state({ orcaPresent: true, linkedIssue: 1298 });
    const report = runLifecycle({
      expected: { ...paths.expected, bindingKind: 'issue', bindingNumber: 1298 },
      context: 'post-create',
      apply: false,
      operations: operations(paths, value),
    });

    expect(report).toMatchObject({
      outcome: 'exact_dual_observed',
      classification: { classification: 'exact_dual' },
      decision: { terminalSpawnAuthorized: false },
    });
  });
});