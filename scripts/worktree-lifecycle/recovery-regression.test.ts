// @vitest-ci-lane light
// @vitest-pre-topology-seconds 120

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import type { ProcessResult } from '../kernel/subprocess.ts';
import type { ExpectedWorktreeIdentity } from './core.ts';
import { runLifecycle, type CommandRunner } from './operations.ts';

const TARGET_SHA = 'a'.repeat(40);
const MERGE_SHA = 'b'.repeat(40);
const TARGET_BRANCH = 'agent/issue-1298';
const REPOSITORY_ID = 'repo-1298';
const temporaryRoots = new Set<string>();

const completed = (stdout = ''): ProcessResult => ({
  outcome: 'exit',
  ok: true,
  exitCode: 0,
  signal: null,
  stdout,
  stderr: '',
  timedOut: false,
  cancelled: false,
});

const lostReceipt = (detail: string): ProcessResult => ({
  ...completed(),
  outcome: 'timeout',
  ok: false,
  exitCode: null,
  timedOut: true,
  stderr: detail,
});

type OpenPr = { number: number; headRefName: string };

interface Scenario {
  root: string;
  repo: string;
  target: string;
  commonDir: string;
  identity: ExpectedWorktreeIdentity;
  gitTargetPresent: boolean;
  orcaTargetPresent: boolean;
  removalAttempts: number;
  removalResponse: ProcessResult;
  ignoredStatus: string;
  openPrs: OpenPr[];
  runner: CommandRunner;
}

function inventoryJson(scenario: Scenario, includeTarget: boolean, includeAgents: boolean): string {
  return JSON.stringify({
    ok: true,
    result: {
      worktrees: [
        {
          id: `${REPOSITORY_ID}::${scenario.repo}`,
          path: scenario.repo,
          head: MERGE_SHA,
          branch: 'refs/heads/main',
          isMainWorktree: true,
          isArchived: false,
          ...(includeAgents ? { agents: [] } : {}),
        },
        ...(includeTarget ? [{
          id: `${REPOSITORY_ID}::${scenario.target}`,
          path: scenario.target,
          head: TARGET_SHA,
          branch: `refs/heads/${TARGET_BRANCH}`,
          linkedPR: 1300,
          isMainWorktree: false,
          isArchived: false,
          ...(includeAgents ? { agents: [] } : {}),
        }] : []),
      ],
    },
  });
}

function buildScenario(): Scenario {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opk-interrupted-recovery-'));
  temporaryRoots.add(root);
  const repo = path.join(root, 'repository');
  const target = path.join(root, 'worktrees', 'issue-1298');
  const commonDir = path.join(repo, '.git');
  const targetGitDir = path.join(commonDir, 'worktrees', 'issue-1298');
  fs.mkdirSync(targetGitDir, { recursive: true });
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, '.git'), `gitdir: ${targetGitDir}\n`, 'utf8');

  const scenario = {
    root,
    repo,
    target,
    commonDir,
    identity: {
      repositoryRoot: repo,
      path: target,
      headSha: TARGET_SHA,
      mode: 'branch-bound' as const,
      branchName: TARGET_BRANCH,
      bindingKind: 'pr' as const,
      bindingNumber: 1300,
    },
    gitTargetPresent: true,
    orcaTargetPresent: false,
    removalAttempts: 0,
    removalResponse: completed(),
    ignoredStatus: '',
    openPrs: [] as OpenPr[],
    runner: (() => completed()) as CommandRunner,
  } satisfies Scenario;

  scenario.runner = (call) => {
    const argv = [...call.args];
    const git = call.command === 'git';
    if (git && argv.includes('worktree') && argv.includes('list')) {
      const primary = [
        `worktree ${repo}`,
        `HEAD ${MERGE_SHA}`,
        'branch refs/heads/main',
        '',
      ];
      const secondary = scenario.gitTargetPresent
        ? [`worktree ${target}`, `HEAD ${TARGET_SHA}`, `branch refs/heads/${TARGET_BRANCH}`, '']
        : [];
      return completed([...primary, ...secondary].join('\n'));
    }
    if (argv[0] === 'worktree' && argv[1] === 'list') {
      return completed(inventoryJson(scenario, scenario.orcaTargetPresent, false));
    }
    if (argv[0] === 'worktree' && argv[1] === 'ps') {
      return completed(inventoryJson(scenario, scenario.orcaTargetPresent, true));
    }
    if (argv[0] === 'terminal' && argv[1] === 'list') {
      return completed(JSON.stringify({ ok: true, result: { terminals: [] } }));
    }
    if (call.command.endsWith('/scripts/gh') && argv[0] === 'pr' && argv[1] === 'view') {
      return completed(JSON.stringify({
        headRefName: TARGET_BRANCH,
        state: 'MERGED',
        headRefOid: TARGET_SHA,
        mergeCommit: { oid: MERGE_SHA },
        headRepository: { nameWithOwner: 'chetwerikoff/orchestrator-pack' },
        baseRefName: 'main',
      }));
    }
    if (call.command.endsWith('/scripts/gh') && argv[0] === 'pr' && argv[1] === 'list') {
      return completed(JSON.stringify(scenario.openPrs));
    }
    if (git && argv.includes('rev-parse') && argv.includes('--git-common-dir')) {
      return completed(`${commonDir}\n`);
    }
    if (git && argv.includes('status') && argv.includes('--untracked-files=all')) return completed();
    if (git && argv.includes('status') && argv.includes('--ignored=matching')) {
      return completed(scenario.ignoredStatus);
    }
    if (git && (argv.includes('merge-base') || argv.includes('fetch'))) return completed();
    if (git && argv.includes('worktree') && argv.includes('remove')) {
      scenario.removalAttempts += 1;
      scenario.gitTargetPresent = false;
      return scenario.removalResponse;
    }
    if (git && argv.includes('branch') && argv.includes('--list')) return completed();
    throw new Error(`unexpected recovery call: ${call.command} ${argv.join(' ')}`);
  };
  return scenario;
}

