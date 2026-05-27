import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSyntheticGitRepo } from '../lib/git_fixture.js';

describe('createSyntheticGitRepo', () => {
  let repo: ReturnType<typeof createSyntheticGitRepo> | undefined;

  afterEach(() => {
    repo?.dispose();
    repo = undefined;
  });

  it('creates an isolated repo with an initial commit', () => {
    repo = createSyntheticGitRepo({
      initialFiles: {
        'plugins/demo.txt': 'demo',
      },
    });

    expect(existsSync(join(repo.root, '.git'))).toBe(true);
    expect(existsSync(join(repo.root, 'plugins', 'demo.txt'))).toBe(true);
  });

  it('documents the fixture strategy for future scope-guard tests', () => {
    // Future integration tests (#5, #6) should:
    // 1. createSyntheticGitRepo() with declared paths
    // 2. stage/commit paths inside and outside scope
    // 3. assert guard/CI behavior without AO runtime
    expect(typeof createSyntheticGitRepo).toBe('function');
  });
});
