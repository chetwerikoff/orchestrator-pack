// @vitest-ci-lane light
// @vitest-pre-topology-seconds 120

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProcessResult } from '../kernel/subprocess.ts';
import {
  runCreateContinuation,
  type CreateContinuationOperations,
  type WorktreeCreateContinuationReport,
} from './create-continuation.ts';
import {
  runLifecycle,
  type CommandInvocation,
  type CommandRunner,
  type LifecycleOperations,
} from './operations.ts';
import type { ExpectedWorktreeIdentity } from './core.ts';

const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);
const ISSUE = 1298;
const PR = 1300;
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

interface GitFixtureRow {
  path: string;
  head: string;
  branch?: string;
  detached?: boolean;
}

interface OrcaFixtureRow {
  path: string;
  head: string;
  branch?: string;
  linkedIssue?: number;
  linkedPR?: number;
  isMainWorktree?: boolean;
  isArchived?: boolean;
}

interface CreateHarness {
  root: string;
  repo: string;
  lockPath: string;
  gitRows: GitFixtureRow[];
  orcaRows: OrcaFixtureRow[];
  createNames: string[];
  createHandlers: Array<(name: string) => ProcessResult>;
  runner: CommandRunner;
  operations: CreateContinuationOperations;
  addGit(name: string, head?: string): string;
  addDual(name: string): string;
}

function gitPorcelain(repo: string, rows: readonly GitFixtureRow[]): string {
  return [
    `worktree ${repo}`,
    `HEAD ${OTHER_HEAD}`,
    'branch refs/heads/main',
    '',
    ...rows.flatMap((row) => [
      `worktree ${row.path}`,
      `HEAD ${row.head}`,
      ...(row.detached ? ['detached'] : [`branch refs/heads/${row.branch ?? 'missing'}`]),
      '',
    ]),
  ].join('\n');
}

function orcaPayload(rows: readonly OrcaFixtureRow[]): string {
  return JSON.stringify({
    ok: true,
    result: {
      worktrees: rows.map((row) => ({
        ...row,
        isMainWorktree: row.isMainWorktree ?? false,
        isArchived: row.isArchived ?? false,
      })),
    },
  });
}

function createHarness(): CreateHarness {
  const root = mkdtempSync(join(tmpdir(), 'opk-create-continuation-'));
  roots.push(root);
  const repo = join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  const lockPath = join(root, 'lifecycle.lock');
  const gitRows: GitFixtureRow[] = [];
  const orcaRows: OrcaFixtureRow[] = [];
  const createNames: string[] = [];
  const createHandlers: Array<(name: string) => ProcessResult> = [];
  const addGit = (name: string, head = HEAD): string => {
    const path = join(root, 'worktrees', name);
    gitRows.push({ path, head, branch: name });
    return path;
  };
  const addDual = (name: string): string => {
    const path = addGit(name);
    orcaRows.push({ path, head: HEAD, branch: `refs/heads/${name}`, linkedIssue: ISSUE });
    return path;
  };
  const runner: CommandRunner = (invocation) => {
    const args = [...invocation.args];
    if (invocation.command === 'git' && args.includes('worktree') && args.includes('list')) {
      return result({ stdout: gitPorcelain(repo, gitRows) });
    }
    if (args[0] === 'worktree' && args[1] === 'list') {
      return result({ stdout: orcaPayload(orcaRows) });
    }
    if (args[0] === 'worktree' && args[1] === 'ps') {
      return result({ stdout: orcaPayload(orcaRows) });
    }
    if (args[0] === 'terminal' && args[1] === 'list') {
      return result({ stdout: JSON.stringify({ ok: true, result: { terminals: [] } }) });
    }
    if (args[0] === 'worktree' && args[1] === 'create') {
      const name = args[args.indexOf('--name') + 1]!;
      createNames.push(name);
      const handler = createHandlers.shift();
      if (!handler) throw new Error(`unexpected create attempt for ${name}`);
      return handler(name);
    }
    throw new Error(`unexpected invocation: ${invocation.command} ${args.join(' ')}`);
  };
  return {
    root,
    repo,
    lockPath,
    gitRows,
    orcaRows,
    createNames,
    createHandlers,
    runner,
    operations: {
      runner,
      orcaExecutable: 'orca-fixture',
      lockPath,
      replacementToken: () => 'fixedtoken',
    },
    addGit,
    addDual,
  };
}

function run(harness: CreateHarness, name = 'issue-1298'): WorktreeCreateContinuationReport {
  return runCreateContinuation({
    repositoryRoot: harness.repo,
    issueNumber: ISSUE,
    expectedHead: HEAD,
    name,
    operations: harness.operations,
  });
}

