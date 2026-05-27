import { execFileSync } from 'node:child_process';

function runGit(repoRoot: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/**
 * List staged paths from the index (pre-commit mode).
 */
export function listStagedPaths(repoRoot: string): string[] {
  const output = runGit(repoRoot, ['diff', '--cached', '--name-only']);
  if (!output) {
    return [];
  }

  return [...new Set(output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];
}
