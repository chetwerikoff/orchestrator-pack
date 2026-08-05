#!/usr/bin/env node
// Exact merged-PR post-merge teardown. Default is dry-run; --apply performs effects.

import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { dirname, isAbsolute, join, posix, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runProcessSync, type ProcessResult } from './kernel/subprocess.ts';
import {
  acquireLifecycleExclusion,
  borrowLifecycleExclusion,
  DEFAULT_WORKTREE_LIFECYCLE_EXCLUSION_PATH,
  releaseLifecycleExclusion,
} from './worktree-lifecycle/exclusion.ts';
import {
  WORKTREE_TEARDOWN_RUNTIME_PROFILE as RUNTIME,
  type RuntimeCommand,
} from './worktree-teardown-runtime-profile.ts';

export type PostMergeTeardownOutcome =
  | 'cleanup_eligible'
  | 'cleanup_complete'
  | 'already_absent'
  | 'quiesced_cleanup_deferred'
  | 'unsupported_runtime_preflight'
  | 'task_degraded'
  | 'cleanup_deferred';

type TargetClassification = 'exact_dual' | 'exact_git_only';
type TargetMode = 'branch-bound' | 'detached-confirmed';
type ManifestCategory = 'tracked' | 'untracked' | 'ignored';

export interface CommandInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly timeoutMs?: number;
}

export type CommandRunner = (invocation: CommandInvocation) => ProcessResult;

export interface PostMergeTeardownArgs {
  readonly destructive: boolean;
  readonly repositoryRoot: string | null;
  readonly worktree: string | null;
  readonly pr: number | null;
  readonly initialHead: string | null;
  readonly finalPrHead: string | null;
  readonly expectedBranch: string | null;
  readonly detached: boolean;
  readonly classification: TargetClassification | null;
  readonly apply: boolean;
  readonly json: boolean;
  readonly lifecycleLockPath: string;
  readonly lifecycleLockToken: string | null;
}

interface PrInfo {
  readonly headRefName: string;
  readonly state: string;
  readonly headRefOid: string;
  readonly mergeCommit?: { readonly oid?: string };
  readonly headRepository?: { readonly nameWithOwner?: string };
  readonly baseRefName?: string;
}

interface RuntimeAgent {
  readonly state?: string;
  readonly interrupted?: boolean;
}

interface RuntimeWorktree {
  readonly id?: string;
  readonly path?: string;
  readonly head?: string;
  readonly branch?: string;
  readonly linkedPR?: number | null;
  readonly isMainWorktree?: boolean;
  readonly isArchived?: boolean;
  readonly agents?: readonly RuntimeAgent[];
}

interface RuntimeTerminal {
  readonly handle?: string;
  readonly worktreePath?: string;
  readonly tabId?: string;
}

interface ProcessSnapshot {
  readonly pid: number;
  readonly ppid: number;
  readonly starttime: string;
  readonly cwd: string | null;
}

export interface DiscardManifestEntry {
  readonly category: ManifestCategory;
  readonly path: string;
}

export interface DiscardManifest {
  readonly schema: 'orchestrator-pack/worktree-discard-manifest/v1';
  readonly repositoryRoot: string;
  readonly worktree: string;
  readonly pr: number;
  readonly targetHead: string;
  readonly branch: string | null;
  readonly capturedAt: string;
  readonly entries: readonly DiscardManifestEntry[];
  readonly digest: string;
  readonly encodedBytes: number;
}

interface InventorySnapshot {
  readonly runtimeWorktrees: readonly RuntimeWorktree[];
  readonly runtimeAgents: readonly RuntimeWorktree[];
  readonly runtimeTerminals: readonly RuntimeTerminal[];
  readonly gitWorktreesRaw: string;
  readonly targetRuntimeRows: readonly RuntimeWorktree[];
  readonly targetAgentRows: readonly RuntimeWorktree[];
  readonly targetTerminals: readonly RuntimeTerminal[];
  readonly unrelatedDigest: string;
}

interface TargetIdentity {
  readonly path: string;
  readonly repositoryRoot: string;
  readonly mode: TargetMode;
  readonly branch: string | null;
  readonly head: string;
  readonly commonDir: string;
  readonly primaryCheckout: string;
}

interface ProofSnapshot {
  readonly identity: TargetIdentity;
  readonly pr: PrInfo;
  readonly inventory: InventorySnapshot;
  readonly branchOwnership: boolean;
  readonly capability: 'supported' | 'not-required';
  readonly dirty: boolean;
  readonly activeOrInterrupted: boolean;
}

interface TerminalEffects {
  readonly stopped: number;
  readonly closedPanes: number;
  readonly closedTabs: number;
  readonly mixedTabPreserved: boolean;
  readonly residual: number;
}

interface ProcessEffects {
  readonly selected: number;
  readonly termed: number;
  readonly sigkilled: number;
  readonly residual: number;
}

interface BranchDecision {
  readonly decision: 'deleted' | 'not-present' | 'not-applicable' | 'refused';
  readonly expectedOid?: string;
  readonly observedOid?: string;
  readonly reason: string;
}

export interface PostMergeTeardownReport {
  readonly schema: 'orchestrator-pack/post-merge-worktree-teardown/v1';
  readonly outcome: PostMergeTeardownOutcome;
  readonly pipelineContinues: true;
  readonly apply: boolean;
  readonly repositoryRoot: string;
  readonly worktree: string;
  readonly pr: number;
  readonly classification: TargetClassification | null;
  readonly authority: {
    readonly targetInitialHead: string;
    readonly finalPrHead: string;
    readonly authorizedHeads: readonly string[];
    readonly expectedBranch: string | null;
    readonly detached: boolean;
  };
  readonly preflight?: {
    readonly exactIdentity: boolean;
    readonly mergedPr: boolean;
    readonly branchOwnership: boolean;
    readonly runtimeCapability: 'supported' | 'not-required' | 'unsupported';
    readonly dirty: boolean;
    readonly activeOrInterrupted: boolean;
  };
  readonly terminals?: TerminalEffects;
  readonly processes?: ProcessEffects;
  readonly manifest?: DiscardManifest;
  readonly removal?: {
    readonly method: 'orca-force' | 'git-force';
    readonly attempted: boolean;
    readonly receipt: 'confirmed' | 'unknown' | 'failed';
  };
  readonly branchDeletion?: BranchDecision;
  readonly readback?: {
    readonly gitAbsent: boolean;
    readonly orcaAbsent: boolean;
    readonly unrelatedInventoryStable: boolean;
  };
  readonly effects: readonly string[];
  readonly error?: string;
}