function invoke(scenario: Scenario, apply: boolean) {
  return runLifecycle({
    expected: scenario.identity,
    context: 'explicit-recovery',
    apply,
    operations: {
      runner: scenario.runner,
      orcaExecutable: 'orca-fixture',
      lockPath: path.join(scenario.root, 'lifecycle.lock'),
      processCensus: () => [],
    },
  });
}

afterAll(() => {
  for (const root of temporaryRoots) fs.rmSync(root, { recursive: true, force: true });
});

describe('unknown recovery outcomes', () => {
  test('settles effect-before-receipt from dual absence without another removal', () => {
    const scenario = buildScenario();
    scenario.removalResponse = lostReceipt('response lost after Git removed the target');

    expect(invoke(scenario, true).outcome).toBe('git_only_recovered');
    expect(invoke(scenario, true).outcome).toBe('already_absent');
    expect(scenario.removalAttempts).toBe(1);
  });

  test('preserves an Orca-only remainder after partial deletion', () => {
    const scenario = buildScenario();
    scenario.removalResponse = lostReceipt('response lost during cross-inventory transition');
    const originalRunner = scenario.runner;
    scenario.runner = (call) => {
      const response = originalRunner(call);
      if (call.command === 'git' && call.args.includes('worktree') && call.args.includes('remove')) {
        scenario.orcaTargetPresent = true;
      }
      return response;
    };

    expect(invoke(scenario, true).outcome).toBe('cleanup_deferred');
    const settlement = invoke(scenario, true);

    expect(settlement).toMatchObject({ outcome: 'cleanup_deferred', pipelineContinues: true });
    expect(settlement.classification.classification).toBe('orca_only');
    expect(scenario.removalAttempts).toBe(1);
  });
});

describe('historical recovery preservation', () => {
  test('refuses non-allowlisted ignored data', () => {
    const scenario = buildScenario();
    scenario.ignoredStatus = '!! private-cache/\n';

    expect(invoke(scenario, false)).toMatchObject({
      outcome: 'cleanup_deferred',
      gates: { ignoredData: false },
      effects: [],
    });
    expect(scenario.removalAttempts).toBe(0);
  });

  test('refuses a branch reused by another open pull request', () => {
    const scenario = buildScenario();
    scenario.openPrs = [{ number: 1301, headRefName: TARGET_BRANCH }];

    expect(invoke(scenario, false)).toMatchObject({
      outcome: 'cleanup_deferred',
      gates: { branchOwnership: false },
      effects: [],
    });
    expect(scenario.removalAttempts).toBe(0);
  });
});
