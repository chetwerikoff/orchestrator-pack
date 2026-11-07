// @vitest-ci-lane light
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runProcessSync, type RunProcessSyncOptions } from './kernel/subprocess.ts';
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
  const calls: RunProcessSyncOptions[] = [];
  const diagnostics: string[] = [];
  let beforeRun: ((options: RunProcessSyncOptions) => void) | undefined;
  const deps = {
    home: root,
    diagnostic: (text: string) => { diagnostics.push(text); },
    run: (options: RunProcessSyncOptions) => {
      calls.push(options);
      beforeRun?.(options);
      // Fake gh only at the pack's REST transport boundary; Git and shell commands are real.
      if (options.command === join(context.packRoot, 'scripts', 'gh')) {
        expect(options.args).toEqual(['api', 'repos/example/formatter/pulls/42']);
        return { ...run({ command: process.execPath, args: ['-e', ''], inheritParentEnv: true }), stdout: JSON.stringify(pull) };
      }
      return run(options);
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
  return { root, primary, remote, head, context, pull, deps, calls, diagnostics, git, snapshot, expectRemoved,
    intercept: (fn: typeof beforeRun) => { beforeRun = fn; } };
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('manager formatter fix', () => {
  it('repairs in its own detached checkout, runs ordered commands and hooks, and publishes only the formatter tree', () => {
    const world = fixture();
    writeFileSync(join(world.primary, 'source.ts'), 'dirty operator source\n');
    writeFileSync(join(world.primary, 'operator.txt'), 'untracked operator file\n');
    const before = world.snapshot();
    const hook = join(world.primary, '.git', 'hooks', 'pre-commit');
    const hookMarker = join(world.root, 'hook-cwd');
    writeFileSync(hook, `#!/bin/sh\npwd > ${JSON.stringify(hookMarker)}\n`);
    chmodSync(hook, 0o755);
    const context = { ...world.context, verification: { formatter: {
      fix: [fix, node(`if (require("node:fs").readFileSync("source.ts", "utf8") !== ${JSON.stringify(formatted)}) process.exit(2)`)], check,
    } } };
    const result = runManagerFormatterFix(context, 42, world.deps);
    expect(result.outcome).toBe('published');
    const published = world.git(world.remote, 'rev-parse', 'refs/heads/fix/format');
    expect(result.message).toBe(`published formatter commit ${published}; next step: arm the CI self-wake`);
    expect(world.git(world.remote, 'show', `${published}:source.ts`)).toBe(formatted.trim());
    expect(world.git(world.remote, 'diff', '--name-only', world.head, published)).toBe('source.ts');
    expect(world.git(world.remote, 'log', '-1', '--format=%s', published)).toBe('Apply formatter');
    expect(world.git(world.remote, 'rev-parse', `${published}^`)).toBe(world.head);
    expect(world.snapshot()).toEqual(before);
    const checkout = readFileSync(hookMarker, 'utf8').trim();
    expect(checkout).toContain(join(world.root, '.local', 'state', 'orchestrator-pack', 'checkouts', 'formatter-pr-42-'));
    expect(world.calls.filter((call) => call.command === 'sh').map((call) => call.cwd)).toEqual([checkout, checkout, checkout]);
    expect(world.calls.find((call) => call.args?.[0] === 'worktree' && call.args[1] === 'add')?.args)
      .toEqual(['worktree', 'add', '--detach', checkout, world.head]);
    expect(world.calls.find((call) => call.args?.[0] === 'push')?.args)
      .toEqual(['push', 'origin', 'HEAD:refs/heads/fix/format']);
    expect(world.diagnostics).toEqual([]);
    expect(world.calls.filter((call) => call.command === join(world.context.packRoot, 'scripts', 'gh'))).toHaveLength(1);
    world.expectRemoved();
  });

  it('refuses an undeclared formatter before reading GitHub or creating a checkout', () => {
    const world = fixture();
    expect(runManagerFormatterFix({ ...world.context, verification: { local: ['make check'] } }, 42, world.deps))
      .toEqual({ outcome: 'refused', message: 'no formatter declared; next step: route the CI failure to GPT with its error lines' });
    expect(world.calls).toEqual([]);
    world.expectRemoved();
  });

  it('reports a clean formatter without a commit or push', () => {
    const world = fixture();
    const context = { ...world.context, verification: { formatter: { fix: ['true'], check: 'true' } } };
    expect(runManagerFormatterFix(context, 42, world.deps)).toEqual({ outcome: 'clean',
      message: `formatter clean on ${world.head}; next step: route the CI failure to GPT with its error lines` });
    expect(world.calls.some((call) => call.args?.[0] === 'commit' || call.args?.[0] === 'push')).toBe(false);
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
    expect(result.message).toContain('next step: send the remaining check errors to GPT');
    expect(world.diagnostics.join('\n')).toContain('remaining lint error');
    expect(world.diagnostics.join('\n')).toContain('M source.ts');
    expect(world.calls.some((call) => call.args?.[0] === 'commit' || call.args?.[0] === 'push')).toBe(false);
    expect(world.git(world.remote, 'rev-parse', 'refs/heads/fix/format')).toBe(world.head);
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
    expect(world.git(world.remote, 'rev-parse', 'refs/heads/fix/format')).toBe(advanced);
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
    expect(world.git(world.remote, 'rev-parse', 'refs/heads/fix/format')).toBe(world.head);
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
    expect(world.git(world.remote, 'rev-parse', 'refs/heads/fix/format')).toBe(world.head);
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
