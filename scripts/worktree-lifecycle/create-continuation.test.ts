// @vitest-ci-lane light
// @vitest-pre-topology-seconds 120

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProcessResult } from '../kernel/subprocess.ts';
import {
  runCreateContinuation,
  type WorktreeCreateContinuationReport,
} from './create-continuation.ts';
import {
  acquireLifecycleExclusion,
  releaseLifecycleExclusion,
} from './exclusion.ts';
import type { CommandRunner } from './operations.ts';

const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);
const ISSUE = 1298;
const REPOSITORY_ID = 'repo-1298';
const PRIMARY = 'issue-1298';
const REPLACEMENT = 'issue-1298-replacement';
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

interface AgentRow {
  state?: string;
  interrupted?: boolean;
}

interface OrcaRow {
  path: string;
  head: string;
  branch: string;
  linkedIssue?: number | null;
  repoId?: string;
  isMainWorktree?: boolean;
  isArchived?: boolean;
  agents?: AgentRow[];
}

interface TerminalRow {
  handle: string;
  worktreePath: string;
  tabId: string;
}

interface Fixture {
  root: string;
  repo: string;
  lockPath: string;
  gitRows: GitRow[];
  orcaRows: OrcaRow[];
  terminals: TerminalRow[];
  creates: string[];
  terminalCreates: string[];
  createHandlers: Array<(name: string) => ProcessResult>;
  terminalHandler?: (path: string) => ProcessResult;
  runner: CommandRunner;
  addGit(name: string, head?: string): string;
  addDual(name: string, head?: string, agents?: AgentRow[]): string;
  addTerminal(path: string): TerminalRow;
}

function gitPayload(value: Fixture): string {
  return [
    `worktree ${value.repo}`,
    `HEAD ${OTHER_HEAD}`,
    'branch refs/heads/main',
    '',
    ...value.gitRows.flatMap((row) => [
      `worktree ${row.path}`,
      `HEAD ${row.head}`,
      `branch refs/heads/${row.branch}`,
      '',
    ]),
  ].join('\n');
}