export interface TeardownDependencies {
  readonly runner?: CommandRunner;
  readonly processCensus?: () => readonly ProcessSnapshot[];
  readonly signalProcess?: (pid: number, starttime: string, signal: NodeJS.Signals) => boolean;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => Date;
}

const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const MANIFEST_MAX_ENTRIES = 2_048;
const MANIFEST_MAX_BYTES = 256 * 1024;
const IGNORED_DIRECTORY_ALLOWLIST = [
  'node_modules/',
  '.venv/',
  'venv/',
  'dist/',
  'build/',
  '.turbo/',
  '.next/',
  'coverage/',
  '__pycache__/',
] as const;

function defaultRunner(invocation: CommandInvocation): ProcessResult {
  return runProcessSync({
    command: invocation.command,
    args: invocation.args,
    cwd: invocation.cwd,
    timeoutMs: invocation.timeoutMs,
    inheritParentEnv: true,
  });
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function normalizePath(value: string): string {
  const normalized = resolve(value).replace(/\/+$/, '');
  return normalized || '/';
}

function existingRealpath(value: string): string | null {
  try {
    return realpathSync(value).replace(/\/+$/, '') || '/';
  } catch {
    return null;
  }
}

function normalizeSha(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!SHA_PATTERN.test(normalized)) throw new TypeError(`${label} must be a full 40-hex SHA`);
  return normalized;
}

function normalizeBranch(value: string): string {
  const normalized = value.trim().replace(/^refs\/heads\//, '');
  if (!normalized || normalized.startsWith('-') || normalized.includes('..')) {
    throw new TypeError('expected branch is malformed');
  }
  return normalized;
}

function valueAfter(argv: readonly string[], name: string): string | null {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1] ?? null;
}

function parseArgs(argv = process.argv.slice(2)): PostMergeTeardownArgs {
  const prText = valueAfter(argv, '--pr');
  const parsedPr = prText === null ? null : Number.parseInt(prText, 10);
  const classification = valueAfter(argv, '--classification');
  return {
    destructive: argv.includes('--post-merge-destructive'),
    repositoryRoot: valueAfter(argv, '--repo-root'),
    worktree: valueAfter(argv, '--worktree'),
    pr: parsedPr !== null && Number.isInteger(parsedPr) && parsedPr > 0 ? parsedPr : null,
    initialHead: valueAfter(argv, '--expected-head'),
    finalPrHead: valueAfter(argv, '--final-pr-head'),
    expectedBranch: valueAfter(argv, '--expected-branch'),
    detached: argv.includes('--detached'),
    classification: classification === 'exact_dual' || classification === 'exact_git_only'
      ? classification
      : null,
    apply: argv.includes('--apply'),
    json: argv.includes('--json'),
    lifecycleLockPath: valueAfter(argv, '--lifecycle-lock-path')
      ?? DEFAULT_WORKTREE_LIFECYCLE_EXCLUSION_PATH,
    lifecycleLockToken: valueAfter(argv, '--lifecycle-lock-token'),
  };
}

function commandError(result: ProcessResult, invocation: CommandInvocation): string {
  return result.stderr.trim()
    || result.error
    || `${invocation.command} ${invocation.args.join(' ')} exited ${String(result.exitCode)}`;
}

function runChecked(runner: CommandRunner, invocation: CommandInvocation, label: string): string {
  const result = runner(invocation);
  if (!result.ok) throw new TypeError(`${label}: ${commandError(result, invocation)}`);
  return result.stdout;
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new TypeError(`${label} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function runtimeJson<T>(runner: CommandRunner, command: RuntimeCommand, label: string): T {
  const stdout = runChecked(runner, command, label);
  const parsed = parseJson(stdout, label);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError(`${label} returned a non-object`);
  }
  const root = parsed as Record<string, unknown>;
  if (root.ok !== true) throw new TypeError(`${label} did not return ok=true`);
  if (root.result === undefined) throw new TypeError(`${label} omitted result`);
  return root.result as T;
}

function parseRuntimeWorktrees(value: unknown, label: string): RuntimeWorktree[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} result must be an object`);
  }
  const rows = (value as Record<string, unknown>).worktrees;
  if (!Array.isArray(rows)) throw new TypeError(`${label} omitted worktrees[]`);
  return rows.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new TypeError(`${label} row ${index} is not an object`);
    }
    return item as RuntimeWorktree;
  });
}

