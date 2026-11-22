// @vitest-ci-lane light
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runProcessSync, type RunProcessSyncOptions, type RunProcessSyncResult } from './kernel/subprocess.ts';
import type { TargetContext } from './lib/target-context.ts';
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

interface CiState {
  headSha: string;
  status: string;
  conclusion: string | null;
  steps: Array<{ name: string; status: string; conclusion: string | null; number: number }>;
  logs: string;
  totalCount?: number;
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
  const blank = (): RunProcessSyncResult => run({ command: process.execPath, args: ['-e', ''], inheritParentEnv: true });
  const deps = {
    home: root,
    diagnostic: (text: string) => { diagnostics.push(text); },
    run: (options: RunProcessSyncOptions) => {
      calls.push(options);
      beforeRun?.(options);
      if (options.command === 'git' && options.args?.[0] === 'rev-list' && failRevList) {
        const failed = run({ command: process.execPath, args: ['-e', 'process.exit(1)'], inheritParentEnv: true });
        return { ...failed, stderr: 'bad ancestry' };
      }
      if (options.command === ghPath(context.packRoot)) {
        const endpoint = String(options.args?.[1] ?? '');
        let stdout = '';
        if (endpoint === 'repos/example/formatter/pulls/42') stdout = JSON.stringify(pull);
        else if (endpoint === `repos/example/formatter/commits/${pull.head.sha}/check-runs`) {
          const runs = [{
            id: 1, name: 'CI / checks', status: ci.status, conclusion: ci.conclusion, head_sha: ci.headSha,
            details_url: 'https://github.com/example/formatter/actions/runs/100/job/200',
            output: { title: 'lint', summary: ci.logs, text: ci.logs },
          }];
          stdout = JSON.stringify({ total_count: ci.totalCount ?? runs.length, check_runs: runs });
        } else if (endpoint === 'repos/example/formatter/actions/jobs/200') {
          stdout = JSON.stringify({
            id: 200, run_id: 100, run_attempt: 4, status: 'completed', conclusion: 'failure',
            name: 'CI / checks', head_sha: ci.headSha, steps: ci.steps,
          });
        } else if (endpoint === 'repos/example/formatter/actions/jobs/200/logs') stdout = ci.logs;
        else throw new Error(`unexpected gh endpoint ${endpoint}`);
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
      'repos/example/formatter/actions/jobs/200',
      'repos/example/formatter/actions/jobs/200/logs',
    ]);
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
