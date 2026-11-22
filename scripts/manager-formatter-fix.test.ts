// @vitest-ci-lane light
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runProcessSync, type ProcessResult, type RunProcessSyncOptions } from './kernel/subprocess.ts';
import type { TargetContext } from './lib/target-context.ts';
import { parseGhArgv } from './lib/gh-parse-argv.mjs';
import { classifyArgv, matchInventoryRoute } from './lib/gh-inventory-match.mjs';
import { executeRestRoute } from './lib/gh-rest-routes.mjs';
import { formatterFixCli, runManagerFormatterFix } from './manager-formatter-fix.ts';

const roots: string[] = [];
const author = {
  GIT_AUTHOR_NAME: 'Formatter Fixture', GIT_AUTHOR_EMAIL: 'formatter@example.invalid',
  GIT_COMMITTER_NAME: 'Formatter Fixture', GIT_COMMITTER_EMAIL: 'formatter@example.invalid',
};
const original = 'export const value=1;\n';
const formatted = 'export const value = 1;\n';
const node = (code: string) => `${JSON.stringify(process.execPath)} -e '${code}'`;
const fix = node(`require("node:fs").writeFileSync("source.ts", ${JSON.stringify(formatted)})`);
const check = node(`process.exit(require("node:fs").readFileSync("source.ts", "utf8") === ${JSON.stringify(formatted)} ? 0 : 1)`);
const ghPath = (packRoot: string) => join(packRoot, 'scripts', 'gh');

interface CiStep {
  name: string;
  status: string;
  conclusion: string | null;
  number: number;
}

interface CiJob {
  id: number;
  runId: number;
  runAttempt: number;
  steps: CiStep[];
  logs: string;
  name?: string;
  conclusion?: string;
  omitCheckOutput?: boolean;
  logResult?: 'fail';
}

interface CiState {
  headSha: string;
  status: string;
  conclusion: string | null;
  steps: CiStep[];
  logs: string;
  totalCount?: number;
  jobs?: CiJob[];
  omitCheckOutput?: boolean;
  logResult?: 'fail';
  requiredContexts?: string[];
  protection?: 'unavailable';
}

function lintSteps() {
  return [{ name: 'lint', status: 'completed', conclusion: 'failure', number: 1 }];
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'opk-formatter-fix-'));
  roots.push(root);
  const primary = join(root, 'primary');
  const remote = join(root, 'remote.git');
  mkdirSync(primary);
  const run = (options: RunProcessSyncOptions) => runProcessSync({ ...options, env: { ...options.env, ...author } });
  const git = (cwd: string, ...args: string[]) => {
    const result = run({ command: 'git', args, cwd, inheritParentEnv: true });
    if (!result.ok) throw new Error(`${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  git(root, 'init', '--bare', '--initial-branch=main', remote);
  git(primary, 'init', '--initial-branch=main');
  git(primary, 'remote', 'add', 'origin', remote);
  writeFileSync(join(primary, 'source.ts'), original);
  git(primary, 'add', '.');
  git(primary, 'commit', '-m', 'Initial source');
  const head = git(primary, 'rev-parse', 'HEAD');
  git(primary, 'push', 'origin', 'HEAD:refs/heads/main', 'HEAD:refs/heads/fix/format');
  const context: TargetContext = {
    projectId: 'fixture', repository: 'example/formatter', primaryRoot: primary, defaultBranch: 'main',
    orcaWorkspacePattern: 'fixture', orchestratorTitlePattern: 'fixture',
    browserGpt: { projectUrl: 'https://chatgpt.com/g/fixture/project' },
    packRoot: resolve(import.meta.dirname, '..'), cardPath: join(root, 'card.json'),
    verification: { formatter: { fix: [fix], check } },
  };
  const pull = { state: 'open', head: { sha: head, ref: 'fix/format', repo: { full_name: context.repository } } };
  const ci: CiState = { headSha: head, status: 'completed', conclusion: 'failure', steps: lintSteps(), logs: 'source.ts:1:1 format error\n' };
  const calls: RunProcessSyncOptions[] = [];
  const diagnostics: string[] = [];
  let beforeRun: ((options: RunProcessSyncOptions) => void) | undefined;
  let failRevList = false;
  const blank = (): ProcessResult => run({ command: process.execPath, args: ['-e', ''], inheritParentEnv: true });
  const deps = {
    home: root,
    diagnostic: (text: string) => { diagnostics.push(text); },
    run: (options: RunProcessSyncOptions) => {
      calls.push(options);
      beforeRun?.(options);
      if (options.command === 'git' && options.args?.[0] === 'fetch' && options.cwd && existsSync(join(String(options.cwd), '.git', 'shallow'))) {
        return run({ ...options, args: [...(options.args ?? []), '--depth=1'] });
      }
      if (options.command === 'git' && options.args?.[1] === 'log' && failRevList) {
        const failed = run({ command: process.execPath, args: ['-e', 'process.exit(1)'], inheritParentEnv: true });
        return { ...failed, stderr: 'bad ancestry' };
      }
      if (options.command === ghPath(context.packRoot)) {
        const endpoint = String(options.args?.[1] ?? '');
        const jobs = ci.jobs ?? [{
          id: 200, runId: 100, runAttempt: 4, steps: ci.steps, logs: ci.logs, name: 'CI / checks',
        }];
        const jobMatch = /^repos\/example\/formatter\/actions\/jobs\/(\d+)$/u.exec(endpoint);
        const logMatch = /^repos\/example\/formatter\/actions\/jobs\/(\d+)\/logs$/u.exec(endpoint);
        let stdout = '';
        if (endpoint === 'repos/example/formatter/pulls/42') stdout = JSON.stringify(pull);
        else if (endpoint === `repos/example/formatter/commits/${pull.head.sha}/check-runs`) {
          const runs = jobs.map((job, index) => ({
            id: index + 1, name: job.name ?? 'CI / checks', status: ci.status, conclusion: ci.conclusion,
            head_sha: ci.headSha,
            details_url: `https://github.com/example/formatter/actions/runs/${job.runId}/job/${job.id}`,
            conclusion: job.conclusion ?? ci.conclusion,
            output: (job.omitCheckOutput ?? ci.omitCheckOutput) ? { title: 'lint' } : { title: 'lint', summary: job.logs, text: job.logs },
          }));
          stdout = JSON.stringify({ total_count: ci.totalCount ?? runs.length, check_runs: runs });
        } else if (jobMatch) {
          const job = jobs.find((candidate) => candidate.id === Number(jobMatch[1]));
          if (!job) throw new Error(`unexpected gh endpoint ${endpoint}`);
          stdout = JSON.stringify({
            id: job.id, run_id: job.runId, run_attempt: job.runAttempt, status: 'completed', conclusion: job.conclusion ?? 'failure',
            name: job.name ?? 'CI / checks', head_sha: ci.headSha, steps: job.steps,
          });
        } else if (endpoint === 'repos/example/formatter/branches/main/protection/required_status_checks') {
          if (ci.protection === 'unavailable') {
            const failed = run({ command: process.execPath, args: ['-e', 'process.exit(1)'], inheritParentEnv: true });
            return { ...failed, stderr: 'protection unavailable' };
          }
          stdout = JSON.stringify({ contexts: ci.requiredContexts ?? ['CI / checks'], checks: [] });
        } else if (logMatch) {
          const job = jobs.find((candidate) => candidate.id === Number(logMatch[1]));
          if (!job) throw new Error(`unexpected gh endpoint ${endpoint}`);
          if ((job.logResult ?? ci.logResult) === 'fail') {
            const failed = run({ command: process.execPath, args: ['-e', 'process.exit(1)'], inheritParentEnv: true });
            return { ...failed, stderr: 'log unavailable' };
          }
          stdout = job.logs;
        } else throw new Error(`unexpected gh endpoint ${endpoint}`);
        return { ...blank(), stdout };
      }
      const result = run(options);
      if (options.command === 'git' && options.args?.join(' ') === 'remote get-url --push --all origin') {
        return { ...result, stdout: result.stdout.split(/\r?\n/u)
          .map((url) => url === remote ? 'https://github.com/example/formatter.git' : url).join('\n') };
      }
      return result;
    },
  };
  const snapshot = () => ({
    branch: git(primary, 'symbolic-ref', '--short', 'HEAD'), head: git(primary, 'rev-parse', 'HEAD'),
    status: git(primary, 'status', '--porcelain'), source: readFileSync(join(primary, 'source.ts'), 'utf8'),
    main: git(remote, 'rev-parse', 'refs/heads/main'),
  });
  const expectRemoved = () => {
    const checkouts = join(root, '.local', 'state', 'orchestrator-pack', 'checkouts');
    expect(existsSync(checkouts) ? readdirSync(checkouts) : []).toEqual([]);
    expect(git(primary, 'worktree', 'list', '--porcelain').match(/^worktree /gmu)).toHaveLength(1);
  };
  const pointAt = (sha: string) => { pull.head.sha = sha; ci.headSha = sha; };
  const remoteHead = () => git(remote, 'rev-parse', 'refs/heads/fix/format');
  return {
    root, primary, remote, head, context, pull, ci, deps, calls, diagnostics, git, snapshot, expectRemoved, pointAt, remoteHead,
    intercept: (fn: typeof beforeRun) => { beforeRun = fn; },
    failRevList: () => { failRevList = true; },
  };
}

