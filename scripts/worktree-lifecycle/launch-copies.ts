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
 * Missing primary counterparts are preserved except exact known setup-generated .env shapes.
 * Differing, unreadable, tracked or non-ignored copies are always preserved.
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
    // Verify ignored/untracked status before either removal path.
    const ignored = git(['-C', worktree, 'check-ignore', '-q', '--', relative]);
    const tracked = git(['-C', worktree, 'ls-files', '--error-unmatch', '--', relative]);
    if (!ignored.ok || tracked.ok) {
      preserved.push({ path: relative, reason: 'not_ignored' });
      continue;
    }
    const generated = relative === '.env' && !existsSync(original) && isGeneratedEnvironment(copy);
    if (!existsSync(original) && !generated) {
      preserved.push({ path: relative, reason: 'primary_copy_missing' });
      continue;
    }
    if (!generated && !regularFile(original)) {
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
