#!/usr/bin/env node

import { existsSync, realpathSync } from 'node:fs';
import { parseGitWorktreePorcelain, normalizeWorktreePath } from './core.ts';
import { removeIdenticalLaunchCopies, type GitResult, type GitRunner, type LaunchCopyResult } from './launch-copies.ts';
import { runProcessSync } from '../kernel/subprocess.ts';
import { collectProcessCensus } from './operations.ts';
import { classifyPromptSendReceipt, promptSendArgv } from '../orca-runtime/send-receipt.ts';
import { resolveOrcaExecutable } from '../orca-runtime/native.ts';

export { LAUNCH_COPY_PATHS, removeIdenticalLaunchCopies } from './launch-copies.ts';
export type { GitResult, GitRunner, LaunchCopyResult } from './launch-copies.ts';

/**
 * Delegated merge cleanup (Issue #2782): exact listed Issue worktrees, identical launch copies,
 * and the completion/blocker message to the orchestrator, in that order.
 */

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
  /**
   * Orca runtime state of the tree: whether Orca knows it, its live agents and bound terminals.
   * Must throw when the inventory is unavailable, truncated or malformed (fail closed).
   */
  readonly orcaState: (path: string) => {
    readonly known: boolean;
    readonly agents: number;
    readonly terminals: number;
  };
  /**
   * Non-force removal of one exact tree. A tree Orca knows is removed only by Orca; its refusal
   * is final. Plain `git worktree remove` (itself non-force) is used only for trees Orca does not know.
   */
  readonly removeTree: (path: string, orcaKnown: boolean) => { readonly ok: boolean; readonly detail: string };
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

function cleanupOneTree(
  path: string,
  primary: string,
  inventory: Set<string>,
  deps: MergeCleanupDeps,
  exists: (path: string) => boolean,
  canonical: (path: string) => string,
): ListedTreeResult {
  const census = deps.holders(path);
  const unreadable = { cwd: census.unreadableCwd, fd: census.unreadableFd };
  const preserved = (reason: string): ListedTreeResult => ({
    path,
    status: 'preserved',
    reason,
    unreadableProcessObservations: unreadable,
  });
  if (census.holders > 0) {
    return preserved(`${String(census.holders)} live process(es) hold the tree (readable cwd or fd)`);
  }
  let orca: ReturnType<MergeCleanupDeps['orcaState']>;
  try {
    orca = deps.orcaState(path);
  } catch (error) {
    return preserved(`Orca inventory unavailable or incomplete: ${oneLine(error instanceof Error ? error.message : String(error))}`);
  }
  if (orca.agents > 0) return preserved(`${String(orca.agents)} live Orca agent(s) on the tree`);
  if (orca.terminals > 0) return preserved(`${String(orca.terminals)} Orca terminal(s) still bound to the tree`);
  // Gates passed: only now are identical launch copies removed, so a preserved tree is never touched.
  const launchCopies = removeIdenticalLaunchCopies(path, primary, deps.git);
  if (launchCopies.preserved.length > 0) {
    return {
      path,
      status: 'preserved',
      reason: `launch copy kept: ${launchCopies.preserved.map((item) => `${item.path} (${item.reason})`).join(', ')}`,
      launchCopies,
      unreadableProcessObservations: unreadable,
    };
  }
  const removal = deps.removeTree(path, orca.known);
  let after: Set<string>;
  try {
    after = listedGitPaths(deps.git, canonical);
  } catch {
    after = inventory;
  }
  if (!after.has(path) && !exists(path)) {
    return { path, status: 'removed', launchCopies, unreadableProcessObservations: unreadable };
  }
  return {
    path,
    status: 'preserved',
    reason: `removal not observed: ${oneLine(removal.detail) || 'tree still present after removal'}`,
    launchCopies,
    unreadableProcessObservations: unreadable,
  };
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
    try {
      trees.push(cleanupOneTree(path, primary, inventory, deps, exists, canonical));
    } catch (error) {
      // One tree failing never silences the coordinator report or stops independent trees.
      trees.push({
        path,
        status: 'preserved',
        reason: `unexpected error, tree preserved: ${oneLine(error instanceof Error ? error.message : String(error))}`,
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
    orcaState: (path) => {
      const ps = spawn('orca', ['worktree', 'ps', '--json']);
      const terminals = spawn('orca', ['terminal', 'list', '--json']);
      if (!ps.ok) throw new TypeError(ps.stderr.trim() || 'orca worktree ps failed');
      if (!terminals.ok) throw new TypeError(terminals.stderr.trim() || 'orca terminal list failed');
      const complete = (value: unknown, key: string, label: string): Record<string, unknown>[] => {
        const result = (value as { result?: Record<string, unknown> } | null)?.result;
        const rows = result?.[key];
        if (!result || !Array.isArray(rows)) throw new TypeError(`${label} omitted result.${key}[]`);
        if (result.truncated === true) throw new TypeError(`${label} is truncated`);
        if (typeof result.totalCount === 'number' && result.totalCount !== rows.length) {
          throw new TypeError(`${label} totalCount does not match its rows`);
        }
        return rows as Record<string, unknown>[];
      };
      const worktrees = complete(JSON.parse(ps.stdout), 'worktrees', 'orca worktree ps');
      const termRows = complete(JSON.parse(terminals.stdout), 'terminals', 'orca terminal list');
      const rows = worktrees.filter((row) => typeof row.path === 'string' && canon(row.path) === path);
      const agents = rows.reduce((sum, row) => sum + (Array.isArray(row.agents) ? row.agents.length : 0), 0);
      const unverifiable = rows.reduce(
        (sum, row) => sum + (typeof row.unverifiableTerminalCount === 'number' ? row.unverifiableTerminalCount : 0),
        0,
      );
      const bound = termRows.filter((row) => typeof row.worktreePath === 'string' && canon(row.worktreePath) === path).length;
      return { known: rows.length > 0, agents, terminals: bound + unverifiable };
    },
    removeTree: (path, orcaKnown) => {
      if (orcaKnown) {
        const viaOrca = spawn('orca', ['worktree', 'rm', '--worktree', `path:${path}`, '--json']);
        return { ok: viaOrca.ok, detail: viaOrca.ok ? 'orca worktree rm' : viaOrca.stderr || viaOrca.stdout };
      }
      const viaGit = spawn('git', ['-C', repoRoot, 'worktree', 'remove', path]);
      return { ok: viaGit.ok, detail: viaGit.ok ? 'git worktree remove' : viaGit.stderr };
    },
    send: (handle, text) => {
      const sent = spawn(resolveOrcaExecutable(), promptSendArgv(handle, text));
      try {
        const receipt = classifyPromptSendReceipt(sent.ok ? JSON.parse(sent.stdout) : null, handle);
        if (receipt.status === 'turn_started') return { ok: true, detail: 'sent' };
      } catch { /* Malformed output cannot prove submission. */ }
      return { ok: false, detail: 'delivery unverified; next: owner reads the exact orchestrator pane; do not resend' };
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
  if (argv.includes('--launch-copies-only')) {
    const [tree] = valuesAfter(argv, '--worktree');
    if (!repoRoot || !primaryRoot || !tree) {
      console.error('usage: merge-cleanup.ts --launch-copies-only --repo-root R --primary-root P --worktree PATH');
      process.exitCode = 2;
      return;
    }
    const copies = removeIdenticalLaunchCopies(canon(tree), canon(primaryRoot), defaultMergeCleanupDeps(repoRoot).git);
    console.log(JSON.stringify(copies, null, 2));
    process.exitCode = copies.preserved.length === 0 ? 0 : 1;
    return;
  }
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