function shCommands(world: ReturnType<typeof fixture>, from = 0): string[] {
  return world.calls.slice(from).filter((call) => call.command === 'sh').map((call) => String(call.args?.[1] ?? ''));
}

function treeWithSource(world: ReturnType<typeof fixture>, parent: string, content: string): string {
  const index = join(world.root, 'tree.idx');
  const file = join(world.root, 'tree-source.ts');
  writeFileSync(file, content);
  const run = (args: string[]) => {
    const result = runProcessSync({
      command: 'git', args, cwd: world.primary, inheritParentEnv: true,
      env: { ...author, GIT_INDEX_FILE: index },
    });
    if (!result.ok) throw new Error(`${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  run(['read-tree', parent]);
  const blob = run(['hash-object', '-w', file]);
  run(['update-index', '--add', '--cacheinfo', '100644', blob, 'source.ts']);
  return run(['write-tree']);
}

function pushedCommit(world: ReturnType<typeof fixture>, parent: string, tree: string, subject: string, extraParent?: string): string {
  const args = ['commit-tree', tree, '-p', parent];
  if (extraParent) args.push('-p', extraParent);
  args.push('-m', subject);
  const sha = world.git(world.primary, ...args);
  world.git(world.primary, 'push', 'origin', `${sha}:refs/heads/fix/format`);
  return sha;
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('manager formatter fix', () => {
  it('C1 shim one commit repairs in its own detached checkout, runs ordered commands and hooks, and publishes only the formatter tree', () => {
    const world = fixture();
    writeFileSync(join(world.primary, 'source.ts'), 'dirty operator source\n');
    writeFileSync(join(world.primary, 'operator.txt'), 'untracked operator file\n');
    const before = world.snapshot();
    const hook = join(world.primary, '.git', 'hooks', 'pre-commit');
    const hookMarker = join(world.root, 'hook-cwd');
    writeFileSync(hook, `#!/bin/sh\npwd > ${JSON.stringify(hookMarker)}\n`);
    chmodSync(hook, 0o755);
    const secondFix = node(`if (require("node:fs").readFileSync("source.ts", "utf8") !== ${JSON.stringify(formatted)}) process.exit(2)`);
    const secondCheck = 'true';
    const context = { ...world.context, verification: { formatter: { fix: [fix, secondFix], checks: [check, secondCheck] } } };
    const result = runManagerFormatterFix(context, 42, world.deps);
    expect(result.outcome).toBe('published');
    const published = world.remoteHead();
    expect(result.message).toBe(`published formatter commit ${published}; next step: arm the CI self-wake`);
    expect(result.message).not.toContain('GPT');
    expect(world.git(world.remote, 'show', `${published}:source.ts`)).toBe(formatted.trim());
    expect(world.git(world.remote, 'diff', '--name-only', world.head, published)).toBe('source.ts');
    expect(world.git(world.remote, 'log', '-1', '--format=%s', published)).toBe('Apply formatter');
    expect(world.git(world.remote, 'rev-parse', `${published}^`)).toBe(world.head);
    expect(world.git(world.remote, 'rev-parse', `${published}^{tree}`)).toBe(world.git(world.primary, 'rev-parse', `${published}^{tree}`));
    expect(world.snapshot()).toEqual(before);
    const checkout = readFileSync(hookMarker, 'utf8').trim();
    expect(checkout).toContain(join(world.root, '.local', 'state', 'orchestrator-pack', 'checkouts', 'formatter-pr-42-'));
    expect(shCommands(world)).toEqual([check, secondCheck, fix, secondFix, check, secondCheck]);
    expect(world.calls.filter((call) => call.command === 'sh').every((call) => call.cwd === checkout)).toBe(true);
    expect(world.calls.find((call) => call.args?.[0] === 'worktree' && call.args[1] === 'add')?.args)
      .toEqual(['worktree', 'add', '--detach', checkout, world.head]);
    expect(world.calls.find((call) => call.args?.[0] === 'push')?.args)
      .toEqual(['push', 'origin', 'HEAD:refs/heads/fix/format']);
    expect(world.diagnostics).toEqual([]);
    expect(world.calls.filter((call) => call.command === ghPath(world.context.packRoot)).map((call) => call.args?.[1])).toEqual([
      'repos/example/formatter/pulls/42',
      `repos/example/formatter/commits/${world.head}/check-runs`,
      'repos/example/formatter/branches/main/protection/required_status_checks',
      'repos/example/formatter/actions/jobs/200',
      'repos/example/formatter/actions/jobs/200/logs',
    ]);
    expect(world.calls.filter((call) => call.command === ghPath(world.context.packRoot)).every((call) => call.args?.length === 2)).toBe(true);
    expect(world.calls.filter((call) => call.command === 'git' && call.args?.[1] === 'log')).toHaveLength(1);
    expect(world.calls.some((call) => call.args?.[0] === 'rev-list')).toBe(false);

    world.expectRemoved();
  });

  it('refuses an undeclared formatter before reading GitHub or creating a checkout', () => {
    const world = fixture();
    expect(runManagerFormatterFix({ ...world.context, verification: { local: ['make check'] } }, 42, world.deps))
      .toEqual({ outcome: 'refused', message: 'no formatter declared; next step: route the CI failure to GPT with its error lines' });
    expect(world.calls).toEqual([]);
    world.expectRemoved();
  });

  it('does not publish when local checks pass while CI lint stays red', () => {
    const world = fixture();
    const context = { ...world.context, verification: { formatter: { fix: ['true'], check: 'true' } } };
    const result = runManagerFormatterFix(context, 42, world.deps);
    expect(result.outcome).toBe('refused');
    expect(result.message).toContain('local formatter checks passed');
    expect(result.message).not.toContain('GPT fixer');
    expect(result.message).toContain('Do not send a GPT style turn');
    expect(world.calls.some((call) => call.args?.[0] === 'commit' || call.args?.[0] === 'push')).toBe(false);
    expect(world.remoteHead()).toBe(world.head);
    world.expectRemoved();
  });

  it.each(['fix', 'check', 'checkout hook'] as const)('excludes untracked output from a %s while publishing only tracked formatting', (producer) => {
    const world = fixture();
    const artifact = node('require("node:fs").mkdirSync(".venv"); require("node:fs").writeFileSync(".venv/local-report", "fixture artifact")');
    if (producer === 'checkout hook') {
      const hook = join(world.primary, '.git', 'hooks', 'post-checkout');
      writeFileSync(hook, `#!/bin/sh\n${artifact}\ngit add .venv\n`);
      chmodSync(hook, 0o755);
    }
    const context = { ...world.context, verification: { formatter: {
      fix: producer === 'fix' ? [fix, artifact] : [fix],
      check: producer === 'check' ? `${check} && ${artifact}` : check,
    } } };
    expect(runManagerFormatterFix(context, 42, world.deps).outcome).toBe('published');
    const published = world.remoteHead();
    expect(world.git(world.remote, 'diff', '--name-only', world.head, published)).toBe('source.ts');
    expect(world.git(world.remote, 'ls-tree', '-r', '--name-only', published)).toBe('source.ts');
    expect(world.diagnostics.join('\n')).toContain('.venv/local-report');
    world.expectRemoved();
  });

  it('does not create a formatter commit when the only output is an untracked artifact', () => {
    const world = fixture();
    const context = { ...world.context, verification: { formatter: {
      fix: [node('require("node:fs").writeFileSync("local-report", "fixture artifact")')], check,
    } } };
    const result = runManagerFormatterFix(context, 42, world.deps);
    expect(result.outcome).toBe('refused');
    expect(result.message).toContain('formatter check failed');
    expect(world.calls.some((call) => call.args?.[0] === 'commit' || call.args?.[0] === 'push')).toBe(false);
    expect(world.remoteHead()).toBe(world.head);
    world.expectRemoved();
  });

  it.each(['divergent', 'multiple'] as const)('refuses %s effective push destinations without touching either remote', (scenario) => {
    const world = fixture();
    const alternate = join(world.root, 'alternate.git');
    world.git(world.root, 'init', '--bare', '--initial-branch=main', alternate);
    if (scenario === 'multiple') world.git(world.primary, 'remote', 'set-url', '--add', '--push', 'origin', world.remote);
    world.git(world.primary, 'remote', 'set-url', '--add', '--push', 'origin', alternate);
    const result = runManagerFormatterFix(world.context, 42, world.deps);
    expect(result.outcome).toBe('refused');
    expect(result.message).toContain('configure exactly one origin push URL for example/formatter');
    expect(world.calls.some((call) => call.args?.[0] === 'push')).toBe(false);
    expect(world.remoteHead()).toBe(world.head);
    expect(world.git(alternate, 'for-each-ref', '--format=%(refname)')).toBe('');
    expect(world.diagnostics.join('\n')).not.toContain(alternate);
    world.expectRemoved();
  });

  it('refuses a foreign GitHub push URL even with the correct fetch remote', () => {
    const world = fixture();
    world.git(world.primary, 'remote', 'set-url', '--push', 'origin', 'https://github.com/other/formatter.git');
    expect(runManagerFormatterFix(world.context, 42, world.deps).outcome).toBe('refused');
    expect(world.calls.some((call) => call.args?.[0] === 'push')).toBe(false);
    expect(world.remoteHead()).toBe(world.head);
    world.expectRemoved();
  });

  it.each(['fix', 'check'] as const)('retains %s failure output and changed-file diagnostics before cleanup, without committing', (step) => {
    const world = fixture();
    const failure = node('console.error("remaining lint error"); process.exit(1)');
    const context = { ...world.context, verification: { formatter: {
      fix: step === 'fix' ? [fix, failure] : [fix], check: step === 'check' ? failure : check,
    } } };
    const result = runManagerFormatterFix(context, 42, world.deps);
    expect(result.outcome).toBe('refused');
    expect(result.message).toContain('Do not send a GPT style turn');
    expect(result.message).not.toContain('GPT fixer');
    expect(world.diagnostics.join('\n')).toContain('remaining lint error');
    expect(world.diagnostics.join('\n')).toContain('M source.ts');
    expect(world.calls.some((call) => call.args?.[0] === 'commit' || call.args?.[0] === 'push')).toBe(false);
    expect(world.remoteHead()).toBe(world.head);
    world.expectRemoved();
  });

  it.each(['closed', 'foreign repository', 'default branch', 'invalid SHA', 'invalid branch'])(
    'refuses a %s PR before fetching or creating a checkout', (scenario) => {
      const world = fixture();
      if (scenario === 'closed') world.pull.state = 'closed';
      if (scenario === 'foreign repository') world.pull.head.repo.full_name = 'someone/fork';
      if (scenario === 'default branch') world.pull.head.ref = 'main';
      if (scenario === 'invalid SHA') world.pull.head.sha = 'no-sha';
      if (scenario === 'invalid branch') world.pull.head.ref = 'bad..branch';
      const result = runManagerFormatterFix(world.context, 42, world.deps);
      expect(result.outcome).toBe('refused');
      expect(result.message).toContain('next step:');
      expect(world.calls.some((call) => call.args?.[0] === 'fetch')).toBe(false);
      world.expectRemoved();
    });

  function advanceBranch(world: ReturnType<typeof fixture>): string {
    const advanced = world.git(world.primary, 'commit-tree', `${world.head}^{tree}`, '-p', world.head, '-m', 'Author advance');
    world.git(world.primary, 'push', 'origin', `${advanced}:refs/heads/fix/format`);
    return advanced;
  }

  it('refuses a fetched SHA that no longer equals the live PR snapshot', () => {
    const world = fixture();
    advanceBranch(world);
    const result = runManagerFormatterFix(world.context, 42, world.deps);
    expect(result.outcome).toBe('refused');
    expect(result.message).toContain('run the command again on the new head');
    expect(world.calls.some((call) => call.args?.[0] === 'worktree')).toBe(false);
    world.expectRemoved();
  });

  it('does not retry a non-fast-forward rejection and removes its unpublished commit checkout', () => {
    const world = fixture();
    let advanced = '';
    world.intercept((options) => {
      if (options.args?.[0] === 'push') advanced = advanceBranch(world);
    });
    const result = runManagerFormatterFix(world.context, 42, world.deps);
    expect(result.outcome).toBe('refused');
    expect(result.message).toContain('run the command again on the new head');
    expect(world.calls.filter((call) => call.args?.[0] === 'push')).toHaveLength(1);
    expect(world.remoteHead()).toBe(advanced);
    expect(world.diagnostics.join('\n')).toContain('rejected');
    expect(world.diagnostics.join('\n')).toContain('source.ts');
    world.expectRemoved();
  });

  it('reports a hook rejection, preserving hooks and removing the checkout', () => {
    const world = fixture();
    const hook = join(world.primary, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, '#!/bin/sh\nprintf "hook rejected commit\\n" >&2\nexit 1\n');
    chmodSync(hook, 0o755);
    expect(runManagerFormatterFix(world.context, 42, world.deps).outcome).toBe('refused');
    expect(world.diagnostics.join('\n')).toContain('hook rejected commit');
    expect(world.calls.some((call) => call.args?.[0] === 'push')).toBe(false);
    expect(world.remoteHead()).toBe(world.head);
    world.expectRemoved();
  });

  it('reports a transport push failure truthfully without leaving its checkout', () => {
    const world = fixture();
    const hook = join(world.remote, 'hooks', 'pre-receive');
    writeFileSync(hook, '#!/bin/sh\nprintf "publication denied\\n" >&2\nexit 1\n');
    chmodSync(hook, 0o755);
    const result = runManagerFormatterFix(world.context, 42, world.deps);
    expect(result.outcome).toBe('refused');
    expect(result.message).toContain('repair the reported push failure');
    expect(world.diagnostics.join('\n')).toContain('publication denied');
    expect(world.remoteHead()).toBe(world.head);
    world.expectRemoved();
  });

  it('removes the reserved checkout directory if worktree creation fails', () => {
    const world = fixture();
    world.intercept((options) => {
      if (options.args?.[0] === 'worktree' && options.args[1] === 'add') throw new Error('checkout creation failed');
    });
    const result = runManagerFormatterFix(world.context, 42, world.deps);
    expect(result.outcome).toBe('refused');
    expect(result.message).toContain('checkout creation failed');
    world.expectRemoved();
  });

  it('rejects malformed CLI arguments with an actionable usage line', () => {
    for (const argv of [[], ['--project', 'fixture', '--pr', '0'], ['--project', 'fixture', '--pr', '42', '--force']]) {
      expect(formatterFixCli(argv)).toMatchObject({ outcome: 'refused' });
      expect(formatterFixCli(argv).message).toContain('next step:');
    }
  });
});

