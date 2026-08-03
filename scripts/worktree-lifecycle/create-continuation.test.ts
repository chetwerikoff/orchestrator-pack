// @vitest-ci-lane light
// @vitest-pre-topology-seconds 120

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProcessResult } from '../kernel/subprocess.ts';
import {
  runCreateContinuation,
  type WorktreeCreateContinuationReport,
} from './create-continuation.ts';
import type { CommandRunner } from './operations.ts';

const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);
const ISSUE = 1298;
const roots: string[] = [];

const processResult = (overrides: Partial<ProcessResult> = {}): ProcessResult => ({
  outcome: 'exit', ok: true, exitCode: 0, signal: null, stdout: '', stderr: '',
  timedOut: false, cancelled: false, ...overrides,
});

interface GitRow {
  path: string;
  head: string;
  branch: string;
}

interface OrcaRow {
  path: string;
  head: string;
  branch: string;
  linkedIssue: number;
}

interface Fixture {
  root: string;
  repo: string;
  lockPath: string;
  gitRows: GitRow[];
  orcaRows: OrcaRow[];
  creates: string[];
  handlers: Array<(name: string) => ProcessResult>;
  runner: CommandRunner;
  addGit(name: string, head?: string): string;
  addDual(name: string): string;
}

function gitPayload(fixture: Fixture): string {
  return [
    `worktree ${fixture.repo}`,
    `HEAD ${OTHER_HEAD}`,
    'branch refs/heads/main',
    '',
    ...fixture.gitRows.flatMap((row) => [
      `worktree ${row.path}`,
      `HEAD ${row.head}`,
      `branch refs/heads/${row.branch}`,
      '',
    ]),
  ].join('\n');
}

function orcaPayload(rows: readonly OrcaRow[]): string {
  return JSON.stringify({
    ok: true,
    result: {
      worktrees: rows.map((row) => ({ ...row, isMainWorktree: false, isArchived: false })),
    },
  });
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'opk-create-continuation-'));
  roots.push(root);
  const repo = join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  const value = {
    root,
    repo,
    lockPath: join(root, 'lifecycle.lock'),
    gitRows: [] as GitRow[],
    orcaRows: [] as OrcaRow[],
    creates: [] as string[],
    handlers: [] as Array<(name: string) => ProcessResult>,
    runner: (() => processResult()) as CommandRunner,
    addGit(name: string, head = HEAD): string {
      const path = join(root, 'worktrees', name);
      this.gitRows.push({ path, head, branch: name });
      return path;
    },
    addDual(name: string): string {
      const path = this.addGit(name);
      this.orcaRows.push({ path, head: HEAD, branch: `refs/heads/${name}`, linkedIssue: ISSUE });
      return path;
    },
  } satisfies Fixture;
  value.runner = (invocation) => {
    const args = [...invocation.args];
    if (invocation.command === 'git' && args.includes('worktree') && args.includes('list')) {
      return processResult({ stdout: gitPayload(value) });
    }
    if (args[0] === 'worktree' && args[1] === 'list') {
      return processResult({ stdout: orcaPayload(value.orcaRows) });
    }
    if (args[0] === 'worktree' && args[1] === 'ps') {
      return processResult({ stdout: orcaPayload(value.orcaRows) });
    }
    if (args[0] === 'terminal' && args[1] === 'list') {
      return processResult({ stdout: JSON.stringify({ ok: true, result: { terminals: [] } }) });
    }
    if (args[0] === 'worktree' && args[1] === 'create') {
      const name = args[args.indexOf('--name') + 1]!;
      value.creates.push(name);
      const handler = value.handlers.shift();
      if (!handler) throw new Error(`unexpected create: ${name}`);
      return handler(name);
    }
    throw new Error(`unexpected invocation: ${invocation.command} ${args.join(' ')}`);
  };
  return value;
}

function execute(value: Fixture, name = 'issue-1298'): WorktreeCreateContinuationReport {
  return runCreateContinuation({
    repositoryRoot: value.repo,
    issueNumber: ISSUE,
    expectedHead: HEAD,
    name,
    operations: {
      runner: value.runner,
      orcaExecutable: 'orca-fixture',
      lockPath: value.lockPath,
      replacementToken: () => 'fixedtoken',
    },
  });
}

