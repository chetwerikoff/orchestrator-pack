// @vitest-ci-lane light
// @vitest-pre-topology-seconds 60
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runProcessSync } from '../kernel/subprocess.ts';
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
      'printf "one:%s\\n" "$PWD" >> verification.log',
      'printf "two:%s\\n" "$PWD" >> verification.log',
    ];
    writeFileSync(target.cardPath, JSON.stringify({
      ...target.card,
      verification: { local: commands, focused: 'npm test -- {path}' },
    }), 'utf8');

    const context = resolveTargetContext({ projectId: 'fixture-target', env: target.env });
    const observed: Array<{ command: string; args: readonly string[]; cwd?: string; inheritParentEnv?: boolean }> = [];
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
});
