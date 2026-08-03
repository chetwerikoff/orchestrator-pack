#!/usr/bin/env node
// Unified worktree teardown: validation, gates, terminal stop/close, process reap, re-check, removal.
// Default is DRY-RUN. --apply executes. Exit 0 only for reaped_clean.

import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { runProcessSync, type ProcessResult } from './kernel/subprocess.ts';
import {
  WORKTREE_TEARDOWN_RUNTIME_PROFILE as RUNTIME,
  type RuntimeCommand,
} from './worktree-teardown-runtime-profile.ts';

type TeardownOutcome =
  | 'reaped_clean'
  | 'blocked_lock_held'
  | 'blocked_invalid_target'
  | 'blocked_unprovable_orphan'
  | 'blocked_identity_drift'
  | 'blocked_dirty_worktree'
  | 'blocked_ignored_operator_data'
  | 'blocked_unmerged_work'
  | 'blocked_shared_head_ref'
  | 'blocked_state_desync'
  | 'blocked_state_drift'
  | 'blocked_mixed_tab'
  | 'partial_residual_processes'
  | 'terminal_stop_failed'
  | 'worktree_remove_failed';

type GateVerdict = 'pass' | 'fail';

interface TeardownReport {
  worktree: string;
  pr: number;
  outcome: TeardownOutcome;
  apply_mode: boolean;
  gates: Record<'g1' | 'g2a' | 'g2b' | 'g3' | 'g4' | 'g5', GateVerdict>;
  validation: {
    is_primary_checkout: boolean;
    is_in_inventory: boolean;
    path_exists: boolean;
  };
  terminals?: {
    stopped: number;
    closed_panes: number;
    closed_tabs: number;
    mixed_tab_found: boolean;
  };
  processes?: {
    selected: number;
    termed: number;
    sigkilled: number;
    residual: number;
  };
  recheck?: Record<'g1' | 'g2a' | 'g2b' | 'g5', GateVerdict>;
  worktree_removal?: {
    attempted: boolean;
    removed: boolean;
  };
  branch_deletion?: {
    method: 'd' | 'skipped';
    reason: string;
  };
  error?: string;
}

interface ParsedArgs {
  worktree: string | null;
  pr: number | null;
  apply: boolean;
  json: boolean;
  orphan: boolean;
  iKnowThisPath: boolean;
}

interface PRInfo {
  headRefName: string;
  state: string;
  headRefOid: string;
  mergeCommit?: { oid: string };
  headRepository?: { nameWithOwner: string };
  baseRefName?: string;
}

interface RuntimeAgent {
  state?: string;
  interrupted?: boolean;
}

interface RuntimeWorktree {
  path?: string;
  head?: string;
  branch?: string;
  isMainWorktree?: boolean;
  agents?: RuntimeAgent[];
}

interface RuntimeTerminal {
  handle?: string;
  worktreePath?: string;
  tabId?: string;
}

interface IdentitySnapshot {
  mode: 'branch-bound' | 'detached-confirmed';
  headSha: string;
  branchName?: string;
}

interface GateResults {
  g1: boolean;
  g2a: boolean;
  g2b: boolean;
  g3: boolean;
  g4: boolean;
  g5: boolean;
  failedOutcome?: TeardownOutcome;
  prBranchName?: string;
  identity?: IdentitySnapshot;
  detail?: string;
}

interface ProcessSnapshot {
  pid: number;
  ppid: number;
  starttime: string;
  cwd: string | null;
  cmd: string;
  exe: string | null;
}

interface ReapResult {
  selected: number;
  termed: number;
  sigkilled: number;
  residual: number;
}

interface RuntimeJsonResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

const LOCK_PATH = '/tmp/opk-worktree-teardown.lock';
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

function parseArgs(): ParsedArgs {
  const argv = process.argv.slice(2);
  const value = (name: string): string | null => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] ?? null : null;
  };
  const prValue = value('--pr');
  const parsedPr = prValue === null ? null : Number.parseInt(prValue, 10);
  return {
    worktree: value('--worktree'),
    pr: parsedPr !== null && Number.isInteger(parsedPr) && parsedPr > 0 ? parsedPr : null,
    apply: argv.includes('--apply'),
    json: argv.includes('--json'),
    orphan: argv.includes('--orphan'),
    iKnowThisPath: argv.includes('--i-know-this-path'),
  };
}

function gitRunSync(args: readonly string[], cwd?: string): ProcessResult {
  return runProcessSync({ command: 'git', args, cwd, inheritParentEnv: true });
}

function normalizePath(pathValue: string): string {
  const normalized = pathValue.replace(/\/+$/, '');
  return normalized || '/';
}

function existingRealpath(pathValue: string): string | null {
  try {
    return normalizePath(realpathSync(pathValue));
  } catch {
    return null;
  }
}

