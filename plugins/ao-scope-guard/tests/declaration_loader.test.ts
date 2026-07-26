import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSyntheticGitRepo } from '@orchestrator-pack/shared/lib/git_fixture.js';
import {
  findLatestMirrorIterationId,
  findLatestSnapshotIterationId,
  loadLatestActiveDeclaration,
  resolveScopeCheckIterationId,
} from '../lib/declaration_loader.js';

describe('resolveScopeCheckIterationId', () => {
  let repo: ReturnType<typeof createSyntheticGitRepo> | undefined;

  afterEach(() => {
    repo?.dispose();
    repo = undefined;
    delete process.env.AO_SESSION_ID;
  });

  it('prefers explicit and AO session ids over discovered declarations', () => {
    repo = createSyntheticGitRepo();
    const mirrorDir = join(repo.root, '.ao', 'declarations');
    mkdirSync(mirrorDir, { recursive: true });
    writeFileSync(join(mirrorDir, '5.stored.json'), '{}', 'utf8');

    expect(
      resolveScopeCheckIterationId(repo.root, 5, 'explicit-id', {}),
    ).toBe('explicit-id');

    process.env.AO_SESSION_ID = 'session-id';
    expect(resolveScopeCheckIterationId(repo.root, 5, undefined, process.env)).toBe(
      'session-id',
    );
  });

  it('falls back to the latest mirror and then snapshot iteration ids', () => {
    repo = createSyntheticGitRepo();

    expect(resolveScopeCheckIterationId(repo.root, 7)).toBeNull();

    const snapshotDir = join(repo.root, 'docs', 'declarations');
    mkdirSync(snapshotDir, { recursive: true });
    writeFileSync(join(snapshotDir, '7.alpha.json'), '{}', 'utf8');
    writeFileSync(join(snapshotDir, '7.beta.json'), '{}', 'utf8');

    expect(findLatestSnapshotIterationId(repo.root, 7)).toBe('beta');
    expect(resolveScopeCheckIterationId(repo.root, 7)).toBe('beta');

    const mirrorDir = join(repo.root, '.ao', 'declarations');
    mkdirSync(mirrorDir, { recursive: true });
    writeFileSync(join(mirrorDir, '7.gamma.json'), '{}', 'utf8');

    expect(findLatestMirrorIterationId(repo.root, 7)).toBe('gamma');
    expect(resolveScopeCheckIterationId(repo.root, 7)).toBe('gamma');
  });

  it('treats malformed declaration JSON as unreadable and skips to older valid files', () => {
    repo = createSyntheticGitRepo({
      initialFiles: { 'README.md': '# fixture\n' },
    });

    const baseline = 'abc123def4567890abc123def4567890abc12345';
    const validSnapshot = {
      issue_number: 8,
      iteration_id: 'valid',
      iteration_id_source: 'wrapper_generated',
      supersedes: null,
      created_at: '2026-05-27T00:00:00.000Z',
      baseline: {
        commit_sha: baseline,
        worktree_dirty: false,
        active_scope_hash: 'sha256:valid',
      },
      declared_paths: ['README.md'],
      declared_globs: [],
      amendments: [],
    };

    const mirrorDir = join(repo.root, '.ao', 'declarations');
    mkdirSync(mirrorDir, { recursive: true });
    writeFileSync(
      join(mirrorDir, '8.valid.json'),
      `${JSON.stringify(validSnapshot, null, 2)}\n`,
      'utf8',
    );
    writeFileSync(join(mirrorDir, '8.draft.json'), '{ incomplete json', 'utf8');

    expect(loadLatestActiveDeclaration(repo.root, 8)).toEqual(validSnapshot);
  });
});
