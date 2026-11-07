// @vitest-ci-lane light
// @vitest-pre-topology-seconds 120

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runProcessSync, type ProcessResult } from '../kernel/subprocess.ts';
import { WRAPPER_PATH } from '../lib/gh-resolve-real-binary.mjs';
import {
  collectCensus,
  readPrIdentity,
  runLifecycle,
  type CommandInvocation,
  type CommandRunner,
  type LifecycleOperations,
} from './operations.ts';
import type { ExpectedWorktreeIdentity } from './core.ts';
import { closeSync, openSync, realpathSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { defaultProcessCensus } from '../worktree-teardown.ts';
import {
  removeIdenticalLaunchCopies,
  runMergeCleanup,
  type GitRunner,
  type MergeCleanupDeps,
} from './merge-cleanup.ts';
import { collectProcessCensus, type ProcIo } from './operations.ts';

const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);
const BRANCH = 'agent/issue-1298';
const REPOSITORY_ID = 'repo-1298';
const roots: string[] = [];

function result(input: Partial<ProcessResult> & { stdout?: string } = {}): ProcessResult {
  const base: ProcessResult = {
    outcome: input.outcome ?? 'exit',
    ok: input.ok ?? true,
    exitCode: input.exitCode ?? 0,
    signal: input.signal ?? null,
    stdout: input.stdout ?? '',
    stderr: input.stderr ?? '',
    timedOut: input.timedOut ?? false,
    cancelled: input.cancelled ?? false,
  };
  return input.error ? { ...base, error: input.error } : base;
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
  foreignOrcaRows?: object[];
  foreignOrcaRowsAfterTeardown?: object[];
  removalResult?: ProcessResult;
  standardTeardownResult?: ProcessResult;
  standardTeardownEffect?: 'both-absent' | 'git-only-absent' | 'none';
  removeCount: number;
  ignoredReads: number;
  childLockTokens: string[];
  invocations: CommandInvocation[];
}