function parseRuntimeTerminals(value: unknown, label: string): RuntimeTerminal[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} result must be an object`);
  }
  const rows = (value as Record<string, unknown>).terminals;
  if (!Array.isArray(rows)) throw new TypeError(`${label} omitted terminals[]`);
  return rows.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new TypeError(`${label} row ${index} is not an object`);
    }
    const terminal = item as RuntimeTerminal;
    if (typeof terminal.worktreePath !== 'string' || typeof terminal.handle !== 'string') {
      throw new TypeError(`${label} row ${index} omitted worktreePath/handle`);
    }
    return terminal;
  });
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}

function gitWorktreeRows(raw: string): Array<{ path: string; head: string | null; branch: string | null; detached: boolean }> {
  const rows: Array<{ path: string; head: string | null; branch: string | null; detached: boolean }> = [];
  for (const block of raw.split(/\r?\n\r?\n/)) {
    if (!block.trim()) continue;
    let path: string | null = null;
    let head: string | null = null;
    let branch: string | null = null;
    let detached = false;
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) path = normalizePath(line.slice('worktree '.length));
      else if (line.startsWith('HEAD ')) head = line.slice('HEAD '.length).trim().toLowerCase();
      else if (line.startsWith('branch ')) branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
      else if (line === 'detached') detached = true;
    }
    if (path) rows.push({ path, head, branch, detached });
  }
  return rows;
}

function targetRuntimeRows(rows: readonly RuntimeWorktree[], target: string): RuntimeWorktree[] {
  return rows.filter((row) => typeof row.path === 'string' && normalizePath(row.path) === target);
}

function targetTerminals(rows: readonly RuntimeTerminal[], target: string): RuntimeTerminal[] {
  return rows.filter((row) => typeof row.worktreePath === 'string' && normalizePath(row.worktreePath) === target);
}

function inventorySnapshot(
  runner: CommandRunner,
  repositoryRoot: string,
  target: string,
): InventorySnapshot {
  const gitRaw = runChecked(runner, {
    command: 'git',
    args: ['-C', repositoryRoot, 'worktree', 'list', '--porcelain'],
  }, 'git worktree inventory');
  const runtimeWorktrees = parseRuntimeWorktrees(
    runtimeJson<unknown>(runner, RUNTIME.worktrees(), 'orca worktree list'),
    'orca worktree list',
  );
  const runtimeAgents = parseRuntimeWorktrees(
    runtimeJson<unknown>(runner, RUNTIME.agents(), 'orca worktree ps'),
    'orca worktree ps',
  );
  const runtimeTerminals = parseRuntimeTerminals(
    runtimeJson<unknown>(runner, RUNTIME.terminals_all(), 'orca terminal list'),
    'orca terminal list',
  );
  const gitUnrelated = gitWorktreeRows(gitRaw).filter((row) => row.path !== target);
  const orcaUnrelated = runtimeWorktrees.filter(
    (row) => typeof row.path !== 'string' || normalizePath(row.path) !== target,
  );
  return {
    runtimeWorktrees,
    runtimeAgents,
    runtimeTerminals,
    gitWorktreesRaw: gitRaw,
    targetRuntimeRows: targetRuntimeRows(runtimeWorktrees, target),
    targetAgentRows: targetRuntimeRows(runtimeAgents, target),
    targetTerminals: targetTerminals(runtimeTerminals, target),
    unrelatedDigest: digest({ git: gitUnrelated, orca: orcaUnrelated }),
  };
}

function validateGitLink(
  runner: CommandRunner,
  repositoryRoot: string,
  target: string,
): { commonDir: string; primaryCheckout: string } {
  if (!existsSync(target)) throw new TypeError('target worktree path does not exist');
  const gitPath = join(target, '.git');
  const stat = lstatSync(gitPath);
  if (stat.isDirectory()) throw new TypeError('target is the primary checkout');
  if (!stat.isFile()) throw new TypeError('target .git is not a regular gitdir link file');
  const content = readFileSync(gitPath, 'utf8').trim();
  if (!content.startsWith('gitdir: ')) throw new TypeError('target .git file omitted gitdir');
  const rawGitdir = content.slice('gitdir: '.length).trim();
  const gitdir = normalizePath(isAbsolute(rawGitdir) ? rawGitdir : resolve(target, rawGitdir));
  if (!existsSync(gitdir)) throw new TypeError(`target gitdir does not exist: ${gitdir}`);
  const targetCommon = normalizePath(runChecked(runner, {
    command: 'git',
    args: ['-C', target, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
  }, 'target git common-dir').trim());
  const repoCommon = normalizePath(runChecked(runner, {
    command: 'git',
    args: ['-C', repositoryRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
  }, 'repository git common-dir').trim());
  if (targetCommon !== repoCommon) throw new TypeError('target and repository have different git common directories');
  if (gitdir !== repoCommon && !gitdir.startsWith(`${repoCommon}/worktrees/`)) {
    throw new TypeError('target gitdir is outside the repository common directory');
  }
  const primaryCheckout = dirname(repoCommon);
  if (target === primaryCheckout || repositoryRoot === target) throw new TypeError('target is the primary checkout');
  return { commonDir: repoCommon, primaryCheckout };
}

function readTargetIdentity(
  runner: CommandRunner,
  repositoryRoot: string,
  target: string,
  expectedBranch: string | null,
  detached: boolean,
  authorizedHeads: ReadonlySet<string>,
): TargetIdentity {
  const link = validateGitLink(runner, repositoryRoot, target);
  const head = normalizeSha(runChecked(runner, {
    command: 'git', args: ['-C', target, 'rev-parse', 'HEAD'],
  }, 'target HEAD').trim(), 'target HEAD');
  if (!authorizedHeads.has(head)) {
    throw new TypeError(`target head ${head} is outside the authorized H0/H1 set`);
  }
  const branchResult = runner({
    command: 'git', args: ['-C', target, 'symbolic-ref', '--short', 'HEAD'],
  });
  if (detached) {
    if (branchResult.ok) throw new TypeError('target is branch-bound but detached mode was authorized');
    return {
      path: target,
      repositoryRoot,
      mode: 'detached-confirmed',
      branch: null,
      head,
      commonDir: link.commonDir,
      primaryCheckout: link.primaryCheckout,
    };
  }
  if (!branchResult.ok) throw new TypeError('target is detached but branch-bound mode was authorized');
  const branch = normalizeBranch(branchResult.stdout);
  if (!expectedBranch || branch !== expectedBranch) {
    throw new TypeError(`target branch ${branch} does not match ${expectedBranch ?? '<missing>'}`);
  }
  return {
    path: target,
    repositoryRoot,
    mode: 'branch-bound',
    branch,
    head,
    commonDir: link.commonDir,
    primaryCheckout: link.primaryCheckout,
  };
}

function readPr(
  runner: CommandRunner,
  repositoryRoot: string,
  pr: number,
): PrInfo {
  const gh = join(repositoryRoot, 'scripts', 'gh');
  const stdout = runChecked(runner, {
    command: gh,
    args: [
      'pr', 'view', String(pr), '--json',
      'headRefName,state,headRefOid,mergeCommit,headRepository,baseRefName',
    ],
    cwd: repositoryRoot,
  }, 'gh pr view');
  const parsed = parseJson(stdout, 'gh pr view');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('gh pr view returned a non-object');
  }
  const row = parsed as Record<string, unknown>;
  if (
    typeof row.headRefName !== 'string'
    || typeof row.state !== 'string'
    || typeof row.headRefOid !== 'string'
  ) {
    throw new TypeError('gh pr view omitted headRefName/state/headRefOid');
  }
  const mergeCommit = row.mergeCommit && typeof row.mergeCommit === 'object' && !Array.isArray(row.mergeCommit)
    ? row.mergeCommit as { oid?: string }
    : undefined;
  const headRepository = row.headRepository && typeof row.headRepository === 'object' && !Array.isArray(row.headRepository)
    ? row.headRepository as { nameWithOwner?: string }
    : undefined;
  return {
    headRefName: normalizeBranch(row.headRefName),
    state: row.state.trim().toUpperCase(),
    headRefOid: normalizeSha(row.headRefOid, 'live PR head'),
    ...(mergeCommit ? { mergeCommit } : {}),
    ...(headRepository ? { headRepository } : {}),
    ...(typeof row.baseRefName === 'string' ? { baseRefName: row.baseRefName.trim() } : {}),
  };
}

function proveMergedPr(
  runner: CommandRunner,
  repositoryRoot: string,
  pr: number,
  expectedBranch: string | null,
  detached: boolean,
  finalPrHead: string,
): PrInfo {
  const info = readPr(runner, repositoryRoot, pr);
  if (info.state !== 'MERGED') throw new TypeError(`PR #${String(pr)} is ${info.state}, not MERGED`);
  if (info.headRefOid !== finalPrHead) throw new TypeError('live merged PR head differs from bound H1');
  if (!detached && info.headRefName !== expectedBranch) throw new TypeError('live merged PR branch differs from bound branch');
  if (info.baseRefName !== undefined && info.baseRefName !== 'main') throw new TypeError('merged PR base is not main');
  const mergeOid = info.mergeCommit?.oid;
  if (typeof mergeOid !== 'string') throw new TypeError('merged PR omitted mergeCommit.oid');
  const normalizedMerge = normalizeSha(mergeOid, 'merge commit');
  runChecked(runner, {
    command: 'git', args: ['-C', repositoryRoot, 'fetch', 'origin', 'main'],
  }, 'fetch current main');
  const adopted = runner({
    command: 'git',
    args: ['-C', repositoryRoot, 'merge-base', '--is-ancestor', normalizedMerge, 'origin/main'],
  });
  if (!adopted.ok || adopted.exitCode !== 0) {
    throw new TypeError('PR merge result is not adopted by current origin/main');
  }
  return info;
}