const replacement = (name = 'issue-1298'): string => `${name}-replacement-fixedtoken`;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('bounded worktree creation', () => {
  it('authorizes spawn only after one create and two exact-dual reads', () => {
    const value = fixture();
    value.handlers.push((name) => {
      value.addDual(name);
      return processResult({ stdout: JSON.stringify({ ok: true }) });
    });

    const report = execute(value);

    expect(report).toMatchObject({ outcome: 'ready_to_spawn', terminalSpawnAuthorized: true });
    expect(report.attempts[0]?.candidateReports).toHaveLength(2);
    expect(value.creates).toEqual(['issue-1298']);
  });

  it('preserves Git-only state and performs exactly one same-source replacement', () => {
    const value = fixture();
    value.handlers.push(
      (name) => {
        value.addGit(name);
        return processResult({ stdout: JSON.stringify({ ok: true }) });
      },
      (name) => {
        value.addDual(name);
        return processResult({ stdout: JSON.stringify({ ok: true }) });
      },
    );

    const report = execute(value);

    expect(report.selected?.path).toBe(join(value.root, 'worktrees', replacement()));
    expect(report.attempts.map((attempt) => attempt.kind)).toEqual(['initial', 'replacement']);
    expect(value.creates).toEqual(['issue-1298', replacement()]);
  });

  it('creates one replacement beside a stale Orca-only row for the same Issue', () => {
    const value = fixture();
    value.orcaRows.push({
      path: join(value.root, 'worktrees', 'stale-orca-only'),
      head: OTHER_HEAD,
      branch: 'refs/heads/stale-issue-1298',
      linkedIssue: ISSUE,
    });
    value.handlers.push((name) => {
      value.addDual(name);
      return processResult({ stdout: JSON.stringify({ ok: true }) });
    });

    const report = execute(value);

    expect(report).toMatchObject({ outcome: 'ready_to_spawn', terminalSpawnAuthorized: true });
    expect(report.attempts.map((attempt) => attempt.kind)).toEqual(['replacement']);
    expect(report.selected?.path).toBe(join(value.root, 'worktrees', replacement()));
    expect(value.creates).toEqual([replacement()]);
    expect(value.orcaRows.some((row) => row.branch === 'refs/heads/stale-issue-1298')).toBe(true);
  });

  it('recovers an effect whose create receipt was lost without a blind retry', () => {
    const value = fixture();
    value.handlers.push((name) => {
      value.addDual(name);
      return processResult({
        outcome: 'timeout', ok: false, exitCode: null, timedOut: true, stderr: 'receipt lost',
      });
    });

    const report = execute(value);

    expect(report.outcome).toBe('ready_to_spawn');
    expect(report.attempts[0]?.command).toMatchObject({ acknowledged: false, timedOut: true });
    expect(value.creates).toEqual(['issue-1298']);
  });

  it('resumes an existing exact Issue-bound worktree with no create', () => {
    const value = fixture();
    const path = value.addDual('issue-1298');

    expect(execute(value)).toMatchObject({
      outcome: 'ready_to_spawn', resumedExisting: true, selected: { path }, attempts: [], effects: [],
    });
    expect(value.creates).toEqual([]);
  });

  it('uses only replacement after a pre-existing disputed create', () => {
    const value = fixture();
    value.addGit('issue-1298');
    value.handlers.push((name) => {
      value.addDual(name);
      return processResult({ stdout: JSON.stringify({ ok: true }) });
    });

    const report = execute(value);

    expect(report.attempts.map((attempt) => attempt.kind)).toEqual(['replacement']);
    expect(value.creates).toEqual([replacement()]);
  });

  it('does not adopt an ABA-reused path', () => {
    const value = fixture();
    const reused = value.addGit('issue-1298', OTHER_HEAD);
    value.handlers.push(
      () => {
        value.gitRows[0] = { path: reused, head: HEAD, branch: 'issue-1298' };
        return processResult({ stdout: JSON.stringify({ ok: true }) });
      },
      (name) => {
        value.addDual(name);
        return processResult({ stdout: JSON.stringify({ ok: true }) });
      },
    );

    const report = execute(value);

    expect(report.selected?.path).not.toBe(reused);
    expect(report.attempts[0]?.newGitPaths).toEqual([]);
  });

  it('degrades after one replacement instead of creating a third worktree', () => {
    const value = fixture();
    value.handlers.push(
      (name) => {
        value.addGit(name);
        return processResult({ stdout: JSON.stringify({ ok: true }) });
      },
      (name) => {
        value.addGit(name);
        return processResult({ stdout: JSON.stringify({ ok: true }) });
      },
    );

    const report = execute(value);

    expect(report).toMatchObject({ outcome: 'task_degraded', terminalSpawnAuthorized: false });
    expect(value.creates).toEqual(['issue-1298', replacement()]);
  });

  it('gives a concurrent caller no-effect degraded control', () => {
    const value = fixture();
    let loser: WorktreeCreateContinuationReport | undefined;
    value.handlers.push((name) => {
      loser = execute(value, 'concurrent-1298');
      value.addDual(name);
      return processResult({ stdout: JSON.stringify({ ok: true }) });
    });

    expect(execute(value).outcome).toBe('ready_to_spawn');
    expect(loser).toMatchObject({ outcome: 'task_degraded', attempts: [], effects: [] });
    expect(value.creates).toEqual(['issue-1298']);
  });

  it('recovers a dead lock owner and blocks a live owner', () => {
    const stale = fixture();
    writeFileSync(stale.lockPath, '99999999\n\nold-token\n', 'utf8');
    stale.handlers.push((name) => {
      stale.addDual(name);
      return processResult({ stdout: JSON.stringify({ ok: true }) });
    });
    expect(execute(stale).outcome).toBe('ready_to_spawn');

    const live = fixture();
    writeFileSync(live.lockPath, `${String(process.pid)}\n`, 'utf8');
    expect(execute(live)).toMatchObject({ outcome: 'task_degraded', attempts: [], effects: [] });
    expect(live.creates).toEqual([]);
  });
});