describe('C1 routing matrix', () => {
  it('publishes one candidate for a separate lint step and does not claim whole-CI formatter-only', () => {
    const world = fixture();
    const result = runManagerFormatterFix(world.context, 42, world.deps);
    expect(result.outcome).toBe('published');
    expect(result.message).not.toContain('whole-CI');
    expect(result.message).not.toContain('GPT');
    world.expectRemoved();
  });

  it('publishes one candidate when a composite lint step fails and later steps were not executed', () => {
    const world = fixture();
    world.ci.steps = [
      { name: 'lint', status: 'completed', conclusion: 'failure', number: 1 },
      { name: 'typecheck', status: 'completed', conclusion: 'skipped', number: 2 },
      { name: 'test', status: 'completed', conclusion: 'skipped', number: 3 },
    ];
    const result = runManagerFormatterFix(world.context, 42, world.deps);
    expect(result.outcome).toBe('published');
    expect(result.message).toContain('later steps were not executed and stay unknown');
    expect(result.message).toContain('not a whole-CI formatter-only claim');
    world.expectRemoved();
  });

  it('selects the GPT fixer for a logic-only failure and writes nothing', () => {
    const world = fixture();
    world.ci.steps = [
      { name: 'lint', status: 'completed', conclusion: 'success', number: 1 },
      { name: 'typecheck', status: 'completed', conclusion: 'failure', number: 2 },
    ];
    world.ci.logs = 'typecheck: expected number, got string\n';
    const result = runManagerFormatterFix(world.context, 42, world.deps);
    expect(result.outcome).toBe('gpt');
    expect(result.message).toContain('typecheck: expected number, got string');
    expect(result.message).toContain('run attempt 4');
    expect(result.message).toContain('existing GPT fixer');
    expect(shCommands(world)).toEqual([]);
    expect(world.remoteHead()).toBe(world.head);
    world.expectRemoved();
  });

  it.each(['lint job then test job', 'test job then lint job'] as const)('keeps every sibling job of the latest run attempt (%s)', (order) => {
    const world = fixture();
    const lintJob = {
      id: 201, runId: 100, runAttempt: 4, logs: 'source.ts:1:1 format error\n',
      steps: [{ name: 'lint', status: 'completed', conclusion: 'failure', number: 1 }],
    };
    const testJob = {
      id: 202, runId: 100, runAttempt: 4, logs: 'test failed: expected true\n',
      steps: [{ name: 'test', status: 'completed', conclusion: 'failure', number: 1 }],
    };
    const olderLint = {
      id: 199, runId: 100, runAttempt: 3, logs: 'old format error\n',
      steps: [{ name: 'lint', status: 'completed', conclusion: 'failure', number: 1 }],
    };
    world.ci.jobs = order === 'lint job then test job'
      ? [lintJob, testJob, olderLint]
      : [testJob, lintJob, olderLint];
    const result = runManagerFormatterFix(world.context, 42, world.deps);
    expect(result.outcome).toBe('gpt');
    expect(result.message).toContain('test failed: expected true');
    expect(result.message).not.toContain('old format error');
    expect(world.calls.some((call) => call.args?.[0] === 'commit' || call.args?.[0] === 'push')).toBe(false);
    expect(world.remoteHead()).toBe(world.head);
    const logCalls = world.calls.filter((call) => String(call.args?.[1] ?? '').endsWith('/logs'));
    expect(logCalls.map((call) => call.args)).toEqual([['api', 'repos/example/formatter/actions/jobs/202/logs']]);
    world.expectRemoved();
  });

  it('drops an older substantive attempt when the latest attempt is lint-only', () => {
    const world = fixture();
    world.ci.jobs = [
      {
        id: 202, runId: 100, runAttempt: 4, logs: 'source.ts:1:1 format error\n',
        steps: [{ name: 'lint', status: 'completed', conclusion: 'failure', number: 1 }],
      },
      {
        id: 201, runId: 100, runAttempt: 3, logs: 'test failed: expected true\n',
        steps: [{ name: 'test', status: 'completed', conclusion: 'failure', number: 1 }],
      },
    ];
    const result = runManagerFormatterFix(world.context, 42, world.deps);
    expect(result.outcome).toBe('published');
    expect(result.message).not.toContain('GPT');
    expect(result.message).not.toContain('test failed');
    expect(world.remoteHead()).not.toBe(world.head);
  });

  it('does not treat a composite lint and test step as a proved substantive failure', () => {
    const world = fixture();
    world.ci.steps = [{ name: 'Run lint, typecheck and tests', status: 'completed', conclusion: 'failure', number: 1 }];
    world.ci.logs = 'ruff failed\n';
    const result = runManagerFormatterFix(world.context, 42, world.deps);
    expect(result.outcome).toBe('refused');
    expect(result.message).toContain('unclassifiable failing step Run lint, typecheck and tests');
    expect(result.message).not.toContain('GPT fixer');
    expect(world.calls.some((call) => call.args?.[0] === 'commit' || call.args?.[0] === 'push')).toBe(false);
    expect(world.remoteHead()).toBe(world.head);
    world.expectRemoved();
  });

  it('reads check-runs and job steps through inventory routes', () => {
    const sha = 'a'.repeat(40);
    const checksArgv = ['api', `repos/example/formatter/commits/${sha}/check-runs`];
    expect(matchInventoryRoute(parseGhArgv(checksArgv))).toMatchObject({
      id: 'commit-check-runs', repoSlug: 'example/formatter', headSha: sha,
    });
    expect(matchInventoryRoute(parseGhArgv([...checksArgv, '--paginate']))).toBeNull();
    expect(matchInventoryRoute(parseGhArgv(['api', 'repos/example/formatter/actions/jobs/202']))).toMatchObject({
      id: 'actions-job', repoSlug: 'example/formatter', jobId: 202,
    });

    const root = mkdtempSync(join(tmpdir(), 'opk-ci-route-'));
    roots.push(root);
    const calls = join(root, 'calls.txt');
    writeFileSync(calls, '');
    const fake = join(root, 'gh');
    const page1 = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, head_sha: sha }));
    writeFileSync(fake, `#!/usr/bin/env node
const fs = require('node:fs');
const endpoint = process.argv[process.argv.indexOf('api') + 1];
fs.appendFileSync(process.env.GH_CALLS, endpoint + '\\n');
const sha = ${JSON.stringify(sha)};
const page1 = ${JSON.stringify(page1)};
const bodies = {
  ['repos/example/formatter/commits/' + sha + '/check-runs?per_page=100&page=1']: { total_count: 101, check_runs: page1 },
  ['repos/example/formatter/commits/' + sha + '/check-runs?per_page=100&page=2']: {
    total_count: 101,
    check_runs: [{ id: 101, head_sha: sha, details_url: 'https://github.com/example/formatter/actions/runs/100/job/202' }],
  },
  'repos/example/formatter/actions/jobs/201': { id: 201, run_id: 100, run_attempt: 4, steps: [{ name: 'lint', conclusion: 'failure' }] },
  'repos/example/formatter/actions/jobs/202': { id: 202, run_id: 100, run_attempt: 4, steps: [{ name: 'test', conclusion: 'failure' }] },
};
const body = bodies[endpoint];
if (!body) { process.stderr.write('missing ' + endpoint + '\\n'); process.exit(1); }
process.stdout.write('HTTP/2 200\\n\\n' + JSON.stringify(body));
`);
    chmodSync(fake, 0o755);
    const previous = process.env.GH_CALLS;
    process.env.GH_CALLS = calls;
    try {
      const classified = classifyArgv(checksArgv);
      const payload = executeRestRoute(classified.route!.id, {
        realGh: fake, parsed: classified.parsed, route: classified.route, cwd: root,
      }) as { total_count: number; check_runs: Array<{ id: number }> };
      expect(payload.total_count).toBe(101);
      expect(payload.check_runs).toHaveLength(101);
      expect(payload.check_runs.at(-1)?.id).toBe(101);
      for (const [id, name] of [[201, 'lint'], [202, 'test']] as const) {
        const jobArgv = classifyArgv(['api', `repos/example/formatter/actions/jobs/${id}`]);
        const job = executeRestRoute(jobArgv.route!.id, {
          realGh: fake, parsed: jobArgv.parsed, route: jobArgv.route, cwd: root,
        }) as { steps: Array<{ name: string }> };
        expect(job.steps[0]?.name).toBe(name);
      }
    } finally {
      if (previous === undefined) delete process.env.GH_CALLS;
      else process.env.GH_CALLS = previous;
    }
    expect(readFileSync(calls, 'utf8')).toContain('page=1');
    expect(readFileSync(calls, 'utf8')).toContain('page=2');

    const incomplete = join(root, 'incomplete-gh');
    writeFileSync(incomplete, `#!/usr/bin/env node
const endpoint = process.argv[process.argv.indexOf('api') + 1];
if (!endpoint.includes('page=1')) process.exit(1);
process.stdout.write('HTTP/2 200\\n\\n' + JSON.stringify({ total_count: 2, check_runs: [{ id: 1, head_sha: ${JSON.stringify(sha)} }] }));
`);
    chmodSync(incomplete, 0o755);
    const partial = classifyArgv(checksArgv);
    expect(() => executeRestRoute(partial.route!.id, {
      realGh: incomplete, parsed: partial.parsed, route: partial.route, cwd: root,
    })).toThrow(/check-runs pagination incomplete/);
  });

  it('uses the inventory job-log route and withholds unsafe or missing lines', () => {
    const bare = parseGhArgv(['api', 'repos/example/formatter/actions/jobs/200/logs']);
    expect(matchInventoryRoute(bare)).toMatchObject({ id: 'actions-job-log', jobId: 200, repoSlug: 'example/formatter' });
    const flagged = parseGhArgv(['api', 'repos/example/formatter/actions/jobs/200/logs', '--allow-escape-sequences']);
    expect(matchInventoryRoute(flagged)).toBeNull();

    const escaped = fixture();
    escaped.ci.steps = [{ name: 'typecheck', status: 'completed', conclusion: 'failure', number: 1 }];
    escaped.ci.logs = 'typecheck expected number\u001b[31m\n';
    escaped.ci.omitCheckOutput = true;
    const escapedResult = runManagerFormatterFix(escaped.context, 42, escaped.deps);
    expect(escapedResult.outcome).toBe('gpt');
    expect(escapedResult.message).toContain('typecheck expected number');
    expect(escapedResult.message).not.toContain('\u001b');
    expect(escaped.calls.filter((call) => String(call.args?.[1] ?? '').endsWith('/logs')).every((call) => call.args?.length === 2)).toBe(true);

    const unsafe = fixture();
    unsafe.ci.steps = [{ name: 'typecheck', status: 'completed', conclusion: 'failure', number: 1 }];
    unsafe.ci.logs = 'typecheck \u001b';
    unsafe.ci.omitCheckOutput = true;
    const unsafeResult = runManagerFormatterFix(unsafe.context, 42, unsafe.deps);
    expect(unsafeResult.outcome).toBe('refused');
    expect(unsafeResult.message).toContain('sanitized CI logs and check output are unavailable');
    expect(unsafeResult.message).toContain('GitHub UI');
    expect(unsafeResult.message).not.toContain('GPT fixer');
    expect(unsafeResult.message).not.toContain('\u001b');
    expect(unsafe.remoteHead()).toBe(unsafe.head);

    const missing = fixture();
    missing.ci.steps = [{ name: 'test', status: 'completed', conclusion: 'failure', number: 1 }];
    missing.ci.logs = '';
    missing.ci.omitCheckOutput = true;
    missing.ci.logResult = 'fail';
    const missingResult = runManagerFormatterFix(missing.context, 42, missing.deps);
    expect(missingResult.outcome).toBe('refused');
    expect(missingResult.message).toContain('sanitized CI logs and check output are unavailable');
    expect(missingResult.message).not.toContain('GPT fixer');
    expect(missing.calls.some((call) => call.args?.[0] === 'commit' || call.args?.[0] === 'push')).toBe(false);

    const secret = fixture();
    secret.ci.steps = [{ name: 'typecheck', status: 'completed', conclusion: 'failure', number: 1 }];
    secret.ci.logs = 'typecheck failed\ntoken=supersecretvalue ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\n';
    const secretResult = runManagerFormatterFix(secret.context, 42, secret.deps);
    expect(secretResult.outcome).toBe('gpt');
    expect(secretResult.message).toContain('typecheck failed');
    expect(secretResult.message).toContain('[redacted]');
    expect(secretResult.message).not.toContain('supersecretvalue');
    expect(secretResult.message).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
    expect(secret.remoteHead()).toBe(secret.head);
  });

  it('does not send a sibling lint log when the failed test job has no sanitized lines', () => {
    const world = fixture();
    world.ci.jobs = [
      {
        id: 201, runId: 100, runAttempt: 4, logs: 'source.ts:1:1 format error from lint job\n',
        steps: [{ name: 'lint', status: 'completed', conclusion: 'failure', number: 1 }],
      },
      {
        id: 202, runId: 100, runAttempt: 4, logs: '', conclusion: 'failure', omitCheckOutput: true, logResult: 'fail',
        steps: [{ name: 'test', status: 'completed', conclusion: 'failure', number: 1 }],
      },
    ];
    const result = runManagerFormatterFix(world.context, 42, world.deps);
    expect(result.outcome).toBe('refused');
    expect(result.message).toContain('sanitized CI logs and check output are unavailable');
    expect(result.message).not.toContain('format error from lint job');
    expect(result.message).not.toContain('GPT fixer');
    expect(world.remoteHead()).toBe(world.head);
  });


  it('publishes a required lint failure beside an unrelated successful job', () => {
    for (const sameRun of [true, false]) {
      const world = fixture();
      world.ci.requiredContexts = ['CI / checks'];
      world.ci.jobs = [
        {
          id: 501, runId: 100, runAttempt: 4, conclusion: 'failure', logs: 'source.ts:1:1 format error\n',
          name: 'CI / checks',
          steps: [{ name: 'lint', status: 'completed', conclusion: 'failure', number: 1 }],
        },
        {
          id: 502, runId: sameRun ? 100 : 101, runAttempt: 4, conclusion: 'success', logs: 'unrelated ok\n',
          name: 'unrelated',
          steps: [{ name: 'notify', status: 'completed', conclusion: 'success', number: 1 }],
        },
      ];
      const result = runManagerFormatterFix(world.context, 42, world.deps);
      expect(result.outcome).toBe('published');
      expect(result.message).not.toContain('required-check relevance is unproved');
      expect(world.remoteHead()).not.toBe(world.head);
    }
  });

  it('does not publish an optional lint failure when required CI is unavailable or unobserved', () => {
    const unavailable = fixture();
    unavailable.ci.protection = 'unavailable';
    const missingAuthority = runManagerFormatterFix(unavailable.context, 42, unavailable.deps);
    expect(missingAuthority.outcome).toBe('refused');
    expect(missingAuthority.message).toContain('required-check relevance is unproved');
    expect(missingAuthority.message).toContain('unavailable');
    expect(unavailable.remoteHead()).toBe(unavailable.head);

    const unobserved = fixture();
    unobserved.ci.requiredContexts = ['required CI'];
    unobserved.ci.jobs = [{
      id: 601, runId: 100, runAttempt: 4, conclusion: 'failure', logs: 'optional format error\n',
      name: 'optional lint',
      steps: [{ name: 'lint', status: 'completed', conclusion: 'failure', number: 1 }],
    }];
    const missingCheck = runManagerFormatterFix(unobserved.context, 42, unobserved.deps);
    expect(missingCheck.outcome).toBe('refused');
    expect(missingCheck.message).toContain('required check required CI was not observed');
    expect(unobserved.calls.some((call) => call.args?.[0] === 'commit' || call.args?.[0] === 'push')).toBe(false);
    expect(unobserved.remoteHead()).toBe(unobserved.head);
  });

  it('does not publish from an optional failed lint run when another current-head run succeeded', () => {
    const world = fixture();
    world.ci.requiredContexts = ['required CI'];
    world.ci.jobs = [
      {
        id: 301, runId: 100, runAttempt: 4, conclusion: 'success', logs: 'required ci passed\n',
        name: 'required CI',
        steps: [{ name: 'test', status: 'completed', conclusion: 'success', number: 1 }],
      },
      {
        id: 302, runId: 101, runAttempt: 1, conclusion: 'failure', logs: 'optional format error\n',
        name: 'optional lint experiment',
        steps: [{ name: 'lint', status: 'completed', conclusion: 'failure', number: 1 }],
      },
    ];
    const result = runManagerFormatterFix(world.context, 42, world.deps);
    expect(result.outcome).toBe('refused');
    expect(result.message).toContain('required-check relevance is unproved');
    expect(world.calls.some((call) => call.args?.[0] === 'commit' || call.args?.[0] === 'push')).toBe(false);
    expect(world.remoteHead()).toBe(world.head);
  });

  it('does not publish when a failed lint job shares a run with a successful job', () => {
    const world = fixture();
    world.ci.requiredContexts = ['required CI'];
    world.ci.jobs = [
      {
        id: 401, runId: 100, runAttempt: 4, conclusion: 'success', logs: 'required ci passed\n',
        name: 'required CI',
        steps: [{ name: 'test', status: 'completed', conclusion: 'success', number: 1 }],
      },
      {
        id: 402, runId: 100, runAttempt: 4, conclusion: 'failure', logs: 'optional format error\n',
        name: 'optional lint',
        steps: [{ name: 'lint', status: 'completed', conclusion: 'failure', number: 1 }],
      },
    ];
    const result = runManagerFormatterFix(world.context, 42, world.deps);
    expect(result.outcome).toBe('refused');
    expect(result.message).toContain('required-check relevance is unproved');
    expect(world.calls.some((call) => call.args?.[0] === 'commit' || call.args?.[0] === 'push')).toBe(false);
    expect(world.remoteHead()).toBe(world.head);
  });

  it('still sends a failed test job to GPT when a lint job in the same run succeeded', () => {
    const world = fixture();
    world.ci.requiredContexts = ['test'];
    world.ci.jobs = [
      {
        id: 411, runId: 100, runAttempt: 4, conclusion: 'success', logs: 'lint clean\n',
        name: 'lint',
        steps: [{ name: 'lint', status: 'completed', conclusion: 'success', number: 1 }],
      },
      {
        id: 412, runId: 100, runAttempt: 4, conclusion: 'failure', logs: 'test failed: expected true\n',
        name: 'test',
        steps: [{ name: 'test', status: 'completed', conclusion: 'failure', number: 1 }],
      },
    ];
    const result = runManagerFormatterFix(world.context, 42, world.deps);
    expect(result.outcome).toBe('gpt');
    expect(result.message).toContain('test failed: expected true');
    expect(result.message).not.toContain('lint clean');
    expect(world.calls.some((call) => call.args?.[0] === 'commit' || call.args?.[0] === 'push')).toBe(false);
    expect(world.remoteHead()).toBe(world.head);
  });

  it('gives a mixed lint and test failure to GPT and does not publish', () => {
    const world = fixture();
    world.ci.steps = [
      { name: 'lint', status: 'completed', conclusion: 'failure', number: 1 },
      { name: 'test', status: 'completed', conclusion: 'failure', number: 2 },
    ];
    world.ci.logs = 'test failed: expected true\n';
    const result = runManagerFormatterFix(world.context, 42, world.deps);
    expect(result.outcome).toBe('gpt');
    expect(result.message).toContain('test');
    expect(result.message).toContain('lint');
    expect(result.message).toContain('test failed: expected true');
    expect(world.calls.some((call) => call.args?.[0] === 'commit' || call.args?.[0] === 'push')).toBe(false);
    expect(world.remoteHead()).toBe(world.head);
    world.expectRemoved();
  });

  it('refuses a mutating pre-fix diagnostic before fix and publication', () => {
    const world = fixture();
    const mutate = node('require("node:fs").writeFileSync("source.ts", "mutated\\n")');
    const context = { ...world.context, verification: { formatter: { fix: [fix], check: mutate } } };
    const result = runManagerFormatterFix(context, 42, world.deps);
    expect(result.outcome).toBe('refused');
    expect(result.message).toContain('pre-fix check mutated tracked files');
    expect(result.message).toContain('Do not send a GPT style turn');
    expect(shCommands(world)).toEqual([mutate]);
    expect(world.remoteHead()).toBe(world.head);
    world.expectRemoved();
  });

  it.each(['pending', 'stale', 'unclassifiable'] as const)('does not guess a formatter or GPT route for %s CI evidence', (scenario) => {
    const world = fixture();
    if (scenario === 'pending') world.ci.status = 'in_progress';
    if (scenario === 'stale') world.ci.headSha = 'b'.repeat(40);
    if (scenario === 'unclassifiable') {
      world.ci.steps = [{ name: 'build', status: 'completed', conclusion: 'failure', number: 1 }];
    }
    const result = runManagerFormatterFix(world.context, 42, world.deps);
    expect(result.outcome).toBe('refused');
    expect(result.message).toContain('Do not send a guessed GPT diagnosis');
    expect(result.message).not.toContain('GPT fixer');
    expect(shCommands(world)).toEqual([]);
    expect(world.remoteHead()).toBe(world.head);
    world.expectRemoved();
  });
});

