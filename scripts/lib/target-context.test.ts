// @vitest-ci-lane light
// @vitest-pre-topology-seconds 60
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runProcess, runProcessSync } from '../kernel/subprocess.ts';
import { resolvePackWorkerReportRequest, type ReportDeps } from '../pack-worker-report.ts';
import { resolveWakeSupervisorStateRoot } from '../pr2-foundation/wake-supervisor-state-root.ts';
import { publishCurrentWorkerAssignment, resolveWorkerAssignmentStorePath } from './worker-assignment-store.ts';
import { ensureProjectStateBinding } from './project-state-binding.ts';
import { isCommandSafe } from './reverify-command-resolution.ts';
import { runContractEvidenceReverify } from './contract-evidence-reverify.ts';
import { captureBoundIssueSnapshot } from './reverify-bound-issue-snapshot.ts';
import { isPrHeadNetworkSandboxAvailable } from './reverify-sandbox.ts';
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

async function checkCli(target: ReturnType<typeof fixture>) {
  return runProcess({
    command: process.execPath,
    args: [
      '--experimental-strip-types',
      join(import.meta.dirname, 'target-context.ts'),
      'check', '--project', target.card.projectId,
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
  it.each(['leopoker', 'appliedin', 'orchestrator-pack'])('defaults an existing %s-shaped card to no formatter', (projectId) => {
    const target = fixture({ projectId });
    expect(resolveTargetContext({ projectId, env: target.env }).verification)
      .toEqual({ local: ['npm test'], focused: 'npm test -- {path}' });
  });

  it('validates and freezes the optional formatter fix/check declaration', () => {
    const target = fixture();
    const formatter = { fix: ['uv run --locked ruff format .', 'uv run --locked ruff check --fix .'], check: 'make lint' };
    writeFileSync(target.cardPath, JSON.stringify({ ...target.card, verification: { ...target.card.verification, formatter } }));
    const actual = resolveTargetContext({ env: target.env, projectId: target.card.projectId }).verification?.formatter;
    expect(actual).toEqual(formatter);
    expect(Object.isFrozen(actual)).toBe(true);
    expect(Object.isFrozen(actual?.fix)).toBe(true);
    for (const malformed of [null, [], 'ruff', {}, { fix: [], check: 'make lint' },
      { fix: [' '], check: 'make lint' }, { fix: [1], check: 'make lint' },
      { fix: ['ruff format .'] }, { fix: ['ruff format .'], check: '' },
      { fix: ['ruff format .'], check: ['make lint'] }]) {
      writeFileSync(target.cardPath, JSON.stringify({ ...target.card, verification: { formatter: malformed } }));
      expect(codeOf(() => resolveTargetContext({ env: target.env, projectId: target.card.projectId }))).toBe('card-invalid');
    }
  });

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

  it('validates and freezes the optional project-owned evidence boundary without changing pack defaults', () => {
    const target = fixture({ projectId: 'synthetic-b13', repository: 'example/synthetic-b13' });
    expect(resolveTargetContext({ projectId: 'synthetic-b13', env: target.env }).contractEvidenceProducer)
      .toBeUndefined();

    writeFileSync(target.cardPath, JSON.stringify({
      ...target.card,
      contractEvidenceProducer: {
        name: 'target-status',
        boundaryCommand: 'node tests/fixtures/contract-evidence-reverify/producers/emit-reverify-status.mjs',
      },
    }), 'utf8');
    const declared = resolveTargetContext({ projectId: 'synthetic-b13', env: target.env });
    expect(declared.contractEvidenceProducer).toEqual({
      name: 'target-status',
      boundaryCommand: 'node tests/fixtures/contract-evidence-reverify/producers/emit-reverify-status.mjs',
    });
    expect(Object.isFrozen(declared.contractEvidenceProducer)).toBe(true);

    for (const bad of [[], { name: '', boundaryCommand: 'node tests/x.mjs' },
      { name: 'target-status', boundaryCommand: ['node tests/x.mjs', 'rm file'].join(String.fromCharCode(10)) }]) {
      writeFileSync(target.cardPath, JSON.stringify({ ...target.card, contractEvidenceProducer: bad }), 'utf8');
      expect(codeOf(() => resolveTargetContext({ projectId: 'synthetic-b13', env: target.env })))
        .toBe('card-invalid');
    }
    expect(codeOf(() => resolveTargetContext({ projectId: 'other-project', env: target.env })))
      .toBe('card-missing');
  });

  it('admits only the exact validated selected-card boundary under the target primary root', () => {
    const target = fixture({ projectId: 'synthetic-boundary', repository: 'example/synthetic-boundary' });
    const command = 'node scripts/verify-boundary.mjs';
    mkdirSync(join(target.primaryRoot, 'scripts'), { recursive: true });
    writeFileSync(join(target.primaryRoot, 'scripts', 'verify-boundary.mjs'), 'console.log("verified")\n');
    writeFileSync(join(target.primaryRoot, 'scripts', 'unlisted.mjs'), 'console.log("unlisted")\n');
    writeFileSync(target.cardPath, JSON.stringify({
      ...target.card,
      contractEvidenceProducer: { name: 'target-status', boundaryCommand: command },
    }), 'utf8');
    const selected = resolveTargetContext({ projectId: 'synthetic-boundary', env: target.env });
    const other = fixture({ projectId: 'other-boundary', repository: 'example/other-boundary' });
    const unrelated = resolveTargetContext({ projectId: 'other-boundary', env: other.env });

    expect(isCommandSafe(command, target.primaryRoot)).toBe(false);
    expect(isCommandSafe(command, target.primaryRoot, selected)).toBe(true);
    expect(isCommandSafe(command, target.primaryRoot, unrelated)).toBe(false);
    for (const untrusted of [
      'node scripts/unlisted.mjs',
      'node scripts/verify-boundary.mjs other-argument',
      'node scripts/verify-boundary.mjs; echo unsafe',
      'node ../verify-boundary.mjs',
      'sh -c node scripts/verify-boundary.mjs',
    ]) {
      expect(isCommandSafe(untrusted, target.primaryRoot, selected), untrusted).toBe(false);
    }
  });
  it('normalizes requiredCi workflow/job selectors, rejects ambiguous grammar and normalized duplicates, and exposes check read-back', async () => {
    const valid = fixture();
    writeFileSync(valid.cardPath, JSON.stringify({
      ...valid.card,
      requiredCi: ['  CI  /  checks  ', 'Release / verify'],
    }), 'utf8');
    const context = resolveTargetContext({ projectId: 'orchestrator-pack', env: valid.env });
    expect(context.requiredCi).toEqual(['CI / checks', 'Release / verify']);
    expect(Object.isFrozen(context.requiredCi)).toBe(true);
    const cli = await checkCli(valid);
    expect(cli.ok).toBe(true);
    expect(JSON.parse(cli.stdout)).toMatchObject({
      requiredCi: ['CI / checks', 'Release / verify'],
    });

    const invalid = fixture();
    for (const requiredCi of [
      [],
      ['CI/checks'],
      ['CI / '],
      ['CI / checks / extra'],
      ['CI / checks', ' ci / CHECKS '],
      ['CI / checks', 7],
    ]) {
      writeFileSync(invalid.cardPath, JSON.stringify({ ...invalid.card, requiredCi }), 'utf8');
      expect(codeOf(() => resolveTargetContext({
        projectId: 'orchestrator-pack',
        env: invalid.env,
      }))).toBe('card-invalid');
    }
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

  it('binds the selected card to the strict GitHub origin with case-insensitive equality', () => {
    const target = fixture({ repository: 'Example/MixedRepo' });
    for (const origin of [
      'https://github.com/example/mixedrepo.git',
      'git@github.com:EXAMPLE/MIXEDREPO.git',
      'ssh://git@github.com/Example/MixedRepo',
      'https://github.com:443/Example/MixedRepo.git',
      'ssh://git@github.com:22/EXAMPLE/MIXEDREPO.git',
    ]) {
      git(target.primaryRoot, 'remote', 'set-url', 'origin', origin);
      expect(resolveTargetContext({
        projectId: 'orchestrator-pack',
        env: target.env,
      }).repository).toBe('example/mixedrepo');
    }
    for (const untrusted of [
      'git@other.example:Example/MixedRepo.git',
      'https://github.com.attacker.example/Example/MixedRepo.git',
      'https://github.com:444/Example/MixedRepo.git',
      'ssh://git@github.com:222/Example/MixedRepo.git',
      'https://another.example/Example/MixedRepo',
      'Example/MixedRepo',
    ]) {
      git(target.primaryRoot, 'remote', 'set-url', 'origin', untrusted);
      expect(codeOf(() => resolveTargetContext({
        projectId: 'orchestrator-pack',
        env: target.env,
      })), untrusted).toBe('origin-mismatch');
    }
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


  it('Issue #2790: selected producer is bound to a distinct exact-SHA PR worktree in library and CLI', () => {
    const target = fixture({ projectId: 'synthetic-2790-w', repository: 'example/synthetic-2790-w' });
    const packRoot = join(import.meta.dirname, '..', '..');
    const p = target.primaryRoot;
    const w = join(target.root, 'review-pr');
    const producerDir = 'tests/fixtures/contract-evidence-reverify/producers';
    const manifestPath = 'tests/external-output-references/capture-manifest.json';
    const boundary = 'node scripts/selected-producer.mjs';
    const proof = 'node ' + producerDir + '/genuine-new-proof.mjs';
    const proofPath = 'tests/external-output-references/captures/synthetic/reverify.raw.json';
    const producer = "import { readFileSync } from 'node:fs';\n"
      + "process.stdout.write(readFileSync('" + proofPath + "', 'utf8'));\n";
    for (const rel of ['scripts', producerDir, 'tests/external-output-references/captures/synthetic']) {
      mkdirSync(join(p, rel), { recursive: true });
    }
    for (const file of ['genuine-new-proof.mjs', 'emit-reverify-status.mjs']) {
      copyFileSync(join(packRoot, producerDir, file), join(p, producerDir, file));
    }
    writeFileSync(join(p, producerDir, 'emit-reverify-status.mjs'), producer);
    writeFileSync(join(p, 'scripts/selected-producer.mjs'), producer);
    writeFileSync(join(p, proofPath), JSON.stringify({ 'reverify-status': 'primary-only' }));
    writeFileSync(join(p, manifestPath), JSON.stringify({
      version: 1, corpusRoot: 'tests/external-output-references', entries: {
        'synthetic/reverify': { producer: 'selected-status', kind: 'structured', path: 'captures/synthetic/reverify.raw.json' },
      },
    }));
    git(p, 'config', 'user.name', 'Fixture');
    git(p, 'config', 'user.email', 'fixture@example.test');
    git(p, 'add', '.');
    git(p, 'commit', '-m', 'primary P trusted closure');
    const sha = (cwd: string) => runProcessSync({
      command: 'git', args: ['rev-parse', 'HEAD'], cwd, inheritParentEnv: true,
    }).stdout.trim();
    const pSha = sha(p);
    git(p, 'worktree', 'add', '--detach', w, pSha);
    writeFileSync(join(w, proofPath), JSON.stringify({ 'reverify-status': 'verified' }));
    git(w, 'add', proofPath);
    git(w, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
      'commit', '-m', 'PR input differs from P');
    const prSha = sha(w);
    expect(prSha).not.toBe(pSha);
    expect(readFileSync(join(p, 'scripts/selected-producer.mjs')))
      .toEqual(readFileSync(join(w, 'scripts/selected-producer.mjs')));
    const card = { ...target.card, contractEvidenceProducer: {
      name: 'selected-status', boundaryCommand: boundary,
    } };
    writeFileSync(target.cardPath, JSON.stringify(card));
    const ticks = String.fromCharCode(96).repeat(3);
    const body = [
      '## Acceptance criteria', '1. Verify selected W producer.', '',
      ticks + 'producer-emission', 'producer: selected-status', 'datum: reverify-status',
      'expected: verified', 'proof-command: ' + proof, 'producer-command: ' + boundary,
      ticks, '', ticks + 'contract-evidence',
      'binding: selected worktree status',
      'binding-id: selected-status:reverify-status:verified',
      'producer: selected-status', 'evidence: NEW(produced-by AC#1)', ticks, '',
    ].join('\n');
    const library = (head: string | null, modified: string[] = [proofPath]) =>
      runContractEvidenceReverify({
        repoRoot: packRoot, trustedBaseRoot: p, reviewTargetRoot: w,
        projectId: card.projectId, env: target.env, manifestPath,
        boundSnapshotBody: body, explicitIssueNumber: 2790,
        prHeadSha: head, prModifiedPaths: modified,
      });
    const candidate = library(prSha);
    expect(candidate).toMatchObject({ runOutcome: 'rows-evaluated',
      candidateOnly: true, neverBlocks: true });
    expect(candidate.rows).toHaveLength(1);
    if (isPrHeadNetworkSandboxAvailable()) {
      expect(candidate.rows[0]).toMatchObject({
        status: 'verified', verificationMode: 'live', producerVerified: true,
      });
    } else {
      expect(candidate.rows[0]).toMatchObject({
        status: 'unverified', reason: 'producer-unreachable',
      });
    }
    const snapshotDir = join(target.root, 'bound-snapshots');
    const captured = captureBoundIssueSnapshot({
      projectId: card.projectId, prNumber: 2798, prHeadSha: prSha, issueNumber: 2790,
      issueBody: body, storeDirOverride: snapshotDir,
    });
    const modifiedFile = join(target.root, 'paths.txt');
    writeFileSync(modifiedFile, proofPath + '\n');
    const invoke = (head: string | null = prSha) => runProcessSync({
      command: process.execPath,
      args: ['--experimental-strip-types',
        join(packRoot, 'scripts/invoke-contract-evidence-reverify.ts'),
        '--repo-root', packRoot, '--trusted-base-root', p, '--review-target-root', w,
        '--manifest-path', manifestPath, '--snapshot-file', captured.snapshotPath,
        '--bound-snapshot-pr-number', '2798', '--bound-snapshot-issue-number', '2790',
        '--project-id', card.projectId, '--explicit-issue', '2790',
        ...(head === null ? [] : ['--pr-head-sha', head]),
        '--changed-paths-file', modifiedFile],
      env: { ...target.env, OPK_BOUND_ISSUE_SNAPSHOT_STORE_DIR: snapshotDir },
      inheritParentEnv: false,
    });
    const verifiedCli = invoke();
    expect(verifiedCli.exitCode, verifiedCli.stderr).toBe(0);
    expect(JSON.parse(verifiedCli.stdout)).toMatchObject({
      candidateOnly: true, neverBlocks: true, runOutcome: 'rows-evaluated',
    });
    expect(JSON.parse(verifiedCli.stdout).rows[0].status).toBe(candidate.rows[0]!.status);

    // Run the actual prompt commands, not a second hand-maintained argv recipe.
    const prompt = readFileSync(join(packRoot, 'prompts/codex_review_prompt.md'), 'utf8');
    const checkpoint = prompt.slice(prompt.indexOf('SnapshotFile="$(node'), prompt.indexOf('\n```', prompt.indexOf('SnapshotFile="$(node')));
    const issueFile = join(target.root, 'issue.md');
    const prFile = join(target.root, 'pr.md');
    writeFileSync(issueFile, body);
    writeFileSync(prFile, 'Closes #2790');
    const substitutions: Record<string, string> = {
      '<trusted-pack-root>': packRoot, '<trusted-base-root>': p, '<pr-worktree-path>': w,
      '<project-id>': card.projectId, '<pr-number>': '2798', '<issue-number>': '2790',
      '<sha>': prSha, '<issue-body>': issueFile, '<pr-body>': prFile, '<changed-paths>': modifiedFile,
    };
    const promptRun = (head: string) => runProcessSync({
      command: 'bash', args: ['-e', '-c', Object.entries({ ...substitutions, '<sha>': head })
        .reduce((command, [key, value]) => command.replaceAll(key, value), checkpoint)],
      env: { ...target.env, OPK_BOUND_ISSUE_SNAPSHOT_STORE_DIR: snapshotDir }, inheritParentEnv: false,
    });
    const promptResult = promptRun(prSha);
    expect(promptResult.exitCode, promptResult.stderr).toBe(0);
    expect(promptResult.stdout).toContain('(candidate evidence only)');
    expect(promptResult.stdout).toContain('never-blocks: true');
    expect(promptResult.stdout).toContain('run-outcome: rows-evaluated');
    expect(promptRun('f'.repeat(40)).exitCode).not.toBe(0);

    if (isPrHeadNetworkSandboxAvailable()) {
      // Deterministically switch the real clean W after admission, either before
      // proof's archive or between proof and independent producer. The preload
      // observes native git archive in subprocesses; production gets no test hook.
      for (const route of ['library', 'cli'] as const) {
        for (const switchAt of [1, 2]) {
          git(w, 'checkout', '--detach', prSha);
          const hook = join(target.root, `archive-${route}-${switchAt}.mjs`);
          const observed = join(target.root, `archive-${route}-${switchAt}.jsonl`);
          writeFileSync(hook, `import cp from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const original = cp.spawnSync;
let count = 0;
cp.spawnSync = function(command, args, options) {
  if (command === 'git' && args?.[0] === 'archive' && options?.cwd === ${JSON.stringify(w)}) {
    if (++count === ${switchAt}) {
      const changed = original('git', ['checkout', '--detach', ${JSON.stringify(pSha)}], { cwd: options.cwd });
      if (changed.status !== 0) throw new Error('fixture checkout failed');
    }
    appendFileSync(${JSON.stringify(observed)}, JSON.stringify(args) + '\\n');
  }
  return original.apply(this, arguments);
};
syncBuiltinESMExports();
`);
          const args = route === 'cli'
            ? ['--experimental-strip-types', join(packRoot, 'scripts/invoke-contract-evidence-reverify.ts'),
              '--repo-root', packRoot, '--trusted-base-root', p, '--review-target-root', w,
              '--manifest-path', manifestPath, '--snapshot-file', captured.snapshotPath,
              '--bound-snapshot-pr-number', '2798', '--project-id', card.projectId,
              '--explicit-issue', '2790', '--pr-head-sha', prSha, '--changed-paths-file', modifiedFile]
            : ['--experimental-strip-types', '--input-type=module', '--eval',
              `import { runContractEvidenceReverify } from ${JSON.stringify(join(packRoot, 'scripts/lib/contract-evidence-reverify.ts'))};
console.log(JSON.stringify(runContractEvidenceReverify(${JSON.stringify({
  repoRoot: packRoot, trustedBaseRoot: p, reviewTargetRoot: w, manifestPath,
  projectId: card.projectId, env: target.env, boundSnapshotBody: body,
  explicitIssueNumber: 2790, prHeadSha: prSha, prModifiedPaths: [proofPath],
})})));`];
          const output = runProcessSync({ command: process.execPath, args: ['--import', hook, ...args],
            env: { ...target.env, OPK_BOUND_ISSUE_SNAPSHOT_STORE_DIR: snapshotDir }, inheritParentEnv: false });
          expect(output.exitCode, output.stderr).toBe(0);
          expect(JSON.parse(output.stdout).rows[0], `${route} switch ${switchAt}`)
            .toMatchObject({ status: 'verified', verificationMode: 'live', producerVerified: true });
          expect(readFileSync(observed, 'utf8').trim().split('\n').map((line) => JSON.parse(line)))
            .toEqual([['archive', prSha], ['archive', prSha]]);
        }
      }
      git(w, 'checkout', '--detach', prSha);
      const objectRef = runProcessSync({ command: 'git', cwd: w, inheritParentEnv: true,
        args: ['rev-parse', '--git-path', `objects/${prSha.slice(0, 2)}/${prSha.slice(2)}`] });
      expect(objectRef.ok).toBe(true);
      const objectPath = resolve(w, objectRef.stdout.trim());
      const objectBytes = readFileSync(objectPath);
      const missingHook = join(target.root, 'archive-object-disappears.mjs');
      const missingLog = join(target.root, 'archive-object-disappears.jsonl');
      writeFileSync(missingHook, `import cp from 'node:child_process';
import { appendFileSync, unlinkSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const original = cp.spawnSync;
cp.spawnSync = function(command, args, options) {
  if (command === 'git' && args?.[0] === 'archive' && options?.cwd === ${JSON.stringify(w)}) {
    unlinkSync(${JSON.stringify(objectPath)});
    appendFileSync(${JSON.stringify(missingLog)}, JSON.stringify(args) + '\\n');
  }
  return original.apply(this, arguments);
};
syncBuiltinESMExports();
`);
      try {
        const missing = runProcessSync({ command: process.execPath,
          args: ['--import', missingHook, '--experimental-strip-types',
            join(packRoot, 'scripts/invoke-contract-evidence-reverify.ts'),
            '--repo-root', packRoot, '--trusted-base-root', p, '--review-target-root', w,
            '--manifest-path', manifestPath, '--snapshot-file', captured.snapshotPath,
            '--bound-snapshot-pr-number', '2798', '--project-id', card.projectId,
            '--explicit-issue', '2790', '--pr-head-sha', prSha, '--changed-paths-file', modifiedFile],
          env: { ...target.env, OPK_BOUND_ISSUE_SNAPSHOT_STORE_DIR: snapshotDir }, inheritParentEnv: false });
        expect(missing.exitCode, missing.stderr).toBe(0);
        expect(JSON.parse(missing.stdout).rows[0]).toMatchObject({ status: 'unverified' });
        expect(readFileSync(missingLog, 'utf8').trim()).toBe(JSON.stringify(['archive', prSha]));
      } finally { writeFileSync(objectPath, objectBytes); }
    }
    const unverified = (row: { status?: string; producerVerified?: boolean } | undefined) => {
      expect(row?.status).toBe('unverified');
      expect(row?.producerVerified).not.toBe(true);
    };
    unverified(library('f'.repeat(40)).rows[0]);
    unverified(library(null).rows[0]);
    expect(invoke('f'.repeat(40)).exitCode).toBe(2);
    expect(invoke(null).exitCode).toBe(2);
    unverified(library(prSha, ['scripts/selected-producer.mjs']).rows[0]);
    writeFileSync(modifiedFile, 'scripts/selected-producer.mjs\n');
    const blocked = invoke();
    expect(blocked.exitCode, blocked.stderr).toBe(0);
    unverified(JSON.parse(blocked.stdout).rows[0]);
    writeFileSync(modifiedFile, 'inputs/reverify.json\n');
    git(w, 'checkout', '--detach', pSha);
    unverified(library(prSha).rows[0]);
    const wrongCli = invoke();
    expect(wrongCli.exitCode, wrongCli.stderr).toBe(0);
    unverified(JSON.parse(wrongCli.stdout).rows[0]);
    git(w, 'checkout', '--detach', prSha);
    writeFileSync(join(w, 'scripts/selected-producer.mjs'), 'process.exit(88);\n');
    unverified(library(prSha).rows[0]);
    git(w, 'checkout', '--', 'scripts/selected-producer.mjs');
    git(w, 'remote', 'set-url', 'origin', 'https://github.com/example/other.git');
    unverified(library(prSha).rows[0]);
    git(w, 'remote', 'set-url', 'origin', 'https://github.com/' + card.repository + '.git');
    rmSync(join(p, 'scripts/selected-producer.mjs'));
    unverified(library(prSha).rows[0]);
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