function orcaPayload(value: Fixture, includeAgents: boolean): string {
  return JSON.stringify({
    ok: true,
    result: {
      worktrees: [
        {
          id: `${REPOSITORY_ID}::${value.repo}`,
          path: value.repo,
          head: OTHER_HEAD,
          branch: 'refs/heads/main',
          isMainWorktree: true,
          isArchived: false,
          ...(includeAgents ? { agents: [] } : {}),
        },
        ...value.orcaRows.map((row) => {
          const repoId = row.repoId ?? REPOSITORY_ID;
          return {
            id: `${repoId}::${row.path}`,
            path: row.path,
            head: row.head,
            branch: row.branch,
            linkedIssue: row.linkedIssue,
            isMainWorktree: row.isMainWorktree ?? false,
            isArchived: row.isArchived ?? false,
            ...(includeAgents ? { agents: row.agents ?? [] } : {}),
          };
        }),
      ],
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
    terminals: [] as TerminalRow[],
    creates: [] as string[],
    terminalCreates: [] as string[],
    createHandlers: [] as Array<(name: string) => ProcessResult>,
    runner: (() => processResult()) as CommandRunner,
    addGit(name: string, head = HEAD): string {
      const path = join(root, 'worktrees', name);
      this.gitRows.push({ path, head, branch: name });
      return path;
    },
    addDual(name: string, head = HEAD, agents: AgentRow[] = []): string {
      const path = this.addGit(name, head);
      this.orcaRows.push({
        path,
        head,
        branch: `refs/heads/${name}`,
        linkedIssue: ISSUE,
        agents,
      });
      return path;
    },
    addTerminal(path: string): TerminalRow {
      const terminal = {
        handle: `terminal-${String(this.terminals.length + 1)}`,
        worktreePath: path,
        tabId: `tab-${String(this.terminals.length + 1)}`,
      };
      this.terminals.push(terminal);
      return terminal;
    },
  } satisfies Fixture;
  value.runner = (invocation) => {
    const args = [...invocation.args];
    if (invocation.command === 'git' && args.includes('worktree') && args.includes('list')) {
      return processResult({ stdout: gitPayload(value) });
    }
    if (args[0] === 'worktree' && args[1] === 'list') {
      return processResult({ stdout: orcaPayload(value, false) });
    }
    if (args[0] === 'worktree' && args[1] === 'ps') {
      return processResult({ stdout: orcaPayload(value, true) });
    }
    if (args[0] === 'terminal' && args[1] === 'list') {
      return processResult({ stdout: JSON.stringify({ ok: true, result: { terminals: value.terminals } }) });
    }
    if (args[0] === 'worktree' && args[1] === 'create') {
      const name = args[args.indexOf('--name') + 1]!;
      value.creates.push(name);
      const handler = value.createHandlers.shift();
      if (!handler) throw new Error(`unexpected create: ${name}`);
      return handler(name);
    }
    if (args[0] === 'terminal' && args[1] === 'create') {
      const rawPath = args[args.indexOf('--worktree') + 1]!;
      const path = rawPath.replace(/^path:/, '');
      value.terminalCreates.push(path);
      if (value.terminalHandler) return value.terminalHandler(path);
      value.addTerminal(path);
      return processResult({ stdout: JSON.stringify({ ok: true }) });
    }
    throw new Error(`unexpected invocation: ${invocation.command} ${args.join(' ')}`);
  };
  return value;
}

function execute(value: Fixture): WorktreeCreateContinuationReport {
  return runCreateContinuation({
    repositoryRoot: value.repo,
    issueNumber: ISSUE,
    expectedHead: HEAD,
    terminalTitle: 'worker #1298',
    terminalCommand: 'agent --model test',
    operations: {
      runner: value.runner,
      orcaExecutable: 'orca-fixture',
      lockPath: value.lockPath,
    },
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('bounded worktree creation and worker spawn', () => {
  it('creates one exact worktree and one terminal under the same exclusion', () => {
    const value = fixture();
    value.createHandlers.push((name) => {
      value.addDual(name);
      return processResult({ stdout: JSON.stringify({ ok: true }) });
    });

    const report = execute(value);

    expect(report).toMatchObject({
      outcome: 'worker_spawned',
      terminalSpawnCompleted: true,
      terminalSpawnAuthorized: false,
      terminal: { handle: 'terminal-1' },
    });
    expect(report.attempts[0]?.candidateReports).toHaveLength(2);
    expect(value.creates).toEqual([PRIMARY]);
    expect(value.terminalCreates).toEqual([join(value.root, 'worktrees', PRIMARY)]);
  });

  it('ignores same-Issue active agents in a foreign Orca repository', () => {
    const value = fixture();
    const foreignPath = join(value.root, 'foreign-repo', PRIMARY);
    value.orcaRows.push({
      path: foreignPath,
      head: HEAD,
      branch: `refs/heads/${PRIMARY}`,
      linkedIssue: ISSUE,
      repoId: 'foreign-repository',
      agents: [{ state: 'working', interrupted: false }],
    });
    value.createHandlers.push((name) => {
      value.addDual(name);
      return processResult({ stdout: JSON.stringify({ ok: true }) });
    });

    expect(execute(value).outcome).toBe('worker_spawned');
    expect(value.creates).toEqual([PRIMARY]);
  });

  it('preserves Git-only state and performs one stable same-source replacement', () => {
    const value = fixture();
    value.createHandlers.push(
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

    expect(report.outcome).toBe('worker_spawned');
    expect(report.selected?.path).toBe(join(value.root, 'worktrees', REPLACEMENT));
    expect(report.attempts.map((attempt) => attempt.kind)).toEqual(['initial', 'replacement']);
    expect(value.creates).toEqual([PRIMARY, REPLACEMENT]);
  });

  it('recognizes a changed-name interrupted primary by stable Issue marker', () => {
    const value = fixture();
    value.addGit('caller-selected-1298-attempt');
    value.createHandlers.push((name) => {
      value.addDual(name);
      return processResult({ stdout: JSON.stringify({ ok: true }) });
    });

    const report = execute(value);

    expect(report.outcome).toBe('worker_spawned');
    expect(report.attempts.map((attempt) => attempt.kind)).toEqual(['replacement']);
    expect(value.creates).toEqual([REPLACEMENT]);
  });

  it('creates one replacement beside a same-head Orca-only row', () => {
    const value = fixture();
    value.orcaRows.push({
      path: join(value.root, 'worktrees', 'stale-orca-only'),
      head: HEAD,
      branch: 'refs/heads/stale-issue-1298',
      linkedIssue: ISSUE,
      agents: [],
    });
    value.createHandlers.push((name) => {
      value.addDual(name);
      return processResult({ stdout: JSON.stringify({ ok: true }) });
    });

    const report = execute(value);

    expect(report.outcome).toBe('worker_spawned');
    expect(report.attempts.map((attempt) => attempt.kind)).toEqual(['replacement']);
    expect(value.creates).toEqual([REPLACEMENT]);
  });

  it('blocks old-head Git and Orca family rows from reopening the create budget', () => {
    const gitOld = fixture();
    gitOld.addGit(PRIMARY, OTHER_HEAD);
    expect(execute(gitOld)).toMatchObject({ outcome: 'task_degraded', attempts: [], effects: [] });
    expect(gitOld.creates).toEqual([]);

    const orcaOld = fixture();
    orcaOld.orcaRows.push({
      path: join(orcaOld.root, 'worktrees', PRIMARY),
      head: OTHER_HEAD,
      branch: `refs/heads/${PRIMARY}`,
      linkedIssue: ISSUE,
      agents: [],
    });
    expect(execute(orcaOld)).toMatchObject({ outcome: 'task_degraded', attempts: [], effects: [] });
    expect(orcaOld.creates).toEqual([]);
  });

  it('preserves create-owned fallback/default terminals without replacement or second spawn', () => {
    for (const count of [1, 2]) {
      const value = fixture();
      value.createHandlers.push((name) => {
        const path = value.addDual(name);
        for (let index = 0; index < count; index += 1) value.addTerminal(path);
        return processResult({ stdout: JSON.stringify({ ok: true }) });
      });

      const report = execute(value);

      expect(report).toMatchObject({ outcome: 'task_degraded', terminalSpawnCompleted: false });
      expect(report.error).toMatch(/startup terminals/);
      expect(report.attempts[0]?.createOwnedTerminals).toHaveLength(count);
      expect(value.creates).toEqual([PRIMARY]);
      expect(value.terminalCreates).toEqual([]);
    }
  });

  it('blocks active and malformed Issue-family agent evidence', () => {
    const active = fixture();
    active.addDual(PRIMARY, HEAD, [{ state: 'working', interrupted: false }]);
    expect(execute(active)).toMatchObject({ outcome: 'task_degraded', attempts: [], effects: [] });
    expect(active.terminalCreates).toEqual([]);

    const malformed = fixture();
    malformed.addDual(PRIMARY, HEAD, [{ state: 'done' }]);
    expect(execute(malformed)).toMatchObject({ outcome: 'task_degraded', attempts: [], effects: [] });
    expect(malformed.terminalCreates).toEqual([]);
  });

  it('recovers create and terminal effects whose receipts were lost', () => {
    const value = fixture();
    value.createHandlers.push((name) => {
      value.addDual(name);
      return processResult({
        outcome: 'timeout', ok: false, exitCode: null, timedOut: true, stderr: 'create receipt lost',
      });
    });
    value.terminalHandler = (path) => {
      value.addTerminal(path);
      return processResult({
        outcome: 'timeout', ok: false, exitCode: null, timedOut: true, stderr: 'terminal receipt lost',
      });
    };

    const report = execute(value);

    expect(report.outcome).toBe('worker_spawned');
    expect(report.attempts[0]?.command).toMatchObject({ acknowledged: false, timedOut: true });
    expect(report.terminalSpawn?.command).toMatchObject({ acknowledged: false, timedOut: true });
    expect(value.creates).toEqual([PRIMARY]);
    expect(value.terminals).toHaveLength(1);
  });

  it('resumes an exact Issue-bound worktree and spawns once', () => {
    const value = fixture();
    const path = value.addDual(PRIMARY);

    expect(execute(value)).toMatchObject({
      outcome: 'worker_spawned',
      resumedExisting: true,
      selected: { path },
      attempts: [],
      terminal: { handle: 'terminal-1' },
    });
    expect(value.creates).toEqual([]);
  });

  it('refuses a sequential second caller after the first terminal exists', () => {
    const value = fixture();
    value.addDual(PRIMARY);

    expect(execute(value).outcome).toBe('worker_spawned');
    const second = execute(value);

    expect(second).toMatchObject({
      outcome: 'task_degraded',
      terminalSpawnCompleted: false,
      attempts: [],
      effects: [],
    });
    expect(second.error).toMatch(/existing or ambiguous Issue-family terminal/);
    expect(value.terminals).toHaveLength(1);
    expect(value.terminalCreates).toHaveLength(1);
  });

  it('gives a caller entering during terminal creation no-effect degraded control', () => {
    const value = fixture();
    value.addDual(PRIMARY);
    let loser: WorktreeCreateContinuationReport | undefined;
    value.terminalHandler = (path) => {
      loser = execute(value);
      value.addTerminal(path);
      return processResult({ stdout: JSON.stringify({ ok: true }) });
    };

    expect(execute(value).outcome).toBe('worker_spawned');
    expect(loser).toMatchObject({ outcome: 'task_degraded', attempts: [], effects: [] });
    expect(value.terminals).toHaveLength(1);
  });

  it('does not create a third worktree after primary and replacement are disputed', () => {
    const value = fixture();
    value.addGit(PRIMARY);
    value.addGit(REPLACEMENT);

    const report = execute(value);

    expect(report).toMatchObject({ outcome: 'task_degraded', attempts: [], effects: [] });
    expect(report.error).toMatch(/multiple pre-existing Issue-family candidates/);
    expect(value.creates).toEqual([]);
  });

  it('degrades after one replacement instead of creating a third worktree', () => {
    const value = fixture();
    value.createHandlers.push(
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

    expect(report).toMatchObject({ outcome: 'task_degraded', terminalSpawnCompleted: false });
    expect(value.creates).toEqual([PRIMARY, REPLACEMENT]);
    expect(value.terminalCreates).toEqual([]);
  });

  it('recovers a dead owner, blocks a live owner, and preserves a replaced lock on release', () => {
    const stale = fixture();
    writeFileSync(stale.lockPath, '99999999\n\nold-token\n', 'utf8');
    stale.createHandlers.push((name) => {
      stale.addDual(name);
      return processResult({ stdout: JSON.stringify({ ok: true }) });
    });
    expect(execute(stale).outcome).toBe('worker_spawned');

    const live = fixture();
    writeFileSync(live.lockPath, `${String(process.pid)}\n`, 'utf8');
    expect(execute(live)).toMatchObject({ outcome: 'task_degraded', attempts: [], effects: [] });
    expect(live.creates).toEqual([]);

    const replaced = fixture();
    const handle = acquireLifecycleExclusion(replaced.lockPath);
    expect(handle).not.toBeNull();
    writeFileSync(replaced.lockPath, `${String(process.pid)}\n\nreplacement-token\n`, 'utf8');
    releaseLifecycleExclusion(replaced.lockPath, handle!);
    expect(readFileSync(replaced.lockPath, 'utf8')).toContain('replacement-token');
  });
});