function proveBranchOwnership(
  runner: CommandRunner,
  repositoryRoot: string,
  pr: number,
  info: PrInfo,
  branch: string | null,
): boolean {
  if (!branch) return true;
  const repo = info.headRepository?.nameWithOwner;
  if (!repo) return false;
  const gh = join(repositoryRoot, 'scripts', 'gh');
  const stdout = runChecked(runner, {
    command: gh,
    args: [
      'pr', 'list', '--state', 'open', '--json',
      'number,headRefName,headRepository', '--repo', repo,
    ],
    cwd: repositoryRoot,
  }, 'gh pr list');
  const rows = parseJson(stdout, 'gh pr list');
  if (!Array.isArray(rows)) throw new TypeError('gh pr list returned a non-array');
  return rows.every((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const row = value as Record<string, unknown>;
    return !(row.number !== pr && row.headRefName === branch);
  });
}

export function validateForceRemovalHelp(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').toLowerCase();
  return normalized.includes('worktree rm')
    && normalized.includes('--worktree')
    && normalized.includes('--force')
    && normalized.includes('--json');
}

function proveRuntimeCapability(
  runner: CommandRunner,
  classification: TargetClassification,
): 'supported' | 'not-required' {
  if (classification === 'exact_git_only') return 'not-required';
  const command = RUNTIME.remove_worktree_help();
  const result = runner(command);
  if (!result.ok || !validateForceRemovalHelp(`${result.stdout}\n${result.stderr}`)) {
    throw new TypeError('installed Orca does not capture-prove worktree rm --worktree --force --json');
  }
  return 'supported';
}

