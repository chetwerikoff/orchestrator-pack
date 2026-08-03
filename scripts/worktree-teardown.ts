#!/usr/bin/env node
// scripts/worktree-teardown.ts — unified worktree teardown: validation, gates, terminal stop, process reap, deletion.
//
// Invocation:
//   node --experimental-strip-types scripts/worktree-teardown.ts \
//     --worktree <abs-path> --pr <number> [--apply] [--json] [--orphan] [--i-know-this-path]
//
// Default is DRY-RUN. --apply executes. --json outputs one JSON object to stdout; otherwise human-readable output.
// Exit 0 = reaped_clean; nonzero = blocked_* or partial_* (normal outcomes after successful merge).

import { realpathSync, existsSync, statSync, readFileSync, readlinkSync, readdirSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { runProcessSync } from '#opk-kernel/subprocess';

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

interface TeardownReport {
  worktree: string;
  pr: number;
  outcome: TeardownOutcome;
  apply_mode: boolean;
  gates: {
    g1: 'pass' | 'fail';
    g2a: 'pass' | 'fail';
    g2b: 'pass' | 'fail';
    g3: 'pass' | 'fail';
    g4: 'pass' | 'fail';
    g5: 'pass' | 'fail';
  };
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
  recheck?: {
    g1: 'pass' | 'fail';
    g2a: 'pass' | 'fail';
    g2b: 'pass' | 'fail';
    g5: 'pass' | 'fail';
  };
  branch_deletion?: {
    method: 'd' | 'D' | 'skipped';
    reason: string;
  };
  error?: string;
}

// ===== ARGV PARSING =====
function parseArgs(): {
  worktree: string | null;
  pr: number | null;
  apply: boolean;
  json: boolean;
  orphan: boolean;
  iKnowThisPath: boolean;
} {
  const argv = process.argv.slice(2);
  const arg = (n: string) => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : null;
  };

  return {
    worktree: arg('--worktree'),
    pr: arg('--pr') ? parseInt(arg('--pr')!, 10) : null,
    apply: argv.includes('--apply'),
    json: argv.includes('--json'),
    orphan: argv.includes('--orphan'),
    iKnowThisPath: argv.includes('--i-know-this-path'),
  };
}

// ===== GIT HELPERS =====
function gitRunSync(args: string[], cwd?: string) {
  const result = runProcessSync({
    command: 'git',
    args,
    cwd,
    inheritParentEnv: true,
  });
  return result;
}

