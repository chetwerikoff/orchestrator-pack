import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSyntheticGitRepo } from '@orchestrator-pack/shared/lib/git_fixture.js';
import { runProcessSync } from '../../../scripts/kernel/subprocess.ts';
import { runScopeCheck } from '../bin/scope-check.ts';
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
  });

  it('prefers an explicit iteration id over discovered declarations', () => {
    repo = createSyntheticGitRepo();
    const mirrorDir = join(repo.root, '.orchestrator-pack', 'declarations');
    mkdirSync(mirrorDir, { recursive: true });
    writeFileSync(join(mirrorDir, '5.stored.json'), '{}', 'utf8');

    expect(resolveScopeCheckIterationId(repo.root, 5, 'explicit-id')).toBe('explicit-id');
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

    const mirrorDir = join(repo.root, '.orchestrator-pack', 'declarations');
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

    const mirrorDir = join(repo.root, '.orchestrator-pack', 'declarations');
    mkdirSync(mirrorDir, { recursive: true });
    writeFileSync(
      join(mirrorDir, '8.valid.json'),
      `${JSON.stringify(validSnapshot, null, 2)}\n`,
      'utf8',
    );
    writeFileSync(join(mirrorDir, '8.draft.json'), '{ incomplete json', 'utf8');

    expect(loadLatestActiveDeclaration(repo.root, 8)).toEqual(validSnapshot);
  });

  it('accepts a CI-selected v1 wrap for staged scope checks', () => {
    repo = createSyntheticGitRepo({
      initialFiles: {
        'docs/browser-gpt-turn-runbook.md': 'original\n',
      },
    });

    const declarationDir = join(repo.root, 'docs', 'declarations');
    mkdirSync(declarationDir, { recursive: true });
    writeFileSync(
      join(repo.root, 'docs/browser-gpt-turn-runbook.md'),
      'changed\n',
      'utf8',
    );
    const staged = runProcessSync({
      command: 'git',
      args: ['add', 'docs/browser-gpt-turn-runbook.md'],
      cwd: repo.root,
      inheritParentEnv: true,
    });
    expect(staged.ok, staged.stderr || staged.error).toBe(true);

    expect(
      runScopeCheck({
        repoRoot: repo.root,
        issueNumber: 1795,
        mode: 'index',
      }),
    ).toMatchObject({
      ok: false,
      reason: 'missing_declaration',
    });

    writeFileSync(
      join(declarationDir, '1795.wrap-20260828T091255Z.json'),
      `${JSON.stringify({
        schema_version: 'orchestrator-pack/pr-scope-declaration/v1',
        issue_number: 1795,
        declared_paths: ['docs/browser-gpt-turn-runbook.md'],
        denylist: [
          '.env',
          'credentials/',
          'packages/core/',
          'secrets/',
          'vendor/',
        ],
        allowed_roots: ['docs/'],
      })}\n`,
      'utf8',
    );

    expect(
      runScopeCheck({
        repoRoot: repo.root,
        issueNumber: 1795,
        mode: 'index',
      }),
    ).toEqual({
      ok: true,
      skipped_control_artifacts: [],
      checked_paths: ['docs/browser-gpt-turn-runbook.md'],
    });
  });
});
