// @vitest-ci-lane light
// @vitest-pre-topology-seconds 60
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runProcess, runProcessSync } from '../kernel/subprocess.ts';
import { resolvePackWorkerReportRequest, type ReportDeps } from '../pack-worker-report.ts';
import { resolveWakeSupervisorStateRoot } from '../pr2-foundation/wake-supervisor-state-root.ts';
import { publishCurrentWorkerAssignment, resolveWorkerAssignmentStorePath } from './worker-assignment-store.ts';
import { ensureProjectStateBinding } from './project-state-binding.ts';
import { readWorkerSmokeReceipt } from './worker-smoke-receipt.ts';
import {
  TargetContextError,
  TargetVerificationError,
  projectCardPath,
  resolveTargetContext,
  runTargetVerification,
} from './target-context.ts';

const roots: string[] = [];

function git(root: string, ...args: string[]): void {
  const result = runProcessSync({ command: 'git', args, cwd: root, inheritParentEnv: true });
  if (!result.ok) throw new Error(`git fixture failed: ${result.stderr || result.error || result.exitCode}`);
}

function fixture(input: {
  projectId?: string;
  repository?: string;
  basename?: string;
  projectUrl?: string;
  extraRemote?: boolean;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'opk-target-context-'));
  roots.push(root);
  const projectId = input.projectId ?? 'orchestrator-pack';
  const repository = input.repository ?? 'chetwerikoff/orchestrator-pack';
  const primaryRoot = join(root, input.basename ?? 'target');
  mkdirSync(primaryRoot, { recursive: true });
  git(primaryRoot, 'init');
  git(primaryRoot, 'remote', 'add', 'origin', `https://github.com/${repository}.git`);
  if (input.extraRemote) git(primaryRoot, 'remote', 'add', 'upstream', 'https://github.com/example/unrelated.git');
  const env = { ...process.env, XDG_CONFIG_HOME: join(root, 'config'), HOME: root };
  const cardPath = projectCardPath(projectId, env);
  mkdirSync(join(env.XDG_CONFIG_HOME, 'orchestrator-pack', 'projects'), { recursive: true });
  const card = {
    projectId,
    repository,
    primaryRoot,
    defaultBranch: 'main',
    orcaWorkspacePattern: `orca/workspaces/${projectId}/`,
    orchestratorTitlePattern: `${projectId}.*orchestrator`,
    browserGpt: { projectUrl: input.projectUrl ?? `https://chatgpt.com/g/${projectId}/project` },
    verification: { local: ['npm test'], focused: 'npm test -- {path}' },
  };
  writeFileSync(cardPath, JSON.stringify(card), 'utf8');
  return { root, env, cardPath, card, primaryRoot };
}

async function verifyCli(target: ReturnType<typeof fixture>, args: string[]) {
  return runProcess({
    command: process.execPath,
    args: [
      '--experimental-strip-types',
      join(import.meta.dirname, 'target-context.ts'),
      'verify', '--project', target.card.projectId, ...args,
    ],
    cwd: target.root,
    env: target.env,
    encoding: 'utf8',
  });
}