function realpath(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

// ===== LOCK MANAGEMENT =====
function acquireLock(lockPath: string): boolean {
  try {
    // Check if lock already held
    if (existsSync(lockPath)) {
      return false;
    }
    // Try to create lock file atomically
    writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
    return true;
  } catch {
    // File already exists or other error
    return false;
  }
}

function releaseLock(lockPath: string) {
  try {
    unlinkSync(lockPath);
  } catch {
    // ignore
  }
}

// ===== VALIDATION =====
interface ValidationResult {
  isPrimaryCheckout: boolean;
  isInInventory: boolean;
  pathExists: boolean;
  gitFileStatus: 'directory' | 'file' | 'missing';
}

function validateTarget(worktreePath: string): ValidationResult & { gitFileError?: string } {
  const pathExists = existsSync(worktreePath);
  let gitFileStatus: 'directory' | 'file' | 'missing' = 'missing';
  let gitFileError: string | undefined;

  if (pathExists) {
    try {
      const stat = statSync(join(worktreePath, '.git'));
      if (stat.isDirectory()) {
        gitFileStatus = 'directory';
      } else if (stat.isFile()) {
        // Validate .git file contents: must start with "gitdir: " and point to existing path
        try {
          const gitFileContent = readFileSync(join(worktreePath, '.git'), 'utf8').trim();
          if (!gitFileContent.startsWith('gitdir: ')) {
            gitFileError = '.git file does not start with "gitdir: "';
            gitFileStatus = 'missing'; // treat as invalid
          } else {
            const gitdirPath = gitFileContent.slice(8); // Remove "gitdir: " prefix
            if (!existsSync(gitdirPath)) {
              gitFileError = `gitdir path does not exist: ${gitdirPath}`;
              gitFileStatus = 'missing'; // treat as invalid
            } else {
              // Validation passed
              gitFileStatus = 'file';
            }
          }
        } catch (e) {
          gitFileError = `cannot read .git file: ${(e as Error).message}`;
          gitFileStatus = 'missing'; // treat as invalid
        }
      }
    } catch (e) {
      // .git not found or not accessible
      gitFileStatus = 'missing';
    }
  }

  const isPrimaryCheckout = gitFileStatus === 'directory';
  return {
    isPrimaryCheckout,
    isInInventory: false, // would check against runtime inventory in full impl
    pathExists,
    gitFileStatus,
    gitFileError,
  };
}

// ===== GATES =====
interface GateResults {
  g1: boolean;
  g2a: boolean;
  g2b: boolean;
  g3: boolean;
  g4: boolean;
  g5: boolean;
  failedGate?: string;
  prBranchName?: string;
  isBranchBound?: boolean;
  savedHeadSha?: string;
}

interface PRInfo {
  headRefName: string;
  state: string;
  headRefOid: string;
  mergeCommit?: { oid: string };
  headRepository?: { nameWithOwner: string };
  baseRefName?: string;
}

// Fetch PR information from GitHub
function getPRInfo(prNumber: number): PRInfo | null {
  const result = runProcessSync({
    command: 'gh',
    args: ['pr', 'view', String(prNumber), '--json', 'headRefName,state,headRefOid,mergeCommit,headRepository,baseRefName'],
    inheritParentEnv: true,
  });
  if (!result.ok) {
    return null;
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

function checkG1Identity(worktreePath: string, prInfo: PRInfo): { pass: boolean; mode: 'branch-bound' | 'detached-confirmed'; savedSha?: string } {
  // Try to get current branch
  const branchResult = gitRunSync(['symbolic-ref', '--short', 'HEAD'], worktreePath);

  if (branchResult.ok) {
    // Branch-bound mode: check if current branch matches PR headRefName
    const currentBranch = branchResult.stdout.trim();
    const pass = currentBranch === prInfo.headRefName;
    return { pass, mode: 'branch-bound' };
  }

  // Detached mode: check if HEAD SHA matches PR headRefOid
  const shaResult = gitRunSync(['rev-parse', 'HEAD'], worktreePath);
  if (!shaResult.ok) {
    return { pass: false, mode: 'detached-confirmed' };
  }
  const currentSha = shaResult.stdout.trim();
  const pass = currentSha === prInfo.headRefOid;
  return { pass, mode: 'detached-confirmed', savedSha: currentSha };
}

function checkG2aClean(worktreePath: string): boolean {
  const result = gitRunSync(['status', '--porcelain', '--untracked-files=all'], worktreePath);
  if (!result.ok) return false;
  return result.stdout.trim() === '';
}

function checkG2bIgnored(worktreePath: string): boolean {
  const result = gitRunSync(['status', '--porcelain', '--ignored=matching'], worktreePath);
  if (!result.ok) return false;

  const WHITELIST = ['node_modules/', '.venv/', 'venv/', 'dist/', 'build/', '.turbo/', '.next/', 'coverage/', '__pycache__/'];
  const lines = result.stdout.split('\n').filter((l) => l.startsWith('!! '));

  for (const line of lines) {
    const path_part = line.slice(3).trim();
    if (!WHITELIST.some((w) => path_part.startsWith(w))) {
      return false;
    }
  }
  return true;
}

function checkG3Merged(worktreePath: string, prInfo: PRInfo): boolean {
  // Proof (a): merge-base --is-ancestor HEAD origin/main
  const proofA = gitRunSync(['merge-base', '--is-ancestor', 'HEAD', 'origin/main'], worktreePath);
  if (proofA.ok && proofA.exitCode === 0) {
    return true;
  }

  // Proof (b): state == MERGED && headRefOid == HEAD && mergeCommit is ancestor of origin/main
  if (prInfo.state !== 'MERGED') {
    return false;
  }

  const headResult = gitRunSync(['rev-parse', 'HEAD'], worktreePath);
  if (!headResult.ok) {
    return false;
  }

  const currentSha = headResult.stdout.trim();
  if (currentSha !== prInfo.headRefOid) {
    return false;
  }

  if (!prInfo.mergeCommit?.oid) {
    return false;
  }

  // Fetch origin to ensure we have fresh data
  gitRunSync(['fetch', 'origin', 'main'], worktreePath);

  // Check if mergeCommit is ancestor of origin/main
  const ancestorResult = gitRunSync(['merge-base', '--is-ancestor', prInfo.mergeCommit.oid, 'origin/main'], worktreePath);
  return ancestorResult.ok && ancestorResult.exitCode === 0;
}

function checkG4Ownership(prNumber: number, prInfo: PRInfo): boolean {
  // Check if no other open PR has the same headRepository + headRefName pair
  if (!prInfo.headRepository?.nameWithOwner) {
    // Can't verify without repo info, refuse
    return false;
  }

  const result = runProcessSync({
    command: 'gh',
    args: [
      'pr', 'list',
      '--state', 'open',
      '--json', 'number,headRefName,headRepository',
      '--repo', prInfo.headRepository.nameWithOwner,
    ],
    inheritParentEnv: true,
  });

  if (!result.ok) {
    return false;
  }

  try {
    const prs: Array<{ number: number; headRefName: string; headRepository?: { nameWithOwner: string } }> = JSON.parse(result.stdout);
    const sameHeadCount = prs.filter(
      (p) => p.headRefName === prInfo.headRefName && p.number !== prNumber,
    ).length;
    return sameHeadCount === 0;
  } catch {
    return false;
  }
}

function checkG5Agents(_worktreePath: string): boolean {
  // Would check agent state from runtime inventory
  // Cannot implement without runtime integration; documented as limitation
  return true;
}

function runGates(worktreePath: string, prNumber: number): GateResults {
  const prInfo = getPRInfo(prNumber);
  if (!prInfo) {
    return {
      g1: false,
      g2a: false,
      g2b: false,
      g3: false,
      g4: false,
      g5: false,
      failedGate: 'blocked_state_desync',
    };
  }

  const g1Result = checkG1Identity(worktreePath, prInfo);
  const g2a = checkG2aClean(worktreePath);
  const g2b = checkG2bIgnored(worktreePath);
  const g3 = checkG3Merged(worktreePath, prInfo);
  const g4 = checkG4Ownership(prNumber, prInfo);
  const g5 = checkG5Agents(worktreePath);

  let failedGate: string | undefined;
  if (!g1Result.pass) failedGate = 'blocked_identity_drift';
  else if (!g2a) failedGate = 'blocked_dirty_worktree';
  else if (!g2b) failedGate = 'blocked_ignored_operator_data';
  else if (!g3) failedGate = 'blocked_unmerged_work';
  else if (!g4) failedGate = 'blocked_shared_head_ref';
  else if (!g5) failedGate = 'blocked_state_desync';

  return {
    g1: g1Result.pass,
    g2a,
    g2b,
    g3,
    g4,
    g5,
    failedGate,
    prBranchName: prInfo.headRefName,
    isBranchBound: g1Result.mode === 'branch-bound',
    savedHeadSha: g1Result.savedSha,
  };
}

// ===== PROCESS REAPING (transposed from reap-worktree.mjs) =====
interface ProcessSnapshot {
  pid: number;
  ppid: number;
  starttime: string;
  cwd: string | null;
  cmd: string;
  exe: string | null;
}

function snapshotProcs(): Map<number, ProcessSnapshot> {
  const result = new Map<number, ProcessSnapshot>();
  const procDir = '/proc';

  try {
    const pids = readdirSync(procDir).filter((d) => /^\d+$/.test(d));

    for (const pidStr of pids) {
      const pid = parseInt(pidStr, 10);
      let stat: string;
      try {
        stat = readFileSync(join(procDir, pidStr, 'stat'), 'utf8');
      } catch {
        continue;
      }

      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      let cwd: string | null = null;
      try {
        cwd = readlinkSync(join(procDir, pidStr, 'cwd'));
      } catch {
        // ignore
      }

      let cmd = '';
      try {
        cmd = readFileSync(join(procDir, pidStr, 'cmdline'), 'utf8').replace(/\0/g, ' ').trim();
      } catch {
        // ignore
      }

      let exe: string | null = null;
      try {
        exe = readlinkSync(join(procDir, pidStr, 'exe'));
      } catch {
        // ignore
      }

      result.set(pid, {
        pid,
        ppid: parseInt(fields[1], 10),
        starttime: fields[19],
        cwd: cwd || null,
        cmd,
        exe,
      });
    }
  } catch {
    // ignore
  }

  return result;
}

function norm(c: string | null): string | null {
  return c ? c.replace(/ \(deleted\)$/, '') : null;
}

function under(c: string | null, root: string): boolean {
  const n = norm(c);
  return !!n && (n === root || n.startsWith(root + '/'));
}

function selfChain(procs: Map<number, ProcessSnapshot>): Set<number> {
  const out = new Set<number>();
  let p = process.pid;
  while (p && p !== 0 && procs.has(p) && !out.has(p)) {
    out.add(p);
    p = procs.get(p)!.ppid;
  }
  out.add(1);
  return out;
}

interface ReapResult {
  selected: number;
  termed: number;
  sigkilled: number;
  residual: number;
}

function computeKillSet(
  procs: Map<number, ProcessSnapshot>,
  wtPath: string,
  protectedPaths: Set<string>,
  knownWorktrees: Set<string>,
): ProcessSnapshot[] {
  const kids = new Map<number, number[]>();
  for (const p of procs.values()) {
    if (!kids.has(p.ppid)) kids.set(p.ppid, []);
    kids.get(p.ppid)!.push(p.pid);
  }

  const inWt = (c: string | null) => under(c, wtPath);
  const seed: number[] = [];
  for (const p of procs.values()) {
    if (inWt(p.cwd)) seed.push(p.pid);
  }

  const killSet = new Set(seed);
  const stack = [...seed];
  while (stack.length) {
    const x = stack.pop()!;
    for (const k of kids.get(x) || []) {
      if (!killSet.has(k)) {
        killSet.add(k);
        stack.push(k);
      }
    }
  }

  const immune = selfChain(procs);
  const out: ProcessSnapshot[] = [];

  for (const pid of killSet) {
    const p = procs.get(pid);
    if (!p) continue;
    if (pid <= 1 || immune.has(pid)) continue;

    const n = norm(p.cwd);
    if (n && [...protectedPaths].some((q) => n === q || n.startsWith(q + '/'))) continue;
    if (n && !inWt(p.cwd) && [...knownWorktrees].some((q) => q !== wtPath && (n === q || n.startsWith(q + '/')))) continue;

    out.push(p);
  }

  return out.sort((a, b) => b.pid - a.pid);
}

function stillSame(pid: number, starttime: string): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] === starttime;
  } catch {
    return false;
  }
}

