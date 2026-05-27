import { execFileSync } from 'node:child_process';
import type { DeclarationSnapshot } from '@orchestrator-pack/shared/lib/declaration_schema.js';

function runGit(repoRoot: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/**
 * Resolve the baseline commit for worktree diffs. Falls back to HEAD so
 * control-artifact-only changes can pass before a declaration exists.
 */
export function resolveWorktreeBaseline(
  repoRoot: string,
  explicitBaseline?: string,
  declaration?: DeclarationSnapshot | null,
): string {
  if (explicitBaseline?.trim()) {
    return explicitBaseline.trim();
  }

  if (declaration?.baseline.commit_sha) {
    return declaration.baseline.commit_sha;
  }

  return runGit(repoRoot, ['rev-parse', 'HEAD']);
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
