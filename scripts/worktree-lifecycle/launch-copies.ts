import { existsSync, lstatSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Launch copies (Issue #2782 F2): ignored files copied from the primary checkout at launch.
 * Shared by the selected-worktree teardown gate and the listed-tree cleanup helper.
 */

/** Ignored files copied from the primary checkout at launch. */
export const LAUNCH_COPY_PATHS: readonly string[] = [
  '.env',
  '.claude/skills/discuss-with-gpt/local.config.json',
];

export type LaunchCopyPreserveReason =
  | 'differs_from_primary'
  | 'primary_copy_missing'
  | 'unverified'
  | 'not_ignored'
  | 'remove_failed';

export interface LaunchCopyResult {
  readonly removed: readonly string[];
  readonly preserved: readonly { readonly path: string; readonly reason: LaunchCopyPreserveReason }[];
}

export interface GitResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

export type GitRunner = (args: readonly string[]) => GitResult;

function regularFile(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Remove launch copies in `worktree` that are byte-identical to the same file in `primaryRoot`.
 * A copy that differs, has no readable primary counterpart, or is not git-ignored is preserved.
 */
export function removeIdenticalLaunchCopies(
  worktree: string,
  primaryRoot: string,
  git: GitRunner,
): LaunchCopyResult {
  const removed: string[] = [];
  const preserved: { path: string; reason: LaunchCopyPreserveReason }[] = [];
  for (const relative of LAUNCH_COPY_PATHS) {
    const copy = join(worktree, relative);
    if (!existsSync(copy) && !regularFile(copy)) continue;
    const original = join(primaryRoot, relative);
    if (!regularFile(copy)) {
      preserved.push({ path: relative, reason: 'unverified' });
      continue;
    }
    if (!existsSync(original)) {
      preserved.push({ path: relative, reason: 'primary_copy_missing' });
      continue;
    }
    if (!regularFile(original)) {
      preserved.push({ path: relative, reason: 'unverified' });
      continue;
    }
    let same: boolean;
    try {
      same = readFileSync(copy).equals(readFileSync(original));
    } catch {
      preserved.push({ path: relative, reason: 'unverified' });
      continue;
    }
    if (!same) {
      preserved.push({ path: relative, reason: 'differs_from_primary' });
      continue;
    }
    // Only an untracked, git-ignored file is a launch copy; never delete tracked content.
    const ignored = git(['-C', worktree, 'check-ignore', '-q', '--', relative]);
    const tracked = git(['-C', worktree, 'ls-files', '--error-unmatch', '--', relative]);
    if (!ignored.ok || tracked.ok) {
      preserved.push({ path: relative, reason: 'not_ignored' });
      continue;
    }
    try {
      rmSync(copy, { force: true });
    } catch {
      preserved.push({ path: relative, reason: 'remove_failed' });
      continue;
    }
    removed.push(relative);
  }
  return { removed, preserved };
}