function targetOrca(paths: Paths, state: RunnerState, includeAgents: boolean): object[] {
  if (!state.orcaPresent) return [];
  return [{
    id: `${REPOSITORY_ID}::${paths.worktree}`,
    path: paths.worktree,
    head: HEAD,
    branch: `refs/heads/${BRANCH}`,
    ...(state.linkedIssue === undefined ? { linkedPR: 1300 } : { linkedIssue: state.linkedIssue }),
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
          id: `${REPOSITORY_ID}::${paths.repo}`,
          path: paths.repo,
          head: OTHER_HEAD,
          branch: 'refs/heads/main',
          isMainWorktree: true,
          isArchived: false,
          ...(includeAgents ? { agents: [] } : {}),
        },
        ...targetOrca(paths, state, includeAgents),
        ...(state.foreignOrcaRows ?? []),
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
      const tokenIndex = args.indexOf('--lifecycle-lock-token');
      const pathIndex = args.indexOf('--lifecycle-lock-path');
      expect(tokenIndex).toBeGreaterThan(-1);
      expect(pathIndex).toBeGreaterThan(-1);
      state.childLockTokens.push(args[tokenIndex + 1]!);
      if (state.standardTeardownEffect === 'both-absent') {
        state.gitPresent = false;
        state.orcaPresent = false;
      } else if (state.standardTeardownEffect === 'git-only-absent') {
        state.gitPresent = false;
      }
      if (state.foreignOrcaRowsAfterTeardown) {
        state.foreignOrcaRows = state.foreignOrcaRowsAfterTeardown;
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
    childLockTokens: [],
    invocations: [],
    ...overrides,
  };
}

function foreignRow(paths: Paths, suffix: string): object {
  const path = join(paths.root, 'foreign-repository', suffix);
  return {
    id: `foreign-repository::${path}`,
    path,
    head: HEAD,
    branch: `refs/heads/${BRANCH}`,
    linkedPR: 1300,
    isMainWorktree: false,
    isArchived: false,
    agents: [{ state: 'working', interrupted: false }],
  };
}

function operations(
  paths: Paths,
  value: RunnerState,
  processCensus: LifecycleOperations['processCensus'] = () => [],
): LifecycleOperations {
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

describe('Issue #2754 AC3 native vanished-registration pruning', () => {
  it('prunes recent vanished only in its selected repository and preserves live dirty and locked registrations', () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-2754-native-prune-'));
    roots.push(root);
    const repo = join(root, 'selected');
    const live = join(root, 'live-dirty');
    const locked = join(root, 'locked-vanished');
    const vanished = join(root, 'vanished-unlocked');
    const foreign = join(root, 'foreign');
    const run = (cwd: string, args: string[]): string => {
      const result = runProcessSync({ command: 'git', args, cwd, env: {
        ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_AUTHOR_NAME: 'synthetic', GIT_AUTHOR_EMAIL: 'synthetic@example.test',
        GIT_COMMITTER_NAME: 'synthetic', GIT_COMMITTER_EMAIL: 'synthetic@example.test',
      } });
      if (!result.ok) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
      return result.stdout;
    };
    run(root, ['init', '-q', '-b', 'main', repo]);
    run(root, ['init', '-q', '-b', 'main', foreign]);
    writeFileSync(join(repo, 'proof.txt'), 'original\n');
    run(repo, ['add', 'proof.txt']);
    run(repo, ['commit', '-q', '-m', 'synthetic seed']);
    for (const [path, name] of [[live, 'live'], [locked, 'locked'], [vanished, 'vanished']] as const) {
      run(repo, ['worktree', 'add', '-q', '-b', name, path, 'HEAD']);
    }
    writeFileSync(join(live, 'untracked.txt'), 'must survive\n');
    writeFileSync(join(live, 'proof.txt'), 'dirty content\n');
    run(repo, ['worktree', 'lock', '--reason', 'manual retention', locked]);
    rmSync(locked, { recursive: true, force: true });
    rmSync(vanished, { recursive: true, force: true });
    const beforeForeign = run(foreign, ['worktree', 'list', '--porcelain']);
    run(repo, ['worktree', 'prune', '--expire=now']);
    const after = run(repo, ['worktree', 'list', '--porcelain']);
    expect(after).toContain(`worktree ${live}`);
    expect(after).toContain(`worktree ${locked}`);
    expect(after).not.toContain(`worktree ${vanished}`);
    expect(existsSync(join(live, 'untracked.txt'))).toBe(true);
    expect(run(live, ['status', '--porcelain=v1', '--untracked-files=all'])).toContain('proof.txt');
    expect(run(foreign, ['worktree', 'list', '--porcelain'])).toBe(beforeForeign);
  });
});

describe('dual census authority', () => {
  it('derives repository identity from the active main Orca composite id', () => {
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

  it('ignores matching PR, branch, and active agents in a foreign repository', () => {
    const paths = fixture();
    const value = state({ foreignOrcaRows: [foreignRow(paths, 'active')] });
    const report = runLifecycle({
      expected: paths.expected,
      context: 'explicit-recovery',
      apply: false,
      operations: operations(paths, value),
    });

    expect(report).toMatchObject({
      outcome: 'git_only_recovery_eligible',
      gates: { runtimeAgentsAbsent: true, freshRecheck: true },
    });
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
  it('accepts an explicitly bound local branch whose name differs from the merged PR source', () => {
    const paths = fixture();
    const value = state();
    const opts = operations(paths, value);
    const base = opts.runner!;
    const report = runLifecycle({ expected: { ...paths.expected, finalPrHeadSha: HEAD }, context: 'explicit-recovery', apply: true,
      operations: { ...opts, runner: (invocation) => {
        const response = base(invocation);
        if (invocation.args[0] === 'pr' && invocation.args[1] === 'view') {
          return result({ stdout: JSON.stringify({ ...JSON.parse(response.stdout), headRefName: 'pushed/other-name' }) });
        }
        return response;
      } },
    });
    expect(report).toMatchObject({ outcome: 'git_only_recovered', gates: { merged: true, branchOwnership: true } });
  });

  it.each(['wrong head', 'unmerged PR', 'open PR owns local branch'])(
    'preserves the bound tree on %s with a differently named PR branch', (failure) => {
      const paths = fixture();
      const value = state({ ...(failure === 'open PR owns local branch' ? { openPrs: [{ number: 1301, headRefName: BRANCH }] } : {}) });
      const opts = operations(paths, value);
      const base = opts.runner!;
      const report = runLifecycle({ expected: { ...paths.expected, finalPrHeadSha: HEAD }, context: 'explicit-recovery', apply: true,
        operations: { ...opts, runner: (invocation) => {
          const response = base(invocation);
          if (invocation.args[0] === 'pr' && invocation.args[1] === 'view') {
            return result({ stdout: JSON.stringify({ ...JSON.parse(response.stdout), headRefName: 'pushed/other-name',
              ...(failure === 'wrong head' ? { headRefOid: OTHER_HEAD } : {}),
              ...(failure === 'unmerged PR' ? { state: 'OPEN' } : {}),
            }) });
          }
          return response;
        } },
      });
      expect(report.outcome).toBe('cleanup_deferred');
      expect(value.removeCount).toBe(0);
    },
  );

  it.each(['explicit-recovery', 'post-merge-cleanup'] as const)(
    'compares pre-existing sibling identities only in %s', (context) => {
      for (const change of ['addition', 'sibling commit', 'Orca activity', 'removed Git sibling', 'removed Orca sibling']) {
        const paths = fixture();
        const value = state({ standardTeardownEffect: 'both-absent',
          standardTeardownResult: result({ stdout: JSON.stringify({ outcome: 'cleanup_complete' }) }) });
        const opts = operations(paths, value);
        const base = opts.runner!;
        const sibling = join(paths.root, 'sibling');
        const added = join(paths.root, 'added');
        const report = runLifecycle({ expected: { ...paths.expected, finalPrHeadSha: HEAD }, context, apply: true,
          operations: { ...opts, runner: (invocation) => {
            const response = base(invocation);
            const after = !value.gitPresent;
            const args = invocation.args;
            if (invocation.command === 'git' && args.includes('worktree') && args.includes('list')) {
              const extra = after && change === 'removed Git sibling' ? ''
                : `\nworktree ${sibling}\nHEAD ${after && change === 'sibling commit' ? 'c'.repeat(40) : OTHER_HEAD}\nbranch refs/heads/${after && change === 'sibling commit' ? 'sibling-next' : 'sibling'}\n`;
              return result({ stdout: response.stdout + extra + (after && change === 'addition'
                ? `\nworktree ${added}\nHEAD ${OTHER_HEAD}\nbranch refs/heads/added\n` : '') });
            }
            if (args[0] === 'worktree' && (args[1] === 'list' || args[1] === 'ps')) {
              const payload = JSON.parse(response.stdout);
              if (!(after && change === 'removed Orca sibling')) payload.result.worktrees.push({
                id: `${REPOSITORY_ID}::${sibling}`, path: sibling, head: after && change === 'sibling commit' ? 'c'.repeat(40) : OTHER_HEAD,
                branch: `refs/heads/${after && change === 'sibling commit' ? 'sibling-next' : 'sibling'}`,
                lastActivityAt: after && change === 'Orca activity' ? 'later' : 'earlier',
                isMainWorktree: false, isArchived: false, agents: [],
              });
              if (after && change === 'addition') payload.result.worktrees.push({
                id: `${REPOSITORY_ID}::${added}`, path: added, head: OTHER_HEAD,
                branch: 'refs/heads/added', isMainWorktree: false, isArchived: false, agents: [],
              });
              return result({ stdout: JSON.stringify(payload) });
            }
            return response;
          } },
        });
        expect(report.outcome, change).toBe(change.startsWith('removed') ? 'task_degraded'
          : context === 'explicit-recovery' ? 'git_only_recovered' : 'cleanup_complete');
        if (change.startsWith('removed')) expect(report.error).toContain(sibling);
      }
    },
  );

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
    expect(value.invocations.some((item) => item.args.includes(
      'headRefName,state,headRefOid,mergeCommit,headRepository,baseRefName',
    ))).toBe(true);
    expect(value.removeCount).toBe(0);
  });

  it('recovers a dead shared lock and blocks a live owner', () => {
    const stalePaths = fixture();
    const staleState = state();
    const staleOps = operations(stalePaths, staleState);
    writeFileSync(staleOps.lockPath!, '99999999\n\nstale-token\n', 'utf8');
    expect(runLifecycle({
      expected: stalePaths.expected,
      context: 'explicit-recovery',
      apply: false,
      operations: staleOps,
    }).outcome).toBe('git_only_recovery_eligible');

    const livePaths = fixture();
    const liveState = state();
    const liveOps = operations(livePaths, liveState);
    writeFileSync(liveOps.lockPath!, `${String(process.pid)}\n`, 'utf8');
    expect(runLifecycle({
      expected: livePaths.expected,
      context: 'explicit-recovery',
      apply: false,
      operations: liveOps,
    }).outcome).toBe('cleanup_deferred');
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
  it('holds one borrowed child token through dual absence read-back', () => {
    const paths = fixture();
    const value = state({ orcaPresent: true, standardTeardownEffect: 'both-absent' });
    const report = runLifecycle({
      expected: { ...paths.expected, finalPrHeadSha: HEAD },
      context: 'post-merge-cleanup',
      apply: true,
      operations: operations(paths, value),
    });

    expect(report).toMatchObject({
      outcome: 'cleanup_complete',
      postClassification: { classification: 'absent' },
    });
    expect(value.childLockTokens).toHaveLength(1);
    expect(value.childLockTokens[0]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('ignores foreign-repository inventory changes during post-effect settlement', () => {
    const paths = fixture();
    const value = state({
      orcaPresent: true,
      foreignOrcaRows: [foreignRow(paths, 'before')],
      foreignOrcaRowsAfterTeardown: [foreignRow(paths, 'after')],
      standardTeardownEffect: 'both-absent',
    });
    const report = runLifecycle({
      expected: { ...paths.expected, finalPrHeadSha: HEAD },
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
      expected: { ...paths.expected, finalPrHeadSha: HEAD },
      context: 'post-merge-cleanup',
      apply: true,
      operations: operations(paths, value),
    });

    expect(report).toMatchObject({
      outcome: 'task_degraded',
      postClassification: { classification: 'orca_only' },
    });
    expect(report.error).toMatch(/did not prove exact absence/);
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
      expected: { ...paths.expected, finalPrHeadSha: HEAD },
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

const PACK_ROOT = dirname(dirname(WRAPPER_PATH));
const PACK_TEARDOWN = join(dirname(WRAPPER_PATH), 'worktree-teardown.ts');

describe('pack-owned lifecycle tool paths', () => {
  it('uses the exact pack gh and explicit normalized target cwd for PR identity and branch ownership', () => {
    const paths = fixture();
    const value = state();
    const opts = operations(paths, value);
    expect(existsSync(join(paths.repo, 'scripts', 'gh'))).toBe(false);

    const identity = readPrIdentity(join(paths.repo, 'unused', '..'), 1300, opts);
    expect(identity).toMatchObject({
      headRefName: BRANCH,
      headRefOid: HEAD,
      state: 'MERGED',
    });

    const report = runLifecycle({
      expected: paths.expected,
      context: 'explicit-recovery',
      apply: false,
      operations: opts,
    });
    expect(report.outcome).toBe('git_only_recovery_eligible');
    expect(report.effects).toEqual([]);

    const ghCalls = value.invocations.filter((call) => call.args[0] === 'pr');
    expect(ghCalls.length).toBeGreaterThanOrEqual(3);
    expect(ghCalls.every((call) => call.command === WRAPPER_PATH && call.cwd === paths.repo)).toBe(true);
    expect(ghCalls).toEqual(expect.arrayContaining([
      {
        command: WRAPPER_PATH,
        args: ['pr', 'view', '1300', '--json', 'headRefName,state,headRefOid,mergeCommit,headRepository,baseRefName'],
        cwd: paths.repo,
      },
      {
        command: WRAPPER_PATH,
        args: [
          'pr', 'list', '--state', 'open', '--json',
          'number,headRefName,headRepository', '--repo', 'chetwerikoff/orchestrator-pack',
        ],
        cwd: paths.repo,
      },
    ]));
  });

  it('spawns the exact pack teardown child from a target that lacks both pack scripts', () => {
    const paths = fixture();
    const value = state({
      orcaPresent: true,
      standardTeardownResult: result({ stdout: JSON.stringify({ outcome: 'cleanup_eligible' }) }),
    });
    expect(existsSync(join(paths.repo, 'scripts', 'gh'))).toBe(false);
    expect(existsSync(join(paths.repo, 'scripts', 'worktree-teardown.ts'))).toBe(false);

    const report = runLifecycle({
      expected: { ...paths.expected, finalPrHeadSha: HEAD },
      context: 'post-merge-cleanup',
      apply: false,
      operations: operations(paths, value),
    });
    expect(report.outcome).toBe('cleanup_eligible');
    expect(report.effects).toEqual([]);

    const children = value.invocations.filter((call) => call.command === process.execPath);
    expect(children).toHaveLength(1);
    const child = children[0]!;
    expect(child.cwd).toBe(paths.repo);
    expect(child.args[0]).toBe('--experimental-strip-types');
    expect(child.args[1]).toBe(PACK_TEARDOWN);
    expect(child.args.slice(child.args.indexOf('--repo-root'), child.args.indexOf('--repo-root') + 2))
      .toEqual(['--repo-root', paths.repo]);
    expect(child.args).toContain('--post-merge-destructive');
    expect(child.args).not.toContain('--apply');
  });

  it('keeps explicit pack-root cwd and intended PR argv when the pack is the target', () => {
    const paths = fixture();
    const packPaths: Paths = {
      ...paths,
      repo: PACK_ROOT,
      expected: { ...paths.expected, repositoryRoot: PACK_ROOT },
    };
    const value = state({
      orcaPresent: false,
      standardTeardownResult: result({ stdout: JSON.stringify({ outcome: 'cleanup_eligible' }) }),
    });
    const opts = operations(packPaths, value);
    expect(readPrIdentity(PACK_ROOT, 1300, opts).state).toBe('MERGED');
    expect(runLifecycle({
      expected: packPaths.expected,
      context: 'explicit-recovery',
      apply: false,
      operations: opts,
    }).outcome).toBe('git_only_recovery_eligible');

    value.orcaPresent = true;
    expect(runLifecycle({
      expected: { ...packPaths.expected, finalPrHeadSha: HEAD },
      context: 'post-merge-cleanup',
      apply: false,
      operations: opts,
    }).outcome).toBe('cleanup_eligible');

    const ghCalls = value.invocations.filter((call) => call.args[0] === 'pr');
    expect(ghCalls.length).toBeGreaterThan(0);
    expect(ghCalls.every((call) => call.command === WRAPPER_PATH && call.cwd === PACK_ROOT)).toBe(true);
    expect(ghCalls.some((call) => call.args.join(' ') ===
      'pr view 1300 --json headRefName,state,headRefOid,mergeCommit,headRepository,baseRefName')).toBe(true);
    const child = value.invocations.find((call) => call.command === process.execPath)!;
    expect(child.args[1]).toBe(PACK_TEARDOWN);
    expect(child.cwd).toBe(PACK_ROOT);
    expect(child.args.slice(child.args.indexOf('--repo-root'), child.args.indexOf('--repo-root') + 2))
      .toEqual(['--repo-root', PACK_ROOT]);
    expect(value.removeCount).toBe(0);
  });
});

describe('process census (Issue #2782)', () => {
const TARGET = '/work/issue-1';

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

function stat(ppid: number): string {
  // pid (comm) state ppid ... starttime is field index 19 after ") "
  const fields = Array.from({ length: 22 }, (_, index) => String(index));
  fields[0] = 'S';
  fields[1] = String(ppid);
  fields[19] = '777';
  return `1 (x) ${fields.join(' ')}`;
}

interface FakeProc {
  readonly ppid: number;
  readonly cwd: string | Error;
  readonly fds?: readonly (string | Error)[] | Error;
}

function fakeIo(table: Record<string, FakeProc>): ProcIo {
  return {
    readdirSync(path) {
      if (path === '/proc') return Object.keys(table);
      const match = /^\/proc\/(\d+)\/fd$/.exec(path);
      const fds = match ? table[match[1]!]?.fds : undefined;
      if (fds instanceof Error) throw fds;
      if (!fds) return [];
      return fds.map((_, index) => String(index));
    },
    readFileSync(path) {
      const match = /^\/proc\/(\d+)\/stat$/.exec(path);
      const row = match ? table[match[1]!] : undefined;
      if (!row) throw errno('ENOENT');
      return stat(row.ppid);
    },
    readlinkSync(path) {
      const cwd = /^\/proc\/(\d+)\/cwd$/.exec(path);
      if (cwd) {
        const value = table[cwd[1]!]!.cwd;
        if (value instanceof Error) throw value;
        return value;
      }
      const fd = /^\/proc\/(\d+)\/fd\/(\d+)$/.exec(path)!;
      const value = (table[fd[1]!]!.fds as readonly (string | Error)[])[Number(fd[2])]!;
      if (value instanceof Error) throw value;
      return value;
    },
  };
}

describe('process census with unreadable observations', () => {
  const table: Record<string, FakeProc> = {
    '10': { ppid: 1, cwd: errno('EACCES') },
    '11': { ppid: 1, cwd: errno('EPERM'), fds: errno('EACCES') },
    '12': { ppid: 1, cwd: '/elsewhere' },
    '13': { ppid: 1, cwd: `${TARGET}/sub` },
    '14': { ppid: 1, cwd: '/elsewhere', fds: [`${TARGET}/file.log`] },
    '15': { ppid: 13, cwd: '/elsewhere' },
  };

  it('operations census counts denied cwd/fd reads and keeps real holders', () => {
    const result = collectProcessCensus(TARGET, fakeIo(table));
    expect(result.observations).toMatchObject({ unreadableCwd: 2, unreadableFd: 1 });
    expect(result.observations.unreadable?.map((row) => row.pid)).toEqual([10, 11]);
    expect(result.processes.map((row) => row.pid)).toEqual([13, 14, 15]);
    expect(result.processes.find((row) => row.pid === 14)?.fd).toBe(`${TARGET}/file.log`);
  });

  it('operations census still throws on a non-permission cwd error', () => {
    const io = fakeIo({ '20': { ppid: 1, cwd: errno('EIO') } });
    expect(() => collectProcessCensus(TARGET, io)).toThrow(/could not read \/proc\/20\/cwd/);
  });

  it('operations census reports no holder and the denied count when only denied reads exist', () => {
    const result = collectProcessCensus(TARGET, fakeIo({ '10': table['10']! }));
    expect(result.processes).toEqual([]);
    expect(result.observations.unreadableCwd).toBe(1);
  });

  it.each(['EACCES', 'EPERM'])('reports kernel-denied %s reads without counting a holder, regardless of uid', (code) => {
    const result = collectProcessCensus(TARGET, fakeIo({
      '20': { ppid: 1, cwd: errno(code) },
    }));
    expect(result.processes).toEqual([]);
    expect(result.observations.unreadable).toMatchObject([{ pid: 20, cwdDenied: true }]);
  });

  it('lists kernel-denied fd enumeration as unreadable', () => {
    const result = collectProcessCensus(TARGET, fakeIo({
      '20': { ppid: 1, cwd: '/elsewhere', fds: errno('EACCES') },
    }));
    expect(result.processes).toEqual([]);
    expect(result.observations.unreadable).toMatchObject([{ pid: 20, fdDenied: true }]);
  });

  it.each(['ENOENT', 'ESRCH'])('skips a vanished pid (%s)', (code) => {
    const io = fakeIo({ '20': { ppid: 1, cwd: errno(code) } });
    expect(collectProcessCensus(TARGET, io).processes).toEqual([]);
    expect(defaultProcessCensus(TARGET, io)).toEqual([]);
  });

  it('keeps readable fd holders and their descendants despite a denied cwd', () => {
    const result = collectProcessCensus(TARGET, fakeIo({
      '20': { ppid: 1, cwd: errno('EACCES'), fds: [`${TARGET}/held`] },
      '21': { ppid: 20, cwd: '/elsewhere' },
    }));
    expect(result.processes.map((row) => row.pid)).toEqual([20, 21]);
  });

  it('reports denied individual fd links but still detects a later readable holder', () => {
    const io = fakeIo({
      '20': { ppid: 1, cwd: '/elsewhere', fds: [errno('EACCES'), `${TARGET}/held`] },
    });
    const result = collectProcessCensus(TARGET, io);
    expect(result.processes).toMatchObject([{ pid: 20, fd: `${TARGET}/held` }]);
    expect(result.observations.unreadable).toMatchObject([{ pid: 20, fdDenied: true }]);
    expect(defaultProcessCensus(TARGET, io)).toMatchObject([{ pid: 20, fdDenied: true, fd: `${TARGET}/held` }]);
  });

  it('teardown census marks denied cwd/fd and keeps readable fd holders', () => {
    const rows = defaultProcessCensus(TARGET, fakeIo(table));
    expect(rows.filter((row) => row.cwdDenied).map((row) => row.pid)).toEqual([10, 11]);
    expect(rows.filter((row) => row.fdDenied).map((row) => row.pid)).toEqual([11]);
    expect(rows.find((row) => row.pid === 14)?.fd).toBe(`${TARGET}/file.log`);
    expect(rows.find((row) => row.pid === 13)?.cwd).toBe(`${TARGET}/sub`);
  });

  it('both censuses see a real open file descriptor under the target', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'census-fd-')));
    try {
      mkdirSync(join(dir, 'tree'));
      const fd = openSync(join(dir, 'tree', 'held.txt'), 'w');
      try {
        const target = join(dir, 'tree');
        // Exercise real fd links without depending on access to unrelated host processes.
        const io: ProcIo = {
          readdirSync: (path) => path === '/proc' ? [String(process.pid)] : readdirSync(path),
          readFileSync,
          readlinkSync,
        };
        const own = collectProcessCensus(target, io).processes.find((row) => row.pid === process.pid);
        expect(own?.fd).toBe(join(target, 'held.txt'));
        const teardown = defaultProcessCensus(target, io).find((row) => row.pid === process.pid);
        expect(teardown?.fd).toBe(join(target, 'held.txt'));
      } finally {
        closeSync(fd);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
});

describe('merge cleanup (Issue #2782)', () => {
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sh(cwd: string, ...args: string[]): string {
  const result = runProcessSync({ command: 'git', args, cwd, inheritParentEnv: true, timeoutMs: 60_000 });
  if (!result.ok) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

const LOCAL_CONFIG = '.claude/skills/discuss-with-gpt/local.config.json';

interface Fixture {
  readonly primary: string;
  readonly own: string;
  readonly manager: string;
  readonly smoke: string;
  readonly unrelated: string;
  readonly git: GitRunner;
}

function fixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'merge-cleanup-')));
  roots.push(root);
  const primary = join(root, 'primary');
  mkdirSync(primary);
  sh(primary, 'init', '-q', '-b', 'main');
  sh(primary, 'config', 'user.email', 't@example.com');
  sh(primary, 'config', 'user.name', 't');
  writeFileSync(join(primary, '.gitignore'), '.env\n.claude/skills/discuss-with-gpt/local.config.json\n');
  writeFileSync(join(primary, 'a.txt'), 'a');
  sh(primary, 'add', '-A');
  sh(primary, 'commit', '-qm', 'init');
  writeFileSync(join(primary, '.env'), 'SECRET=1\n');
  mkdirSync(join(primary, '.claude/skills/discuss-with-gpt'), { recursive: true });
  writeFileSync(join(primary, LOCAL_CONFIG), '{"a":1}\n');
  const make = (name: string): string => {
    const path = join(root, name);
    sh(primary, 'worktree', 'add', '-q', '--detach', path);
    return path;
  };
  const own = make('own');
  const manager = make('manager');
  const smoke = make('smoke');
  const unrelated = make('unrelated');
  for (const tree of [manager, smoke, unrelated]) {
    writeFileSync(join(tree, '.env'), 'SECRET=1\n');
    mkdirSync(join(tree, '.claude/skills/discuss-with-gpt'), { recursive: true });
    writeFileSync(join(tree, LOCAL_CONFIG), '{"a":1}\n');
  }
  const git: GitRunner = (args) => {
    const result = runProcessSync({
      command: 'git', args: ['-C', primary, ...args], inheritParentEnv: true, timeoutMs: 60_000,
    });
    return { ok: result.ok, stdout: result.stdout, stderr: result.stderr };
  };
  return { primary, own, manager, smoke, unrelated, git };
}

function deps(fx: Fixture, overrides: Partial<MergeCleanupDeps> = {}, log: string[] = []): MergeCleanupDeps {
  return {
    git: fx.git,
    holders: () => ({ holders: 0, unreadableCwd: 0, unreadableFd: 0 }),
    orcaState: () => ({ known: false, agents: 0, terminals: 0 }),
    removeTree: (path) => {
      log.push(`remove:${path}`);
      const result = fx.git(['worktree', 'remove', path]);
      return { ok: result.ok, detail: result.stderr };
    },
    send: (handle, text) => {
      log.push(`send:${handle}:${text}`);
      return { ok: true, detail: 'sent' };
    },
    ...overrides,
  };
}

describe('removeIdenticalLaunchCopies', () => {
  const generated = 'APP_ENV=development\nCOMPOSE_PROJECT_NAME=leopoker_issue_333_abcdef12\nPOSTGRES_USER=leopoker\nPOSTGRES_PASSWORD=leopoker\nPOSTGRES_DB=leopoker\nPOSTGRES_HOST=localhost\nPOSTGRES_PORT=54321\nDATABASE_URL=postgresql+psycopg://leopoker:leopoker@localhost:54321/leopoker\nHERO_CONFIG__PLAYER_NAME=\n';

  it.each([generated, 'APPLIEDIN_WEB_PORT=9123\n'])('removes exact setup-generated env with no primary copy', (content) => {
    const fx = fixture();
    rmSync(join(fx.primary, '.env'));
    writeFileSync(join(fx.manager, '.env'), content);
    const result = removeIdenticalLaunchCopies(fx.manager, fx.primary, fx.git);
    expect(result.removed).toContain('.env');
    expect(result.preserved).toEqual([]);
    expect(existsSync(join(fx.manager, '.env'))).toBe(false);
  });

  it.each([
    generated.replace('APP_ENV=development', 'APP_ENV=production'),
    `${generated}USER_DATA=keep\n`,
    generated.replace('localhost:54321/', 'localhost:54322/'),
    generated.replace('POSTGRES_DB=leopoker\n', ''),
    `${generated}\n`,
    'APPLIEDIN_WEB_PORT=9123\nUSER_DATA=keep\n',
    'APPLIEDIN_WEB_PORT=9123',
    'APPLIEDIN_WEB_PORT=8788\n',
  ])('preserves env with edited, extra or missing content', (content) => {
    const fx = fixture();
    rmSync(join(fx.primary, '.env'));
    writeFileSync(join(fx.manager, '.env'), content);
    expect(removeIdenticalLaunchCopies(fx.manager, fx.primary, fx.git).preserved)
      .toEqual([{ path: '.env', reason: 'primary_copy_missing' }]);
    expect(readFileSync(join(fx.manager, '.env'), 'utf8')).toBe(content);
  });

  it('removes byte-identical ignored copies and preserves differing ones', () => {
    const fx = fixture();
    writeFileSync(join(fx.manager, '.env'), 'SECRET=changed\n');
    const result = removeIdenticalLaunchCopies(fx.manager, fx.primary, fx.git);
    expect(result.removed).toEqual([LOCAL_CONFIG]);
    expect(result.preserved).toEqual([{ path: '.env', reason: 'differs_from_primary' }]);
    expect(existsSync(join(fx.manager, '.env'))).toBe(true);
    expect(existsSync(join(fx.manager, LOCAL_CONFIG))).toBe(false);
  });

  it('preserves a copy whose primary counterpart is missing', () => {
    const fx = fixture();
    rmSync(join(fx.primary, '.env'));
    const result = removeIdenticalLaunchCopies(fx.manager, fx.primary, fx.git);
    expect(result.preserved).toEqual([{ path: '.env', reason: 'primary_copy_missing' }]);
    expect(existsSync(join(fx.manager, '.env'))).toBe(true);
  });
});

describe('runMergeCleanup', () => {
  it('removes every exact listed tree, keeps primary, own and unrelated trees, then reports MERGED after cleanup', () => {
    const fx = fixture();
    const log: string[] = [];
    const report = runMergeCleanup(
      {
        primaryRoot: fx.primary,
        ownWorktree: fx.own,
        listed: [fx.manager, fx.smoke, fx.own, join(fx.primary, '..', 'gone-already')],
        prNumber: 2758,
        mergeSha: 'abc123',
        orchestratorHandle: 'term_orch',
      },
      deps(fx, {}, log),
    );
    expect(report.blockers).toEqual([]);
    expect(report.message).toBe('MERGED 2758 abc123');
    expect(report.delivery.ok).toBe(true);
    expect(existsSync(fx.manager)).toBe(false);
    expect(existsSync(fx.smoke)).toBe(false);
    expect(existsSync(fx.unrelated)).toBe(true);
    expect(existsSync(fx.own)).toBe(true);
    expect(existsSync(fx.primary)).toBe(true);
    expect(report.trees.map((tree) => tree.status)).toEqual(['removed', 'removed', 'excluded_own_worktree', 'already_absent']);
    expect(report.trees[0]?.launchCopies?.removed).toEqual(['.env', LOCAL_CONFIG]);
    // the message is sent only after both removals
    expect(log.map((entry) => entry.split(':')[0])).toEqual(['remove', 'remove', 'send']);
    expect(report.order[report.order.length - 1]).toBe('send');
  });

  it('preserves a held tree and reports the exact blocker instead of MERGED', () => {
    const fx = fixture();
    const log: string[] = [];
    const report = runMergeCleanup(
      {
        primaryRoot: fx.primary,
        ownWorktree: fx.own,
        listed: [fx.manager, fx.smoke],
        prNumber: 9,
        mergeSha: 'def456',
        orchestratorHandle: 'term_orch',
      },
      deps(fx, {
        holders: (path) => (path === fx.smoke
          ? { holders: 2, unreadableCwd: 3, unreadableFd: 1 }
          : { holders: 0, unreadableCwd: 3, unreadableFd: 0 }),
      }, log),
    );
    expect(existsSync(fx.smoke)).toBe(true);
    expect(existsSync(join(fx.smoke, '.env'))).toBe(true);
    expect(existsSync(fx.manager)).toBe(false);
    expect(report.message).toMatch(/^CLEANUP_BLOCKED 9 def456 merged; .*smoke: 2 live process/);
    expect(report.message).not.toMatch(/[`!]/);
    expect(report.trees[1]?.unreadableProcessObservations).toEqual({ cwd: 3, fd: 1 });
    expect(log[log.length - 1]).toMatch(/^send:term_orch:CLEANUP_BLOCKED/);
  });

  it('never removes the primary checkout or an unlisted path named in the spec', () => {
    const fx = fixture();
    const report = runMergeCleanup(
      {
        primaryRoot: fx.primary,
        ownWorktree: fx.own,
        listed: [fx.primary, fx.primary],
        prNumber: 1,
        mergeSha: 's',
        orchestratorHandle: 'h',
      },
      deps(fx),
    );
    expect(existsSync(fx.primary)).toBe(true);
    expect(report.blockers).toHaveLength(1);
    expect(report.message).toMatch(/^CLEANUP_BLOCKED/);
  });

  it('does not bypass an Orca refusal with Git: Orca-known tree is preserved when Orca refuses', () => {
    const fx = fixture();
    const log: string[] = [];
    const report = runMergeCleanup(
      { primaryRoot: fx.primary, ownWorktree: fx.own, listed: [fx.manager], prNumber: 5, mergeSha: 's5', orchestratorHandle: 'h' },
      deps(fx, {
        orcaState: () => ({ known: true, agents: 0, terminals: 0 }),
        removeTree: (path, orcaKnown) => {
          log.push(`remove:${path}:${String(orcaKnown)}`);
          return { ok: false, detail: 'orca refused: active agent check' };
        },
      }, log),
    );
    expect(existsSync(fx.manager)).toBe(true);
    expect(log[0]).toBe(`remove:${fx.manager}:true`);
    expect(report.message).toMatch(/^CLEANUP_BLOCKED 5 s5 merged; .*orca refused/);
  });

  it('preserves a tree with a live Orca agent or an incomplete Orca inventory', () => {
    const fx = fixture();
    const report = runMergeCleanup(
      { primaryRoot: fx.primary, ownWorktree: fx.own, listed: [fx.manager, fx.smoke], prNumber: 6, mergeSha: 's6', orchestratorHandle: 'h' },
      deps(fx, {
        orcaState: (path) => {
          if (path === fx.manager) return { known: true, agents: 1, terminals: 0 };
          throw new Error('orca worktree ps is truncated');
        },
      }),
    );
    expect(existsSync(fx.manager)).toBe(true);
    expect(existsSync(fx.smoke)).toBe(true);
    expect(report.blockers.join('|')).toMatch(/1 live Orca agent/);
    expect(report.blockers.join('|')).toMatch(/inventory unavailable or incomplete: orca worktree ps is truncated/);
  });

  it('keeps going and still sends exactly one blocker line when a tree throws', () => {
    const fx = fixture();
    const log: string[] = [];
    const report = runMergeCleanup(
      { primaryRoot: fx.primary, ownWorktree: fx.own, listed: [fx.manager, fx.smoke], prNumber: 7, mergeSha: 's7', orchestratorHandle: 'h' },
      deps(fx, {
        holders: (path) => {
          if (path === fx.manager) throw new Error('process census could not read /proc/9/cwd: EIO');
          return { holders: 0, unreadableCwd: 0, unreadableFd: 0 };
        },
      }, log),
    );
    expect(existsSync(fx.manager)).toBe(true);
    expect(existsSync(fx.smoke)).toBe(false);
    expect(log.filter((entry) => entry.startsWith('send:'))).toHaveLength(1);
    expect(report.message).toMatch(/^CLEANUP_BLOCKED 7 s7 merged; .*unexpected error, tree preserved: process census could not read/);
  });

  it('preserves a tree whose differing launch copy remains instead of removing it', () => {
    const fx = fixture();
    writeFileSync(join(fx.manager, '.env'), 'LOCAL_ONLY=1\n');
    const report = runMergeCleanup(
      { primaryRoot: fx.primary, ownWorktree: fx.own, listed: [fx.manager], prNumber: 8, mergeSha: 's8', orchestratorHandle: 'h' },
      deps(fx),
    );
    expect(existsSync(join(fx.manager, '.env'))).toBe(true);
    expect(report.message).toMatch(/launch copy kept: \.env \(differs_from_primary\)/);
  });

  it('does not claim delivery when the send fails', () => {
    const fx = fixture();
    const report = runMergeCleanup(
      {
        primaryRoot: fx.primary,
        ownWorktree: fx.own,
        listed: [fx.manager],
        prNumber: 1,
        mergeSha: 's',
        orchestratorHandle: 'h',
      },
      deps(fx, { send: () => ({ ok: false, detail: 'pane gone' }) }),
    );
    expect(report.delivery).toEqual({ ok: false, detail: 'pane gone' });
  });
});
});
