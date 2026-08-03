import {
  existsSync,
  lstatSync,
  openSync,
  closeSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { runProcessSync, type ProcessResult } from '../kernel/subprocess.ts';
import { resolveOrcaExecutable } from '../orca-runtime/native.ts';
import {
  classifyWorktree,
  decideContinuation,
  normalizeBranchName,
  normalizeExpectedIdentity,
  normalizeWorktreePath,
  parseGitWorktreePorcelain,
  parseOrcaWorktreePayload,
  type CensusEvidence,
  type ExpectedWorktreeIdentity,
  type GitWorktreeRow,
  type LifecycleContext,
  type OrcaWorktreeRow,
  type WorktreeClassificationReport,
} from './core.ts';

export interface CommandInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly timeoutMs?: number;
}

export type CommandRunner = (invocation: CommandInvocation) => ProcessResult;

export interface LifecycleOperations {
  readonly runner?: CommandRunner;
  readonly orcaExecutable?: string;
  readonly lockPath?: string;
  readonly processCensus?: (worktreePath: string) => readonly ProcessEvidence[];
}

export interface ProcessEvidence {
  readonly pid: number;
  readonly ppid: number;
  readonly starttime: string;
  readonly cwd: string;
}

export interface TerminalEvidence {
  readonly handle?: string;
  readonly worktreePath: string;
  readonly tabId?: string;
}

export interface PrIdentity {
  readonly headRefName: string;
  readonly state: string;
  readonly headRefOid: string;
  readonly mergeCommitOid?: string;
  readonly headRepository?: string;
  readonly baseRefName?: string;
}

export interface RecoveryGates {
  readonly identity: boolean;
  readonly gitLink: boolean;
  readonly clean: boolean;
  readonly ignoredData: boolean;
  readonly merged: boolean;
  readonly branchOwnership: boolean;
  readonly runtimeAgentsAbsent: boolean;
  readonly terminalsAbsent: boolean;
  readonly processesAbsent: boolean;
  readonly freshRecheck: boolean;
}

export type CleanupOutcome =
  | 'cleanup_complete'
  | 'cleanup_deferred'
  | 'git_only_recovery_eligible'
  | 'git_only_recovered'
  | 'already_absent'
  | 'task_degraded';

export interface LifecycleTerminalReport {
  readonly schema: 'orchestrator-pack/worktree-lifecycle-terminal/v1';
  readonly context: LifecycleContext;
  readonly outcome: CleanupOutcome;
  readonly pipelineContinues: true;
  readonly classification: WorktreeClassificationReport;
  readonly decision: ReturnType<typeof decideContinuation>;
  readonly gates?: RecoveryGates;
  readonly effects: readonly string[];
  readonly postClassification?: WorktreeClassificationReport;
  readonly standardTeardown?: unknown;
  readonly processes?: readonly ProcessEvidence[];
  readonly terminals?: readonly TerminalEvidence[];
  readonly branchDeletion?: 'deleted' | 'not-present' | 'refused' | 'not-applicable';
  readonly error?: string;
}

interface OrcaAgentInventoryRow extends OrcaWorktreeRow {
  readonly agents?: readonly { state?: string; interrupted?: boolean }[];
}

const DEFAULT_LOCK_PATH = '/tmp/opk-worktree-teardown.lock';
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
    inheritParentEnv: true,
    timeoutMs: invocation.timeoutMs,
  });
}

