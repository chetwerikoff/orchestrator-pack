import { lstatSync, readFileSync, rmSync } from 'node:fs';
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

// Exact setup output: LeoPoker orca.yaml:48-58 and AppliedIn orca.yaml:14-21.
// No marker exists; only these whole-content shapes are authorized by Issue #2801.
const GENERATED_ENV_SHAPES = [
  /^APP_ENV=development\nCOMPOSE_PROJECT_NAME=leopoker_[a-z0-9_]+_[a-f0-9]{8}\nPOSTGRES_USER=leopoker\nPOSTGRES_PASSWORD=leopoker\nPOSTGRES_DB=leopoker\nPOSTGRES_HOST=localhost\nPOSTGRES_PORT=([1-9][0-9]{4})\nDATABASE_URL=postgresql\+psycopg:\/\/leopoker:leopoker@localhost:\1\/leopoker\nHERO_CONFIG__PLAYER_NAME=\n$/,
  /^APPLIEDIN_WEB_PORT=(9[0-8][0-9]{2})\n$/,
] as const;

function isGeneratedEnvironment(path: string): boolean {
  try {
    const content = readFileSync(path, 'utf8');
    return GENERATED_ENV_SHAPES.some((shape) => {
      const match = shape.exec(content);
      return match !== null && match[0] === content && Number(match[1]) <= 65535;
    });
  } catch {
    return false;
  }
}

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

type PathInspection = 'absent' | 'regular-file' | 'nonregular' | 'error';

/** Proven ENOENT is absence. Any other lstat result is present or uncertain. */
function inspectPath(path: string): PathInspection {
  try {
    const stat = lstatSync(path);
    if (stat.isFile() && !stat.isSymbolicLink()) return 'regular-file';
    return 'nonregular';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'error';
  }
}

/**
 * Remove launch copies in `worktree` that are byte-identical to the same file in `primaryRoot`.
 * Missing primary counterparts are preserved except exact known setup-generated .env shapes.
 * Differing, unreadable, tracked, non-ignored, or nonregular copies are always preserved.
 * A failed tracked listing is unverified and is never treated as untracked.
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
    const copyInspection = inspectPath(copy);
    if (copyInspection === 'absent') continue;
    if (copyInspection !== 'regular-file') {
      preserved.push({ path: relative, reason: 'unverified' });
      continue;
    }
    // Verify ignored/untracked status before either removal path.
    // Only a successful empty cached listing proves the path is untracked.
    const ignored = git(['-C', worktree, 'check-ignore', '-q', '--', relative]);
    const tracked = git(['-C', worktree, 'ls-files', '--cached', '-z', '--', relative]);
    if (!ignored.ok) {
      preserved.push({ path: relative, reason: 'not_ignored' });
      continue;
    }
    if (!tracked.ok || tracked.stdout.length !== 0) {
      preserved.push({ path: relative, reason: tracked.ok ? 'not_ignored' : 'unverified' });
      continue;
    }
    const original = join(primaryRoot, relative);
    const primaryInspection = inspectPath(original);
    const generated = relative === '.env' && primaryInspection === 'absent' && isGeneratedEnvironment(copy);
    if (primaryInspection === 'absent' && !generated) {
      preserved.push({ path: relative, reason: 'primary_copy_missing' });
      continue;
    }
    if (!generated && primaryInspection !== 'regular-file') {
      preserved.push({ path: relative, reason: 'unverified' });
      continue;
    }
    let same: boolean;
    try {
      same = generated || readFileSync(copy).equals(readFileSync(original));
    } catch {
      preserved.push({ path: relative, reason: 'unverified' });
      continue;
    }
    if (!same) {
      preserved.push({ path: relative, reason: 'differs_from_primary' });
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
