import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { resolveSpawnDefaultBranchBaseRef } from '../docs/spawn-worktree-git-ref.mjs';
import { resolveTrustedSystemGit, withTempGitRepo } from './_test-git-fixture.js';

const git = resolveTrustedSystemGit();

export function gitInSpawnWorktreeRepo(dir: string, args: string[]) {
  execFileSync(git, ['-C', dir, ...args], { stdio: 'ignore' });
}

export function headOidSpawnWorktreeRepo(dir: string) {
  return execFileSync(git, ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim().toLowerCase();
}

export function setupSpawnWorktreeRepo(
  run: (ctx: { repo: string; mainOid: string; baseRef: string }) => void,
) {
  withTempGitRepo((repo) => {
    writeFileSync(path.join(repo, 'feature.txt'), 'feature\n');
    gitInSpawnWorktreeRepo(repo, ['add', 'feature.txt']);
    gitInSpawnWorktreeRepo(repo, ['commit', '-m', 'feature']);
    const mainOid = headOidSpawnWorktreeRepo(repo);
    gitInSpawnWorktreeRepo(repo, ['branch', 'feature-branch']);
    gitInSpawnWorktreeRepo(repo, ['update-ref', 'refs/heads/main', mainOid]);
    gitInSpawnWorktreeRepo(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    gitInSpawnWorktreeRepo(repo, ['remote', 'add', 'origin', repo]);
    gitInSpawnWorktreeRepo(repo, ['update-ref', 'refs/remotes/origin/main', mainOid]);
    const baseRef = resolveSpawnDefaultBranchBaseRef(repo).refToken ?? 'refs/heads/main';
    run({ repo, mainOid, baseRef });
  });
}