function commandError(result: ProcessResult, command: string, args: readonly string[]): string {
  return result.stderr.trim()
    || result.error
    || `${command} ${args.join(' ')} exited ${String(result.exitCode)}`;
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

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new TypeError(`${label} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function mergeAgentRows(
  worktrees: readonly OrcaWorktreeRow[],
  agentRows: readonly OrcaWorktreeRow[],
): OrcaAgentInventoryRow[] {
  const agentsByPath = new Map(agentRows.map((row) => [row.path, row.agents]));
  const merged = worktrees.map((row) => ({ ...row, agents: agentsByPath.get(row.path) ?? row.agents }));
  for (const row of agentRows) {
    if (!worktrees.some((worktree) => worktree.path === row.path)) merged.push(row);
  }
  return merged;
}

function parseTerminalPayload(payload: unknown): TerminalEvidence[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('Orca terminal response must be an object');
  }
  const root = payload as Record<string, unknown>;
  if (root.ok !== true || !root.result || typeof root.result !== 'object' || Array.isArray(root.result)) {
    throw new TypeError('Orca terminal response must carry ok=true and result');
  }
  const terminals = (root.result as Record<string, unknown>).terminals;
  if (!Array.isArray(terminals)) throw new TypeError('Orca terminal response omitted result.terminals[]');
  return terminals.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError(`Orca terminal row ${index} is not an object`);
    }
    const row = value as Record<string, unknown>;
    if (typeof row.worktreePath !== 'string' || !row.worktreePath.trim()) {
      throw new TypeError(`Orca terminal row ${index} omitted worktreePath`);
    }
    return {
      ...(typeof row.handle === 'string' && row.handle.trim() ? { handle: row.handle.trim() } : {}),
      worktreePath: normalizeWorktreePath(row.worktreePath),
      ...(typeof row.tabId === 'string' && row.tabId.trim() ? { tabId: row.tabId.trim() } : {}),
    };
  });
}

export function collectProcessEvidence(worktreePath: string): ProcessEvidence[] {
  const target = normalizeWorktreePath(worktreePath);
  const result: ProcessEvidence[] = [];
  let names: string[];
  try {
    names = readdirSync('/proc').filter((name) => /^\d+$/.test(name));
  } catch {
    return result;
  }
  for (const name of names) {
    const pid = Number.parseInt(name, 10);
    let cwd: string;
    let stat: string;
    try {
      cwd = readlinkSync(`/proc/${name}/cwd`).replace(/ \(deleted\)$/, '');
      stat = readFileSync(`/proc/${name}/stat`, 'utf8');
    } catch {
      continue;
    }
    const normalizedCwd = normalizeWorktreePath(cwd);
    if (normalizedCwd !== target && !normalizedCwd.startsWith(`${target}/`)) continue;
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    result.push({
      pid,
      ppid: Number.parseInt(fields[1] ?? '0', 10),
      starttime: fields[19] ?? '',
      cwd: normalizedCwd,
    });
  }
  return result.sort((left, right) => left.pid - right.pid);
}

export function collectCensus(
  expectedInput: ExpectedWorktreeIdentity,
  operations: LifecycleOperations = {},
): {
  classification: WorktreeClassificationReport;
  agentRows: readonly OrcaAgentInventoryRow[];
  terminals: readonly TerminalEvidence[];
  errors: readonly string[];
} {
  const expected = normalizeExpectedIdentity(expectedInput);
  const runner = operations.runner ?? defaultRunner;
  const orcaExecutable = operations.orcaExecutable ?? resolveOrcaExecutable();
  const errors: string[] = [];

  let gitRows: GitWorktreeRow[] = [];
  let gitStatus: CensusEvidence['git']['status'] = 'ok';
  const gitResult = runner({
    command: 'git',
    args: ['-C', expected.repositoryRoot, 'worktree', 'list', '--porcelain'],
  });
  if (!gitResult.ok) {
    gitStatus = 'unavailable';
    errors.push(commandError(gitResult, 'git', ['worktree', 'list', '--porcelain']));
  } else {
    try {
      gitRows = parseGitWorktreePorcelain(gitResult.stdout);
    } catch (error) {
      gitStatus = 'malformed';
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  let orcaRows: OrcaWorktreeRow[] = [];
  let agentRows: OrcaWorktreeRow[] = [];
  let terminals: TerminalEvidence[] = [];
  let orcaStatus: CensusEvidence['orca']['status'] = 'ok';
  const worktreeResult = runner({ command: orcaExecutable, args: ['worktree', 'list', '--json'] });
  const agentResult = runner({ command: orcaExecutable, args: ['worktree', 'ps', '--json'] });
  const terminalResult = runner({ command: orcaExecutable, args: ['terminal', 'list', '--json'] });
  try {
    if (!worktreeResult.ok) throw new TypeError(commandError(worktreeResult, orcaExecutable, ['worktree', 'list', '--json']));
    orcaRows = parseOrcaWorktreePayload(parseJson(worktreeResult.stdout, 'orca worktree list'));
    if (!agentResult.ok) throw new TypeError(commandError(agentResult, orcaExecutable, ['worktree', 'ps', '--json']));
    agentRows = parseOrcaWorktreePayload(parseJson(agentResult.stdout, 'orca worktree ps'));
    if (!terminalResult.ok) throw new TypeError(commandError(terminalResult, orcaExecutable, ['terminal', 'list', '--json']));
    terminals = parseTerminalPayload(parseJson(terminalResult.stdout, 'orca terminal list'));
  } catch (error) {
    orcaStatus = worktreeResult.ok && agentResult.ok && terminalResult.ok ? 'malformed' : 'unavailable';
    errors.push(error instanceof Error ? error.message : String(error));
  }

  const evidence: CensusEvidence = {
    git: {
      status: gitStatus,
      rows: gitRows,
      ...(gitStatus === 'ok' ? {} : { error: errors.find((item) => item.includes('git')) ?? 'git census failed' }),
    },
    orca: {
      status: orcaStatus,
      rows: orcaRows,
      ...(orcaStatus === 'ok' ? {} : { error: errors.find((item) => item.includes('orca')) ?? 'Orca census failed' }),
    },
  };
  return {
    classification: classifyWorktree({ expected, evidence }),
    agentRows: mergeAgentRows(orcaRows, agentRows),
    terminals,
    errors,
  };
}

export function readPrIdentity(
  repositoryRoot: string,
  prNumber: number,
  operations: LifecycleOperations = {},
): PrIdentity {
  const runner = operations.runner ?? defaultRunner;
  const gh = join(normalizeWorktreePath(repositoryRoot), 'scripts', 'gh');
  const args = [
    'pr',
    'view',
    String(prNumber),
    '--json',
    'headRefName,state,headRefOid,mergeCommit,headRepository,baseRefName',
  ];
  const result = runner({ command: gh, args });
  if (!result.ok) throw new TypeError(commandError(result, gh, args));
  const parsed = parseJson(result.stdout, 'gh pr view');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('gh pr view returned a non-object');
  }
  const row = parsed as Record<string, unknown>;
  if (typeof row.headRefName !== 'string' || typeof row.state !== 'string' || typeof row.headRefOid !== 'string') {
    throw new TypeError('gh pr view omitted headRefName/state/headRefOid');
  }
  const mergeCommit = row.mergeCommit && typeof row.mergeCommit === 'object' && !Array.isArray(row.mergeCommit)
    ? row.mergeCommit as Record<string, unknown>
    : undefined;
  const headRepository = row.headRepository && typeof row.headRepository === 'object' && !Array.isArray(row.headRepository)
    ? row.headRepository as Record<string, unknown>
    : undefined;
  return {
    headRefName: normalizeBranchName(row.headRefName)!,
    state: row.state,
    headRefOid: String(row.headRefOid).trim().toLowerCase(),
    ...(typeof mergeCommit?.oid === 'string' ? { mergeCommitOid: mergeCommit.oid.trim().toLowerCase() } : {}),
    ...(typeof headRepository?.nameWithOwner === 'string' ? { headRepository: headRepository.nameWithOwner } : {}),
    ...(typeof row.baseRefName === 'string' ? { baseRefName: row.baseRefName } : {}),
  };
}

function gitResult(runner: CommandRunner, args: readonly string[], cwd?: string): ProcessResult {
  return runner({ command: 'git', args, cwd });
}

function validateGitLink(expected: ExpectedWorktreeIdentity, runner: CommandRunner): boolean {
  if (!existsSync(expected.path)) return false;
  const gitPath = join(expected.path, '.git');
  try {
    if (!lstatSync(gitPath).isFile()) return false;
    const content = readFileSync(gitPath, 'utf8').trim();
    if (!content.startsWith('gitdir: ')) return false;
    const rawGitdir = content.slice('gitdir: '.length).trim();
    const gitdir = normalizeWorktreePath(isAbsolute(rawGitdir) ? rawGitdir : resolve(expected.path, rawGitdir));
    if (!existsSync(gitdir)) return false;
    const targetCommon = gitResult(runner, ['-C', expected.path, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
    const repoCommon = gitResult(runner, ['-C', expected.repositoryRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
    if (!targetCommon.ok || !repoCommon.ok) return false;
    const targetCommonPath = normalizeWorktreePath(targetCommon.stdout.trim());
    const repoCommonPath = normalizeWorktreePath(repoCommon.stdout.trim());
    return targetCommonPath === repoCommonPath
      && (gitdir === repoCommonPath || gitdir.startsWith(`${repoCommonPath}/worktrees/`));
  } catch {
    return false;
  }
}

function checkClean(expected: ExpectedWorktreeIdentity, runner: CommandRunner): boolean {
  const result = gitResult(runner, ['-C', expected.path, 'status', '--porcelain', '--untracked-files=all']);
  return result.ok && result.stdout.trim() === '';
}

function checkIgnored(expected: ExpectedWorktreeIdentity, runner: CommandRunner): boolean {
  const result = gitResult(runner, ['-C', expected.path, 'status', '--porcelain', '--ignored=matching']);
  if (!result.ok) return false;
  return result.stdout.split(/\r?\n/).filter((line) => line.startsWith('!! ')).every((line) => {
    const path = line.slice(3).trim();
    return IGNORED_DIRECTORY_ALLOWLIST.some((allowed) => path.startsWith(allowed));
  });
}

function checkMerged(
  expected: ExpectedWorktreeIdentity,
  pr: PrIdentity,
  runner: CommandRunner,
): boolean {
  const ordinary = gitResult(runner, ['-C', expected.path, 'merge-base', '--is-ancestor', 'HEAD', 'origin/main']);
  if (ordinary.ok && ordinary.exitCode === 0) return true;
  if (pr.state !== 'MERGED' || pr.headRefOid !== expected.headSha || !pr.mergeCommitOid) return false;
  const fetched = gitResult(runner, ['-C', expected.path, 'fetch', 'origin', 'main']);
  if (!fetched.ok) return false;
  const squash = gitResult(runner, [
    '-C',
    expected.path,
    'merge-base',
    '--is-ancestor',
    pr.mergeCommitOid,
    'origin/main',
  ]);
  return squash.ok && squash.exitCode === 0;
}

function checkBranchOwnership(
  expected: ExpectedWorktreeIdentity,
  pr: PrIdentity,
  runner: CommandRunner,
): boolean {
  if (expected.mode === 'detached-confirmed') return true;
  if (!pr.headRepository || !expected.branchName) return false;
  const gh = join(expected.repositoryRoot, 'scripts', 'gh');
  const args = [
    'pr',
    'list',
    '--state',
    'open',
    '--json',
    'number,headRefName,headRepository',
    '--repo',
    pr.headRepository,
  ];
  const result = runner({ command: gh, args });
  if (!result.ok) return false;
  try {
    const rows = JSON.parse(result.stdout) as Array<{ number?: number; headRefName?: string }>;
    return rows.filter(
      (row) => normalizeBranchName(row.headRefName) === expected.branchName && row.number !== expected.prNumber,
    ).length === 0;
  } catch {
    return false;
  }
}

function relevantInventoryFingerprint(
  expected: ExpectedWorktreeIdentity,
  census: ReturnType<typeof collectCensus>,
): string {
  const git = census.classification.evidence.git.rows.filter(
    (row) => row.path === expected.path || row.headSha === expected.headSha || row.branchName === expected.branchName,
  );
  const orca = census.classification.evidence.orca.rows.filter(
    (row) => row.path === expected.path || row.headSha === expected.headSha || row.branchName === expected.branchName,
  );
  const agents = census.agentRows.filter(
    (row) => row.path === expected.path || row.headSha === expected.headSha || row.branchName === expected.branchName,
  );
  const terminals = census.terminals.filter((row) => row.worktreePath === expected.path);
  return digest({ git, orca, agents, terminals });
}

function nonTargetFingerprint(expected: ExpectedWorktreeIdentity, census: ReturnType<typeof collectCensus>): string {
  return digest({
    git: census.classification.evidence.git.rows.filter((row) => row.path !== expected.path),
    orca: census.classification.evidence.orca.rows.filter((row) => row.path !== expected.path),
  });
}

function acquireLock(path: string): number | null {
  try {
    const fd = openSync(path, 'wx', 0o600);
    writeFileSync(fd, `${process.pid}\n`, 'utf8');
    return fd;
  } catch {
    return null;
  }
}

function releaseLock(path: string, fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // Best effort; unlink below still attempts owner cleanup.
  }
  try {
    unlinkSync(path);
  } catch {
    // Missing-at-release is harmless.
  }
}

function recoverGitOnly(
  expectedInput: ExpectedWorktreeIdentity,
  apply: boolean,
  operations: LifecycleOperations,
): LifecycleTerminalReport {
  const expected = normalizeExpectedIdentity(expectedInput);
  const runner = operations.runner ?? defaultRunner;
  const lockPath = operations.lockPath ?? DEFAULT_LOCK_PATH;
  const lockFd = acquireLock(lockPath);
  const initial = collectCensus(expected, operations);
  const decision = decideContinuation(initial.classification.classification, 'explicit-recovery');
  if (lockFd === null) {
    return {
      schema: 'orchestrator-pack/worktree-lifecycle-terminal/v1',
      context: 'explicit-recovery',
      outcome: 'cleanup_deferred',
      pipelineContinues: true,
      classification: initial.classification,
      decision,
      effects: [],
      error: `lifecycle exclusion lock is held at ${lockPath}`,
    };
  }
  try {
    if (initial.classification.classification === 'absent') {
      return {
        schema: 'orchestrator-pack/worktree-lifecycle-terminal/v1',
        context: 'explicit-recovery',
        outcome: 'already_absent',
        pipelineContinues: true,
        classification: initial.classification,
        decision,
        effects: [],
      };
    }
    if (initial.classification.classification !== 'exact_git_only') {
      return {
        schema: 'orchestrator-pack/worktree-lifecycle-terminal/v1',
        context: 'explicit-recovery',
        outcome: 'cleanup_deferred',
        pipelineContinues: true,
        classification: initial.classification,
        decision,
        effects: [],
        error: `guarded Git-only recovery requires exact_git_only, got ${initial.classification.classification}`,
      };
    }

    let pr: PrIdentity;
    try {
      pr = readPrIdentity(expected.repositoryRoot, expected.prNumber, operations);
    } catch (error) {
      return {
        schema: 'orchestrator-pack/worktree-lifecycle-terminal/v1',
        context: 'explicit-recovery',
        outcome: 'cleanup_deferred',
        pipelineContinues: true,
        classification: initial.classification,
        decision,
        effects: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
    const targetTerminals = initial.terminals.filter((row) => row.worktreePath === expected.path);
    const targetAgents = initial.agentRows.filter(
      (row) => row.path === expected.path || row.headSha === expected.headSha || row.branchName === expected.branchName,
    );
    const processes = (operations.processCensus ?? collectProcessEvidence)(expected.path);
    const initialFingerprint = relevantInventoryFingerprint(expected, initial);
    const gatesWithoutFresh = {
      identity: initial.classification.exactGitRows.length === 1,
      gitLink: validateGitLink(expected, runner),
      clean: checkClean(expected, runner),
      ignoredData: checkIgnored(expected, runner),
      merged: checkMerged(expected, pr, runner),
      branchOwnership: checkBranchOwnership(expected, pr, runner),
      runtimeAgentsAbsent: targetAgents.length === 0,
      terminalsAbsent: targetTerminals.length === 0,
      processesAbsent: processes.length === 0,
    };
    const fresh = collectCensus(expected, operations);
    const freshRecheck = fresh.classification.classification === 'exact_git_only'
      && relevantInventoryFingerprint(expected, fresh) === initialFingerprint;
    const gates: RecoveryGates = { ...gatesWithoutFresh, freshRecheck };
    const allPass = Object.values(gates).every(Boolean);
    if (!allPass || !apply) {
      return {
        schema: 'orchestrator-pack/worktree-lifecycle-terminal/v1',
        context: 'explicit-recovery',
        outcome: allPass ? 'git_only_recovery_eligible' : 'cleanup_deferred',
        pipelineContinues: true,
        classification: initial.classification,
        decision,
        gates,
        effects: [],
        processes,
        terminals: targetTerminals,
        ...(!allPass ? { error: 'one or more guarded Git-only recovery gates failed' } : {}),
      };
    }

    const beforeNonTarget = nonTargetFingerprint(expected, fresh);
    const removalArgs = ['-C', expected.repositoryRoot, 'worktree', 'remove', expected.path];
    const removal = runner({ command: 'git', args: removalArgs });
    if (!removal.ok) {
      return {
        schema: 'orchestrator-pack/worktree-lifecycle-terminal/v1',
        context: 'explicit-recovery',
        outcome: 'cleanup_deferred',
        pipelineContinues: true,
        classification: initial.classification,
        decision,
        gates,
        effects: ['git worktree remove attempted'],
        processes,
        terminals: targetTerminals,
        error: commandError(removal, 'git', removalArgs),
      };
    }
    const effects = ['git worktree remove (non-force)'];
    let branchDeletion: LifecycleTerminalReport['branchDeletion'] = 'not-applicable';
    if (expected.mode === 'branch-bound' && expected.branchName) {
      const present = runner({
        command: 'git',
        args: ['-C', expected.repositoryRoot, 'branch', '--list', expected.branchName],
      });
      if (!present.ok || present.stdout.trim() === '') {
        branchDeletion = 'not-present';
      } else {
        const deleted = runner({
          command: 'git',
          args: ['-C', expected.repositoryRoot, 'branch', '-d', expected.branchName],
        });
        branchDeletion = deleted.ok ? 'deleted' : 'refused';
        if (deleted.ok) effects.push('git branch -d');
      }
    }
    const post = collectCensus(expected, operations);
    const absent = post.classification.classification === 'absent';
    const unrelatedStable = nonTargetFingerprint(expected, post) === beforeNonTarget;
    return {
      schema: 'orchestrator-pack/worktree-lifecycle-terminal/v1',
      context: 'explicit-recovery',
      outcome: absent && unrelatedStable ? 'git_only_recovered' : 'task_degraded',
      pipelineContinues: true,
      classification: initial.classification,
      decision,
      gates,
      effects,
      postClassification: post.classification,
      processes,
      terminals: targetTerminals,
      branchDeletion,
      ...(!absent || !unrelatedStable
        ? { error: 'post-effect read-back did not prove exact absence with unrelated inventory unchanged' }
        : {}),
    };
  } finally {
    releaseLock(lockPath, lockFd);
  }
}

function standardTeardown(
  expected: ExpectedWorktreeIdentity,
  apply: boolean,
  operations: LifecycleOperations,
): LifecycleTerminalReport {
  const runner = operations.runner ?? defaultRunner;
  const census = collectCensus(expected, operations);
  const decision = decideContinuation(census.classification.classification, 'post-merge-cleanup');
  if (census.classification.classification === 'absent') {
    return {
      schema: 'orchestrator-pack/worktree-lifecycle-terminal/v1',
      context: 'post-merge-cleanup',
      outcome: 'already_absent',
      pipelineContinues: true,
      classification: census.classification,
      decision,
      effects: [],
    };
  }
  if (census.classification.classification === 'exact_git_only') {
    const recovered = recoverGitOnly(expected, apply, operations);
    return { ...recovered, context: 'post-merge-cleanup' };
  }
  if (census.classification.classification !== 'exact_dual') {
    return {
      schema: 'orchestrator-pack/worktree-lifecycle-terminal/v1',
      context: 'post-merge-cleanup',
      outcome: 'cleanup_deferred',
      pipelineContinues: true,
      classification: census.classification,
      decision,
      effects: [],
      error: census.errors.join('; ') || 'disputed worktree identity was preserved',
    };
  }
  const args = [
    '--experimental-strip-types',
    join(expected.repositoryRoot, 'scripts', 'worktree-teardown.ts'),
    '--worktree',
    expected.path,
    '--pr',
    String(expected.prNumber),
    '--json',
    ...(apply ? ['--apply'] : []),
  ];
  const result = runner({ command: process.execPath, args, cwd: expected.repositoryRoot });
  let child: unknown;
  try {
    child = JSON.parse(result.stdout) as unknown;
  } catch {
    child = { raw_stdout: result.stdout.trim(), raw_stderr: result.stderr.trim() };
  }
  return {
    schema: 'orchestrator-pack/worktree-lifecycle-terminal/v1',
    context: 'post-merge-cleanup',
    outcome: result.ok ? 'cleanup_complete' : 'cleanup_deferred',
    pipelineContinues: true,
    classification: census.classification,
    decision,
    effects: result.ok && apply ? ['standard guarded teardown'] : [],
    standardTeardown: child,
    ...(!result.ok ? { error: 'standard teardown blocked or failed; completed merge/adoption remains successful' } : {}),
  };
}

export function runLifecycle(input: {
  readonly expected: ExpectedWorktreeIdentity;
  readonly context: LifecycleContext;
  readonly apply: boolean;
  readonly operations?: LifecycleOperations;
}): LifecycleTerminalReport {
  const expected = normalizeExpectedIdentity(input.expected);
  const operations = input.operations ?? {};
  if (input.context === 'post-merge-cleanup') return standardTeardown(expected, input.apply, operations);
  if (input.context === 'explicit-recovery') return recoverGitOnly(expected, input.apply, operations);
  const census = collectCensus(expected, operations);
  const decision = decideContinuation(census.classification.classification, 'post-create');
  return {
    schema: 'orchestrator-pack/worktree-lifecycle-terminal/v1',
    context: 'post-create',
    outcome: census.classification.classification === 'exact_dual' ? 'cleanup_complete' : 'task_degraded',
    pipelineContinues: true,
    classification: census.classification,
    decision,
    effects: [],
    terminals: census.terminals.filter((row) => row.worktreePath === expected.path),
    ...(census.errors.length > 0 ? { error: census.errors.join('; ') } : {}),
  };
}