function replacementName(name = 'issue-1298'): string {
  return `${name}-replacement-fixedtoken`;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('bounded create continuation actuator', () => {
  it('performs one initial create and authorizes spawn only after two exact dual reads', () => {
    const harness = createHarness();
    harness.createHandlers.push((name) => {
      harness.addDual(name);
      return result({ stdout: JSON.stringify({ ok: true, result: { worktree: { id: name } } }) });
    });

    const report = run(harness);

    expect(report).toMatchObject({
      outcome: 'ready_to_spawn',
      terminalSpawnAuthorized: true,
      resumedExisting: false,
    });
    expect(report.attempts).toHaveLength(1);
    expect(report.attempts[0]?.kind).toBe('initial');
    expect(report.attempts[0]?.candidateReports).toHaveLength(2);
    expect(harness.createNames).toEqual(['issue-1298']);
  });

  it('preserves a Git-only first result and performs exactly one isolated replacement', () => {
    const harness = createHarness();
    harness.createHandlers.push(
      (name) => {
        harness.addGit(name);
        return result({ stdout: JSON.stringify({ ok: true }) });
      },
      (name) => {
        harness.addDual(name);
        return result({ stdout: JSON.stringify({ ok: true }) });
      },
    );

    const report = run(harness);

    expect(report.outcome).toBe('ready_to_spawn');
    expect(report.selected?.path).toBe(join(harness.root, 'worktrees', replacementName()));
    expect(harness.createNames).toEqual(['issue-1298', replacementName()]);
    expect(harness.gitRows.some((row) => row.branch === 'issue-1298')).toBe(true);
    expect(report.attempts).toHaveLength(2);
  });

  it('treats effect-before-receipt as success after authoritative read-back without retry', () => {
    const harness = createHarness();
    harness.createHandlers.push((name) => {
      harness.addDual(name);
      return result({
        outcome: 'timeout',
        ok: false,
        exitCode: null,
        timedOut: true,
        stderr: 'caller receipt lost',
      });
    });

    const report = run(harness);

    expect(report.outcome).toBe('ready_to_spawn');
    expect(report.attempts).toHaveLength(1);
    expect(report.attempts[0]?.command).toMatchObject({ acknowledged: false, timedOut: true });
    expect(harness.createNames).toEqual(['issue-1298']);
  });

  it('resumes one pre-existing exact dual worktree and performs no create', () => {
    const harness = createHarness();
    const path = harness.addDual('already-created');

    const report = run(harness);

    expect(report).toMatchObject({
      outcome: 'ready_to_spawn',
      resumedExisting: true,
      selected: { path },
      attempts: [],
      effects: [],
    });
    expect(harness.createNames).toEqual([]);
  });

  it('does not recreate a disputed pre-existing target and uses only the replacement attempt', () => {
    const harness = createHarness();
    harness.addGit('lost-receipt');
    harness.createHandlers.push((name) => {
      harness.addDual(name);
      return result({ stdout: JSON.stringify({ ok: true }) });
    });

    const report = run(harness);

    expect(report.outcome).toBe('ready_to_spawn');
    expect(report.attempts.map((attempt) => attempt.kind)).toEqual(['replacement']);
    expect(harness.createNames).toEqual([replacementName()]);
  });

  it('does not adopt an ABA-reused path and selects only a newly observed replacement path', () => {
    const harness = createHarness();
    const reusedPath = harness.addGit('issue-1298', OTHER_HEAD);
    harness.createHandlers.push(
      () => {
        harness.gitRows[0] = { path: reusedPath, head: HEAD, branch: 'issue-1298' };
        return result({ stdout: JSON.stringify({ ok: true }) });
      },
      (name) => {
        harness.addDual(name);
        return result({ stdout: JSON.stringify({ ok: true }) });
      },
    );

    const report = run(harness);

    expect(report.outcome).toBe('ready_to_spawn');
    expect(report.selected?.path).not.toBe(reusedPath);
    expect(report.attempts[0]?.newGitPaths).toEqual([]);
    expect(harness.createNames).toEqual(['issue-1298', replacementName()]);
  });

  it('returns task degradation after the single replacement without a third create', () => {
    const harness = createHarness();
    harness.createHandlers.push(
      (name) => {
        harness.addGit(name);
        return result({ stdout: JSON.stringify({ ok: true }) });
      },
      (name) => {
        harness.addGit(name);
        return result({ stdout: JSON.stringify({ ok: true }) });
      },
    );

    const report = run(harness);

    expect(report).toMatchObject({
      outcome: 'task_degraded',
      pipelineContinues: true,
      terminalSpawnAuthorized: false,
    });
    expect(report.attempts).toHaveLength(2);
    expect(harness.createNames).toEqual(['issue-1298', replacementName()]);
  });

  it('gives one concurrent caller the lock and the other caller no effects', () => {
    const harness = createHarness();
    let nested: WorktreeCreateContinuationReport | undefined;
    harness.createHandlers.push((name) => {
      nested = run(harness, 'concurrent-1298');
      harness.addDual(name);
      return result({ stdout: JSON.stringify({ ok: true }) });
    });

    const winner = run(harness);

    expect(winner.outcome).toBe('ready_to_spawn');
    expect(nested).toMatchObject({
      outcome: 'task_degraded',
      terminalSpawnAuthorized: false,
      attempts: [],
      effects: [],
    });
    expect(harness.createNames).toEqual(['issue-1298']);
  });

  it('recovers a dead-owner lock but fails closed for a live-owner lock', () => {
    const stale = createHarness();
    writeFileSync(stale.lockPath, '99999999\n\nold-token\n', 'utf8');
    stale.createHandlers.push((name) => {
      stale.addDual(name);
      return result({ stdout: JSON.stringify({ ok: true }) });
    });
    expect(run(stale).outcome).toBe('ready_to_spawn');

    const live = createHarness();
    writeFileSync(live.lockPath, `${String(process.pid)}\n`, 'utf8');
    expect(run(live)).toMatchObject({ outcome: 'task_degraded', attempts: [], effects: [] });
    expect(live.createNames).toEqual([]);
  });
});

interface RecoveryHarness {
  root: string;
  repo: string;
  worktree: string;
  common: string;
  lockPath: string;
  expected: ExpectedWorktreeIdentity;
  removed: boolean;
  keepOrcaAfterRemoval: boolean;
  removeCount: number;
  ignoredOutput: string;
  branchOwners: Array<{ number: number; headRefName: string }>;
  removeResult: ProcessResult;
  runner: CommandRunner;
  operations: LifecycleOperations;
}

function recoveryHarness(): RecoveryHarness {
  const root = mkdtempSync(join(tmpdir(), 'opk-create-recovery-'));
  roots.push(root);
  const repo = join(root, 'repo');
  const worktree = join(root, 'worktrees', 'issue-1298');
  const common = join(repo, '.git');
  const gitdir = join(common, 'worktrees', 'issue-1298');
  mkdirSync(gitdir, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(worktree, '.git'), `gitdir: ${gitdir}\n`, 'utf8');
  const harness = {
    root,
    repo,
    worktree,
    common,
    lockPath: join(root, 'lifecycle.lock'),
    expected: {
      repositoryRoot: repo,
      path: worktree,
      headSha: HEAD,
      mode: 'branch-bound' as const,
      branchName: 'agent/issue-1298',
      bindingKind: 'pr' as const,
      bindingNumber: PR,
    },
    removed: false,
    keepOrcaAfterRemoval: false,
    removeCount: 0,
    ignoredOutput: '',
    branchOwners: [] as Array<{ number: number; headRefName: string }>,
    removeResult: result(),
    runner: (() => result()) as CommandRunner,
    operations: {} as LifecycleOperations,
  };
  harness.runner = (invocation: CommandInvocation) => {
    const args = [...invocation.args];
    if (invocation.command === 'git' && args.includes('worktree') && args.includes('list')) {
      return result({
        stdout: harness.removed
          ? `worktree ${repo}\nHEAD ${OTHER_HEAD}\nbranch refs/heads/main\n`
          : [
              `worktree ${repo}`,
              `HEAD ${OTHER_HEAD}`,
              'branch refs/heads/main',
              '',
              `worktree ${worktree}`,
              `HEAD ${HEAD}`,
              'branch refs/heads/agent/issue-1298',
              '',
            ].join('\n'),
      });
    }
    if (args[0] === 'worktree' && args[1] === 'list') {
      const rows = harness.removed && !harness.keepOrcaAfterRemoval
        ? []
        : harness.removed
          ? [{
              path: worktree,
              head: HEAD,
              branch: 'refs/heads/agent/issue-1298',
              linkedPR: PR,
              isMainWorktree: false,
              isArchived: false,
            }]
          : [];
      return result({ stdout: orcaPayload(rows) });
    }
    if (args[0] === 'worktree' && args[1] === 'ps') return result({ stdout: orcaPayload([]) });
    if (args[0] === 'terminal' && args[1] === 'list') {
      return result({ stdout: JSON.stringify({ ok: true, result: { terminals: [] } }) });
    }
    if (invocation.command.endsWith('/scripts/gh') && args[0] === 'pr' && args[1] === 'view') {
      return result({
        stdout: JSON.stringify({
          headRefName: 'agent/issue-1298',
          state: 'MERGED',
          headRefOid: HEAD,
          mergeCommit: { oid: OTHER_HEAD },
          headRepository: { nameWithOwner: 'chetwerikoff/orchestrator-pack' },
          baseRefName: 'main',
        }),
      });
    }
    if (invocation.command.endsWith('/scripts/gh') && args[0] === 'pr' && args[1] === 'list') {
      return result({ stdout: JSON.stringify(harness.branchOwners) });
    }
    if (invocation.command === 'git' && args.includes('rev-parse') && args.includes('--git-common-dir')) {
      return result({ stdout: `${common}\n` });
    }
    if (invocation.command === 'git' && args.includes('status') && args.includes('--untracked-files=all')) {
      return result({ stdout: '' });
    }
    if (invocation.command === 'git' && args.includes('status') && args.includes('--ignored=matching')) {
      return result({ stdout: harness.ignoredOutput });
    }
    if (invocation.command === 'git' && args.includes('merge-base')) return result();
    if (invocation.command === 'git' && args.includes('fetch')) return result();
    if (invocation.command === 'git' && args.includes('worktree') && args.includes('remove')) {
      harness.removeCount += 1;
      harness.removed = true;
      return harness.removeResult;
    }
    if (invocation.command === 'git' && args.includes('branch') && args.includes('--list')) {
      return result({ stdout: '' });
    }
    throw new Error(`unexpected recovery invocation: ${invocation.command} ${args.join(' ')}`);
  };
  harness.operations = {
    runner: harness.runner,
    orcaExecutable: 'orca-fixture',
    lockPath: harness.lockPath,
    processCensus: () => [],
  };
  return harness;
}

describe('interrupted recovery and preservation regressions', () => {
  it('does not repeat a removal whose effect happened before the caller receipt', () => {
    const harness = recoveryHarness();
    harness.removeResult = result({
      outcome: 'timeout',
      ok: false,
      exitCode: null,
      timedOut: true,
      stderr: 'receipt lost after effect',
    });

    const first = runLifecycle({
      expected: harness.expected,
      context: 'explicit-recovery',
      apply: true,
      operations: harness.operations,
    });
    const second = runLifecycle({
      expected: harness.expected,
      context: 'explicit-recovery',
      apply: true,
      operations: harness.operations,
    });

    expect(first.outcome).toBe('cleanup_deferred');
    expect(second.outcome).toBe('already_absent');
    expect(harness.removeCount).toBe(1);
  });

  it('preserves partial Git/Orca disappearance and does not repeat removal', () => {
    const harness = recoveryHarness();
    harness.keepOrcaAfterRemoval = true;
    harness.removeResult = result({
      outcome: 'timeout',
      ok: false,
      exitCode: null,
      timedOut: true,
      stderr: 'partial delete receipt lost',
    });

    runLifecycle({
      expected: harness.expected,
      context: 'explicit-recovery',
      apply: true,
      operations: harness.operations,
    });
    const second = runLifecycle({
      expected: harness.expected,
      context: 'explicit-recovery',
      apply: true,
      operations: harness.operations,
    });

    expect(second).toMatchObject({ outcome: 'cleanup_deferred', pipelineContinues: true });
    expect(second.classification.classification).toBe('orca_only');
    expect(harness.removeCount).toBe(1);
  });

  it('blocks non-allowlisted ignored data and branch reuse', () => {
    const ignored = recoveryHarness();
    ignored.ignoredOutput = '!! private-cache/\n';
    const ignoredReport = runLifecycle({
      expected: ignored.expected,
      context: 'explicit-recovery',
      apply: false,
      operations: ignored.operations,
    });
    expect(ignoredReport).toMatchObject({
      outcome: 'cleanup_deferred',
      gates: { ignoredData: false },
      effects: [],
    });

    const reused = recoveryHarness();
    reused.branchOwners = [{ number: 1301, headRefName: 'agent/issue-1298' }];
    const reusedReport = runLifecycle({
      expected: reused.expected,
      context: 'explicit-recovery',
      apply: false,
      operations: reused.operations,
    });
    expect(reusedReport).toMatchObject({
      outcome: 'cleanup_deferred',
      gates: { branchOwnership: false },
      effects: [],
    });
  });
});
