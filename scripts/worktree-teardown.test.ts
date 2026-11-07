// @vitest-ci-lane light
// @vitest-pre-topology-seconds 120

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProcessResult } from './kernel/subprocess.ts';
import { WRAPPER_PATH } from './lib/gh-resolve-real-binary.mjs';
import {
  parseDiscardEntries,
  defaultProcessCensus,
  runPostMergeTeardown,
  validateForceRemovalHelp,
  type CommandInvocation,
  type PostMergeTeardownArgs,
} from './worktree-teardown.ts';

const H0 = 'a'.repeat(40);
const H1 = 'b'.repeat(40);
const H2 = 'c'.repeat(40);
const MERGE = 'd'.repeat(40);
const MAIN = 'e'.repeat(40);
const BRANCH = 'agent/issue-1328';
const roots: string[] = [];

describe('shared process census (Issue #2801)', () => {
  it.each(['EACCES', 'EPERM'])('lists kernel-denied %s processes, keeps readable holders and skips exited pids', (code) => {
    const denied = Object.assign(new Error(code), { code });
    const gone = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const rows = defaultProcessCensus('/work/target', {
      readdirSync: (path) => path === '/proc' ? ['1368', '2000', '3000'] : ['1', '2'],
      readFileSync: () => `1 (systemd --user) S 1 ${Array(17).fill('0').join(' ')} 777`,
      readlinkSync: (path) => {
        if (path.startsWith('/proc/1368/')) throw denied;
        if (path.startsWith('/proc/3000/')) throw gone;
        if (path.endsWith('/cwd')) return '/elsewhere';
        if (path.endsWith('/1')) throw denied;
        return '/work/target/held';
      },
    });
    expect(rows).toMatchObject([
      { pid: 1368, cwd: null, cwdDenied: true, fdDenied: true },
      { pid: 2000, fd: '/work/target/held', fdDenied: true },
    ]);
    expect(rows).toHaveLength(2);
  });
});

function result(input: Partial<ProcessResult> = {}): ProcessResult {
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

interface Fixture {
  readonly root: string;
  readonly repo: string;
  readonly target: string;
  readonly common: string;
  readonly args: PostMergeTeardownArgs;
}

function fixture(classification: 'exact_dual' | 'exact_git_only' = 'exact_dual'): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'opk-1328-teardown-'));
  roots.push(root);
  const repo = join(root, 'repo');
  const target = join(root, 'worktrees', 'issue-1328');
  const common = join(repo, '.git');
  const gitdir = join(common, 'worktrees', 'issue-1328');
  mkdirSync(gitdir, { recursive: true });
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, '.git'), `gitdir: ${gitdir}\n`, 'utf8');
  return {
    root,
    repo,
    target,
    common,
    args: {
      destructive: true,
      repositoryRoot: repo,
      worktree: target,
      pr: 1329,
      initialHead: H0,
      finalPrHead: H1,
      expectedBranch: BRANCH,
      detached: false,
      classification,
      apply: false,
      json: true,
      lifecycleLockPath: join(root, 'lifecycle.lock'),
      lifecycleLockToken: null,
    },
  };
}

interface State {
  gitPresent: boolean;
  orcaPresent: boolean;
  targetHead: string;
  branchOid: string | null;
  active: boolean;
  targetProcessAlive: boolean;
  residualProcess: boolean;
  validHelp: boolean;
  targetDriftsAfterQuiescence: boolean;
  manifestChanges: boolean;
  identityReads: number;
  statusReads: number;
  terminals: Array<{ handle: string; worktreePath: string; tabId?: string }>;
  invocations: CommandInvocation[];
  signalled: Array<{ pid: number; signal: NodeJS.Signals }>;
}

function defaultState(paths: Fixture): State {
  return {
    gitPresent: true,
    orcaPresent: paths.args.classification === 'exact_dual',
    targetHead: H0,
    branchOid: H0,
    active: true,
    targetProcessAlive: true,
    residualProcess: false,
    validHelp: true,
    targetDriftsAfterQuiescence: false,
    manifestChanges: false,
    identityReads: 0,
    statusReads: 0,
    terminals: [
      { handle: 'target-pane', worktreePath: paths.target, tabId: 'mixed-tab' },
      { handle: 'main-pane', worktreePath: paths.repo, tabId: 'mixed-tab' },
    ],
    invocations: [],
    signalled: [],
  };
}

