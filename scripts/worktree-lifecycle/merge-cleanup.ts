#!/usr/bin/env node

import { existsSync, lstatSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { parseGitWorktreePorcelain, normalizeWorktreePath } from './core.ts';
import { runProcessSync } from '../kernel/subprocess.ts';
import { collectProcessCensus } from './operations.ts';

/**
 * Delegated merge cleanup (Issue #2782): exact listed Issue worktrees, identical launch copies,
 * and the completion/blocker message to the orchestrator, in that order.
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
  | 'not_ignored';

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
    rmSync(copy, { force: true });
    removed.push(relative);
  }
  return { removed, preserved };
}

export type ListedTreeStatus =
  | 'removed'
  | 'already_absent'
  | 'excluded_own_worktree'
  | 'preserved';

export interface ListedTreeResult {
  readonly path: string;
  readonly status: ListedTreeStatus;
  readonly reason?: string;
  readonly launchCopies?: LaunchCopyResult;
  readonly unreadableProcessObservations?: { readonly cwd: number; readonly fd: number };
}

export interface MergeCleanupDeps {
  readonly git: GitRunner;
  /** Live holders (readable cwd or fd under the tree, plus descendants) and denied observations. */
  readonly holders: (path: string) => {
    readonly holders: number;
    readonly unreadableCwd: number;
    readonly unreadableFd: number;
  };
  /** Orca terminals whose structured worktreePath equals the tree. Throw when the inventory is unavailable. */
  readonly terminals: (path: string) => number;
  /** Non-force removal of one exact tree. */
  readonly removeTree: (path: string) => { readonly ok: boolean; readonly detail: string };
  /** Deliver one line to the orchestrator pane. */
  readonly send: (handle: string, text: string) => { readonly ok: boolean; readonly detail: string };
  readonly exists?: (path: string) => boolean;
  readonly canonical?: (path: string) => string;
}

export interface MergeCleanupInput {
  readonly primaryRoot: string;
  /** The merge agent's own worktree: never removed here. */
  readonly ownWorktree: string;
  /** Exact trees named in the merge specification. */
  readonly listed: readonly string[];
  readonly prNumber: number;
  readonly mergeSha: string;
  readonly orchestratorHandle: string;
}

export interface MergeCleanupReport {
  readonly trees: readonly ListedTreeResult[];
  readonly blockers: readonly string[];
  readonly message: string;
  readonly delivery: { readonly ok: boolean; readonly detail: string };
  /** Observed order of effects, for audit. */
  readonly order: readonly string[];
}

function canon(path: string): string {
  const normalized = normalizeWorktreePath(path);
  try {
    return realpathSync(normalized);
  } catch {
    return normalized;
  }
}

function listedGitPaths(git: GitRunner, canonical: (path: string) => string): Set<string> {
  const result = git(['worktree', 'list', '--porcelain']);
  if (!result.ok) throw new TypeError(`git worktree list failed: ${result.stderr.trim() || 'no detail'}`);
  return new Set(parseGitWorktreePorcelain(result.stdout).map((row) => canonical(row.path)));
}

