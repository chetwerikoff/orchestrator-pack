import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runProcessSync } from './kernel/subprocess.ts';
import {
  evaluateManagerBrowserEnvironmentPreflight,
  resolveManagerBrowserOperatorConfig,
} from './lib/command-runtime-bootstrap.mjs';

const roots: string[] = [];

function tempDir(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Issue #1998 manager environment preflight', () => {
  it('accepts CDP manager config without chromePath', () => {
    const profile = tempDir('opk-1998-profile-');
    const result = resolveManagerBrowserOperatorConfig({
      env: {
        DISCUSS_WITH_GPT_PROJECT_URL: 'https://chatgpt.com/g/project',
        DISCUSS_WITH_GPT_CHROME_USER_DATA_DIR: profile,
      },
    });
    expect(result).toEqual({
      ok: true,
      config: {
        projectUrl: 'https://chatgpt.com/g/project',
        chromeUserDataDir: profile,
        source: 'environment',
      },
    });
  });

  it('reports the foreign first gh before any workspace or browser admission', () => {
    const packRoot = resolve(process.cwd());
    const profile = tempDir('opk-1998-profile-');
    const foreignGh = join(tempDir('opk-1998-foreign-'), 'gh');
    const result = evaluateManagerBrowserEnvironmentPreflight({
      packRoot,
      effectivePath: process.env.PATH ?? '',
      env: {
        DISCUSS_WITH_GPT_PROJECT_URL: 'https://chatgpt.com/g/project',
        DISCUSS_WITH_GPT_CHROME_USER_DATA_DIR: profile,
      },
      tools: {
        node: process.execPath,
        packGh: join(packRoot, 'scripts', 'gh'),
        firstGh: foreignGh,
        nativeGh: '/usr/bin/gh',
      },
    });
    expect(result).toMatchObject({
      ok: false,
      probe: 'tracked_gh_path',
      reason: 'pack_gh_not_first_on_path',
    });
    if (!result.ok) {
      expect(result.evidence).toContain(foreignGh);
      expect(result.remedy).toContain('scripts');
      expect(result.remedy).toContain('first on PATH');
    }
  });

  it('proves the exported shared module resolves inside this worktree', () => {
    const packRoot = resolve(process.cwd());
    const profile = tempDir('opk-1998-profile-');
    const packGh = join(packRoot, 'scripts', 'gh');
    const result = evaluateManagerBrowserEnvironmentPreflight({
      packRoot,
      effectivePath: process.env.PATH ?? '',
      env: {
        DISCUSS_WITH_GPT_PROJECT_URL: 'https://chatgpt.com/g/project',
        DISCUSS_WITH_GPT_CHROME_USER_DATA_DIR: profile,
      },
      tools: {
        node: process.execPath,
        packGh,
        firstGh: packGh,
        nativeGh: '/usr/bin/gh',
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sharedModulePath).toContain(join('plugins', '_shared'));
      expect(result.config).not.toHaveProperty('chromePath');
    }
  });

  it('returns the npm ci remedy when the active worktree cannot resolve the shared export', () => {
    const fakeWorktree = tempDir('opk-1998-worktree-');
    const profile = tempDir('opk-1998-profile-');
    mkdirSync(join(fakeWorktree, 'scripts'), { recursive: true });
    mkdirSync(join(fakeWorktree, 'plugins', '_shared'), { recursive: true });
    const packGh = join(fakeWorktree, 'scripts', 'gh');
    const result = evaluateManagerBrowserEnvironmentPreflight({
      packRoot: fakeWorktree,
      effectivePath: process.env.PATH ?? '',
      env: {
        DISCUSS_WITH_GPT_PROJECT_URL: 'https://chatgpt.com/g/project',
        DISCUSS_WITH_GPT_CHROME_USER_DATA_DIR: profile,
      },
      tools: {
        node: process.execPath,
        packGh,
        firstGh: packGh,
        nativeGh: '/usr/bin/gh',
      },
    });
    expect(result).toMatchObject({
      ok: false,
      probe: 'workspace_shared_module',
      reason: 'workspace_dependencies_unavailable',
    });
    if (!result.ok) {
      expect(result.evidence).toContain('@orchestrator-pack/shared/lib/normalize.js');
      expect(result.remedy).toContain('npm ci --include=dev');
    }
  });

  it('reaches manager preflight in the real entrypoint when the active worktree cannot resolve shared', () => {
    const worktree = tempDir('opk-1998-entrypoint-worktree-');
    const scriptsDir = join(worktree, 'scripts');
    mkdirSync(scriptsDir, { recursive: true });
    mkdirSync(join(worktree, 'plugins', '_shared'), { recursive: true });
    writeFileSync(join(worktree, 'package.json'), '{}\n');
    const trackedGh = join(scriptsDir, 'gh');
    symlinkSync(join(resolve(process.cwd()), 'scripts', 'gh'), trackedGh);
    const profile = join(worktree, 'profile');
    mkdirSync(profile);
    const loader = join(worktree, 'block-workspace-shared-loader.mjs');
    writeFileSync(loader, [
      'export async function resolve(specifier, context, nextResolve) {',
      '  if (specifier.startsWith("@orchestrator-pack/shared/")) {',
      '    const error = new Error("workspace dependency unavailable: " + specifier);',
      '    error.code = "ERR_MODULE_NOT_FOUND";',
      '    throw error;',
      '  }',
      '  return nextResolve(specifier, context);',
      '}',
      '',
    ].join('\n'));
    const output = join(worktree, 'reply.txt');
    const handoff = join(worktree, 'handoff.json');
    const lifecycleState = join(worktree, 'lifecycle-state');
    const manager = join(resolve(process.cwd()), 'scripts', 'flow-manager-browser-gpt-long-run.ts');
    const result = runProcessSync({
      command: process.execPath,
      args: [
        '--experimental-strip-types', '--experimental-loader', loader, manager,
        '--run-identity', 'run-1998-subprocess',
        '--attempt-identity', 'attempt-1998-subprocess',
        '--handoff-receipt', handoff,
        '--invocation-id', 'invocation-1998-subprocess',
        '--terminal-envelope', join(worktree, 'terminal.json'),
        '--output', output,
        '--profile', profile,
        '--cdp', 'http://127.0.0.1:9222',
        '--input', join(worktree, 'input.txt'),
        '--cwd', worktree,
        '--reviewer-source-output', join(worktree, 'source.txt'),
        '--reviewer-source', 'gpt',
        '--repository', 'chetwerikoff/orchestrator-pack',
        '--issue-number', '1998',
        '--source-revision', 'r04',
        '--stage', 'architectural-review',
        '--source-slot', '01',
        '--stage-attempt-id', 'attempt-1998-subprocess',
      ],
      cwd: process.cwd(),
      env: {
        PATH: [scriptsDir, process.env.PATH ?? ''].filter(Boolean).join(':'),
        DISCUSS_WITH_GPT_PROJECT_URL: 'https://chatgpt.com/g/project',
        DISCUSS_WITH_GPT_CHROME_USER_DATA_DIR: profile,
        OPK_CREATE_ISSUE_DRAFT_STATE_ROOT: lifecycleState,
      },
      inheritParentEnv: true,
      encoding: 'utf8',
      timeoutMs: 20_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.exitCode).toBe(2);
    const managerResult = JSON.parse(result.stderr.trim().split(/\r?\n/u).at(-1) ?? '{}') as {
      schema?: string;
      reason?: string;
      cause?: string;
      remedy?: string;
      evidence?: string;
      nextAction?: unknown;
    };
    expect(managerResult).toMatchObject({
      schema: 'flow-manager-browser-gpt-long-run-refusal/v1',
      reason: 'create_issue_browser_preflight_failed',
      cause: 'workspace_dependencies_unavailable',
      nextAction: null,
    });
    expect(managerResult.evidence).toContain('workspace_shared_module');
    expect(managerResult.remedy).toContain('npm ci --include=dev');
    expect(result.stderr).not.toContain('ERR_MODULE_NOT_FOUND');
    expect(existsSync(output)).toBe(false);
    expect(existsSync(handoff)).toBe(false);
    expect(existsSync(lifecycleState)).toBe(false);
  });
});