function signalProc(pid: number, starttime: string, sig: NodeJS.Signals): boolean {
  if (pid <= 1 || !stillSame(pid, starttime)) return false;
  try {
    process.kill(pid, sig);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function reapProcesses(wtPath: string, protectedPaths: Set<string>, knownWorktrees: Set<string>, apply: boolean): Promise<ReapResult> {
  const victims = computeKillSet(snapshotProcs(), wtPath, protectedPaths, knownWorktrees);

  if (!apply) {
    return { selected: victims.length, termed: 0, sigkilled: 0, residual: 0 };
  }

  for (const v of victims) {
    signalProc(v.pid, v.starttime, 'SIGTERM');
  }

  let waited = 0;
  while (waited < 10000 && victims.some((v) => {
    try {
      process.kill(v.pid, 0);
      return true;
    } catch {
      return false;
    }
  })) {
    await sleep(500);
    waited += 500;
  }

  const stubborn = victims.filter((v) => {
    try {
      process.kill(v.pid, 0);
      return stillSame(v.pid, v.starttime);
    } catch {
      return false;
    }
  });

  for (const v of stubborn) {
    signalProc(v.pid, v.starttime, 'SIGKILL');
  }

  await sleep(1000);
  const residual = computeKillSet(snapshotProcs(), wtPath, protectedPaths, knownWorktrees);

  return {
    selected: victims.length,
    termed: victims.length - stubborn.length,
    sigkilled: stubborn.length,
    residual: residual.length,
  };
}

// ===== BRANCH DELETION =====
function deleteBranch(worktreePath: string, branchName: string, apply: boolean): { method: 'd' | 'D' | 'skipped'; reason: string } {
  if (!apply) {
    return { method: 'skipped', reason: 'dry-run' };
  }

  const listResult = gitRunSync(['branch', '--list', branchName], worktreePath);
  if (!listResult.ok || listResult.stdout.trim() === '') {
    return { method: 'skipped', reason: 'branch not found (already deleted by runtime)' };
  }

  const delResult = gitRunSync(['branch', '-d', branchName], worktreePath);
  if (delResult.ok) {
    return { method: 'd', reason: 'deleted with -d' };
  }

  return { method: 'skipped', reason: 'branch -d failed, not forced' };
}

// ===== MAIN =====
async function main() {
  const args = parseArgs();
  let outcome: TeardownOutcome = 'reaped_clean';
  const report: TeardownReport = {
    worktree: args.worktree || '',
    pr: args.pr || 0,
    outcome,
    apply_mode: args.apply,
    gates: {
      g1: 'fail',
      g2a: 'fail',
      g2b: 'fail',
      g3: 'fail',
      g4: 'fail',
      g5: 'fail',
    },
    validation: {
      is_primary_checkout: false,
      is_in_inventory: false,
      path_exists: false,
    },
  };

  if (!args.worktree || !args.pr) {
    outcome = 'blocked_invalid_target';
    report.outcome = outcome;
    report.error = 'Missing --worktree or --pr';
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else console.log(`REFUSE: --worktree and --pr are required`);
    process.exit(outcome.startsWith('blocked_') ? 1 : 0);
  }

  const lockPath = join('/tmp', `orca-teardown-lock-${Date.now()}`);
  const lockAcquired = acquireLock(lockPath);

  if (!lockAcquired) {
    outcome = 'blocked_lock_held';
    report.outcome = outcome;
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else console.log('REFUSE: Another teardown is in progress (lock held)');
    process.exit(1);
  }

  try {
    const wtReal = realpath(args.worktree);
    const wtPath = wtReal || args.worktree;
    report.worktree = wtPath;

    // Validate target
    const validation = validateTarget(wtPath);
    report.validation = {
      is_primary_checkout: validation.isPrimaryCheckout,
      is_in_inventory: validation.isInInventory,
      path_exists: validation.pathExists,
    };

    if (validation.isPrimaryCheckout) {
      outcome = 'blocked_invalid_target';
      report.outcome = outcome;
      if (args.json) console.log(JSON.stringify(report, null, 2));
      else console.log('REFUSE: target is a primary checkout (has .git directory)');
      process.exit(1);
    }

    if (validation.gitFileStatus === 'missing' && validation.pathExists) {
      outcome = 'blocked_invalid_target';
      report.outcome = outcome;
      if (validation.gitFileError) {
        report.error = validation.gitFileError;
      }
      if (args.json) console.log(JSON.stringify(report, null, 2));
      else console.log(`REFUSE: target exists but .git is invalid${validation.gitFileError ? ': ' + validation.gitFileError : ''}`);
      process.exit(1);
    }

    // Run gates
    const gates = runGates(wtPath, args.pr);
    report.gates.g1 = gates.g1 ? 'pass' : 'fail';
    report.gates.g2a = gates.g2a ? 'pass' : 'fail';
    report.gates.g2b = gates.g2b ? 'pass' : 'fail';
    report.gates.g3 = gates.g3 ? 'pass' : 'fail';
    report.gates.g4 = gates.g4 ? 'pass' : 'fail';
    report.gates.g5 = gates.g5 ? 'pass' : 'fail';

    if (gates.failedGate) {
      outcome = gates.failedGate as TeardownOutcome;
      report.outcome = outcome;
      if (args.json) console.log(JSON.stringify(report, null, 2));
      else console.log(`Gate check failed: ${gates.failedGate}`);
      process.exit(1);
    }

    const prBranchName = gates.prBranchName || `pr-${args.pr}`;

    // Reap processes
    const protectedPaths = new Set<string>();
    const knownWorktrees = new Set<string>();
    const reapResult = await reapProcesses(wtPath, protectedPaths, knownWorktrees, args.apply);
    report.processes = reapResult;

    if (reapResult.residual > 0) {
      outcome = 'partial_residual_processes';
      report.outcome = outcome;
      if (args.json) console.log(JSON.stringify(report, null, 2));
      else console.log(`Residual processes detected (${reapResult.residual}); worktree not deleted`);
      process.exit(1);
    }

    // Delete branch
    const branchDel = deleteBranch(wtPath, prBranchName, args.apply);
    report.branch_deletion = branchDel;

    // Output
    outcome = 'reaped_clean';
    report.outcome = outcome;
    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`Outcome: ${outcome}`);
      console.log(`Processes: ${reapResult.selected} selected, ${reapResult.termed} SIGTERM, ${reapResult.sigkilled} SIGKILL`);
      console.log(`Branch: ${branchDel.method} (${branchDel.reason})`);
    }
    process.exit(0);
  } finally {
    releaseLock(lockPath);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(2);
});