function gitInventory(paths: Fixture, state: State): string {
  return [
    `worktree ${paths.repo}`,
    `HEAD ${MAIN}`,
    'branch refs/heads/main',
    '',
    ...(state.gitPresent ? [
      `worktree ${paths.target}`,
      `HEAD ${state.targetHead}`,
      `branch refs/heads/${BRANCH}`,
      '',
    ] : []),
  ].join('\n');
}

function runtimeWorktrees(paths: Fixture, state: State, includeAgents: boolean): object[] {
  return [
    {
      id: `repo::${paths.repo}`,
      path: paths.repo,
      head: MAIN,
      branch: 'refs/heads/main',
      isMainWorktree: true,
      isArchived: false,
      ...(includeAgents ? { agents: [] } : {}),
    },
    ...(state.orcaPresent ? [{
      id: `repo::${paths.target}`,
      path: paths.target,
      head: state.targetHead,
      branch: `refs/heads/${BRANCH}`,
      linkedPR: 1329,
      isMainWorktree: false,
      isArchived: false,
      ...(includeAgents
        ? { agents: state.active ? [{ state: 'working', interrupted: true }] : [] }
        : {}),
    }] : []),
  ];
}

function runner(paths: Fixture, state: State) {
  return (invocation: CommandInvocation): ProcessResult => {
    state.invocations.push(invocation);
    const args = [...invocation.args];

    if (invocation.command.endsWith('/scripts/gh') && args[0] === 'pr' && args[1] === 'view') {
      return result({
        stdout: JSON.stringify({
          headRefName: BRANCH,
          state: 'MERGED',
          headRefOid: H1,
          mergeCommit: { oid: MERGE },
          headRepository: { nameWithOwner: 'chetwerikoff/orchestrator-pack' },
          baseRefName: 'main',
        }),
      });
    }
    if (invocation.command.endsWith('/scripts/gh') && args[0] === 'pr' && args[1] === 'list') {
      return result({ stdout: '[]' });
    }

    if (invocation.command === 'git' && args.includes('worktree') && args.includes('list')) {
      return result({ stdout: gitInventory(paths, state) });
    }
    if (invocation.command === 'git' && args.includes('--git-common-dir')) {
      return result({ stdout: `${paths.common}\n` });
    }
    if (invocation.command === 'git' && args.includes('rev-parse') && args.at(-1) === 'HEAD') {
      state.identityReads += 1;
      if (state.targetDriftsAfterQuiescence && state.identityReads >= 2) state.targetHead = H2;
      return result({ stdout: `${state.targetHead}\n` });
    }
    if (invocation.command === 'git' && args.includes('symbolic-ref')) {
      return result({ stdout: `${BRANCH}\n` });
    }
    if (invocation.command === 'git' && args.includes('fetch')) return result();
    if (invocation.command === 'git' && args.includes('merge-base')) return result();
    if (invocation.command === 'git' && args.includes('status')) {
      if (args.includes('-z')) {
        state.statusReads += 1;
        const suffix = state.manifestChanges && state.statusReads >= 2 ? '?? late.txt\0' : '';
        return result({ stdout: ` M tracked.txt\0?? untracked.txt\0${suffix}` });
      }
      return result({ stdout: ' M tracked.txt\n?? untracked.txt\n' });
    }
    if (invocation.command === 'git' && args.includes('ls-files')) {
      return result({ stdout: 'private-cache/token.txt\0node_modules/pkg/index.js\0' });
    }
    if (invocation.command === 'git' && args.includes('worktree') && args.includes('remove')) {
      expect(args).toContain('--force');
      state.gitPresent = false;
      return result();
    }
    if (invocation.command === 'git' && args.includes('rev-parse') && args.includes('--verify')) {
      return state.branchOid ? result({ stdout: `${state.branchOid}\n` }) : result({ ok: false, exitCode: 1 });
    }
    if (invocation.command === 'git' && args.includes('update-ref') && args.includes('-d')) {
      const expected = args.at(-1);
      if (state.branchOid === expected) {
        state.branchOid = null;
        return result();
      }
      return result({ ok: false, exitCode: 1, stderr: 'compare-and-delete refused' });
    }

    if (args[0] === 'worktree' && args[1] === 'list') {
      return result({
        stdout: JSON.stringify({ ok: true, result: { worktrees: runtimeWorktrees(paths, state, false) } }),
      });
    }
    if (args[0] === 'worktree' && args[1] === 'ps') {
      return result({
        stdout: JSON.stringify({ ok: true, result: { worktrees: runtimeWorktrees(paths, state, true) } }),
      });
    }
    if (args[0] === 'terminal' && args[1] === 'list') {
      return result({ stdout: JSON.stringify({ ok: true, result: { terminals: state.terminals } }) });
    }
    if (args[0] === 'terminal' && args[1] === 'stop') {
      return result({ stdout: JSON.stringify({ ok: true, result: { stopped: 1 } }) });
    }
    if (args[0] === 'terminal' && args[1] === 'close') {
      const handle = args[args.indexOf('--terminal') + 1];
      state.terminals = state.terminals.filter((terminal) => terminal.handle !== handle);
      return result({ stdout: JSON.stringify({ ok: true, result: { closed: true } }) });
    }
    if (args[0] === 'worktree' && args[1] === 'rm' && args.includes('--help')) {
      return result({
        stdout: state.validHelp
          ? 'usage: orca worktree rm --worktree <selector> [--force] [--json]'
          : 'usage: orca worktree rm --worktree <selector> [--json]',
      });
    }
    if (args[0] === 'worktree' && args[1] === 'rm' && args.includes('--force')) {
      state.gitPresent = false;
      state.orcaPresent = false;
      state.active = false;
      return result({ stdout: JSON.stringify({ ok: true, result: { removed: true } }) });
    }

    throw new Error(`unexpected invocation: ${invocation.command} ${args.join(' ')}`);
  };
}