function oneLine(text: string): string {
  return text.replace(/[`!]/g, '').replace(/\s+/g, ' ').trim();
}

/** Cleanup of exact listed trees, read-back, then the single completion or blocker message. */
export function runMergeCleanup(input: MergeCleanupInput, deps: MergeCleanupDeps): MergeCleanupReport {
  const canonical = deps.canonical ?? canon;
  const exists = deps.exists ?? existsSync;
  const order: string[] = [];
  const primary = canonical(input.primaryRoot);
  const own = canonical(input.ownWorktree);
  const trees: ListedTreeResult[] = [];
  const seen = new Set<string>();

  for (const raw of input.listed) {
    const path = canonical(raw);
    if (seen.has(path)) continue;
    seen.add(path);
    let inventory: Set<string>;
    try {
      inventory = listedGitPaths(deps.git, canonical);
    } catch (error) {
      trees.push({ path, status: 'preserved', reason: oneLine(error instanceof Error ? error.message : String(error)) });
      continue;
    }
    if (path === primary) {
      trees.push({ path, status: 'preserved', reason: 'named path is the primary checkout; never removed' });
      continue;
    }
    if (path === own) {
      trees.push({ path, status: 'excluded_own_worktree', reason: 'merge agent own worktree; orchestrator removes it after the agent stops' });
      continue;
    }
    if (!inventory.has(path)) {
      if (exists(path)) {
        trees.push({ path, status: 'preserved', reason: 'path exists but is not a git worktree of this repository' });
      } else {
        trees.push({ path, status: 'already_absent' });
      }
      continue;
    }

    order.push(`cleanup:${path}`);
    const census = deps.holders(path);
    const unreadable = { cwd: census.unreadableCwd, fd: census.unreadableFd };
    if (census.holders > 0) {
      trees.push({
        path,
        status: 'preserved',
        reason: `${String(census.holders)} live process(es) hold the tree (readable cwd or fd)`,
        unreadableProcessObservations: unreadable,
      });
      continue;
    }
    let terminalCount: number;
    try {
      terminalCount = deps.terminals(path);
    } catch (error) {
      trees.push({
        path,
        status: 'preserved',
        reason: `terminal inventory unavailable: ${oneLine(error instanceof Error ? error.message : String(error))}`,
        unreadableProcessObservations: unreadable,
      });
      continue;
    }
    if (terminalCount > 0) {
      trees.push({
        path,
        status: 'preserved',
        reason: `${String(terminalCount)} Orca terminal(s) still bound to the tree`,
        unreadableProcessObservations: unreadable,
      });
      continue;
    }
    // Gates passed: only now are identical launch copies removed, so a preserved tree is never touched.
    const launchCopies = removeIdenticalLaunchCopies(path, primary, deps.git);
    const removal = deps.removeTree(path);
    let after: Set<string>;
    try {
      after = listedGitPaths(deps.git, canonical);
    } catch {
      after = inventory;
    }
    if (!after.has(path) && !exists(path)) {
      trees.push({ path, status: 'removed', launchCopies, unreadableProcessObservations: unreadable });
    } else {
      trees.push({
        path,
        status: 'preserved',
        reason: `removal not observed: ${oneLine(removal.detail) || 'tree still present after removal'}`,
        launchCopies,
        unreadableProcessObservations: unreadable,
      });
    }
  }

  const blockers = trees
    .filter((tree) => tree.status === 'preserved')
    .map((tree) => `${tree.path}: ${tree.reason ?? 'preserved'}`);
  const head = `${String(input.prNumber)} ${input.mergeSha}`;
  const message = blockers.length === 0
    ? `MERGED ${head}`
    : oneLine(`CLEANUP_BLOCKED ${head} merged; ${blockers.join(' | ')}`);
  // The message is sent only now: after every listed tree was handled and read back.
  order.push('send');
  const delivery = deps.send(input.orchestratorHandle, message);
  return { trees, blockers, message, delivery, order };
}

function spawn(command: string, args: readonly string[], cwd?: string): GitResult {
  const result = runProcessSync({ command, args, cwd, inheritParentEnv: true, timeoutMs: 120_000 });
  return {
    ok: result.ok,
    stdout: result.stdout,
    stderr: `${result.stderr}${result.error ? String(result.error) : ''}`,
  };
}

export function defaultMergeCleanupDeps(repoRoot: string): MergeCleanupDeps {
  return {
    git: (args) => spawn('git', ['-C', repoRoot, ...args]),
    holders: (path) => {
      const census = collectProcessCensus(path);
      const self = new Set<number>([process.pid, process.ppid]);
      return {
        holders: census.processes.filter((row) => !self.has(row.pid)).length,
        unreadableCwd: census.observations.unreadableCwd,
        unreadableFd: census.observations.unreadableFd,
      };
    },
    terminals: (path) => {
      const listed = spawn('orca', ['terminal', 'list', '--json']);
      if (!listed.ok) throw new TypeError(listed.stderr.trim() || 'orca terminal list failed');
      const root = JSON.parse(listed.stdout) as { result?: { terminals?: { worktreePath?: string }[] } };
      const rows = root.result?.terminals;
      if (!Array.isArray(rows)) throw new TypeError('orca terminal list omitted result.terminals[]');
      return rows.filter((row) => typeof row.worktreePath === 'string' && canon(row.worktreePath) === path).length;
    },
    removeTree: (path) => {
      const viaOrca = spawn('orca', ['worktree', 'rm', '--worktree', `path:${path}`, '--json']);
      if (viaOrca.ok) return { ok: true, detail: 'orca worktree rm' };
      const viaGit = spawn('git', ['-C', repoRoot, 'worktree', 'remove', path]);
      return { ok: viaGit.ok, detail: viaGit.ok ? 'git worktree remove' : viaGit.stderr || viaOrca.stderr };
    },
    send: (handle, text) => {
      const sent = spawn('orca', ['terminal', 'send', '--terminal', handle, '--enter', '--text', text]);
      return { ok: sent.ok, detail: sent.ok ? 'sent' : sent.stderr.trim() || 'orca terminal send failed' };
    },
  };
}

function valuesAfter(argv: readonly string[], name: string): string[] {
  const values: string[] = [];
  argv.forEach((item, index) => {
    if (item === name && argv[index + 1] !== undefined) values.push(argv[index + 1]!);
  });
  return values;
}

function main(argv = process.argv.slice(2)): void {
  const [repoRoot] = valuesAfter(argv, '--repo-root');
  const [primaryRoot] = valuesAfter(argv, '--primary-root');
  const [own] = valuesAfter(argv, '--own-worktree');
  const [pr] = valuesAfter(argv, '--pr');
  const [sha] = valuesAfter(argv, '--merge-sha');
  const [handle] = valuesAfter(argv, '--orchestrator-handle');
  const listed = valuesAfter(argv, '--worktree');
  const prNumber = Number.parseInt(pr ?? '', 10);
  if (!repoRoot || !primaryRoot || !own || !sha || !handle || listed.length === 0 || !Number.isInteger(prNumber)) {
    console.error('usage: merge-cleanup.ts --repo-root R --primary-root P --own-worktree W --pr N --merge-sha S --orchestrator-handle H --worktree PATH [--worktree PATH ...]');
    process.exitCode = 2;
    return;
  }
  const report = runMergeCleanup(
    { primaryRoot, ownWorktree: own, listed, prNumber, mergeSha: sha, orchestratorHandle: handle },
    defaultMergeCleanupDeps(repoRoot),
  );
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.delivery.ok && report.blockers.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
