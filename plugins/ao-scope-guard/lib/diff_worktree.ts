import { execFileSync } from 'node:child_process';

function runGit(repoRoot: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/**
 * List working-tree mutations since baseline commit_sha (wrapper mode).
 */
export function listWorktreeChanges(
  repoRoot: string,
  baselineCommitSha: string,
): string[] {
  const tracked = runGit(repoRoot, ['diff', '--name-only', baselineCommitSha]);
  const untracked = runGit(repoRoot, ['ls-files', '--others', '--exclude-standard']);

  const paths = new Set<string>();
  for (const chunk of [tracked, untracked]) {
    if (!chunk) {
      continue;
    }
    for (const line of chunk.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) {
        paths.add(trimmed);
      }
    }
  }

  return [...paths].sort();
}