describe('C1 card gate', () => {
  it('refuses a later failing check with no stage, commit, or GPT style send', () => {
    const world = fixture();
    const failing = node('console.error("check 2 failed"); process.exit(1)');
    const context = { ...world.context, verification: { formatter: { fix: [fix], checks: ['true', failing] } } };
    const result = runManagerFormatterFix(context, 42, world.deps);
    expect(result.outcome).toBe('refused');
    expect(result.message).toContain(`formatter check failed: ${failing}`);
    expect(result.message).toContain('Do not send a GPT style turn');
    expect(world.calls.some((call) => call.args?.[0] === 'commit' || call.args?.[0] === 'push' || call.args?.[0] === 'add')).toBe(false);
    expect(world.remoteHead()).toBe(world.head);
    world.expectRemoved();
  });

  it('refuses a post-fix check that retargets a tracked symlink and exits zero', () => {
    const world = fixture();
    writeFileSync(join(world.primary, 'target-a'), 'same\n');
    writeFileSync(join(world.primary, 'target-b'), 'same\n');
    symlinkSync('target-a', join(world.primary, 'link'));
    world.git(world.primary, 'add', 'target-a', 'target-b', 'link');
    world.git(world.primary, 'commit', '-m', 'Track a symlink');
    const head = world.git(world.primary, 'rev-parse', 'HEAD');
    world.git(world.primary, 'push', 'origin', `${head}:refs/heads/fix/format`);
    world.pointAt(head);
    const retarget = node('const fs=require("node:fs"); const text=fs.readFileSync("source.ts","utf8"); if (text!==' + JSON.stringify(formatted) + ') process.exit(0); fs.unlinkSync("link"); fs.symlinkSync("target-b","link");');
    const context = { ...world.context, verification: { formatter: { fix: [fix], checks: [check, retarget] } } };
    const result = runManagerFormatterFix(context, 42, world.deps);
    expect(result.outcome).toBe('refused');
    expect(result.message).toContain('post-fix check mutated tracked files');
    expect(result.message).toContain(retarget);
    expect(world.calls.some((call) => call.args?.[0] === 'commit' || call.args?.[0] === 'push')).toBe(false);
    expect(world.remoteHead()).toBe(head);
    world.expectRemoved();
  });

  it('refuses a post-fix check that changes tracked content and exits zero', () => {
    const world = fixture();
    const mutateAfter = node(`const fs=require("node:fs"); const text=fs.readFileSync("source.ts","utf8"); if (text===${JSON.stringify(formatted)}) fs.writeFileSync("source.ts", text+"\\nmutated"); else process.exit(1);`);
    const context = { ...world.context, verification: { formatter: { fix: [fix], checks: [check, mutateAfter] } } };
    const result = runManagerFormatterFix(context, 42, world.deps);
    expect(result.outcome).toBe('refused');
    expect(result.message).toContain('post-fix check mutated tracked files');
    expect(result.message).toContain(mutateAfter);
    expect(result.message).toContain('Do not send a GPT style turn');
    expect(world.calls.some((call) => call.args?.[0] === 'commit' || call.args?.[0] === 'push')).toBe(false);
    expect(world.remoteHead()).toBe(world.head);
    world.expectRemoved();
  });

  it('makes no commit or GPT-style decision when local lint is clean and format CI is red', () => {
    const world = fixture();
    const context = { ...world.context, verification: { formatter: { fix: [fix], checks: ['true'] } } };
    const result = runManagerFormatterFix(context, 42, world.deps);
    expect(result.outcome).toBe('refused');
    expect(result.message).toContain('local formatter checks passed');
    expect(result.message).not.toContain('GPT fixer');
    expect(world.remoteHead()).toBe(world.head);
    world.expectRemoved();
  });
});

