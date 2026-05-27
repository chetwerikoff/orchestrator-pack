import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSyntheticGitRepo } from '@orchestrator-pack/shared/lib/git_fixture.js';
import { runScopeCheck } from '../bin/scope-check.js';
import { resolveWrapScopeBaseline, runAgentWrap } from '../bin/agent-wrap.js';

describe('agent-wrap baseline handling', () => {
  let repo: ReturnType<typeof createSyntheticGitRepo> | undefined;

  afterEach(() => {
    repo?.dispose();
    repo = undefined;
    delete process.env.AO_SESSION_ID;
  });

  it('prefers explicit baseline, then declaration baseline, then pre-run HEAD', () => {
    expect(
      resolveWrapScopeBaseline(
        { repoRoot: '.', issueNumber: 1, command: ['true'] },
        'pre-run-head',
        {
          issue_number: 1,
          iteration_id: 'iter',
          iteration_id_source: 'wrapper_generated',
          supersedes: null,
          created_at: '2026-05-27T00:00:00.000Z',
          baseline: {
            commit_sha: 'declaration-baseline',
            worktree_dirty: false,
            active_scope_hash: 'sha256:test',
          },
          declared_paths: ['README.md'],
          declared_globs: [],
          amendments: [],
        },
      ),
    ).toBe('declaration-baseline');

    expect(
      resolveWrapScopeBaseline(
        {
          repoRoot: '.',
          issueNumber: 1,
          baselineCommitSha: 'explicit-baseline',
          command: ['true'],
        },
        'pre-run-head',
        null,
      ),
    ).toBe('explicit-baseline');

    expect(
      resolveWrapScopeBaseline(
        { repoRoot: '.', issueNumber: 1, command: ['true'] },
        'pre-run-head',
        null,
      ),
    ).toBe('pre-run-head');
  });

  it('detects commits made during the wrapped command when no declaration exists', () => {
    delete process.env.AO_SESSION_ID;

    repo = createSyntheticGitRepo({
      initialFiles: {
        'README.md': '# fixture\n',
        'plugins/evil.txt': 'blocked',
      },
    });

    const preRunBaseline = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repo.root,
      encoding: 'utf8',
    }).trim();

    writeFileSync(join(repo.root, 'plugins/evil.txt'), 'committed by agent', 'utf8');
    execFileSync('git', ['add', 'plugins/evil.txt'], { cwd: repo.root });
    execFileSync('git', ['commit', '-m', 'agent commit'], { cwd: repo.root });

    const headFallback = runScopeCheck({
      repoRoot: repo.root,
      issueNumber: 99,
      mode: 'worktree',
    });
    expect(headFallback.ok).toBe(true);

    const preRunCheck = runScopeCheck({
      repoRoot: repo.root,
      issueNumber: 99,
      mode: 'worktree',
      baselineCommitSha: preRunBaseline,
    });
    expect(preRunCheck.ok).toBe(false);
    if (!preRunCheck.ok) {
      expect(preRunCheck.reason).toBe('missing_declaration');
      expect(preRunCheck.out_of_scope).toContain('plugins/evil.txt');
    }
  });

  it('runs scope-check with the pre-run baseline after a successful wrapped command', () => {
    delete process.env.AO_SESSION_ID;

    repo = createSyntheticGitRepo({
      initialFiles: {
        'README.md': '# fixture\n',
        'plugins/evil.txt': 'blocked',
      },
    });

    mkdirSync(join(repo.root, 'plugins'), { recursive: true });
    writeFileSync(join(repo.root, 'plugins/evil.txt'), 'committed by agent', 'utf8');

    const gitCommand =
      process.platform === 'win32'
        ? ['cmd', '/c', 'git add plugins/evil.txt && git commit -m agent-commit']
        : ['sh', '-c', 'git add plugins/evil.txt && git commit -m agent-commit'];

    const exitCode = runAgentWrap({
      repoRoot: repo.root,
      issueNumber: 99,
      command: gitCommand,
    });

    expect(exitCode).toBe(1);
  });
});