function validateRuntimeIdentity(
  classification: TargetClassification,
  inventory: InventorySnapshot,
  identity: TargetIdentity,
  pr: number,
  authorizedHeads: ReadonlySet<string>,
): void {
  const rows = inventory.targetRuntimeRows;
  if (classification === 'exact_git_only') {
    if (rows.length !== 0) throw new TypeError('exact_git_only target unexpectedly exists in Orca inventory');
    const mainRows = inventory.runtimeWorktrees.filter(
      (row) => row.isMainWorktree === true
        && row.isArchived !== true
        && typeof row.path === 'string'
        && normalizePath(row.path) === identity.repositoryRoot,
    );
    if (mainRows.length !== 1) throw new TypeError('Orca did not prove one main repository row for exact_git_only cleanup');
    return;
  }
  if (rows.length !== 1) throw new TypeError(`exact_dual target matched ${String(rows.length)} Orca rows`);
  const row = rows[0]!;
  if (row.isMainWorktree === true || row.isArchived === true) throw new TypeError('target Orca row is main or archived');
  if (typeof row.head !== 'string' || !authorizedHeads.has(normalizeSha(row.head, 'Orca target head'))) {
    throw new TypeError('Orca target head is outside the authorized H0/H1 set');
  }
  const runtimeBranch = typeof row.branch === 'string' ? row.branch.replace(/^refs\/heads\//, '') : null;
  if (identity.mode === 'branch-bound' && runtimeBranch !== identity.branch) {
    throw new TypeError('Orca target branch differs from Git target branch');
  }
  if (identity.mode === 'detached-confirmed' && row.branch !== '') {
    throw new TypeError('Orca detached target does not use the explicit empty-string branch representation');
  }
  if (row.linkedPR !== undefined && row.linkedPR !== null && row.linkedPR !== pr) {
    throw new TypeError('Orca target is linked to another PR');
  }
}

function activeOrInterrupted(rows: readonly RuntimeWorktree[]): boolean {
  return rows.some((row) => Array.isArray(row.agents) && row.agents.some(
    (agent) => agent.state !== 'done' || agent.interrupted === true,
  ));
}

function dirtyStatus(runner: CommandRunner, target: string): boolean {
  const result = runner({
    command: 'git', args: ['-C', target, 'status', '--porcelain', '--untracked-files=all'],
  });
  return result.ok && result.stdout.length > 0;
}

function proveTarget(
  runner: CommandRunner,
  input: {
    readonly repositoryRoot: string;
    readonly target: string;
    readonly pr: number;
    readonly initialHead: string;
    readonly finalPrHead: string;
    readonly expectedBranch: string | null;
    readonly detached: boolean;
    readonly classification: TargetClassification;
  },
): ProofSnapshot {
  const heads = new Set([input.initialHead, input.finalPrHead]);
  const identity = readTargetIdentity(
    runner,
    input.repositoryRoot,
    input.target,
    input.expectedBranch,
    input.detached,
    heads,
  );
  const prInfo = proveMergedPr(
    runner,
    input.repositoryRoot,
    input.pr,
    input.expectedBranch,
    input.detached,
    input.finalPrHead,
  );
  const inventory = inventorySnapshot(runner, input.repositoryRoot, input.target);
  validateRuntimeIdentity(input.classification, inventory, identity, input.pr, heads);
  const ownership = proveBranchOwnership(
    runner,
    input.repositoryRoot,
    input.pr,
    prInfo,
    identity.branch,
  );
  if (!ownership) throw new TypeError('target branch is reused or owned by another open PR');
  const capability = proveRuntimeCapability(runner, input.classification);
  return {
    identity,
    pr: prInfo,
    inventory,
    branchOwnership: ownership,
    capability,
    dirty: dirtyStatus(runner, input.target),
    activeOrInterrupted: activeOrInterrupted(inventory.targetAgentRows),
  };
}

function manifestPath(raw: string): string {
  if (!raw || raw.includes('\0') || posix.isAbsolute(raw)) throw new TypeError('manifest path is empty, NUL-bearing, or absolute');
  const normalized = posix.normalize(raw);
  if (normalized === '..' || normalized.startsWith('../')) throw new TypeError(`manifest path escapes repository: ${JSON.stringify(raw)}`);
  return normalized;
}

export function parseDiscardEntries(
  porcelainZ: string,
  ignoredZ: string,
): DiscardManifestEntry[] {
  const entries: DiscardManifestEntry[] = [];
  const statusParts = porcelainZ.split('\0');
  for (let index = 0; index < statusParts.length; index += 1) {
    const item = statusParts[index]!;
    if (!item) continue;
    if (item.length < 4 || item[2] !== ' ') throw new TypeError(`malformed porcelain-v1 -z entry at index ${String(index)}`);
    const code = item.slice(0, 2);
    const category: ManifestCategory = code === '??' ? 'untracked' : 'tracked';
    entries.push({ category, path: manifestPath(item.slice(3)) });
    if (code.includes('R') || code.includes('C')) {
      const paired = statusParts[index + 1];
      if (!paired) throw new TypeError('rename/copy porcelain entry omitted paired path');
      entries.push({ category: 'tracked', path: manifestPath(paired) });
      index += 1;
    }
  }
  for (const item of ignoredZ.split('\0')) {
    if (!item) continue;
    const path = manifestPath(item);
    if (IGNORED_DIRECTORY_ALLOWLIST.some((allowed) => path === allowed.slice(0, -1) || path.startsWith(allowed))) {
      continue;
    }
    entries.push({ category: 'ignored', path });
  }
  const deduped = [...new Map(entries.map((entry) => [`${entry.category}\0${entry.path}`, entry])).values()]
    .sort((left, right) => left.category.localeCompare(right.category) || left.path.localeCompare(right.path));
  if (deduped.length > MANIFEST_MAX_ENTRIES) {
    throw new TypeError(`discard manifest exceeds ${String(MANIFEST_MAX_ENTRIES)} entries`);
  }
  return deduped;
}

function captureManifest(
  runner: CommandRunner,
  now: () => Date,
  input: {
    readonly repositoryRoot: string;
    readonly target: string;
    readonly pr: number;
    readonly identity: TargetIdentity;
  },
): DiscardManifest {
  const porcelain = runChecked(runner, {
    command: 'git',
    args: ['-C', input.target, 'status', '--porcelain=v1', '-z', '--untracked-files=all'],
  }, 'final git status');
  const ignored = runChecked(runner, {
    command: 'git',
    args: ['-C', input.target, 'ls-files', '--others', '--ignored', '--exclude-standard', '-z'],
  }, 'final ignored-path census');
  const entries = parseDiscardEntries(porcelain, ignored);
  const payload = {
    schema: 'orchestrator-pack/worktree-discard-manifest/v1' as const,
    repositoryRoot: input.repositoryRoot,
    worktree: input.target,
    pr: input.pr,
    targetHead: input.identity.head,
    branch: input.identity.branch,
    capturedAt: now().toISOString(),
    entries,
  };
  const encodedBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  if (encodedBytes > MANIFEST_MAX_BYTES) {
    throw new TypeError(`discard manifest exceeds ${String(MANIFEST_MAX_BYTES)} encoded bytes`);
  }
  return {
    ...payload,
    digest: digest({ ...payload, capturedAt: '<excluded>' }),
    encodedBytes,
  };
}

function sameManifest(left: DiscardManifest, right: DiscardManifest): boolean {
  return left.digest === right.digest
    && left.targetHead === right.targetHead
    && left.branch === right.branch
    && left.entries.length === right.entries.length;
}

function defaultProcessCensus(): ProcessSnapshot[] {
  const result: ProcessSnapshot[] = [];
  for (const name of readdirSync('/proc').filter((value) => /^\d+$/.test(value))) {
    const pid = Number.parseInt(name, 10);
    if (!Number.isInteger(pid) || pid <= 1) continue;
    let stat: string;
    try {
      stat = readFileSync(`/proc/${name}/stat`, 'utf8');
    } catch {
      continue;
    }
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    let cwd: string | null = null;
    try {
      cwd = normalizePath(readlinkSync(`/proc/${name}/cwd`).replace(/ \(deleted\)$/, ''));
    } catch {
      // Process may disappear or deny access between reads.
    }
    result.push({
      pid,
      ppid: Number.parseInt(fields[1] ?? '0', 10),
      starttime: fields[19] ?? '',
      cwd,
    });
  }
  return result;
}

function selectedProcesses(rows: readonly ProcessSnapshot[], target: string): ProcessSnapshot[] {
  const selected = new Set(
    rows.filter((row) => row.cwd === target || row.cwd?.startsWith(`${target}/`)).map((row) => row.pid),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (!selected.has(row.pid) && selected.has(row.ppid)) {
        selected.add(row.pid);
        changed = true;
      }
    }
  }
  const self = new Set<number>([1, process.pid]);
  let parent = rows.find((row) => row.pid === process.pid)?.ppid ?? 0;
  while (parent > 1 && !self.has(parent)) {
    self.add(parent);
    parent = rows.find((row) => row.pid === parent)?.ppid ?? 0;
  }
  return rows
    .filter((row) => selected.has(row.pid) && row.pid > 1 && !self.has(row.pid))
    .sort((left, right) => right.pid - left.pid);
}

function defaultSignal(pid: number, starttime: string, signal: NodeJS.Signals): boolean {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
    if (stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] !== starttime) return false;
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