function dependencies(paths: Fixture, state: State) {
  return {
    runner: runner(paths, state),
    processCensus: () => state.targetProcessAlive || state.residualProcess
      ? [{ pid: 4242, ppid: 1, starttime: '7', cwd: paths.target }]
      : [],
    signalProcess: (pid: number, _starttime: string, signal: NodeJS.Signals) => {
      state.signalled.push({ pid, signal });
      if (!state.residualProcess) state.targetProcessAlive = false;
      return true;
    },
    sleep: async () => {},
    now: () => new Date('2026-08-05T07:00:00.000Z'),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('post-merge destructive teardown', () => {
  it.each(['fork/source', 'upstream/base', 'another/fork'])(
    'preserves a differently named local branch backing an open upstream PR from %s', async (source) => {
      const paths = fixture();
      const state = defaultState(paths);
      const deps = dependencies(paths, state);
      const base = deps.runner;
      const report = await runPostMergeTeardown({ ...paths.args, apply: true }, {
        ...deps,
        runner: (invocation) => {
          const response = base(invocation);
          if (invocation.args[0] === 'pr' && invocation.args[1] === 'view') {
            return result({ stdout: JSON.stringify({ ...JSON.parse(response.stdout),
              headRefName: 'fork/source-A', headRepository: { nameWithOwner: 'fork/source' } }) });
          }
          if (invocation.args[0] === 'pr' && invocation.args[1] === 'list') {
            // The source fork has no PRs based there; the PR from local B is
            // visible only in readPr's upstream/base repository context.
            if (invocation.args.includes('--repo')) return result({ stdout: '[]' });
            expect(invocation.cwd).toBe(paths.repo);
            return result({ stdout: JSON.stringify([{ number: 1330, headRefName: BRANCH,
              headRepository: { nameWithOwner: source } }]) });
          }
          return response;
        },
      });
      expect(report.outcome).toBe('cleanup_deferred');
      expect(state.gitPresent).toBe(true);
      expect(state.branchOid).toBe(H0);
      expect(state.invocations.some((item) => item.args.includes('update-ref'))).toBe(false);
      expect(state.invocations.filter((item) => item.args[0] === 'pr' && item.args[1] === 'list'))
        .not.toContainEqual(expect.objectContaining({ args: expect.arrayContaining(['--repo', 'fork/source']) }));
    },
  );

  it('cleans the explicitly bound local branch when the PR source branch has a different name', async () => {
    const paths = fixture();
    const state = defaultState(paths);
    const deps = dependencies(paths, state);
    const base = deps.runner;
    const report = await runPostMergeTeardown({ ...paths.args, apply: true }, {
      ...deps,
      runner: (invocation) => {
        const response = base(invocation);
        if (invocation.args[0] === 'pr' && invocation.args[1] === 'view') {
          return result({ stdout: JSON.stringify({ ...JSON.parse(response.stdout), headRefName: 'pushed/source-branch',
            headRepository: { nameWithOwner: 'fork/source' } }) });
        }
        return response;
      },
    });
    expect(report).toMatchObject({ outcome: 'cleanup_complete', branchDeletion: { decision: 'deleted', expectedOid: H0 } });
    expect(state.invocations).toContainEqual({ command: 'git', args: ['-C', paths.repo, 'update-ref', '-d', `refs/heads/${BRANCH}`, H0] });
  });

  it.each(['wrong head', 'unmerged PR', 'open PR owns local branch'])(
    'preserves the bound tree when %s, even with a differently named PR source', async (failure) => {
      const paths = fixture();
      const state = defaultState(paths);
      const deps = dependencies(paths, state);
      const base = deps.runner;
      const report = await runPostMergeTeardown({ ...paths.args, apply: true }, {
        ...deps,
        runner: (invocation) => {
          const response = base(invocation);
          if (invocation.args[0] === 'pr' && invocation.args[1] === 'view') {
            return result({ stdout: JSON.stringify({
              ...JSON.parse(response.stdout), headRefName: 'pushed/source-branch',
              ...(failure === 'wrong head' ? { headRefOid: H2 } : {}),
              ...(failure === 'unmerged PR' ? { state: 'OPEN' } : {}),
            }) });
          }
          if (failure === 'open PR owns local branch' && invocation.args[0] === 'pr' && invocation.args[1] === 'list') {
            return result({ stdout: JSON.stringify([{ number: 1330, headRefName: BRANCH }]) });
          }
          return response;
        },
      });
      expect(report.outcome).toBe('cleanup_deferred');
      expect(state.gitPresent).toBe(true);
      expect(state.invocations.some((item) => item.args.includes('update-ref'))).toBe(false);
    },
  );

  it.each(['addition', 'sibling commit', 'Orca activity', 'removed Git sibling', 'removed Orca sibling'])(
    'checks sibling identity presence rather than full rows: %s', async (change) => {
      const paths = fixture();
      const state = defaultState(paths);
      const deps = dependencies(paths, state);
      const base = deps.runner;
      const sibling = join(paths.root, 'sibling');
      const added = join(paths.root, 'new-sibling');
      const report = await runPostMergeTeardown({ ...paths.args, apply: true }, {
        ...deps,
        runner: (invocation) => {
          const response = base(invocation);
          const after = !state.gitPresent;
          const args = invocation.args;
          if (invocation.command === 'git' && args.includes('worktree') && args.includes('list')) {
            const extra = after && change === 'removed Git sibling' ? ''
              : `\nworktree ${sibling}\nHEAD ${after && change === 'sibling commit' ? H2 : H0}\nbranch refs/heads/sibling\n`;
            return result({ stdout: response.stdout + extra + (after && change === 'addition'
              ? `\nworktree ${added}\nHEAD ${H2}\nbranch refs/heads/added\n` : '') });
          }
          if (args[0] === 'worktree' && args[1] === 'list') {
            const value = JSON.parse(response.stdout);
            if (!(after && change === 'removed Orca sibling')) {
              value.result.worktrees.push({ id: `repo::${sibling}`, path: sibling,
                head: after && change === 'sibling commit' ? H2 : H0,
                lastActivityAt: after && change === 'Orca activity' ? 'later' : 'earlier',
                comment: after ? 'working' : '', isUnread: after });
            }
            if (after && change === 'addition') value.result.worktrees.push({ id: `repo::${added}`, path: added });
            return result({ stdout: JSON.stringify(value) });
          }
          return response;
        },
      });
      const missing = change.startsWith('removed');
      expect(report.outcome).toBe(missing ? 'task_degraded' : 'cleanup_complete');
      expect(report.readback).toMatchObject({ gitAbsent: true, orcaAbsent: true, unrelatedInventoryStable: !missing,
        missingUnrelatedPaths: missing ? [sibling] : [] });
      if (missing) expect(report.error).toContain(sibling);
    },
  );

  it('accepts H0 target, H1 merged PR, active agents, dirty files, and a moving main', async () => {
    const paths = fixture();
    const state = defaultState(paths);
    const report = await runPostMergeTeardown(paths.args, dependencies(paths, state));

    expect(report).toMatchObject({
      outcome: 'cleanup_eligible',
      preflight: {
        exactIdentity: true,
        mergedPr: true,
        runtimeCapability: 'supported',
        dirty: true,
        activeOrInterrupted: true,
      },
    });
    expect(report.authority.authorizedHeads).toEqual([H0, H1]);
    expect(state.invocations.some((item) => item.args.includes(
      'headRefName,state,headRefOid,mergeCommit,headRepository,baseRefName',
    ))).toBe(true);
    expect(report.manifest?.entries).toEqual([
      { category: 'ignored', path: 'private-cache/token.txt' },
      { category: 'tracked', path: 'tracked.txt' },
      { category: 'untracked', path: 'untracked.txt' },
    ]);
    expect(state.invocations.some((item) => item.args.includes('HEAD') && item.args.includes('origin/main'))).toBe(false);
  });

  it('quiesces an active dirty exact-dual target, force-removes it, and preserves the unrelated mixed-tab pane', async () => {
    const paths = fixture();
    const state = defaultState(paths);
    const report = await runPostMergeTeardown(
      { ...paths.args, apply: true },
      dependencies(paths, state),
    );

    expect(report).toMatchObject({
      outcome: 'cleanup_complete',
      terminals: { mixedTabPreserved: true, residual: 0 },
      processes: { selected: 1, residual: 0 },
      removal: { method: 'orca-force', receipt: 'confirmed' },
      branchDeletion: { decision: 'deleted', expectedOid: H0 },
      readback: { gitAbsent: true, orcaAbsent: true, unrelatedInventoryStable: true },
    });
    expect(state.terminals).toEqual([{ handle: 'main-pane', worktreePath: paths.repo, tabId: 'mixed-tab' }]);
    expect(state.invocations.some((item) => item.args.includes('--force'))).toBe(true);
    expect(state.invocations.some((item) => item.args.includes('update-ref') && item.args.includes('-d'))).toBe(true);
  });

  it('fails capability preflight before any target effect', async () => {
    const paths = fixture();
    const state = defaultState(paths);
    state.validHelp = false;
    const report = await runPostMergeTeardown(
      { ...paths.args, apply: true },
      dependencies(paths, state),
    );

    expect(report.outcome).toBe('unsupported_runtime_preflight');
    expect(state.invocations.some((item) => item.args[0] === 'terminal' && item.args[1] === 'stop')).toBe(false);
    expect(state.invocations.some((item) => item.args.includes('--force'))).toBe(false);
  });

  it('quiesces but preserves worktree and branch when the target moves to unauthorized H2', async () => {
    const paths = fixture();
    const state = defaultState(paths);
    state.targetDriftsAfterQuiescence = true;
    const report = await runPostMergeTeardown(
      { ...paths.args, apply: true },
      dependencies(paths, state),
    );

    expect(report.outcome).toBe('quiesced_cleanup_deferred');
    expect(state.gitPresent).toBe(true);
    expect(state.orcaPresent).toBe(true);
    expect(state.invocations.some((item) => item.args.includes('--force'))).toBe(false);
  });

  it('quiesces but refuses removal when the final manifest is unstable', async () => {
    const paths = fixture();
    const state = defaultState(paths);
    state.manifestChanges = true;
    const report = await runPostMergeTeardown(
      { ...paths.args, apply: true },
      dependencies(paths, state),
    );

    expect(report.outcome).toBe('quiesced_cleanup_deferred');
    expect(report.error).toContain('final discard manifest changed');
    expect(state.gitPresent).toBe(true);
    expect(state.orcaPresent).toBe(true);
    expect(state.invocations.some((item) => item.args.includes('--force'))).toBe(false);
  });

  it('preserves a moved branch without downgrading successful worktree cleanup', async () => {
    const paths = fixture();
    const state = defaultState(paths);
    state.branchOid = H2;
    const report = await runPostMergeTeardown(
      { ...paths.args, apply: true },
      dependencies(paths, state),
    );

    expect(report).toMatchObject({
      outcome: 'cleanup_complete',
      branchDeletion: { decision: 'refused', observedOid: H2 },
    });
    expect(state.branchOid).toBe(H2);
  });

  it('reports a residual observable process and never removes the target', async () => {
    const paths = fixture();
    const state = defaultState(paths);
    state.residualProcess = true;
    const report = await runPostMergeTeardown(
      { ...paths.args, apply: true },
      dependencies(paths, state),
    );

    expect(report).toMatchObject({ outcome: 'task_degraded', processes: { residual: 1 } });
    expect(state.gitPresent).toBe(true);
    expect(state.invocations.some((item) => item.args.includes('--force'))).toBe(false);
  });

  it('counts a denied cwd observation without treating it as a holder or as proof', async () => {
    const paths = fixture();
    const state = defaultState(paths);
    const report = await runPostMergeTeardown(
      { ...paths.args, apply: true },
      {
        ...dependencies(paths, state),
        processCensus: () => [
          { pid: 77, ppid: 1, starttime: '3', cwd: null, cwdDenied: true },
          { pid: 78, ppid: 1, starttime: '4', cwd: null, cwdDenied: true, fdDenied: true },
        ],
      },
    );

    expect(report).toMatchObject({
      outcome: 'cleanup_complete',
      processes: { selected: 0, residual: 0, unreadableCwd: 2, unreadableFd: 1 },
    });
  });

  it('blocks cleanup on a readable fd holder even when its cwd is elsewhere', async () => {
    const paths = fixture();
    const state = defaultState(paths);
    const report = await runPostMergeTeardown(
      { ...paths.args, apply: true },
      {
        ...dependencies(paths, state),
        processCensus: () => [
          { pid: 79, ppid: 1, starttime: '5', cwd: '/elsewhere', fd: `${paths.target}/held.log` },
          { pid: 80, ppid: 1, starttime: '6', cwd: null, cwdDenied: true },
        ],
      },
    );

    expect(report).toMatchObject({
      outcome: 'task_degraded',
      processes: { residual: 1, unreadableCwd: 1 },
    });
    expect(state.gitPresent).toBe(true);
  });

  it('removes an identical launch copy with the tree and refuses removal when a copy differs', async () => {
    const identical = fixture();
    writeFileSync(join(identical.repo, '.env'), 'K=1\n');
    writeFileSync(join(identical.target, '.env'), 'K=1\n');
    const identicalState = defaultState(identical);
    const withIgnoredGit = (state: State, paths: Fixture) => {
      const inner = dependencies(paths, state);
      return {
        ...inner,
        runner: (invocation: CommandInvocation) => {
          if (invocation.args.includes('check-ignore')) return result();
          if (invocation.args.includes('ls-files') && invocation.args.includes('--error-unmatch')) return result({ ok: false, exitCode: 1 });
          return inner.runner(invocation);
        },
      };
    };
    const done = await runPostMergeTeardown({ ...identical.args, apply: true }, withIgnoredGit(identicalState, identical));
    expect(done.outcome).toBe('cleanup_complete');
    expect(existsSync(join(identical.target, '.env'))).toBe(false);

    const differing = fixture();
    writeFileSync(join(differing.repo, '.env'), 'K=1\n');
    writeFileSync(join(differing.target, '.env'), 'K=local\n');
    const differingState = defaultState(differing);
    const refused = await runPostMergeTeardown({ ...differing.args, apply: true }, withIgnoredGit(differingState, differing));
    expect(refused).toMatchObject({
      outcome: 'quiesced_cleanup_deferred',
      launchCopies: { preserved: [{ path: '.env', reason: 'differs_from_primary' }] },
    });
    expect(existsSync(join(differing.target, '.env'))).toBe(true);
    expect(differingState.gitPresent).toBe(true);
    expect(differingState.invocations.some((item) => item.args.includes('--force'))).toBe(false);
  });

  it('uses Git force removal for exact-git-only while retaining dual read-back', async () => {
    const paths = fixture('exact_git_only');
    const state = defaultState(paths);
    state.orcaPresent = false;
    state.active = false;
    state.terminals = [];
    state.targetProcessAlive = false;
    const report = await runPostMergeTeardown(
      { ...paths.args, apply: true },
      dependencies(paths, state),
    );

    expect(report).toMatchObject({
      outcome: 'cleanup_complete',
      removal: { method: 'git-force', receipt: 'confirmed' },
      readback: { gitAbsent: true, orcaAbsent: true },
    });
  });
});

describe('manifest and capability parsing', () => {
  it('uses NUL-safe paths, includes both rename paths, and excludes allowlisted ignored data', () => {
    expect(parseDiscardEntries(
      'R  new name.txt\0old\nname.txt\0?? untracked file.txt\0',
      'node_modules/pkg/a.js\0private/cache.db\0',
    )).toEqual([
      { category: 'ignored', path: 'private/cache.db' },
      { category: 'tracked', path: 'new name.txt' },
      { category: 'tracked', path: 'old\nname.txt' },
      { category: 'untracked', path: 'untracked file.txt' },
    ]);
  });

  it('requires the exact installed force-removal help surface', () => {
    expect(validateForceRemovalHelp('orca worktree rm --worktree path:x --force --json')).toBe(true);
    expect(validateForceRemovalHelp('orca worktree rm --worktree path:x --json')).toBe(false);
  });
});

describe('pack GH path in direct post-merge teardown', () => {
  const prViewArgs = [
    'pr', 'view', '1329', '--json',
    'headRefName,state,headRefOid,mergeCommit,headRepository,baseRefName',
  ];
  const prListArgs = [
    'pr', 'list', '--state', 'open', '--json',
    'number,headRefName,headRepository',
  ];

  it('preserves a target checkout without scripts/gh and runs both exact pack GH commands with target cwd', async () => {
    const paths = fixture();
    const state = defaultState(paths);
    expect(existsSync(join(paths.repo, 'scripts', 'gh'))).toBe(false);
    const report = await runPostMergeTeardown(paths.args, dependencies(paths, state));
    expect(report.outcome).toBe('cleanup_eligible');
    expect(report.effects).toEqual([]);

    const prCalls = state.invocations.filter((call) => call.args[0] === 'pr');
    expect(prCalls).toEqual([
      { command: WRAPPER_PATH, args: prViewArgs, cwd: paths.repo },
      { command: WRAPPER_PATH, args: prListArgs, cwd: paths.repo },
    ]);
    expect(state.gitPresent).toBe(true);
    expect(state.orcaPresent).toBe(true);
  });

  it('preserves explicit pack-root cwd and the same PR argv when the pack itself is selected', async () => {
    const original = fixture();
    const packRoot = dirname(dirname(WRAPPER_PATH));
    const paths: Fixture = {
      ...original,
      repo: packRoot,
      args: { ...original.args, repositoryRoot: packRoot },
    };
    const state = defaultState(paths);
    const report = await runPostMergeTeardown(paths.args, dependencies(paths, state));
    expect(report.outcome).toBe('cleanup_eligible');
    expect(report.effects).toEqual([]);

    const prCalls = state.invocations.filter((call) => call.args[0] === 'pr');
    expect(prCalls).toEqual([
      { command: WRAPPER_PATH, args: prViewArgs, cwd: packRoot },
      { command: WRAPPER_PATH, args: prListArgs, cwd: packRoot },
    ]);
    expect(state.gitPresent).toBe(true);
    expect(state.orcaPresent).toBe(true);
  });
});
