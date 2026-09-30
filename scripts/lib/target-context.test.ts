// @vitest-ci-lane light
// @vitest-pre-topology-seconds 60
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runProcessSync } from '../kernel/subprocess.ts';
import {
  TargetContextError,
  projectCardPath,
  resolveTargetContext,
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
    if (!(error instanceof TargetContextError)) throw error;
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