async function reapTargetProcesses(
  target: string,
  apply: boolean,
  dependencies: Required<Pick<TeardownDependencies, 'processCensus' | 'signalProcess' | 'sleep'>>,
): Promise<ProcessEffects> {
  const initial = selectedProcesses(dependencies.processCensus(), target);
  if (!apply) return { selected: initial.length, termed: 0, sigkilled: 0, residual: initial.length };
  let termed = 0;
  for (const row of initial) if (dependencies.signalProcess(row.pid, row.starttime, 'SIGTERM')) termed += 1;
  for (let iteration = 0; iteration < 20; iteration += 1) {
    if (selectedProcesses(dependencies.processCensus(), target).length === 0) break;
    await dependencies.sleep(500);
  }
  const stubborn = selectedProcesses(dependencies.processCensus(), target);
  let sigkilled = 0;
  for (const row of stubborn) if (dependencies.signalProcess(row.pid, row.starttime, 'SIGKILL')) sigkilled += 1;
  let firstZero = false;
  let residual: ProcessSnapshot[] = [];
  for (let iteration = 0; iteration < 8; iteration += 1) {
    residual = selectedProcesses(dependencies.processCensus(), target);
    if (residual.length === 0) {
      if (firstZero) break;
      firstZero = true;
    } else {
      firstZero = false;
    }
    await dependencies.sleep(250);
  }
  return {
    selected: initial.length,
    termed,
    sigkilled,
    residual: residual.length,
  };
}

function terminalPlan(rows: readonly RuntimeTerminal[], target: string): TerminalEffects {
  const targetRows = targetTerminals(rows, target);
  let closedPanes = 0;
  let closedTabs = 0;
  let mixed = false;
  const byTab = new Map<string, RuntimeTerminal[]>();
  for (const row of targetRows) {
    const key = row.tabId?.trim() || `pane:${row.handle ?? ''}`;
    const bucket = byTab.get(key) ?? [];
    bucket.push(row);
    byTab.set(key, bucket);
  }
  for (const rowsForTarget of byTab.values()) {
    const tabId = rowsForTarget[0]?.tabId?.trim();
    const allRows = tabId ? rows.filter((row) => row.tabId?.trim() === tabId) : rowsForTarget;
    const targetOnly = Boolean(tabId) && allRows.every((row) => targetTerminals([row], target).length === 1);
    if (targetOnly) closedTabs += 1;
    else {
      closedPanes += rowsForTarget.length;
      mixed = mixed || Boolean(tabId && allRows.some((row) => targetTerminals([row], target).length === 0));
    }
  }
  return {
    stopped: targetRows.length,
    closedPanes,
    closedTabs,
    mixedTabPreserved: mixed,
    residual: targetRows.length,
  };
}

function runRuntimeEffect(runner: CommandRunner, command: RuntimeCommand, label: string): void {
  runtimeJson<unknown>(runner, command, label);
}

function quiesceTerminals(
  runner: CommandRunner,
  target: string,
  initialRows: readonly RuntimeTerminal[],
): TerminalEffects {
  const plan = terminalPlan(initialRows, target);
  if (plan.stopped > 0) runRuntimeEffect(runner, RUNTIME.stop_terminals(target), 'orca terminal stop');
  let rows = parseRuntimeTerminals(
    runtimeJson<unknown>(runner, RUNTIME.terminals_all(), 'orca terminal list after stop'),
    'orca terminal list after stop',
  );
  const survivors = targetTerminals(rows, target);
  const byTab = new Map<string, RuntimeTerminal[]>();
  for (const row of survivors) {
    const key = row.tabId?.trim() || `pane:${row.handle ?? ''}`;
    const bucket = byTab.get(key) ?? [];
    bucket.push(row);
    byTab.set(key, bucket);
  }
  let closedPanes = 0;
  let closedTabs = 0;
  let mixed = false;
  for (const rowsForTarget of byTab.values()) {
    const tabId = rowsForTarget[0]?.tabId?.trim();
    const allRows = tabId ? rows.filter((row) => row.tabId?.trim() === tabId) : rowsForTarget;
    const targetOnly = Boolean(tabId) && allRows.every((row) => targetTerminals([row], target).length === 1);
    if (targetOnly) {
      const handle = rowsForTarget[0]?.handle;
      if (!handle) throw new TypeError('target-only tab has no exact terminal handle');
      runRuntimeEffect(runner, RUNTIME.close_tab(handle), 'orca terminal close --tab');
      closedTabs += 1;
    } else {
      mixed = mixed || Boolean(tabId && allRows.some((row) => targetTerminals([row], target).length === 0));
      for (const row of rowsForTarget) {
        if (!row.handle) throw new TypeError('target pane has no exact terminal handle');
        runRuntimeEffect(runner, RUNTIME.close_pane(row.handle), 'orca terminal close pane');
        closedPanes += 1;
      }
    }
  }
  rows = parseRuntimeTerminals(
    runtimeJson<unknown>(runner, RUNTIME.terminals_all(), 'final orca terminal list'),
    'final orca terminal list',
  );
  return {
    stopped: plan.stopped,
    closedPanes,
    closedTabs,
    mixedTabPreserved: mixed,
    residual: targetTerminals(rows, target).length,
  };
}

function branchDecision(
  runner: CommandRunner,
  proof: ProofSnapshot,
  authorizedHeads: ReadonlySet<string>,
  pr: number,
): BranchDecision {
  const branch = proof.identity.branch;
  if (!branch) return { decision: 'not-applicable', reason: 'target is detached' };
  const ref = `refs/heads/${branch}`;
  const current = runner({
    command: 'git', args: ['-C', proof.identity.repositoryRoot, 'rev-parse', '--verify', ref],
  });
  if (!current.ok) return { decision: 'not-present', reason: 'local branch ref is already absent' };
  const oid = normalizeSha(current.stdout.trim(), 'branch ref');
  if (!authorizedHeads.has(oid)) {
    return { decision: 'refused', observedOid: oid, reason: 'branch moved outside the authorized H0/H1 set' };
  }
  const prInfo = proveMergedPr(
    runner,
    proof.identity.repositoryRoot,
    pr,
    branch,
    false,
    normalizeSha(proof.pr.headRefOid, 'final PR head'),
  );
  if (!proveBranchOwnership(runner, proof.identity.repositoryRoot, pr, prInfo, branch)) {
    return { decision: 'refused', observedOid: oid, reason: 'branch ownership is no longer exclusive' };
  }
  const deleted = runner({
    command: 'git',
    args: ['-C', proof.identity.repositoryRoot, 'update-ref', '-d', ref, oid],
  });
  return deleted.ok
    ? { decision: 'deleted', expectedOid: oid, observedOid: oid, reason: 'expected-OID compare-and-delete succeeded' }
    : { decision: 'refused', expectedOid: oid, observedOid: oid, reason: 'expected-OID compare-and-delete refused' };
}