function acquireLock(): boolean {
  try {
    writeFileSync(LOCK_PATH, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function releaseLock(): void {
  try {
    unlinkSync(LOCK_PATH);
  } catch {
    // The owner removes only the lock it acquired; missing-at-release is harmless.
  }
}

function runtimeJson<T>(command: RuntimeCommand): RuntimeJsonResult<T> {
  const result = runProcessSync({
    command: command.command,
    args: command.args,
    inheritParentEnv: true,
  });
  if (!result.ok) {
    return {
      ok: false,
      error: result.stderr.trim() || result.error || `${command.args.join(' ')} failed`,
    };
  }
  try {
    const parsed = JSON.parse(result.stdout) as { ok?: boolean; result?: T; error?: { message?: string; code?: string } };
    if (parsed.ok === false) {
      return {
        ok: false,
        error: parsed.error?.message ?? parsed.error?.code ?? `${command.args.join(' ')} returned ok=false`,
      };
    }
    if (parsed.result === undefined) {
      return { ok: false, error: `${command.args.join(' ')} omitted result` };
    }
    return { ok: true, value: parsed.result };
  } catch (error) {
    return {
      ok: false,
      error: `invalid runtime JSON for ${command.args.join(' ')}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function runtimeWorktrees(): RuntimeJsonResult<RuntimeWorktree[]> {
  const response = runtimeJson<{ worktrees?: RuntimeWorktree[] }>(RUNTIME.worktrees());
  if (!response.ok) return { ok: false, error: response.error };
  if (!Array.isArray(response.value?.worktrees)) {
    return { ok: false, error: 'runtime worktree inventory omitted result.worktrees[]' };
  }
  return { ok: true, value: response.value.worktrees };
}

function runtimeAgentRows(): RuntimeJsonResult<RuntimeWorktree[]> {
  const response = runtimeJson<{ worktrees?: RuntimeWorktree[] }>(RUNTIME.agents());
  if (!response.ok) return { ok: false, error: response.error };
  if (!Array.isArray(response.value?.worktrees)) {
    return { ok: false, error: 'runtime agent inventory omitted result.worktrees[]' };
  }
  return { ok: true, value: response.value.worktrees };
}

function runtimeTerminals(command: RuntimeCommand): RuntimeJsonResult<RuntimeTerminal[]> {
  const response = runtimeJson<{ terminals?: RuntimeTerminal[] }>(command);
  if (!response.ok) return { ok: false, error: response.error };
  if (!Array.isArray(response.value?.terminals)) {
    return { ok: false, error: 'runtime terminal inventory omitted result.terminals[]' };
  }
  return { ok: true, value: response.value.terminals };
}

function validateTarget(worktreePath: string): {
  pathExists: boolean;
  isPrimaryCheckout: boolean;
  gitFileStatus: 'directory' | 'file' | 'missing';
  gitFileError?: string;
} {
  if (!existsSync(worktreePath)) {
    return { pathExists: false, isPrimaryCheckout: false, gitFileStatus: 'missing' };
  }
  const gitPath = join(worktreePath, '.git');
  try {
    const stat = lstatSync(gitPath);
    if (stat.isDirectory()) {
      return { pathExists: true, isPrimaryCheckout: true, gitFileStatus: 'directory' };
    }
    if (!stat.isFile()) {
      return {
        pathExists: true,
        isPrimaryCheckout: false,
        gitFileStatus: 'missing',
        gitFileError: '.git is neither a directory nor a regular file',
      };
    }
    const content = readFileSync(gitPath, 'utf8').trim();
    if (!content.startsWith('gitdir: ')) {
      return {
        pathExists: true,
        isPrimaryCheckout: false,
        gitFileStatus: 'missing',
        gitFileError: '.git file does not start with "gitdir: "',
      };
    }
    const rawGitdir = content.slice('gitdir: '.length).trim();
    const gitdir = isAbsolute(rawGitdir) ? rawGitdir : resolve(worktreePath, rawGitdir);
    if (!existsSync(gitdir)) {
      return {
        pathExists: true,
        isPrimaryCheckout: false,
        gitFileStatus: 'missing',
        gitFileError: `gitdir path does not exist: ${gitdir}`,
      };
    }
    return { pathExists: true, isPrimaryCheckout: false, gitFileStatus: 'file' };
  } catch (error) {
    return {
      pathExists: true,
      isPrimaryCheckout: false,
      gitFileStatus: 'missing',
      gitFileError: error instanceof Error ? error.message : String(error),
    };
  }
}

function getPrimaryCheckout(worktreePath: string): string | null {
  const result = gitRunSync(['rev-parse', '--path-format=absolute', '--git-common-dir'], worktreePath);
  if (!result.ok) return null;
  const commonDir = normalizePath(result.stdout.trim());
  return dirname(commonDir);
}

function getPRInfo(prNumber: number): PRInfo | null {
  const result = runProcessSync({
    command: 'gh',
    args: [
      'pr',
      'view',
      String(prNumber),
      '--json',
      'headRefName,state,headRefOid,mergeCommit,headRepository,baseRefName',
    ],
    inheritParentEnv: true,
  });
  if (!result.ok) return null;
  try {
    const parsed = JSON.parse(result.stdout) as PRInfo;
    return typeof parsed.headRefName === 'string'
      && typeof parsed.headRefOid === 'string'
      && typeof parsed.state === 'string'
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function captureG1Identity(worktreePath: string, prInfo: PRInfo): { pass: boolean; snapshot?: IdentitySnapshot } {
  const headResult = gitRunSync(['rev-parse', 'HEAD'], worktreePath);
  if (!headResult.ok) return { pass: false };
  const headSha = headResult.stdout.trim();
  const branchResult = gitRunSync(['symbolic-ref', '--short', 'HEAD'], worktreePath);
  if (branchResult.ok) {
    const branchName = branchResult.stdout.trim();
    return {
      pass: branchName === prInfo.headRefName,
      snapshot: { mode: 'branch-bound', headSha, branchName },
    };
  }
  return {
    pass: headSha === prInfo.headRefOid,
    snapshot: { mode: 'detached-confirmed', headSha },
  };
}

function recheckG1Identity(worktreePath: string, snapshot: IdentitySnapshot): boolean {
  const headResult = gitRunSync(['rev-parse', 'HEAD'], worktreePath);
  if (!headResult.ok || headResult.stdout.trim() !== snapshot.headSha) return false;
  const branchResult = gitRunSync(['symbolic-ref', '--short', 'HEAD'], worktreePath);
  if (snapshot.mode === 'detached-confirmed') return !branchResult.ok;
  return branchResult.ok && branchResult.stdout.trim() === snapshot.branchName;
}

function checkG2aClean(worktreePath: string): boolean {
  const result = gitRunSync(['status', '--porcelain', '--untracked-files=all'], worktreePath);
  return result.ok && result.stdout.trim() === '';
}

function checkG2bIgnored(worktreePath: string): boolean {
  const result = gitRunSync(['status', '--porcelain', '--ignored=matching'], worktreePath);
  if (!result.ok) return false;
  const ignored = result.stdout.split('\n').filter((line) => line.startsWith('!! '));
  return ignored.every((line) => {
    const relativePath = line.slice(3).trim();
    return IGNORED_DIRECTORY_ALLOWLIST.some((allowed) => relativePath.startsWith(allowed));
  });
}

function checkG3Merged(worktreePath: string, prInfo: PRInfo): boolean {
  const proofA = gitRunSync(['merge-base', '--is-ancestor', 'HEAD', 'origin/main'], worktreePath);
  if (proofA.ok && proofA.exitCode === 0) return true;
  if (prInfo.state !== 'MERGED') return false;
  const headResult = gitRunSync(['rev-parse', 'HEAD'], worktreePath);
  if (!headResult.ok || headResult.stdout.trim() !== prInfo.headRefOid) return false;
  if (!prInfo.mergeCommit?.oid) return false;
  gitRunSync(['fetch', 'origin', 'main'], worktreePath);
  const proofB = gitRunSync(
    ['merge-base', '--is-ancestor', prInfo.mergeCommit.oid, 'origin/main'],
    worktreePath,
  );
  return proofB.ok && proofB.exitCode === 0;
}

function checkG4Ownership(prNumber: number, prInfo: PRInfo): boolean {
  if (!prInfo.headRepository?.nameWithOwner) return false;
  const result = runProcessSync({
    command: 'gh',
    args: [
      'pr',
      'list',
      '--state',
      'open',
      '--json',
      'number,headRefName,headRepository',
      '--repo',
      prInfo.headRepository.nameWithOwner,
    ],
    inheritParentEnv: true,
  });
  if (!result.ok) return false;
  try {
    const rows = JSON.parse(result.stdout) as Array<{
      number: number;
      headRefName: string;
      headRepository?: { nameWithOwner: string };
    }>;
    return rows.filter((row) => row.headRefName === prInfo.headRefName && row.number !== prNumber).length === 0;
  } catch {
    return false;
  }
}

function checkG5Agents(worktreePath: string): { pass: boolean; desync: boolean; detail?: string } {
  const inventory = runtimeAgentRows();
  if (!inventory.ok) return { pass: false, desync: true, detail: inventory.error };
  const target = normalizePath(worktreePath);
  const rows = inventory.value!.filter(
    (row) => typeof row.path === 'string' && normalizePath(row.path) === target,
  );
  if (rows.length !== 1) {
    return {
      pass: false,
      desync: true,
      detail: `runtime agent inventory matched ${rows.length} rows for ${target}`,
    };
  }
  const row = rows[0];
  if (!row || !Array.isArray(row.agents)) {
    return { pass: false, desync: true, detail: 'target runtime row omitted agents[]' };
  }
  const pass = row.agents.every(
    (agent) => agent.state === 'done' && agent.interrupted === false,
  );
  return {
    pass,
    desync: false,
    ...(pass ? {} : { detail: 'one or more target agents are not done or were interrupted' }),
  };
}

function runInitialGates(worktreePath: string, prNumber: number): GateResults {
  const prInfo = getPRInfo(prNumber);
  if (!prInfo) {
    return {
      g1: false,
      g2a: false,
      g2b: false,
      g3: false,
      g4: false,
      g5: false,
      failedOutcome: 'blocked_state_desync',
      detail: 'unable to read PR identity',
    };
  }
  const g1Result = captureG1Identity(worktreePath, prInfo);
  const g2a = checkG2aClean(worktreePath);
  const g2b = checkG2bIgnored(worktreePath);
  const g3 = checkG3Merged(worktreePath, prInfo);
  const g4 = checkG4Ownership(prNumber, prInfo);
  const g5Result = checkG5Agents(worktreePath);
  let failedOutcome: TeardownOutcome | undefined;
  if (!g1Result.pass) failedOutcome = 'blocked_identity_drift';
  else if (!g2a) failedOutcome = 'blocked_dirty_worktree';
  else if (!g2b) failedOutcome = 'blocked_ignored_operator_data';
  else if (!g3) failedOutcome = 'blocked_unmerged_work';
  else if (!g4) failedOutcome = 'blocked_shared_head_ref';
  else if (!g5Result.pass) failedOutcome = 'blocked_state_desync';
  return {
    g1: g1Result.pass,
    g2a,
    g2b,
    g3,
    g4,
    g5: g5Result.pass,
    failedOutcome,
    prBranchName: prInfo.headRefName,
    identity: g1Result.snapshot,
    detail: g5Result.detail,
  };
}

function snapshotProcs(): Map<number, ProcessSnapshot> {
  const result = new Map<number, ProcessSnapshot>();
  try {
    for (const pidText of readdirSync('/proc').filter((name) => /^\d+$/.test(name))) {
      const pid = Number.parseInt(pidText, 10);
      let stat: string;
      try {
        stat = readFileSync(join('/proc', pidText, 'stat'), 'utf8');
      } catch {
        continue;
      }
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      let cwd: string | null = null;
      let cmd = '';
      let exe: string | null = null;
      try {
        cwd = readlinkSync(join('/proc', pidText, 'cwd'));
      } catch {
        // Process may exit or deny access between reads.
      }
      try {
        cmd = readFileSync(join('/proc', pidText, 'cmdline'), 'utf8').replace(/\0/g, ' ').trim();
      } catch {
        // Diagnostic only.
      }
      try {
        exe = readlinkSync(join('/proc', pidText, 'exe'));
      } catch {
        // Diagnostic only.
      }
      result.set(pid, {
        pid,
        ppid: Number.parseInt(fields[1] ?? '0', 10),
        starttime: fields[19] ?? '',
        cwd,
        cmd,
        exe,
      });
    }
  } catch {
    // An unreadable /proc produces an empty, therefore non-destructive, selection.
  }
  return result;
}

function normalizedCwd(cwd: string | null): string | null {
  return cwd ? cwd.replace(/ \(deleted\)$/, '') : null;
}

function cwdUnder(cwd: string | null, root: string): boolean {
  const normalized = normalizedCwd(cwd);
  return normalized !== null && (normalized === root || normalized.startsWith(`${root}/`));
}

function selfChain(processes: Map<number, ProcessSnapshot>): Set<number> {
  const result = new Set<number>();
  let current = process.pid;
  while (current !== 0 && processes.has(current) && !result.has(current)) {
    result.add(current);
    current = processes.get(current)!.ppid;
  }
  result.add(1);
  return result;
}

function computeKillSet(
  processes: Map<number, ProcessSnapshot>,
  worktreePath: string,
  protectedPaths: Set<string>,
  knownWorktrees: Set<string>,
): ProcessSnapshot[] {
  const children = new Map<number, number[]>();
  for (const row of processes.values()) {
    const current = children.get(row.ppid) ?? [];
    current.push(row.pid);
    children.set(row.ppid, current);
  }
  const seeds = [...processes.values()]
    .filter((row) => cwdUnder(row.cwd, worktreePath))
    .map((row) => row.pid);
  const killSet = new Set(seeds);
  const stack = [...seeds];
  while (stack.length > 0) {
    const parent = stack.pop()!;
    for (const child of children.get(parent) ?? []) {
      if (!killSet.has(child)) {
        killSet.add(child);
        stack.push(child);
      }
    }
  }
  const immune = selfChain(processes);
  const selected: ProcessSnapshot[] = [];
  for (const pid of killSet) {
    const row = processes.get(pid);
    if (!row || pid <= 1 || immune.has(pid)) continue;
    const cwd = normalizedCwd(row.cwd);
    if (cwd && [...protectedPaths].some((pathValue) => cwd === pathValue || cwd.startsWith(`${pathValue}/`))) {
      continue;
    }
    if (
      cwd
      && !cwdUnder(row.cwd, worktreePath)
      && [...knownWorktrees].some(
        (pathValue) => pathValue !== worktreePath && (cwd === pathValue || cwd.startsWith(`${pathValue}/`)),
      )
    ) {
      continue;
    }
    selected.push(row);
  }
  return selected.sort((left, right) => right.pid - left.pid);
}

function stillSame(pid: number, starttime: string): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] === starttime;
  } catch {
    return false;
  }
}

function signalProc(pid: number, starttime: string, signal: NodeJS.Signals): boolean {
  if (pid <= 1 || !stillSame(pid, starttime)) return false;
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

function processExists(row: ProcessSnapshot): boolean {
  try {
    process.kill(row.pid, 0);
    return stillSame(row.pid, row.starttime);
  } catch {
    return false;
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

async function reapProcesses(
  worktreePath: string,
  protectedPaths: Set<string>,
  knownWorktrees: Set<string>,
  apply: boolean,
): Promise<ReapResult> {
  const victims = computeKillSet(snapshotProcs(), worktreePath, protectedPaths, knownWorktrees);
  if (!apply) return { selected: victims.length, termed: 0, sigkilled: 0, residual: 0 };
  for (const victim of victims) signalProc(victim.pid, victim.starttime, 'SIGTERM');
  let waited = 0;
  while (waited < 10_000 && victims.some(processExists)) {
    await sleep(500);
    waited += 500;
  }
  const stubborn = victims.filter(processExists);
  for (const victim of stubborn) signalProc(victim.pid, victim.starttime, 'SIGKILL');
  await sleep(1_000);
  const residual = computeKillSet(snapshotProcs(), worktreePath, protectedPaths, knownWorktrees);
  return {
    selected: victims.length,
    termed: victims.length - stubborn.length,
    sigkilled: stubborn.length,
    residual: residual.length,
  };
}

function terminalBelongsTo(terminal: RuntimeTerminal, worktreePath: string): boolean {
  return typeof terminal.worktreePath === 'string'
    && normalizePath(terminal.worktreePath) === worktreePath;
}

function applyRuntimeCommand(command: RuntimeCommand): { ok: boolean; error?: string } {
  const result = runtimeJson<unknown>(command);
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

function planTerminalActions(worktreePath: string): RuntimeJsonResult<NonNullable<TeardownReport['terminals']>> {
  const census = runtimeTerminals(RUNTIME.terminals_all());
  if (!census.ok) return { ok: false, error: census.error };
  const targetRows = census.value!.filter((terminal) => terminalBelongsTo(terminal, worktreePath));
  const targetByTab = new Map<string, RuntimeTerminal[]>();
  for (const terminal of targetRows) {
    const key = terminal.tabId?.trim() || `pane:${terminal.handle ?? ''}`;
    const rows = targetByTab.get(key) ?? [];
    rows.push(terminal);
    targetByTab.set(key, rows);
  }
  let closedTabs = 0;
  let closedPanes = 0;
  let mixedTabFound = false;
  for (const rowsForTarget of targetByTab.values()) {
    const tabId = rowsForTarget[0]?.tabId?.trim();
    const allRowsForTab = tabId
      ? census.value!.filter((terminal) => terminal.tabId?.trim() === tabId)
      : rowsForTarget;
    const targetOnly = tabId !== undefined
      && allRowsForTab.length > 0
      && allRowsForTab.every((terminal) => terminalBelongsTo(terminal, worktreePath));
    if (targetOnly) {
      closedTabs += 1;
    } else {
      closedPanes += rowsForTarget.length;
      mixedTabFound = mixedTabFound
        || Boolean(tabId && allRowsForTab.some((terminal) => !terminalBelongsTo(terminal, worktreePath)));
    }
  }
  return {
    ok: true,
    value: {
      stopped: targetRows.length,
      closed_panes: closedPanes,
      closed_tabs: closedTabs,
      mixed_tab_found: mixedTabFound,
    },
  };
}

function stopAndCloseTerminals(worktreePath: string): {
  ok: boolean;
  outcome?: TeardownOutcome;
  report: NonNullable<TeardownReport['terminals']>;
  error?: string;
} {
  // Tab membership must be captured globally before stop mutates terminal state.
  const globalCensus = runtimeTerminals(RUNTIME.terminals_all());
  if (!globalCensus.ok) {
    return {
      ok: false,
      outcome: 'terminal_stop_failed',
      report: { stopped: 0, closed_panes: 0, closed_tabs: 0, mixed_tab_found: false },
      error: globalCensus.error,
    };
  }
  const targetRows = globalCensus.value!.filter((terminal) => terminalBelongsTo(terminal, worktreePath));
  const targetByTab = new Map<string, RuntimeTerminal[]>();
  for (const terminal of targetRows) {
    const key = terminal.tabId?.trim() || `pane:${terminal.handle ?? ''}`;
    const rows = targetByTab.get(key) ?? [];
    rows.push(terminal);
    targetByTab.set(key, rows);
  }

  const stop = applyRuntimeCommand(RUNTIME.stop_terminals(worktreePath));
  if (!stop.ok) {
    return {
      ok: false,
      outcome: 'terminal_stop_failed',
      report: {
        stopped: targetRows.length,
        closed_panes: 0,
        closed_tabs: 0,
        mixed_tab_found: false,
      },
      error: stop.error,
    };
  }

  // Re-census AFTER the stop. On this runtime `stop_terminals` already removes the rows, so the
  // pre-stop handles are stale and closing by them fails for every tab. Close only what actually
  // survived; nothing left is success, not an error.
  const postStopCensus = runtimeTerminals(RUNTIME.terminals_all());
  if (!postStopCensus.ok) {
    return {
      ok: false,
      outcome: 'terminal_stop_failed',
      report: { stopped: targetRows.length, closed_panes: 0, closed_tabs: 0, mixed_tab_found: false },
      error: postStopCensus.error ?? 'terminal census unavailable after stop',
    };
  }
  const survivingRows = postStopCensus.value!.filter((terminal) => terminalBelongsTo(terminal, worktreePath));
  const survivingByTab = new Map<string, RuntimeTerminal[]>();
  for (const terminal of survivingRows) {
    const key = terminal.tabId?.trim() || `pane:${terminal.handle ?? ''}`;
    const rows = survivingByTab.get(key) ?? [];
    rows.push(terminal);
    survivingByTab.set(key, rows);
  }

  let closedPanes = 0;
  let closedTabs = 0;
  let mixedTabFound = false;
  const errors: string[] = [];
  for (const [tabKey, rowsForTarget] of survivingByTab) {
    const tabId = rowsForTarget[0]?.tabId?.trim();
    const allRowsForTab = tabId
      ? postStopCensus.value!.filter((terminal) => terminal.tabId?.trim() === tabId)
      : rowsForTarget;
    const tabIsTargetOnly = tabId !== undefined
      && allRowsForTab.length > 0
      && allRowsForTab.every((terminal) => terminalBelongsTo(terminal, worktreePath));
    if (tabIsTargetOnly) {
      const handle = rowsForTarget.find((terminal) => terminal.handle?.trim())?.handle?.trim();
      if (!handle) {
        errors.push(`tab ${tabKey} has no closable terminal handle`);
        continue;
      }
      const close = applyRuntimeCommand(RUNTIME.close_tab(handle));
      if (close.ok) closedTabs += 1;
      else errors.push(close.error ?? `failed to close tab ${tabKey}`);
      continue;
    }

    mixedTabFound = mixedTabFound
      || Boolean(tabId && allRowsForTab.some((terminal) => !terminalBelongsTo(terminal, worktreePath)));
    for (const terminal of rowsForTarget) {
      const handle = terminal.handle?.trim();
      if (!handle) {
        errors.push(`target pane in ${tabKey} has no handle`);
        continue;
      }
      const close = applyRuntimeCommand(RUNTIME.close_pane(handle));
      if (close.ok) closedPanes += 1;
      else errors.push(close.error ?? `failed to close pane ${handle}`);
    }
  }

  const finalGlobal = runtimeTerminals(RUNTIME.terminals_all());
  const residual = finalGlobal.ok
    ? finalGlobal.value!.filter((terminal) => terminalBelongsTo(terminal, worktreePath))
    : targetRows;
  const report = {
    stopped: targetRows.length,
    closed_panes: closedPanes,
    closed_tabs: closedTabs,
    mixed_tab_found: mixedTabFound,
  };
  if (!finalGlobal.ok || residual.length > 0 || errors.length > 0) {
    // A genuine mixed tab that could not be reduced is `blocked_mixed_tab`; anything else
    // (census unavailable, close command failed, unexplained residual) is a stop/close failure.
    // Collapsing both into `blocked_mixed_tab` mislabels the incident and sent operators looking
    // for a tab conflict that does not exist.
    return {
      ok: false,
      outcome: mixedTabFound ? 'blocked_mixed_tab' : 'terminal_stop_failed',
      report,
      error: [finalGlobal.error, ...errors, residual.length > 0 ? `${residual.length} target terminals remain` : undefined]
        .filter((value): value is string => Boolean(value))
        .join('; '),
    };
  }
  return { ok: true, report };
}

function recheckState(worktreePath: string, identity: IdentitySnapshot): {
  g1: boolean;
  g2a: boolean;
  g2b: boolean;
  g5: boolean;
  detail?: string;
} {
  const g5 = checkG5Agents(worktreePath);
  return {
    g1: recheckG1Identity(worktreePath, identity),
    g2a: checkG2aClean(worktreePath),
    g2b: checkG2bIgnored(worktreePath),
    g5: g5.pass,
    detail: g5.detail,
  };
}

function deleteBranch(primaryCheckout: string | null, branchName: string, apply: boolean): NonNullable<TeardownReport['branch_deletion']> {
  if (!apply) return { method: 'skipped', reason: 'dry-run' };
  if (!primaryCheckout) return { method: 'skipped', reason: 'primary checkout could not be resolved' };
  const present = gitRunSync(['branch', '--list', branchName], primaryCheckout);
  if (!present.ok || present.stdout.trim() === '') {
    return { method: 'skipped', reason: 'branch not found' };
  }
  const deleted = gitRunSync(['branch', '-d', branchName], primaryCheckout);
  return deleted.ok
    ? { method: 'd', reason: 'deleted after runtime worktree removal' }
    : { method: 'skipped', reason: 'branch -d refused; no force deletion attempted' };
}

function markGates(report: TeardownReport, gates: GateResults): void {
  report.gates = {
    g1: gates.g1 ? 'pass' : 'fail',
    g2a: gates.g2a ? 'pass' : 'fail',
    g2b: gates.g2b ? 'pass' : 'fail',
    g3: gates.g3 ? 'pass' : 'fail',
    g4: gates.g4 ? 'pass' : 'fail',
    g5: gates.g5 ? 'pass' : 'fail',
  };
}

function emit(report: TeardownReport, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`Outcome: ${report.outcome}`);
  console.log(`Gates: G1=${report.gates.g1} G2a=${report.gates.g2a} G2b=${report.gates.g2b} G3=${report.gates.g3} G4=${report.gates.g4} G5=${report.gates.g5}`);
  if (report.terminals) {
    console.log(`Terminals: stop=${report.terminals.stopped} tabs=${report.terminals.closed_tabs} panes=${report.terminals.closed_panes}`);
  }
  if (report.processes) {
    console.log(`Processes: selected=${report.processes.selected} SIGTERM=${report.processes.termed} SIGKILL=${report.processes.sigkilled} residual=${report.processes.residual}`);
  }
  if (report.error) console.log(`Detail: ${report.error}`);
}

async function execute(args: ParsedArgs, report: TeardownReport): Promise<number> {
  if (!args.worktree || !args.pr) {
    report.outcome = 'blocked_invalid_target';
    report.error = 'both --worktree and --pr are required';
    return 1;
  }
  const target = existingRealpath(args.worktree) ?? normalizePath(resolve(args.worktree));
  report.worktree = target;
  const validation = validateTarget(target);
  report.validation.path_exists = validation.pathExists;
  report.validation.is_primary_checkout = validation.isPrimaryCheckout;
  if (validation.isPrimaryCheckout) {
    report.outcome = 'blocked_invalid_target';
    report.error = 'target is the primary checkout';
    return 1;
  }
  if (!validation.pathExists) {
    report.outcome = args.orphan && args.iKnowThisPath
      ? 'blocked_unprovable_orphan'
      : 'blocked_invalid_target';
    report.error = 'target path does not exist; identity and git-state gates cannot be proven';
    return 1;
  }
  if (validation.gitFileStatus !== 'file') {
    report.outcome = 'blocked_invalid_target';
    report.error = validation.gitFileError ?? 'target .git file is invalid';
    return 1;
  }
  const worktreeInventory = runtimeWorktrees();
  if (!worktreeInventory.ok) {
    report.outcome = 'blocked_state_desync';
    report.error = worktreeInventory.error;
    return 1;
  }
  const inventoryMatches = worktreeInventory.value!.filter(
    (row) => typeof row.path === 'string' && normalizePath(row.path) === target,
  );
  report.validation.is_in_inventory = inventoryMatches.length === 1;
  if (inventoryMatches.length !== 1) {
    report.outcome = 'blocked_state_desync';
    report.error = `runtime worktree inventory matched ${inventoryMatches.length} rows for target`;
    return 1;
  }
  const gates = runInitialGates(target, args.pr);
  markGates(report, gates);
  if (gates.failedOutcome) {
    report.outcome = gates.failedOutcome;
    report.error = gates.detail;
    return 1;
  }
  if (!gates.identity || !gates.prBranchName) {
    report.outcome = 'blocked_state_desync';
    report.error = 'initial identity snapshot is incomplete';
    return 1;
  }
  const knownWorktrees = new Set(
    worktreeInventory.value!
      .map((row) => typeof row.path === 'string' ? existingRealpath(row.path) ?? normalizePath(row.path) : null)
      .filter((value): value is string => value !== null),
  );
  const protectedPaths = new Set(
    worktreeInventory.value!
      .filter((row) => row.isMainWorktree === true && typeof row.path === 'string')
      .map((row) => existingRealpath(row.path!) ?? normalizePath(row.path!)),
  );
  const primaryCheckout = getPrimaryCheckout(target);
  if (!args.apply) {
    const terminalPlan = planTerminalActions(target);
    if (!terminalPlan.ok) {
      report.outcome = 'blocked_state_desync';
      report.error = terminalPlan.error;
      return 1;
    }
    report.terminals = terminalPlan.value;
    report.processes = await reapProcesses(target, protectedPaths, knownWorktrees, false);
    const dryRunRecheck = recheckState(target, gates.identity);
    report.recheck = {
      g1: dryRunRecheck.g1 ? 'pass' : 'fail',
      g2a: dryRunRecheck.g2a ? 'pass' : 'fail',
      g2b: dryRunRecheck.g2b ? 'pass' : 'fail',
      g5: dryRunRecheck.g5 ? 'pass' : 'fail',
    };
    if (!dryRunRecheck.g1 || !dryRunRecheck.g2a || !dryRunRecheck.g2b || !dryRunRecheck.g5) {
      report.outcome = 'blocked_state_drift';
      report.error = dryRunRecheck.detail ?? 'state changed during dry-run evaluation';
      return 1;
    }
    report.worktree_removal = { attempted: false, removed: false };
    report.branch_deletion = deleteBranch(primaryCheckout, gates.prBranchName, false);
    report.outcome = 'reaped_clean';
    return 0;
  }
  const terminalResult = stopAndCloseTerminals(target);
  report.terminals = terminalResult.report;
  if (!terminalResult.ok) {
    report.outcome = terminalResult.outcome ?? 'terminal_stop_failed';
    report.error = terminalResult.error;
    return 1;
  }
  const reapResult = await reapProcesses(target, protectedPaths, knownWorktrees, true);
  report.processes = reapResult;
  if (reapResult.residual > 0) {
    report.outcome = 'partial_residual_processes';
    report.error = `${reapResult.residual} selected processes remain`;
    return 1;
  }
  const recheck = recheckState(target, gates.identity);
  report.recheck = {
    g1: recheck.g1 ? 'pass' : 'fail',
    g2a: recheck.g2a ? 'pass' : 'fail',
    g2b: recheck.g2b ? 'pass' : 'fail',
    g5: recheck.g5 ? 'pass' : 'fail',
  };
  if (!recheck.g1 || !recheck.g2a || !recheck.g2b || !recheck.g5) {
    report.outcome = 'blocked_state_drift';
    report.error = recheck.detail ?? 'pre-removal state differs from the saved identity/git/runtime snapshot';
    return 1;
  }
  report.worktree_removal = { attempted: true, removed: false };
  const removal = applyRuntimeCommand(RUNTIME.remove_worktree(target));
  if (!removal.ok) {
    report.outcome = 'worktree_remove_failed';
    report.error = removal.error;
    return 1;
  }
  report.worktree_removal.removed = true;
  report.branch_deletion = deleteBranch(primaryCheckout, gates.prBranchName, true);
  report.outcome = 'reaped_clean';
  return 0;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const report: TeardownReport = {
    worktree: args.worktree ?? '',
    pr: args.pr ?? 0,
    outcome: 'blocked_invalid_target',
    apply_mode: args.apply,
    gates: { g1: 'fail', g2a: 'fail', g2b: 'fail', g3: 'fail', g4: 'fail', g5: 'fail' },
    validation: { is_primary_checkout: false, is_in_inventory: false, path_exists: false },
  };
  if (!acquireLock()) {
    report.outcome = 'blocked_lock_held';
    report.error = `teardown lock already exists at ${LOCK_PATH}; stale locks are not removed automatically`;
    emit(report, args.json);
    process.exitCode = 1;
    return;
  }
  let exitCode = 1;
  try {
    exitCode = await execute(args, report);
  } catch (error) {
    report.outcome = 'blocked_state_desync';
    report.error = error instanceof Error ? error.message : String(error);
    exitCode = 1;
  } finally {
    releaseLock();
  }
  emit(report, args.json);
  process.exitCode = exitCode;
}

void main();
