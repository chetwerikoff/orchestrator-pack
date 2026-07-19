import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createSyntheticGitRepo } from '@orchestrator-pack/shared/lib/git_fixture.js';
import type { DeclarationSnapshot } from '@orchestrator-pack/shared/lib/declaration_schema.js';
import { runProcessSync } from '../../../scripts/kernel/subprocess.ts';
import { runScopeCheck } from '../bin/scope-check.ts';

const scopeCheckScript = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'bin',
  'scope-check.ts',
);


function runGit(repoRoot: string, args: readonly string[]): string {
  const result = runProcessSync({
    command: 'git',
    args,
    cwd: repoRoot,
    inheritParentEnv: true,
  });
  expect(result.ok, result.stderr || result.error).toBe(true);
  return result.stdout.trim();
}

function writeDeclaration(repoRoot: string, snapshot: DeclarationSnapshot): void {
  const mirrorDir = join(repoRoot, '.ao', 'declarations');
  mkdirSync(mirrorDir, { recursive: true });
  writeFileSync(
    join(mirrorDir, `${snapshot.issue_number}.${snapshot.iteration_id}.json`),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    'utf8',
  );
}

describe('scope-guard integration', { timeout: 15_000 }, () => {
  let repo: ReturnType<typeof createSyntheticGitRepo> | undefined;

  afterEach(() => {
    repo?.dispose();
    repo = undefined;
    delete process.env.AO_SESSION_ID;
  });

  it('passes staged in-scope paths and blocks out-of-scope commits', () => {
    repo = createSyntheticGitRepo({
      initialFiles: {
        'plugins/demo/in-scope.txt': 'ok',
        'plugins/demo/outside-scope.txt': 'blocked',
      },
    });

    const baseline = runGit(repo.root, ['rev-parse', 'HEAD']);

    const declaration: DeclarationSnapshot = {
      issue_number: 99,
      iteration_id: 'integration-test',
      iteration_id_source: 'wrapper_generated',
      supersedes: null,
      created_at: '2026-05-27T00:00:00.000Z',
      baseline: {
        commit_sha: baseline,
        worktree_dirty: false,
        active_scope_hash: 'sha256:integration',
      },
      declared_paths: ['plugins/demo/in-scope.txt'],
      declared_globs: [],
      amendments: [],
    };

    writeDeclaration(repo.root, declaration);

    writeFileSync(join(repo.root, 'plugins/demo/in-scope.txt'), 'changed', 'utf8');
    runGit(repo.root, ['add', 'plugins/demo/in-scope.txt']);

    const inScope = runScopeCheck({
      repoRoot: repo.root,
      issueNumber: 99,
      mode: 'index',
      iterationId: 'integration-test',
    });
    expect(inScope.ok).toBe(true);

    writeFileSync(join(repo.root, 'plugins/demo/outside-scope.txt'), 'changed', 'utf8');
    runGit(repo.root, ['add', 'plugins/demo/outside-scope.txt']);

    const outOfScope = runScopeCheck({
      repoRoot: repo.root,
      issueNumber: 99,
      mode: 'index',
      iterationId: 'integration-test',
    });
    expect(outOfScope.ok).toBe(false);
    if (!outOfScope.ok) {
      expect(outOfScope.out_of_scope).toContain('plugins/demo/outside-scope.txt');
    }
  });

  it('allows pure declaration snapshot commits without a mirror', () => {
    repo = createSyntheticGitRepo({
      initialFiles: { 'README.md': '# fixture\n' },
    });

    const snapshotPath = join(
      repo.root,
      'docs/declarations/99.integration-test.json',
    );
    mkdirSync(dirname(snapshotPath), { recursive: true });
    writeFileSync(snapshotPath, '{}\n', 'utf8');
    runGit(repo.root, ['add', snapshotPath]);

    const result = runScopeCheck({
      repoRoot: repo.root,
      issueNumber: 99,
      mode: 'index',
      iterationId: 'integration-test',
    });
    expect(result.ok).toBe(true);
  });

  it('resolves the latest declaration without an explicit iteration id', () => {
    delete process.env.AO_SESSION_ID;

    repo = createSyntheticGitRepo({
      initialFiles: {
        'plugins/demo/in-scope.txt': 'ok',
      },
    });

    const baseline = runGit(repo.root, ['rev-parse', 'HEAD']);

    writeDeclaration(repo.root, {
      issue_number: 99,
      iteration_id: 'stored-iteration',
      iteration_id_source: 'wrapper_generated',
      supersedes: null,
      created_at: '2026-05-27T00:00:00.000Z',
      baseline: {
        commit_sha: baseline,
        worktree_dirty: false,
        active_scope_hash: 'sha256:integration',
      },
      declared_paths: ['plugins/demo/in-scope.txt'],
      declared_globs: [],
      amendments: [],
    });

    writeFileSync(join(repo.root, 'plugins/demo/in-scope.txt'), 'changed', 'utf8');
    runGit(repo.root, ['add', 'plugins/demo/in-scope.txt']);

    const result = runScopeCheck({
      repoRoot: repo.root,
      issueNumber: 99,
      mode: 'index',
    });
    expect(result.ok).toBe(true);
  });

  it('allows pure control-artifact worktree changes without baseline or declaration', () => {
    repo = createSyntheticGitRepo({
      initialFiles: { 'README.md': '# fixture\n' },
    });

    const snapshotPath = join(repo.root, 'docs/declarations/99.wrapper-test.json');
    mkdirSync(dirname(snapshotPath), { recursive: true });
    writeFileSync(snapshotPath, '{ incomplete json', 'utf8');

    const result = runScopeCheck({
      repoRoot: repo.root,
      issueNumber: 99,
      mode: 'worktree',
    });
    expect(result.ok).toBe(true);
  });

  it('allows malformed declaration snapshots while authoring control artifacts only', () => {
    delete process.env.AO_SESSION_ID;

    repo = createSyntheticGitRepo({
      initialFiles: { 'README.md': '# fixture\n' },
    });

    const snapshotPath = join(repo.root, 'docs/declarations/99.draft.json');
    mkdirSync(dirname(snapshotPath), { recursive: true });
    writeFileSync(snapshotPath, '{ "issue_number": 99, incomplete', 'utf8');

    const result = runScopeCheck({
      repoRoot: repo.root,
      issueNumber: 99,
      mode: 'worktree',
    });
    expect(result.ok).toBe(true);
  });

  it('detects committed scoped violations even when only control artifacts are dirty', () => {
    delete process.env.AO_SESSION_ID;

    repo = createSyntheticGitRepo({
      initialFiles: {
        'plugins/demo/in-scope.txt': 'ok',
        'plugins/demo/outside-scope.txt': 'blocked',
      },
    });

    const baseline = runGit(repo.root, ['rev-parse', 'HEAD']);

    writeDeclaration(repo.root, {
      issue_number: 99,
      iteration_id: 'baseline-locked',
      iteration_id_source: 'wrapper_generated',
      supersedes: null,
      created_at: '2026-05-27T00:00:00.000Z',
      baseline: {
        commit_sha: baseline,
        worktree_dirty: false,
        active_scope_hash: 'sha256:integration',
      },
      declared_paths: ['plugins/demo/in-scope.txt'],
      declared_globs: [],
      amendments: [],
    });

    writeFileSync(
      join(repo.root, 'plugins/demo/outside-scope.txt'),
      'committed violation',
      'utf8',
    );
    runGit(repo.root, ['add', 'plugins/demo/outside-scope.txt']);
    runGit(repo.root, ['commit', '-m', 'out of scope commit']);

    const snapshotPath = join(repo.root, 'docs/declarations/99.baseline-locked.json');
    mkdirSync(dirname(snapshotPath), { recursive: true });
    writeFileSync(snapshotPath, '{}\n', 'utf8');

    const result = runScopeCheck({
      repoRoot: repo.root,
      issueNumber: 99,
      mode: 'worktree',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.out_of_scope).toContain('plugins/demo/outside-scope.txt');
    }
  });

  it('runs the scope-check CLI entrypoint', () => {
    const result = runProcessSync({
      command: process.execPath,
      args: ['--experimental-strip-types', scopeCheckScript, '--help'],
      inheritParentEnv: true,
    });
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain('Usage: scope-check');
    expect(result.exitCode).toBe(1);
  });
});