function removeTarget(
  runner: CommandRunner,
  proof: ProofSnapshot,
  classification: TargetClassification,
): NonNullable<PostMergeTeardownReport['removal']> {
  if (classification === 'exact_dual') {
    const command = RUNTIME.remove_worktree_force(proof.identity.path);
    const result = runner(command);
    if (!result.ok) return { method: 'orca-force', attempted: true, receipt: 'unknown' };
    try {
      const parsed = parseJson(result.stdout, 'orca worktree rm --force');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { method: 'orca-force', attempted: true, receipt: 'failed' };
      }
      const root = parsed as Record<string, unknown>;
      const payload = root.result && typeof root.result === 'object' && !Array.isArray(root.result)
        ? root.result as Record<string, unknown>
        : null;
      return root.ok === true && payload?.removed === true
        ? { method: 'orca-force', attempted: true, receipt: 'confirmed' }
        : { method: 'orca-force', attempted: true, receipt: 'failed' };
    } catch {
      return { method: 'orca-force', attempted: true, receipt: 'unknown' };
    }
  }
  const result = runner({
    command: 'git',
    args: ['-C', proof.identity.repositoryRoot, 'worktree', 'remove', '--force', proof.identity.path],
  });
  return {
    method: 'git-force',
    attempted: true,
    receipt: result.ok ? 'confirmed' : 'unknown',
  };
}

function readback(
  runner: CommandRunner,
  repositoryRoot: string,
  target: string,
  unrelatedBefore: string,
): NonNullable<PostMergeTeardownReport['readback']> {
  const snapshot = inventorySnapshot(runner, repositoryRoot, target);
  const gitAbsent = gitWorktreeRows(snapshot.gitWorktreesRaw).every((row) => row.path !== target);
  const orcaAbsent = snapshot.targetRuntimeRows.length === 0;
  return {
    gitAbsent,
    orcaAbsent,
    unrelatedInventoryStable: snapshot.unrelatedDigest === unrelatedBefore,
  };
}

function reportBase(args: PostMergeTeardownArgs): PostMergeTeardownReport {
  const initialHead = args.initialHead && SHA_PATTERN.test(args.initialHead.trim())
    ? args.initialHead.trim().toLowerCase()
    : '';
  const finalPrHead = args.finalPrHead && SHA_PATTERN.test(args.finalPrHead.trim())
    ? args.finalPrHead.trim().toLowerCase()
    : '';
  return {
    schema: 'orchestrator-pack/post-merge-worktree-teardown/v1',
    outcome: 'cleanup_deferred',
    pipelineContinues: true,
    apply: args.apply,
    repositoryRoot: args.repositoryRoot ? normalizePath(args.repositoryRoot) : '',
    worktree: args.worktree ? normalizePath(args.worktree) : '',
    pr: args.pr ?? 0,
    classification: args.classification,
    authority: {
      targetInitialHead: initialHead,
      finalPrHead,
      authorizedHeads: [...new Set([initialHead, finalPrHead].filter(Boolean))],
      expectedBranch: args.expectedBranch,
      detached: args.detached,
    },
    effects: [],
  };
}

function validateArguments(args: PostMergeTeardownArgs): void {
  if (!args.destructive) throw new TypeError('--post-merge-destructive is required');
  if (!args.repositoryRoot || !args.worktree || !args.pr) {
    throw new TypeError('--repo-root, --worktree, and --pr are required');
  }
  if (!args.initialHead || !args.finalPrHead) {
    throw new TypeError('--expected-head H0 and --final-pr-head H1 are required');
  }
  normalizeSha(args.initialHead, 'target initial head');
  normalizeSha(args.finalPrHead, 'final PR head');
  if (args.detached === Boolean(args.expectedBranch)) {
    throw new TypeError('choose exactly one of --expected-branch or --detached');
  }
  if (args.expectedBranch) normalizeBranch(args.expectedBranch);
  if (!args.classification) throw new TypeError('--classification must be exact_dual or exact_git_only');
}