function codeOf(run: () => unknown): string {
  try {
    run();
    return 'no-error';
  } catch (error) {
    if (!(error instanceof TargetContextError) && !(error instanceof TargetVerificationError)) throw error;
    return error.code;
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('target context', () => {
  it('resolves one valid selected card into a frozen cwd-independent context', () => {
    const { env, primaryRoot } = fixture();
    const context = resolveTargetContext({ projectId: 'orchestrator-pack', env });
    expect(context).toMatchObject({
      projectId: 'orchestrator-pack',
      repository: 'chetwerikoff/orchestrator-pack',
      primaryRoot,
      defaultBranch: 'main',
      browserGpt: { projectUrl: 'https://chatgpt.com/g/orchestrator-pack/project' },
    });
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.browserGpt)).toBe(true);
  });

  it('fails closed for missing card, id/file mismatch, origin mismatch, and missing selection', () => {
    const missing = fixture();
    rmSync(missing.cardPath);
    expect(codeOf(() => resolveTargetContext({ projectId: 'orchestrator-pack', env: missing.env }))).toBe('card-missing');

    const mismatch = fixture();
    writeFileSync(mismatch.cardPath, JSON.stringify({ ...mismatch.card, projectId: 'other' }), 'utf8');
    expect(codeOf(() => resolveTargetContext({ projectId: 'orchestrator-pack', env: mismatch.env }))).toBe('project-id-mismatch');

    const origin = fixture();
    writeFileSync(origin.cardPath, JSON.stringify({ ...origin.card, repository: 'chetwerikoff/other' }), 'utf8');
    expect(codeOf(() => resolveTargetContext({ projectId: 'orchestrator-pack', env: origin.env }))).toBe('origin-mismatch');

    const unselected = fixture();
    const env = { ...unselected.env };
    delete env.OPK_PROJECT_ID;
    expect(codeOf(() => resolveTargetContext({ env }))).toBe('missing-selection');
  });

  it('accepts matching dual selectors and rejects disagreement with typed selector-mismatch', () => {
    const { env } = fixture();
    expect(resolveTargetContext({
      projectId: 'orchestrator-pack',
      env: { ...env, OPK_PROJECT_ID: 'orchestrator-pack' },
    }).projectId).toBe('orchestrator-pack');
    expect(codeOf(() => resolveTargetContext({
      projectId: 'orchestrator-pack',
      env: { ...env, OPK_PROJECT_ID: 'leopoker' },
    }))).toBe('selector-mismatch');
  });

  it('binds only origin and ignores unrelated additional GitHub remotes', () => {
    const { env } = fixture({ extraRemote: true });
    expect(resolveTargetContext({ projectId: 'orchestrator-pack', env }).repository)
      .toBe('chetwerikoff/orchestrator-pack');
  });

  it('runs exactly card verification.local commands through sh -lc in the explicit target worktree', () => {
    const target = fixture({ projectId: 'fixture-target', repository: 'example/fixture-target' });
    const commands = [
      '  printf "one:%s\\n" "$PWD" >> verification.log  ',
      'printf "two:%s\\n" "$PWD" >> verification.log',
    ];
    writeFileSync(target.cardPath, JSON.stringify({
      ...target.card,
      verification: { local: commands, focused: 'npm test -- {path}' },
    }), 'utf8');

    const context = resolveTargetContext({ projectId: 'fixture-target', env: target.env });
    const observed: Array<{
      command: string;
      args: readonly string[];
      cwd?: string;
      inheritParentEnv?: boolean;
      forwardOutputToStderr?: boolean;
    }> = [];
    const fakeResult = {
      outcome: 'exit' as const,
      ok: true,
      exitCode: 0,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      cancelled: false,
    };
    const fake = runTargetVerification({
      context,
      targetWorktreeRoot: target.primaryRoot,
      commandRunner(options) {
        observed.push({
          command: options.command,
          args: options.args ?? [],
          cwd: options.cwd,
          inheritParentEnv: options.inheritParentEnv,
          forwardOutputToStderr: options.forwardOutputToStderr,
        });
        return fakeResult;
      },
    });
    expect(fake.commandCount).toBe(2);
    expect(observed).toEqual(commands.map((command) => ({
      command: 'sh',
      args: ['-lc', command],
      cwd: target.primaryRoot,
      inheritParentEnv: true,
      forwardOutputToStderr: true,
    })));

    runTargetVerification({ context, targetWorktreeRoot: target.primaryRoot });
    expect(readFileSync(join(target.primaryRoot, 'verification.log'), 'utf8'))
      .toBe(`one:${target.primaryRoot}\ntwo:${target.primaryRoot}\n`);
  });

  it('fails invalid verification declarations before starting any command', () => {
    const target = fixture({ projectId: 'fixture-invalid', repository: 'example/fixture-invalid' });
    const variants: Array<{ value?: unknown; omit?: boolean; expected: string }> = [
      { omit: true, expected: 'verification-local-required' },
      { value: {}, expected: 'verification-local-required' },
      { value: { focused: 'npm test -- {path}' }, expected: 'verification-local-required' },
      { value: { local: [] }, expected: 'verification-local-required' },
      { value: { local: ['   '] }, expected: 'card-invalid' },
      { value: { local: ['printf started > verification-started', ' '] }, expected: 'card-invalid' },
    ];

    for (const variant of variants) {
      const card: Record<string, unknown> = { ...target.card };
      if (variant.omit) delete card.verification;
      else card.verification = variant.value;
      writeFileSync(target.cardPath, JSON.stringify(card), 'utf8');
      let commandCalls = 0;
      expect(codeOf(() => {
        const context = resolveTargetContext({ projectId: 'fixture-invalid', env: target.env });
        runTargetVerification({
          context,
          targetWorktreeRoot: target.primaryRoot,
          commandRunner() {
            commandCalls += 1;
            throw new Error('verification command must not start');
          },
        });
      })).toBe(variant.expected);
      expect(commandCalls).toBe(0);
      expect(existsSync(join(target.primaryRoot, 'verification-started'))).toBe(false);
    }
  });

  it('fails explicit worktree binding errors before verification commands and never substitutes primaryRoot', () => {
    const target = fixture({ projectId: 'fixture-binding', repository: 'example/fixture-binding' });
    const context = resolveTargetContext({ projectId: 'fixture-binding', env: target.env });
    const notWorktree = join(target.root, 'not-worktree');
    mkdirSync(notWorktree, { recursive: true });
    const nested = join(target.primaryRoot, 'nested');
    mkdirSync(nested, { recursive: true });
    const other = join(target.root, 'other');
    mkdirSync(other, { recursive: true });
    git(other, 'init');
    git(other, 'remote', 'add', 'origin', 'https://github.com/example/other.git');

    const cases = [
      { root: '', expected: 'target-worktree-required' },
      { root: notWorktree, expected: 'target-worktree-invalid' },
      { root: nested, expected: 'target-worktree-invalid' },
      { root: other, expected: 'target-worktree-repository-mismatch' },
    ];
    let commandCalls = 0;
    for (const item of cases) {
      expect(codeOf(() => runTargetVerification({
        context,
        targetWorktreeRoot: item.root,
        commandRunner() {
          commandCalls += 1;
          throw new Error('verification command must not start');
        },
      }))).toBe(item.expected);
    }
    expect(commandCalls).toBe(0);
  });

  it('fails fast on a non-zero local command and on spawn failure', () => {
    const target = fixture({ projectId: 'fixture-fail-fast', repository: 'example/fixture-fail-fast' });
    const commands = ['exit 7', 'printf later > later-sentinel'];
    writeFileSync(target.cardPath, JSON.stringify({
      ...target.card,
      verification: { local: commands },
    }), 'utf8');
    const context = resolveTargetContext({ projectId: 'fixture-fail-fast', env: target.env });

    expect(codeOf(() => runTargetVerification({
      context,
      targetWorktreeRoot: target.primaryRoot,
    }))).toBe('verification-command-failed');
    expect(existsSync(join(target.primaryRoot, 'later-sentinel'))).toBe(false);

    let spawnCalls = 0;
    expect(codeOf(() => runTargetVerification({
      context,
      targetWorktreeRoot: target.primaryRoot,
      commandRunner() {
        spawnCalls += 1;
        return {
          outcome: 'spawn-failure',
          ok: false,
          exitCode: null,
          signal: null,
          stdout: '',
          stderr: '',
          timedOut: false,
          cancelled: false,
          error: 'sh unavailable',
        };
      },
    }))).toBe('verification-command-spawn-failed');
    expect(spawnCalls).toBe(1);
  });

  it('rejects ambient Git overrides for non-worktrees and wrong repositories without losing command env', () => {
    const target = fixture({ projectId: 'fixture-ambient', repository: 'example/fixture-ambient' });
    const missing = join(target.root, 'not-a-worktree');
    mkdirSync(missing);
    const other = join(target.root, 'wrong-repo');
    mkdirSync(other);
    git(other, 'init');
    git(other, 'remote', 'add', 'origin', 'https://github.com/example/other.git');
    writeFileSync(target.cardPath, JSON.stringify({
      ...target.card,
      verification: { local: ['printf "%s" "$GIT_WORK_TREE" > inherited-env'] },
    }), 'utf8');
    const context = resolveTargetContext({ projectId: target.card.projectId, env: target.env });
    const keys = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'] as const;
    const previous = keys.map((key) => process.env[key]);
    let commandCalls = 0;
    try {
      process.env.GIT_DIR = join(target.primaryRoot, '.git');
      process.env.GIT_WORK_TREE = missing;
      process.env.GIT_CONFIG_COUNT = '1';
      process.env.GIT_CONFIG_KEY_0 = 'remote.origin.url';
      process.env.GIT_CONFIG_VALUE_0 = 'https://github.com/example/fixture-ambient.git';
      const reject = (root: string) => runTargetVerification({
        context,
        targetWorktreeRoot: root,
        commandRunner() {
          commandCalls += 1;
          throw new Error('command must not run');
        },
      });
      expect(codeOf(() => reject(missing))).toBe('target-worktree-invalid');
      process.env.GIT_WORK_TREE = other;
      expect(codeOf(() => reject(other))).toBe('target-worktree-repository-mismatch');
      delete process.env.GIT_DIR;
      delete process.env.GIT_WORK_TREE;
      expect(codeOf(() => reject(other))).toBe('target-worktree-repository-mismatch');
      expect(commandCalls).toBe(0);
      expect(existsSync(join(missing, 'inherited-env'))).toBe(false);
      expect(existsSync(join(other, 'inherited-env'))).toBe(false);

      process.env.GIT_WORK_TREE = missing;
      runTargetVerification({ context, targetWorktreeRoot: target.primaryRoot });
      expect(readFileSync(join(target.primaryRoot, 'inherited-env'), 'utf8')).toBe(missing);
    } finally {
      keys.forEach((key, index) => {
        if (previous[index] === undefined) delete process.env[key];
        else process.env[key] = previous[index];
      });
    }
  });

  it('executes only in the explicitly selected linked worktree, not the card primary checkout', () => {
    const target = fixture({ projectId: 'fixture-linked', repository: 'example/fixture-linked' });
    writeFileSync(join(target.primaryRoot, 'tracked.txt'), 'primary unchanged\n', 'utf8');
    git(target.primaryRoot, 'add', 'tracked.txt');
    git(target.primaryRoot, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
      '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture initial commit');
    const secondary = join(target.root, 'linked-secondary');
    git(target.primaryRoot, 'worktree', 'add', '-b', 'fixture-secondary', secondary);
    writeFileSync(target.cardPath, JSON.stringify({
      ...target.card,
      verification: { local: ['printf "%s" "$PWD" > verification-secondary'] },
    }), 'utf8');
    const context = resolveTargetContext({ projectId: target.card.projectId, env: target.env });
    const calls: Array<{ command: string; args?: readonly string[]; cwd?: string }> = [];
    runTargetVerification({
      context,
      targetWorktreeRoot: secondary,
      commandRunner(options) {
        calls.push({ command: options.command, args: options.args, cwd: options.cwd });
        return runProcessSync(options);
      },
    });
    expect(calls).toEqual([{
      command: 'sh',
      args: ['-lc', 'printf "%s" "$PWD" > verification-secondary'],
      cwd: secondary,
    }]);
    expect(readFileSync(join(secondary, 'verification-secondary'), 'utf8')).toBe(secondary);
    expect(existsSync(join(target.primaryRoot, 'verification-secondary'))).toBe(false);
    expect(readFileSync(join(target.primaryRoot, 'tracked.txt'), 'utf8')).toBe('primary unchanged\n');
  });

  it('streams more than 1 MiB of successful verification output to stderr without corrupting CLI JSON', async () => {
    const target = fixture({ projectId: 'fixture-output', repository: 'example/fixture-output' });
    writeFileSync(target.cardPath, JSON.stringify({
      ...target.card,
      verification: { local: [
        `${JSON.stringify(process.execPath)} -e 'process.stdout.write("x".repeat(1048577))'`,
        'printf success > after-large-output',
      ] },
    }), 'utf8');
    const result = await verifyCli(target, ['--target-worktree', target.primaryRoot]);
    expect(result.ok).toBe(true);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, commandCount: 2 });
    expect(result.stderr.length).toBeGreaterThan(1024 * 1024);
    expect(readFileSync(join(target.primaryRoot, 'after-large-output'), 'utf8')).toBe('success');
  });

  it('keeps failing command diagnostics visible on stderr, fails fast, and leaves stdout clean', async () => {
    const target = fixture({ projectId: 'fixture-diagnostics', repository: 'example/fixture-diagnostics' });
    writeFileSync(target.cardPath, JSON.stringify({
      ...target.card,
      verification: { local: ['printf "target diagnostic\\n" >&2; exit 17', 'printf later > later-sentinel'] },
    }), 'utf8');
    const result = await verifyCli(target, ['--target-worktree', target.primaryRoot]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('target diagnostic');
    expect(JSON.parse(result.stderr.trimEnd().split('\n').at(-1)!))
      .toMatchObject({ ok: false, code: 'verification-command-failed' });
    expect(existsSync(join(target.primaryRoot, 'later-sentinel'))).toBe(false);
  });

  it('reports all missing and blank --target-worktree forms as typed CLI errors before execution', async () => {
    const target = fixture({ projectId: 'fixture-cli-worktree', repository: 'example/fixture-cli-worktree' });
    writeFileSync(target.cardPath, JSON.stringify({
      ...target.card,
      verification: { local: ['printf unexpected > verification-started'] },
    }), 'utf8');
    for (const args of [[], ['--target-worktree'], ['--target-worktree', ' \t ']]) {
      const result = await verifyCli(target, args);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr.trimEnd().split('\n').at(-1)!))
        .toMatchObject({ ok: false, code: 'target-worktree-required' });
      expect(existsSync(join(target.primaryRoot, 'verification-started'))).toBe(false);
    }
  });

  it('uses the pack project card verification when the selected target is the pack itself', () => {
    const pack = fixture();
    const packCommand = 'printf pack-card';
    writeFileSync(pack.cardPath, JSON.stringify({
      ...pack.card,
      verification: { local: [packCommand] },
    }), 'utf8');
    const context = resolveTargetContext({ projectId: 'orchestrator-pack', env: pack.env });
    const observed: string[] = [];
    runTargetVerification({
      context,
      targetWorktreeRoot: pack.primaryRoot,
      commandRunner(options) {
        observed.push(String(options.args?.[1] ?? ''));
        return {
          outcome: 'exit',
          ok: true,
          exitCode: 0,
          signal: null,
          stdout: '',
          stderr: '',
          timedOut: false,
          cancelled: false,
        };
      },
    });
    expect(observed).toEqual([packCommand]);
  });

  it('keeps two cards distinct even when target roots share the same basename', () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-target-context-two-'));
    roots.push(root);
    const env = { ...process.env, XDG_CONFIG_HOME: join(root, 'config'), HOME: root };
    const cardsDir = join(env.XDG_CONFIG_HOME, 'orchestrator-pack', 'projects');
    mkdirSync(cardsDir, { recursive: true });
    for (const [projectId, repository] of [
      ['orchestrator-pack', 'chetwerikoff/orchestrator-pack'],
      ['leopoker', 'chetwerikoff/LeoPoker'],
    ] as const) {
      const primaryRoot = join(root, projectId, 'same-name');
      mkdirSync(primaryRoot, { recursive: true });
      git(primaryRoot, 'init');
      git(primaryRoot, 'remote', 'add', 'origin', `https://github.com/${repository}.git`);
      writeFileSync(projectCardPath(projectId, env), JSON.stringify({
        projectId,
        repository,
        primaryRoot,
        defaultBranch: 'main',
        orcaWorkspacePattern: `orca/workspaces/${projectId}/`,
        orchestratorTitlePattern: projectId,
        browserGpt: { projectUrl: `https://chatgpt.com/g/${projectId}/project` },
        verification: { local: ['npm test'] },
      }), 'utf8');
    }
    const pack = resolveTargetContext({ projectId: 'orchestrator-pack', env });
    const leo = resolveTargetContext({ projectId: 'leopoker', env });
    expect(pack.repository).not.toBe(leo.repository);
    expect(pack.browserGpt.projectUrl).not.toBe(leo.browserGpt.projectUrl);
  });

  it('binds automatic worker reports to the selected project repository but reads the PR head from its worktree', async () => {
    const target = fixture();
    const env = {
      ...target.env,
      OPK_PROJECT_ID: 'orchestrator-pack',
      OPK_WAKE_SUPERVISOR_STATE_DIR: '',
      OPK_BASE_DIR: target.root,
      XDG_STATE_HOME: join(target.root, 'state'),
    };
    const stateRoot = resolveWakeSupervisorStateRoot({ env, projectId: 'orchestrator-pack' });
    ensureProjectStateBinding(stateRoot, { projectId: 'orchestrator-pack', repository: target.card.repository });
    const assignmentStore = resolveWorkerAssignmentStorePath('orchestrator-pack', env);
    const assignment = await publishCurrentWorkerAssignment({
      file: assignmentStore,
      repository: target.card.repository,
      issueNumber: 2186,
      taskId: 'task-report-2186',
      kind: 'remote',
      provider: 'browser-gpt',
      bindingKey: 'remote-report-2186',
      role: 'worker',
    });
    if (!assignment.ok) throw new Error(assignment.reason);
    const worktree = join(target.root, 'implementation-worktree');
    mkdirSync(worktree, { recursive: true });
    git(worktree, 'init');
    git(worktree, 'remote', 'add', 'origin', `https://github.com/${target.card.repository}.git`);
    const calls: string[] = [];
    const run: NonNullable<ReportDeps['run']> = async (command, args, cwd) => {
      calls.push(`${command} ${args.join(' ')} @ ${cwd}`);
      if (command === 'git' && args.join(' ') === 'rev-parse --show-toplevel') {
        return { ok: true, stdout: `${worktree}\n` };
      }
      if (command === 'git' && args.join(' ') === 'rev-parse HEAD') {
        return { ok: true, stdout: `${'a'.repeat(40)}\n` };
      }
      if (command === 'gh' && args[0] === 'pr') {
        return { ok: true, stdout: JSON.stringify({
          number: 2234,
          state: 'OPEN',
          headRefOid: 'a'.repeat(40),
          body: 'Closes #2186',
        }) };
      }
      return { ok: false, stdout: '', stderr: 'unexpected child' };
    };
    const resolved = await resolvePackWorkerReportRequest(
      ['ready_for_review', '--repo-root', worktree],
      env,
      { run },
    );
    expect(resolved).toMatchObject({
      kind: 'ok',
      value: {
        repository: target.card.repository,
        repoRoot: worktree,
        issueNumber: 2186,
        prNumber: 2234,
        headSha: 'a'.repeat(40),
      },
    });
    expect(calls).toContain(`gh pr view --json number,state,headRefOid,body @ ${worktree}`);
    git(worktree, 'remote', 'set-url', 'origin', 'https://github.com/owner/other.git');
    await expect(resolvePackWorkerReportRequest(
      ['ready_for_review', '--repo-root', worktree], env, { run },
    )).resolves.toMatchObject({ kind: 'continue_work', reason: 'worktree_repository_mismatch' });
  });

  it('refuses smoke receipts after the selected project repository is retargeted', () => {
    const target = fixture();
    const env = {
      ...target.env,
      OPK_PROJECT_ID: 'orchestrator-pack',
      OPK_WAKE_SUPERVISOR_STATE_DIR: '',
      XDG_STATE_HOME: join(target.root, 'state'),
      WORKER_SMOKE_RECEIPT_ROOT: join(target.root, 'receipts'),
      OPK_VITEST_HARNESS: '',
    };
    const stateRoot = resolveWakeSupervisorStateRoot({ env, projectId: 'orchestrator-pack' });
    ensureProjectStateBinding(stateRoot, { projectId: 'orchestrator-pack', repository: target.card.repository });
    const keys = ['HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'OPK_PROJECT_ID', 'OPK_WAKE_SUPERVISOR_STATE_DIR', 'WORKER_SMOKE_RECEIPT_ROOT', 'OPK_VITEST_HARNESS'] as const;
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    try {
      for (const key of keys) process.env[key] = env[key] ?? '';
      expect(readWorkerSmokeReceipt(2234, 'b'.repeat(40))).toBeNull();
      git(target.primaryRoot, 'remote', 'set-url', 'origin', 'https://github.com/owner/other.git');
      writeFileSync(target.cardPath, JSON.stringify({ ...target.card, repository: 'owner/other' }), 'utf8');
      expect(() => readWorkerSmokeReceipt(2234, 'b'.repeat(40)))
        .toThrow('project_state_binding_mismatch');
    } finally {
      for (const key of keys) {
        const value = previous[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
