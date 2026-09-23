import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
});