describe('C1 hook repeat', () => {
  it('publishes nothing for a second lint-red attempt on an Apply formatter head', () => {
    const world = fixture();
    expect(runManagerFormatterFix(world.context, 42, world.deps).outcome).toBe('published');
    const published = world.remoteHead();
    world.pointAt(published);
    const calls = world.calls.length;
    const result = runManagerFormatterFix(world.context, 42, world.deps);
    expect(result.outcome).toBe('refused');
    expect(result.message).toContain('current head is an Apply formatter commit');
    expect(shCommands(world, calls)).toEqual([]);
    expect(world.remoteHead()).toBe(published);
    world.expectRemoved();
  });

  it('publishes the first formatter repair when a historical merge hides no formatter commit', () => {
    const world = fixture();
    const root = world.head;
    const tree = world.git(world.primary, 'rev-parse', `${root}^{tree}`);
    const side = world.git(world.primary, 'commit-tree', tree, '-p', root, '-m', 'Side edit');
    const merge = pushedCommit(world, root, tree, 'Merge side', side);
    world.pointAt(merge);
    const result = runManagerFormatterFix(world.context, 42, world.deps);
    expect(result.outcome).toBe('published');
    const published = world.remoteHead();
    expect(world.git(world.remote, 'rev-parse', `${published}^`)).toBe(merge);
    expect(world.git(world.remote, 'log', '-1', '--format=%s', published)).toBe('Apply formatter');
  });

  it('does not treat a merge that hides Apply formatter on the second parent as a first episode', () => {
    const world = fixture();
    const root = world.head;
    const tree = world.git(world.primary, 'rev-parse', `${root}^{tree}`);
    const repair = world.git(world.primary, 'commit-tree', tree, '-p', root, '-m', 'Apply formatter');
    const merge = pushedCommit(world, root, tree, 'Merge repair', repair);
    world.pointAt(merge);
    const result = runManagerFormatterFix(world.context, 42, world.deps);
    expect(result.outcome).toBe('refused');
    expect(result.message).toContain('first-parent line is ambiguous');
    expect(world.calls.some((call) => call.args?.[0] === 'commit' || call.args?.[0] === 'push')).toBe(false);
    expect(world.remoteHead()).toBe(merge);
    world.expectRemoved();
  });

  it('does not treat a shallow history that hides Apply formatter as a first episode', () => {
    const world = fixture();
    expect(runManagerFormatterFix(world.context, 42, world.deps).outcome).toBe('published');
    const published = world.remoteHead();
    const tree = world.git(world.primary, 'rev-parse', `${published}^{tree}`);
    const rerun = pushedCommit(world, published, tree, 'ci: rerun');
    world.pointAt(rerun);
    const shallow = join(world.root, 'shallow');
    world.git(world.root, 'clone', '--no-local', '--depth', '1', '--branch', 'fix/format', world.remote, shallow);
    const context = { ...world.context, primaryRoot: shallow };
    const calls = world.calls.length;
    const result = runManagerFormatterFix(context, 42, world.deps);
    expect(result.outcome).toBe('refused');
    expect(result.message).toContain('first-parent ancestry is incomplete');
    expect(world.calls.slice(calls).some((call) => call.args?.[0] === 'commit' || call.args?.[0] === 'push')).toBe(false);
    expect(world.remoteHead()).toBe(rerun);
  });

  it('does not re-arm for a tree-identical ci: rerun child', () => {
    const world = fixture();
    expect(runManagerFormatterFix(world.context, 42, world.deps).outcome).toBe('published');
    const published = world.remoteHead();
    const tree = world.git(world.primary, 'rev-parse', `${published}^{tree}`);
    const rerun = pushedCommit(world, published, tree, 'ci: rerun');
    world.pointAt(rerun);
    const result = runManagerFormatterFix(world.context, 42, world.deps);
    expect(result.outcome).toBe('refused');
    expect(result.message).toContain('no tracked-content change');
    expect(world.remoteHead()).toBe(rerun);
    world.expectRemoved();
  });

  it('does not treat missing or ambiguous ancestry as a first formatter attempt', () => {
    const world = fixture();
    world.failRevList();
    const missing = runManagerFormatterFix(world.context, 42, world.deps);
    expect(missing.outcome).toBe('refused');
    expect(missing.message).toContain('first-parent ancestry is missing');
    expect(world.remoteHead()).toBe(world.head);

    const publishedWorld = fixture();
    expect(runManagerFormatterFix(publishedWorld.context, 42, publishedWorld.deps).outcome).toBe('published');
    const published = publishedWorld.remoteHead();
    const sideTree = publishedWorld.git(publishedWorld.primary, 'rev-parse', `${published}^{tree}`);
    const side = publishedWorld.git(publishedWorld.primary, 'commit-tree', sideTree, '-m', 'side');
    const merge = pushedCommit(publishedWorld, published, sideTree, 'merge', side);
    publishedWorld.pointAt(merge);
    const ambiguous = runManagerFormatterFix(publishedWorld.context, 42, publishedWorld.deps);
    expect(ambiguous.outcome).toBe('refused');
    expect(ambiguous.message).toContain('first-parent line is ambiguous');
    expect(publishedWorld.remoteHead()).toBe(merge);
    publishedWorld.expectRemoved();
  });

  it('reenters diagnosis for a tracked-content-changing descendant without an automatic commit', () => {
    const world = fixture();
    expect(runManagerFormatterFix(world.context, 42, world.deps).outcome).toBe('published');
    const published = world.remoteHead();
    const tree = treeWithSource(world, published, 'export const value = 2;\n');
    const child = pushedCommit(world, published, tree, 'Author edit');
    world.pointAt(child);
    const context = { ...world.context, verification: { formatter: { fix: [fix], check: 'true' } } };
    const calls = world.calls.length;
    const result = runManagerFormatterFix(context, 42, world.deps);
    expect(result.outcome).toBe('refused');
    expect(result.message).toContain(`new diagnostic episode eligible on ${child}`);
    expect(result.message).toContain('Do not publish a formatter commit');
    expect(shCommands(world, calls)).toEqual(['true']);
    expect(world.remoteHead()).toBe(child);
    world.expectRemoved();
  });

  it('does not push when a commit hook stages an unrelated tracked edit', () => {
    const world = fixture();
    writeFileSync(join(world.primary, 'notes.txt'), 'kept\n');
    world.git(world.primary, 'add', 'notes.txt');
    world.git(world.primary, 'commit', '-m', 'Add notes');
    const head = world.git(world.primary, 'rev-parse', 'HEAD');
    world.git(world.primary, 'push', 'origin', `${head}:refs/heads/fix/format`);
    world.pointAt(head);
    const hook = join(world.primary, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, '#!/bin/sh\nprintf "hooked\\n" >> notes.txt\ngit add notes.txt\n');
    chmodSync(hook, 0o755);
    const result = runManagerFormatterFix(world.context, 42, world.deps);
    expect(result.outcome).toBe('refused');
    expect(result.message).toContain('commit hook changed the tracked tree');
    expect(world.calls.some((call) => call.args?.[0] === 'push')).toBe(false);
    expect(world.remoteHead()).toBe(head);
    world.expectRemoved();
  });
});
