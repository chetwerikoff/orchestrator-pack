import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSyntheticGitRepo } from '@orchestrator-pack/shared/lib/git_fixture.js';
import {
  assertCleanWorktree,
  computeActiveScopeHash,
  computeBaseline,
  isWorktreeDirty,
} from '../lib/baseline.js';

describe('baseline', () => {
  let repo: ReturnType<typeof createSyntheticGitRepo> | undefined;

  afterEach(() => {
    repo?.dispose();
    repo = undefined;
  });

  it('computes a stable active_scope_hash', () => {
    const hash = computeActiveScopeHash({
      declared_paths: ['plugins/a.ts'],
      declared_globs: ['plugins/**'],
      issue_denylist: ['vendor/**'],
      issue_allowed_roots: ['plugins/**'],
    });

    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(
      computeActiveScopeHash({
        declared_paths: ['plugins/a.ts'],
        declared_globs: ['plugins/**'],
        issue_denylist: ['vendor/**'],
        issue_allowed_roots: ['plugins/**'],
      }),
    ).toBe(hash);
  });

  it('records baseline metadata from a clean synthetic repo', () => {
    repo = createSyntheticGitRepo({
      initialFiles: {
        'plugins/demo.txt': 'demo',
      },
    });

    const baseline = computeBaseline(repo.root, {
      declared_paths: ['plugins/demo.txt'],
      declared_globs: [],
      issue_denylist: ['vendor/**'],
    });

    expect(baseline.worktree_dirty).toBe(false);
    expect(baseline.commit_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(baseline.active_scope_hash).toMatch(/^sha256:/);
  });

  it('rejects dirty worktrees and ignores runtime mirror paths', () => {
    repo = createSyntheticGitRepo({
      initialFiles: {
        'plugins/demo.txt': 'demo',
      },
    });

    const mirrorDir = join(repo.root, '.ao', 'declarations');
    mkdirSync(mirrorDir, { recursive: true });
    writeFileSync(join(mirrorDir, '1.test.json'), '{}', 'utf8');
    expect(isWorktreeDirty(repo.root)).toBe(false);
    expect(() => assertCleanWorktree(repo.root)).not.toThrow();

    writeFileSync(join(repo.root, 'plugins', 'dirty.txt'), 'pending', 'utf8');
    expect(isWorktreeDirty(repo.root)).toBe(true);
    expect(() => assertCleanWorktree(repo.root)).toThrow(/worktree is dirty/i);
    expect(existsSync(join(mirrorDir, '1.test.json'))).toBe(true);
  });
});
