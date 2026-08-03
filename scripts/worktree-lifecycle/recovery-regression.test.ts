// @vitest-ci-lane light
// @vitest-pre-topology-seconds 120

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProcessResult } from '../kernel/subprocess.ts';
import {
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

const processResult = (overrides: Partial<ProcessResult> = {}): ProcessResult => ({
  outcome: 'exit', ok: true, exitCode: 0, signal: null, stdout: '', stderr: '',
  timedOut: false, cancelled: false, ...overrides,
});

interface Fixture {
  root: string;
  repo: string;
  worktree: string;
  common: string;
  expected: ExpectedWorktreeIdentity;
  removed: boolean;
  keepOrcaAfterRemoval: boolean;
  removeCount: number;
  ignoredOutput: string;
  branchOwners: Array<{ number: number; headRefName: string }>;
  removalResult: ProcessResult;
  operations: LifecycleOperations;
}

function orcaPayload(rows: readonly object[]): string {
  return JSON.stringify({ ok: true, result: { worktrees: rows } });
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'opk-recovery-regression-'));
  roots.push(root);
  const repo = join(root, 'repo');
  const worktree = join(root, 'worktrees', 'issue-1298');
  const common = join(repo, '.git');
  const gitdir = join(common, 'worktrees', 'issue-1298');
  mkdirSync(gitdir, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(worktree, '.git'), `gitdir: ${gitdir}\n`, 'utf8');
  const value: Fixture = {
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
    removed: false,
    keepOrcaAfterRemoval: false,
    removeCount: 0,
    ignoredOutput: '',
    branchOwners: [],
    removalResult: processResult(),
    operations: {},
  };
  const runner: CommandRunner = (invocation: CommandInvocation) => {
    const args = [...invocation.args];
    if (invocation.command === 'git' && args.includes('worktree') && args.includes('list')) {
      const target = value.removed ? [] : [
        `worktree ${worktree}`,
        `HEAD ${HEAD}`,
        `branch refs/heads/${BRANCH}`,
        '',
      ];
      return processResult({
        stdout: [`worktree ${repo}`, `HEAD ${OTHER_HEAD}`, 'branch refs/heads/main', '', ...target].join('\n'),
      });
    }
    if (args[0] === 'worktree' && args[1] === 'list') {
      const rows = value.removed && value.keepOrcaAfterRemoval
        ? [{
            path: worktree,
            head: HEAD,
            branch: `refs/heads/${BRANCH}`,
            linkedPR: 1300,
            isMainWorktree: false,
            isArchived: false,
          }]
        : [];
      return processResult({ stdout: orcaPayload(rows) });
    }
    if (args[0] === 'worktree' && args[1] === 'ps') {
      return processResult({ stdout: orcaPayload([]) });
    }
    if (args[0] === 'terminal' && args[1] === 'list') {
      return processResult({ stdout: JSON.stringify({ ok: true, result: { terminals: [] } }) });
    }
    if (invocation.command.endsWith('/scripts/gh') && args[0] === 'pr' && args[1] === 'view') {
      return processResult({
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
      return processResult({ stdout: JSON.stringify(value.branchOwners) });
    }
    if (invocation.command === 'git' && args.includes('rev-parse') && args.includes('--git-common-dir')) {
      return processResult({ stdout: `${common}\n` });
    }
    if (invocation.command === 'git' && args.includes('status') && args.includes('--untracked-files=all')) {
      return processResult();
    }
    if (invocation.command === 'git' && args.includes('status') && args.includes('--ignored=matching')) {
      return processResult({ stdout: value.ignoredOutput });
    }
    if (invocation.command === 'git' && (args.includes('merge-base') || args.includes('fetch'))) {
      return processResult();
    }
    if (invocation.command === 'git' && args.includes('worktree') && args.includes('remove')) {
      value.removeCount += 1;
      value.removed = true;
      return value.removalResult;
    }
    if (invocation.command === 'git' && args.includes('branch') && args.includes('--list')) {
      return processResult();
    }
    throw new Error(`unexpected invocation: ${invocation.command} ${args.join(' ')}`);
  };
  value.operations = {
    runner,
    orcaExecutable: 'orca-fixture',
    lockPath: join(root, 'lifecycle.lock'),
    processCensus: () => [],
  };
  return value;
}

function recover(value: Fixture, apply: boolean): ReturnType<typeof runLifecycle> {
  return runLifecycle({
    expected: value.expected,
    context: 'explicit-recovery',
    apply,
    operations: value.operations,
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('interrupted recovery', () => {
  it('does not repeat a removal whose effect completed before receipt loss', () => {
    const value = fixture();
    value.removalResult = processResult({
      outcome: 'timeout', ok: false, exitCode: null, timedOut: true, stderr: 'receipt lost after effect',
    });

    expect(recover(value, true).outcome).toBe('cleanup_deferred');
    expect(recover(value, true).outcome).toBe('already_absent');
    expect(value.removeCount).toBe(1);
  });

  it('preserves partial Git/Orca disappearance and does not repeat removal', () => {
    const value = fixture();
    value.keepOrcaAfterRemoval = true;
    value.removalResult = processResult({
      outcome: 'timeout', ok: false, exitCode: null, timedOut: true, stderr: 'partial receipt lost',
    });

    recover(value, true);
    const second = recover(value, true);

    expect(second).toMatchObject({ outcome: 'cleanup_deferred', pipelineContinues: true });
    expect(second.classification.classification).toBe('orca_only');
    expect(value.removeCount).toBe(1);
  });
});

describe('historical target preservation', () => {
  it('blocks non-allowlisted ignored data', () => {
    const value = fixture();
    value.ignoredOutput = '!! private-cache/\n';

    expect(recover(value, false)).toMatchObject({
      outcome: 'cleanup_deferred',
      gates: { ignoredData: false },
      effects: [],
    });
    expect(value.removeCount).toBe(0);
  });

  it('blocks a branch reused by another open PR', () => {
    const value = fixture();
    value.branchOwners = [{ number: 1301, headRefName: BRANCH }];

    expect(recover(value, false)).toMatchObject({
      outcome: 'cleanup_deferred',
      gates: { branchOwnership: false },
      effects: [],
    });
    expect(value.removeCount).toBe(0);
  });
});
