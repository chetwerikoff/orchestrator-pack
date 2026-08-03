// @vitest-ci-lane light
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

function fixture(): {
  root: string;
  repo: string;
  worktree: string;
  common: string;
  expected: ExpectedWorktreeIdentity;
} {
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

function gitPorcelain(input: {
  worktree: string;
  includeTarget?: boolean;
  targetHead?: string;
  targetBranch?: string;
}): string {
  return [
    `worktree ${input.worktree}/main`,
    `HEAD ${OTHER_HEAD}`,
    'branch refs/heads/main',
    '',
    ...(input.includeTarget === false ? [] : [
      `worktree ${input.worktree}`,
      `HEAD ${input.targetHead ?? HEAD}`,
      `branch refs/heads/${input.targetBranch ?? BRANCH}`,
      '',
    ]),
  ].join('\n');
}

function orcaPayload(rows: unknown[]): string {
  return JSON.stringify({ ok: true, result: { worktrees: rows } });
}

function terminalPayload(rows: unknown[] = []): string {
  return JSON.stringify({ ok: true, result: { terminals: rows } });
}

interface RunnerState {
  removed: boolean;
  dirty?: boolean;
  terminals?: unknown[];
  agents?: unknown[];
  orcaRows?: unknown[];
  standardTeardownOk?: boolean;
  invocations: CommandInvocation[];
}

function makeRunner(paths: ReturnType<typeof fixture>, state: RunnerState): CommandRunner {
  return (invocation) => {
    state.invocations.push(invocation);
    const args = [...invocation.args];
    if (invocation.command === 'git' && args.includes('worktree') && args.includes('list')) {
      return result({ stdout: gitPorcelain({ worktree: paths.worktree, includeTarget: !state.removed }) });
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
      return result({ stdout: '[]' });
    }
    if (invocation.command === 'git' && args.includes('rev-parse') && args.includes('--git-common-dir')) {
      return result({ stdout: `${paths.common}\n` });
    }
    if (invocation.command === 'git' && args.includes('status') && args.includes('--untracked-files=all')) {
      return result({ stdout: state.dirty ? ' M tracked.txt\n' : '' });
    }
    if (invocation.command === 'git' && args.includes('status') && args.includes('--ignored=matching')) {
      return result({ stdout: '' });
    }
    if (invocation.command === 'git' && args.includes('merge-base')) return result({ stdout: '' });
    if (invocation.command === 'git' && args.includes('fetch')) return result({ stdout: '' });
    if (invocation.command === 'git' && args.includes('worktree') && args.includes('remove')) {
      expect(args).not.toContain('--force');
      state.removed = true;
      return result({ stdout: '' });
    }
    if (invocation.command === 'git' && args.includes('branch') && args.includes('--list')) {
      return result({ stdout: state.removed ? `${BRANCH}\n` : '' });
    }
    if (invocation.command === 'git' && args.includes('branch') && args.includes('-d')) {
      expect(args).not.toContain('-D');
      return result({ stdout: '' });
    }
    if (args[0] === 'worktree' && args[1] === 'list') {
      return result({ stdout: orcaPayload(state.orcaRows ?? []) });
    }
    if (args[0] === 'worktree' && args[1] === 'ps') {
      return result({ stdout: orcaPayload(state.agents ?? []) });
    }
    if (args[0] === 'terminal' && args[1] === 'list') {
      return result({ stdout: terminalPayload(state.terminals ?? []) });
    }
    if (invocation.command === process.execPath) {
      return state.standardTeardownOk === false
        ? result({ ok: false, exitCode: 1, stdout: JSON.stringify({ outcome: 'blocked_dirty_worktree' }) })
        : result({ stdout: JSON.stringify({ outcome: 'reaped_clean' }) });
    }
    throw new Error(`unexpected invocation: ${invocation.command} ${args.join(' ')}`);
  };
}

function operations(paths: ReturnType<typeof fixture>, state: RunnerState): LifecycleOperations {
  return {
    runner: makeRunner(paths, state),
    orcaExecutable: 'orca-fixture',
    lockPath: join(paths.root, 'lifecycle.lock'),
    processCensus: () => [],
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('dual census', () => {
  it('classifies production-shaped Git-only and conflict states', () => {
    const paths = fixture();
    const state: RunnerState = { removed: false, invocations: [] };
    const gitOnly = collectCensus(paths.expected, operations(paths, state));
    expect(gitOnly.classification.classification).toBe('exact_git_only');

    state.orcaRows = [{
      path: paths.worktree,
      head: OTHER_HEAD,
      branch: `refs/heads/${BRANCH}`,
      linkedPR: 1300,
      isMainWorktree: false,
      isArchived: false,
    }];
    const stale = collectCensus(paths.expected, operations(paths, state));
    expect(stale.classification.classification).toBe('conflict');
    expect(stale.classification.disagreeingFields).toContain('orca.head');
  });

  it('binds post-create agreement to the exact linked issue', () => {
    const paths = fixture();
    const issueExpected: ExpectedWorktreeIdentity = {
      ...paths.expected,
      bindingKind: 'issue',
      bindingNumber: 1298,
    };
    const state: RunnerState = {
      removed: false,
      invocations: [],
      orcaRows: [{
        path: paths.worktree,
        head: HEAD,
        branch: `refs/heads/${BRANCH}`,
        linkedIssue: 1298,
        isMainWorktree: false,
        isArchived: false,
      }],
    };
    expect(collectCensus(issueExpected, operations(paths, state)).classification.classification)
      .toBe('exact_dual');
    state.orcaRows = [{ ...state.orcaRows[0] as object, linkedIssue: 1299 }];
    expect(collectCensus(issueExpected, operations(paths, state)).classification.classification)
      .toBe('conflict');
  });

  it('fails closed when an external response shape is malformed', () => {
    const paths = fixture();
    const state: RunnerState = { removed: false, invocations: [] };
    const base = makeRunner(paths, state);
    const census = collectCensus(paths.expected, {
      ...operations(paths, state),
      runner: (invocation) => invocation.args[0] === 'worktree' && invocation.args[1] === 'list'
        ? result({ stdout: '{"ok":true,"result":{}}' })
        : base(invocation),
    });
    expect(census.classification.classification).toBe('conflict');
    expect(census.errors.join(' ')).toMatch(/worktrees/);
  });
});

describe('guarded Git-only recovery', () => {
  it('is dry-run first and reports eligibility without effects', () => {
    const paths = fixture();
    const state: RunnerState = { removed: false, invocations: [] };
    const report = runLifecycle({
      expected: paths.expected,
      context: 'explicit-recovery',
      apply: false,
      operations: operations(paths, state),
    });
    expect(report).toMatchObject({
      outcome: 'git_only_recovery_eligible',
      pipelineContinues: true,
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
    expect(state.removed).toBe(false);
  });

  it('does not run destructive PR recovery with issue-only authority', () => {
    const paths = fixture();
    const state: RunnerState = { removed: false, invocations: [] };
    const report = runLifecycle({
      expected: { ...paths.expected, bindingKind: 'issue', bindingNumber: 1298 },
      context: 'explicit-recovery',
      apply: true,
      operations: operations(paths, state),
    });
    expect(report).toMatchObject({ outcome: 'cleanup_deferred', pipelineContinues: true });
    expect(report.error).toMatch(/PR-bound/);
    expect(state.removed).toBe(false);
  });

  it('blocks target mutation for dirty, active-terminal, and residual-process states', () => {
    const paths = fixture();
    const cases: Array<Partial<RunnerState> & { processCensus?: LifecycleOperations['processCensus'] }> = [
      { dirty: true },
      { terminals: [{ handle: 't1', worktreePath: paths.worktree, tabId: 'tab-1' }] },
      { processCensus: () => [{ pid: 99, ppid: 1, starttime: '1', cwd: paths.worktree }] },
    ];
    for (const item of cases) {
      const state: RunnerState = { removed: false, invocations: [], ...item };
      const baseOperations = operations(paths, state);
      const report = runLifecycle({
        expected: paths.expected,
        context: 'explicit-recovery',
        apply: true,
        operations: { ...baseOperations, ...(item.processCensus ? { processCensus: item.processCensus } : {}) },
      });
      expect(report.outcome).toBe('cleanup_deferred');
      expect(report.pipelineContinues).toBe(true);
      expect(state.removed).toBe(false);
    }
  });

  it('uses non-force Git removal, reads both authorities back, and becomes idempotent', () => {
    const paths = fixture();
    const state: RunnerState = { removed: false, invocations: [] };
    const opts = operations(paths, state);
    const applied = runLifecycle({
      expected: paths.expected,
      context: 'explicit-recovery',
      apply: true,
      operations: opts,
    });
    expect(applied).toMatchObject({
      outcome: 'git_only_recovered',
      pipelineContinues: true,
      branchDeletion: 'deleted',
    });
    expect(applied.effects).toEqual(['git worktree remove (non-force)', 'git branch -d']);
    expect(applied.postClassification?.classification).toBe('absent');

    const repeated = runLifecycle({
      expected: paths.expected,
      context: 'explicit-recovery',
      apply: true,
      operations: opts,
    });
    expect(repeated).toMatchObject({ outcome: 'already_absent', effects: [] });
  });
});

describe('nonblocking caller contract', () => {
  it('converts an ordinary teardown block into cleanup_deferred after merge', () => {
    const paths = fixture();
    const state: RunnerState = {
      removed: false,
      invocations: [],
      standardTeardownOk: false,
      orcaRows: [{
        path: paths.worktree,
        head: HEAD,
        branch: `refs/heads/${BRANCH}`,
        linkedPR: 1300,
        isMainWorktree: false,
        isArchived: false,
      }],
      agents: [{
        path: paths.worktree,
        head: HEAD,
        branch: `refs/heads/${BRANCH}`,
        linkedPR: 1300,
        isMainWorktree: false,
        isArchived: false,
        agents: [{ state: 'done', interrupted: false }],
      }],
    };
    const report = runLifecycle({
      expected: paths.expected,
      context: 'post-merge-cleanup',
      apply: true,
      operations: operations(paths, state),
    });
    expect(report).toMatchObject({
      outcome: 'cleanup_deferred',
      pipelineContinues: true,
      classification: { classification: 'exact_dual' },
      standardTeardown: { outcome: 'blocked_dirty_worktree' },
    });
  });

  it('preserves a conflicting target and returns control instead of mutating it', () => {
    const paths = fixture();
    const state: RunnerState = {
      removed: false,
      invocations: [],
      orcaRows: [{
        path: paths.worktree,
        head: OTHER_HEAD,
        branch: `refs/heads/${BRANCH}`,
        linkedPR: 1300,
        isMainWorktree: false,
        isArchived: false,
      }],
    };
    const report = runLifecycle({
      expected: paths.expected,
      context: 'post-merge-cleanup',
      apply: true,
      operations: operations(paths, state),
    });
    expect(report).toMatchObject({
      outcome: 'cleanup_deferred',
      pipelineContinues: true,
      decision: { action: 'cleanup_deferred', targetMutationAuthorized: false },
    });
    expect(state.removed).toBe(false);
  });

  it('authorizes post-create spawn only for exact issue-bound dual read-back', () => {
    const paths = fixture();
    const issueExpected: ExpectedWorktreeIdentity = {
      ...paths.expected,
      bindingKind: 'issue',
      bindingNumber: 1298,
    };
    const disputedState: RunnerState = { removed: false, invocations: [] };
    expect(runLifecycle({
      expected: issueExpected,
      context: 'post-create',
      apply: false,
      operations: operations(paths, disputedState),
    })).toMatchObject({
      outcome: 'replacement_required',
      pipelineContinues: true,
      decision: { terminalSpawnAuthorized: false },
    });

    const exactState: RunnerState = {
      removed: false,
      invocations: [],
      orcaRows: [{
        path: paths.worktree,
        head: HEAD,
        branch: `refs/heads/${BRANCH}`,
        linkedIssue: 1298,
        isMainWorktree: false,
        isArchived: false,
      }],
    };
    expect(runLifecycle({
      expected: issueExpected,
      context: 'post-create',
      apply: false,
      operations: operations(paths, exactState),
    })).toMatchObject({
      outcome: 'ready_to_spawn',
      decision: { terminalSpawnAuthorized: true },
    });
  });
});