export async function runPostMergeTeardown(
  args: PostMergeTeardownArgs,
  dependencies: TeardownDependencies = {},
): Promise<PostMergeTeardownReport> {
  const report = reportBase(args);
  try {
    validateArguments(args);
  } catch (error) {
    return { ...report, error: error instanceof Error ? error.message : String(error) };
  }
  const runner = dependencies.runner ?? defaultRunner;
  const processDependencies = {
    processCensus: dependencies.processCensus ?? defaultProcessCensus,
    signalProcess: dependencies.signalProcess ?? defaultSignal,
    sleep: dependencies.sleep ?? defaultSleep,
  };
  const now = dependencies.now ?? (() => new Date());
  const repositoryRoot = existingRealpath(args.repositoryRoot!) ?? normalizePath(args.repositoryRoot!);
  const target = existingRealpath(args.worktree!) ?? normalizePath(args.worktree!);
  const initialHead = normalizeSha(args.initialHead!, 'target initial head');
  const finalPrHead = normalizeSha(args.finalPrHead!, 'final PR head');
  const expectedBranch = args.expectedBranch ? normalizeBranch(args.expectedBranch) : null;
  const authorizedHeads = new Set([initialHead, finalPrHead]);
  const binding = {
    repositoryRoot,
    target,
    pr: args.pr!,
    initialHead,
    finalPrHead,
    expectedBranch,
    detached: args.detached,
    classification: args.classification!,
  };

  if (!existsSync(target)) {
    try {
      const rb = readback(runner, repositoryRoot, target, inventorySnapshot(runner, repositoryRoot, target).unrelatedDigest);
      if (rb.gitAbsent && rb.orcaAbsent) {
        return { ...report, repositoryRoot, worktree: target, outcome: 'already_absent', readback: rb };
      }
    } catch {
      // Fall through to truthful deferred result.
    }
    return { ...report, repositoryRoot, worktree: target, error: 'target is absent but dual absence could not be proven' };
  }

  let first: ProofSnapshot;
  try {
    first = proveTarget(runner, binding);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const unsupported = message.includes('capture-prove worktree rm');
    return {
      ...report,
      repositoryRoot,
      worktree: target,
      outcome: unsupported ? 'unsupported_runtime_preflight' : 'cleanup_deferred',
      preflight: {
        exactIdentity: !message.includes('target') || !message.includes('outside'),
        mergedPr: !message.includes('PR') && !message.includes('merge result') ? false : false,
        branchOwnership: false,
        runtimeCapability: unsupported ? 'unsupported' : 'not-required',
        dirty: false,
        activeOrInterrupted: false,
      },
      error: message,
    };
  }

  const preflight = {
    exactIdentity: true,
    mergedPr: true,
    branchOwnership: first.branchOwnership,
    runtimeCapability: first.capability,
    dirty: first.dirty,
    activeOrInterrupted: first.activeOrInterrupted,
  } as const;
  if (!args.apply) {
    try {
      const dryManifest = captureManifest(runner, now, {
        repositoryRoot,
        target,
        pr: args.pr!,
        identity: first.identity,
      });
      return {
        ...report,
        repositoryRoot,
        worktree: target,
        outcome: 'cleanup_eligible',
        preflight,
        terminals: terminalPlan(first.inventory.runtimeTerminals, target),
        processes: await reapTargetProcesses(target, false, processDependencies),
        manifest: dryManifest,
      };
    } catch (error) {
      return {
        ...report,
        repositoryRoot,
        worktree: target,
        outcome: 'cleanup_deferred',
        preflight,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const effects: string[] = [];
  let terminals: TerminalEffects;
  try {
    terminals = quiesceTerminals(runner, target, first.inventory.runtimeTerminals);
    effects.push('target terminals stopped/closed');
  } catch (error) {
    return {
      ...report,
      repositoryRoot,
      worktree: target,
      outcome: 'task_degraded',
      preflight,
      effects,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (terminals.residual > 0) {
    return {
      ...report,
      repositoryRoot,
      worktree: target,
      outcome: 'task_degraded',
      preflight,
      terminals,
      effects,
      error: `${String(terminals.residual)} exact target terminals remain`,
    };
  }

  const processes = await reapTargetProcesses(target, true, processDependencies);
  effects.push('observable target CWD-and-ancestry processes reaped');
  if (processes.residual > 0) {
    return {
      ...report,
      repositoryRoot,
      worktree: target,
      outcome: 'task_degraded',
      preflight,
      terminals,
      processes,
      effects,
      error: `${String(processes.residual)} observable target processes remain`,
    };
  }

  let fresh: ProofSnapshot;
  try {
    fresh = proveTarget(runner, binding);
  } catch (error) {
    return {
      ...report,
      repositoryRoot,
      worktree: target,
      outcome: 'quiesced_cleanup_deferred',
      preflight,
      terminals,
      processes,
      effects,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  let manifest: DiscardManifest;
  try {
    const firstManifest = captureManifest(runner, now, {
      repositoryRoot,
      target,
      pr: args.pr!,
      identity: fresh.identity,
    });
    const secondIdentity = readTargetIdentity(
      runner,
      repositoryRoot,
      target,
      expectedBranch,
      args.detached,
      authorizedHeads,
    );
    const secondManifest = captureManifest(runner, now, {
      repositoryRoot,
      target,
      pr: args.pr!,
      identity: secondIdentity,
    });
    if (!sameManifest(firstManifest, secondManifest)) {
      throw new TypeError('final discard manifest changed between consecutive post-quiescence captures');
    }
    manifest = secondManifest;
  } catch (error) {
    return {
      ...report,
      repositoryRoot,
      worktree: target,
      outcome: 'quiesced_cleanup_deferred',
      preflight,
      terminals,
      processes,
      effects,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    const finalProof = proveTarget(runner, binding);
    if (
      finalProof.identity.head !== manifest.targetHead
      || finalProof.identity.branch !== manifest.branch
    ) {
      throw new TypeError('target identity changed after final discard manifest capture');
    }
    fresh = finalProof;
  } catch (error) {
    return {
      ...report,
      repositoryRoot,
      worktree: target,
      outcome: 'quiesced_cleanup_deferred',
      preflight,
      terminals,
      processes,
      manifest,
      effects,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const removal = removeTarget(runner, fresh, args.classification!);
  effects.push(`${removal.method} worktree removal attempted`);
  const branchDeletion = branchDecision(runner, fresh, authorizedHeads, args.pr!);
  if (branchDeletion.decision === 'deleted') effects.push('local branch deleted by expected-OID CAS');
  const rb = readback(runner, repositoryRoot, target, first.inventory.unrelatedDigest);
  const complete = rb.gitAbsent && rb.orcaAbsent && rb.unrelatedInventoryStable;
  return {
    ...report,
    repositoryRoot,
    worktree: target,
    outcome: complete ? 'cleanup_complete' : 'task_degraded',
    preflight,
    terminals,
    processes,
    manifest,
    removal,
    branchDeletion,
    readback: rb,
    effects,
    ...(!complete ? { error: 'dual post-effect read-back did not prove exact absence with unrelated inventory unchanged' } : {}),
  };
}

function emit(report: PostMergeTeardownReport, json: boolean): void {
  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`Outcome: ${report.outcome}`);
    console.log(`Target: ${report.worktree}`);
    console.log(`Authorized heads: ${report.authority.authorizedHeads.join(', ')}`);
    if (report.error) console.log(`Detail: ${report.error}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  const lock = args.lifecycleLockToken
    ? borrowLifecycleExclusion(args.lifecycleLockPath, args.lifecycleLockToken)
    : acquireLifecycleExclusion(args.lifecycleLockPath);
  if (!lock) {
    const report = {
      ...reportBase(args),
      outcome: 'cleanup_deferred' as const,
      error: args.lifecycleLockToken
        ? `borrowed lifecycle exclusion could not be verified at ${args.lifecycleLockPath}`
        : `lifecycle exclusion is held or unreadable at ${args.lifecycleLockPath}`,
    };
    emit(report, args.json);
    process.exitCode = 0;
    return;
  }
  try {
    emit(await runPostMergeTeardown(args), args.json);
    process.exitCode = 0;
  } catch (error) {
    emit({
      ...reportBase(args),
      outcome: 'task_degraded',
      error: error instanceof Error ? error.message : String(error),
    }, args.json);
    process.exitCode = 0;
  } finally {
    releaseLifecycleExclusion(args.lifecycleLockPath, lock);
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) void main();
