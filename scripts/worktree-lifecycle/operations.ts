import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { runProcessSync, type ProcessResult } from '../kernel/subprocess.ts';
import { resolveOrcaExecutable } from '../orca-runtime/native.ts';
import {
  classifyWorktree,
  decideContinuation,
  normalizeBranchName,
  normalizeExpectedIdentity,
  normalizeHeadSha,
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
import { WORKTREE_IGNORED_DIRECTORY_ALLOWLIST } from './policy.ts';

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
  readonly cwd: string | null;
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

export type LifecycleOutcome =
  | 'exact_dual_observed'
  | 'replacement_required'
  | 'cleanup_eligible'
  | 'cleanup_complete'
  | 'cleanup_deferred'
  | 'git_only_recovery_eligible'
  | 'git_only_recovered'
  | 'already_absent'
  | 'task_degraded';

export interface LifecycleTerminalReport {
  readonly schema: 'orchestrator-pack/worktree-lifecycle-terminal/v1';
  readonly context: LifecycleContext;
  readonly outcome: LifecycleOutcome;
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

interface RecoverySnapshot {
  readonly census: ReturnType<typeof collectCensus>;
  readonly pr?: PrIdentity;
  readonly gates: Omit<RecoveryGates, 'freshRecheck'>;
  readonly processes: readonly ProcessEvidence[];
  readonly terminals: readonly TerminalEvidence[];
  readonly errors: readonly string[];
}

const DEFAULT_LOCK_PATH = '/tmp/opk-worktree-teardown.lock';

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
  const merged: OrcaAgentInventoryRow[] = worktrees.map((row) => ({
    ...row,
    agents: agentsByPath.get(row.path) ?? row.agents,
  }));
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

function isGone(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
    || (error as NodeJS.ErrnoException).code === 'ESRCH';
}

function readProcessSnapshot(name: string): ProcessEvidence | null {
  const pid = Number.parseInt(name, 10);
  if (!Number.isInteger(pid) || pid <= 1) return null;
  let stat: string;
  try {
    stat = readFileSync(`/proc/${name}/stat`, 'utf8');
  } catch (error) {
    if (isGone(error)) return null;
    throw new TypeError(`process census could not read /proc/${name}/stat: ${error instanceof Error ? error.message : String(error)}`);
  }
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const ppid = Number.parseInt(fields[1] ?? '0', 10);
  const starttime = fields[19] ?? '';
  if (!Number.isInteger(ppid) || !starttime) {
    throw new TypeError(`process census received malformed /proc/${name}/stat`);
  }
  let cwd: string | null = null;
  try {
    cwd = normalizeWorktreePath(readlinkSync(`/proc/${name}/cwd`).replace(/ \(deleted\)$/, ''));
  } catch (error) {
    if (!isGone(error)) {
      throw new TypeError(`process census could not read /proc/${name}/cwd: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { pid, ppid, starttime, cwd };
}

export function collectProcessEvidence(worktreePath: string): ProcessEvidence[] {
  const target = normalizeWorktreePath(worktreePath);
  let names: string[];
  try {
    names = readdirSync('/proc').filter((name) => /^\d+$/.test(name));
  } catch (error) {
    throw new TypeError(`process census could not enumerate /proc: ${error instanceof Error ? error.message : String(error)}`);
  }
  const snapshots = names
    .map(readProcessSnapshot)
    .filter((row): row is ProcessEvidence => row !== null);
  const selected = new Set(
    snapshots
      .filter((row) => row.cwd === target || row.cwd?.startsWith(`${target}/`))
      .map((row) => row.pid),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of snapshots) {
      if (!selected.has(row.pid) && selected.has(row.ppid)) {
        selected.add(row.pid);
        changed = true;
      }
    }
  }
  return snapshots
    .filter((row) => selected.has(row.pid))
    .sort((left, right) => left.pid - right.pid);
}

function resolveRepositoryId(repositoryRoot: string, rows: readonly OrcaWorktreeRow[]): string | null {
  const candidates = rows.filter((row) => row.path === repositoryRoot
    && row.isMainWorktree
    && !row.isArchived
    && row.malformedFields.length === 0
    && Boolean(row.repoId));
  const ids = [...new Set(candidates.map((row) => row.repoId!))];
  return ids.length === 1 ? ids[0]! : null;
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
  const baseExpected = normalizeExpectedIdentity(expectedInput);
  const runner = operations.runner ?? defaultRunner;
  const orcaExecutable = operations.orcaExecutable ?? resolveOrcaExecutable();
  const errors: string[] = [];

  let gitRows: GitWorktreeRow[] = [];
  let gitStatus: CensusEvidence['git']['status'] = 'ok';
  const gitResult = runner({
    command: 'git',
    args: ['-C', baseExpected.repositoryRoot, 'worktree', 'list', '--porcelain'],
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
    if (!worktreeResult.ok) {
      throw new TypeError(commandError(worktreeResult, orcaExecutable, ['worktree', 'list', '--json']));
    }
    orcaRows = parseOrcaWorktreePayload(parseJson(worktreeResult.stdout, 'orca worktree list'));
    if (!agentResult.ok) {
      throw new TypeError(commandError(agentResult, orcaExecutable, ['worktree', 'ps', '--json']));
    }
    agentRows = parseOrcaWorktreePayload(parseJson(agentResult.stdout, 'orca worktree ps'));
    if (!terminalResult.ok) {
      throw new TypeError(commandError(terminalResult, orcaExecutable, ['terminal', 'list', '--json']));
    }
    terminals = parseTerminalPayload(parseJson(terminalResult.stdout, 'orca terminal list'));
  } catch (error) {
    orcaStatus = worktreeResult.ok && agentResult.ok && terminalResult.ok ? 'malformed' : 'unavailable';
    errors.push(error instanceof Error ? error.message : String(error));
  }

  const repositoryId = orcaStatus === 'ok'
    ? resolveRepositoryId(baseExpected.repositoryRoot, orcaRows)
    : null;
  if (!repositoryId) {
    orcaStatus = orcaStatus === 'unavailable' ? 'unavailable' : 'malformed';
    errors.push('Orca inventory did not prove one active main-worktree repository identity');
  }
  const expected: ExpectedWorktreeIdentity = {
    ...baseExpected,
    ...(repositoryId ? { repositoryId } : {}),
  };
  const evidence: CensusEvidence = {
    git: {
      status: gitStatus,
      rows: gitRows,
      ...(gitStatus === 'ok' ? {} : { error: errors.find((item) => item.toLowerCase().includes('git')) ?? 'git census failed' }),
    },
    orca: {
      status: orcaStatus,
      rows: orcaRows,
      ...(orcaStatus === 'ok' ? {} : { error: errors.find((item) => item.toLowerCase().includes('orca')) ?? 'Orca census failed' }),
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
    headRefOid: normalizeHeadSha(row.headRefOid),
    ...(typeof mergeCommit?.oid === 'string' ? { mergeCommitOid: normalizeHeadSha(mergeCommit.oid) } : {}),
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
    const targetCommon = gitResult(runner, [
      '-C', expected.path, 'rev-parse', '--path-format=absolute', '--git-common-dir',
    ]);
    const repoCommon = gitResult(runner, [
      '-C', expected.repositoryRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir',
    ]);
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
    return WORKTREE_IGNORED_DIRECTORY_ALLOWLIST.some((allowed) => path.startsWith(allowed));
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
      (row) => normalizeBranchName(row.headRefName) === expected.branchName
        && row.number !== expected.bindingNumber,
    ).length === 0;
  } catch {
    return false;
  }
}

function relevantInventoryFingerprint(
  expected: ExpectedWorktreeIdentity,
  census: ReturnType<typeof collectCensus>,
): string {
  const repositoryId = census.classification.expected.repositoryId ?? expected.repositoryId;
  const matches = (row: {
    path: string;
    headSha?: string;
    branchName?: string;
    linkedIssue?: number | null;
    linkedPR?: number | null;
  }) => row.path === expected.path
    || row.headSha === expected.headSha
    || row.branchName === expected.branchName
    || (expected.bindingKind === 'issue' && row.linkedIssue === expected.bindingNumber)
    || (expected.bindingKind === 'pr' && row.linkedPR === expected.bindingNumber);
  const git = census.classification.evidence.git.rows.filter(
    (row) => row.path === expected.path || row.headSha === expected.headSha || row.branchName === expected.branchName,
  );
  const orca = census.classification.evidence.orca.rows.filter(
    (row) => row.repoId === repositoryId && matches(row),
  );
  const agents = census.agentRows.filter(
    (row) => row.repoId === repositoryId && matches(row),
  );
  const terminals = census.terminals.filter((row) => row.worktreePath === expected.path);
  return digest({ git, orca, agents, terminals });
}

function nonTargetFingerprint(expected: ExpectedWorktreeIdentity, census: ReturnType<typeof collectCensus>): string {
  const repositoryId = census.classification.expected.repositoryId ?? expected.repositoryId;
  return digest({
    git: census.classification.evidence.git.rows.filter((row) => row.path !== expected.path),
    orca: census.classification.evidence.orca.rows.filter(
      (row) => row.repoId === repositoryId && row.path !== expected.path,
    ),
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

function deferred(
  context: LifecycleContext,
  classification: WorktreeClassificationReport,
  error: string,
): LifecycleTerminalReport {
  return {
    schema: 'orchestrator-pack/worktree-lifecycle-terminal/v1',
    context,
    outcome: 'cleanup_deferred',
    pipelineContinues: true,
    classification,
    decision: decideContinuation(classification.classification, context),
    effects: [],
    error,
  };
}

function targetAgents(expected: ExpectedWorktreeIdentity, census: ReturnType<typeof collectCensus>): OrcaAgentInventoryRow[] {
  const repositoryId = census.classification.expected.repositoryId ?? expected.repositoryId;
  return census.agentRows.filter(
    (row) => row.repoId === repositoryId
      && (row.path === expected.path
        || row.branchName === expected.branchName
        || (expected.bindingKind === 'pr' && row.linkedPR === expected.bindingNumber)
        || (expected.bindingKind === 'issue' && row.linkedIssue === expected.bindingNumber)),
  );
}

function collectRecoverySnapshot(
  expected: ExpectedWorktreeIdentity,
  operations: LifecycleOperations,
): RecoverySnapshot {
  const runner = operations.runner ?? defaultRunner;
  const census = collectCensus(expected, operations);
  const errors = [...census.errors];
  let pr: PrIdentity | undefined;
  try {
    pr = readPrIdentity(expected.repositoryRoot, expected.bindingNumber, operations);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  let processes: readonly ProcessEvidence[] = [];
  let processCensusOk = true;
  try {
    processes = (operations.processCensus ?? collectProcessEvidence)(expected.path);
  } catch (error) {
    processCensusOk = false;
    errors.push(error instanceof Error ? error.message : String(error));
  }
  const terminals = census.terminals.filter((row) => row.worktreePath === expected.path);
  const agents = targetAgents(expected, census);
  return {
    census,
    pr,
    gates: {
      identity: census.classification.classification === 'exact_git_only'
        && census.classification.exactGitRows.length === 1,
      gitLink: validateGitLink(expected, runner),
      clean: checkClean(expected, runner),
      ignoredData: checkIgnored(expected, runner),
      merged: Boolean(pr && checkMerged(expected, pr, runner)),
      branchOwnership: Boolean(pr && checkBranchOwnership(expected, pr, runner)),
      runtimeAgentsAbsent: census.errors.length === 0 && agents.length === 0,
      terminalsAbsent: census.errors.length === 0 && terminals.length === 0,
      processesAbsent: processCensusOk && processes.length === 0,
    },
    processes,
    terminals,
    errors,
  };
}

function recoverySnapshotFingerprint(_expected: ExpectedWorktreeIdentity, snapshot: RecoverySnapshot): string {
  const authoritativeExpected = snapshot.census.classification.expected;
  return digest({
    inventory: relevantInventoryFingerprint(authoritativeExpected, snapshot.census),
    pr: snapshot.pr,
    gates: snapshot.gates,
    processes: snapshot.processes,
    terminals: snapshot.terminals,
  });
}

function recoverGitOnly(
  expectedInput: ExpectedWorktreeIdentity,
  apply: boolean,
  operations: LifecycleOperations,
): LifecycleTerminalReport {
  const expected = normalizeExpectedIdentity(expectedInput);
  if (expected.bindingKind !== 'pr') {
    const initial = collectCensus(expected, operations);
    return deferred(
      'explicit-recovery',
      initial.classification,
      'destructive recovery requires a PR-bound identity; issue-bound post-create state must use replacement flow',
    );
  }
  const runner = operations.runner ?? defaultRunner;
  const lockPath = operations.lockPath ?? DEFAULT_LOCK_PATH;
  const lockFd = acquireLock(lockPath);
  if (lockFd === null) {
    const initial = collectCensus(expected, operations);
    return deferred('explicit-recovery', initial.classification, `lifecycle exclusion lock is held at ${lockPath}`);
  }
  try {
    const first = collectRecoverySnapshot(expected, operations);
    const decision = decideContinuation(first.census.classification.classification, 'explicit-recovery');
    if (first.census.classification.classification === 'absent') {
      return {
        schema: 'orchestrator-pack/worktree-lifecycle-terminal/v1',
        context: 'explicit-recovery',
        outcome: 'already_absent',
        pipelineContinues: true,
        classification: first.census.classification,
        decision,
        effects: [],
      };
    }
    if (first.census.classification.classification !== 'exact_git_only') {
      return deferred(
        'explicit-recovery',
        first.census.classification,
        `guarded Git-only recovery requires exact_git_only, got ${first.census.classification.classification}`,
      );
    }

    const fresh = collectRecoverySnapshot(expected, operations);
    const freshGatesPass = Object.values(fresh.gates).every(Boolean);
    const freshRecheck = freshGatesPass
      && recoverySnapshotFingerprint(expected, fresh) === recoverySnapshotFingerprint(expected, first);
    const gates: RecoveryGates = { ...fresh.gates, freshRecheck };
    const allPass = Object.values(gates).every(Boolean);
    if (!allPass || !apply) {
      return {
        schema: 'orchestrator-pack/worktree-lifecycle-terminal/v1',
        context: 'explicit-recovery',
        outcome: allPass ? 'git_only_recovery_eligible' : 'cleanup_deferred',
        pipelineContinues: true,
        classification: first.census.classification,
        decision,
        gates,
        effects: [],
        processes: fresh.processes,
        terminals: fresh.terminals,
        ...(!allPass ? { error: fresh.errors.join('; ') || 'one or more guarded Git-only recovery gates failed' } : {}),
      };
    }

    const beforeNonTarget = nonTargetFingerprint(expected, fresh.census);
    const removalArgs = ['-C', expected.repositoryRoot, 'worktree', 'remove', expected.path];
    const removal = runner({ command: 'git', args: removalArgs });
    const effects = [removal.ok ? 'git worktree remove (non-force)' : 'git worktree remove attempted'];
    if (!removal.ok) {
      const postFailure = collectCensus(expected, operations);
      if (postFailure.classification.classification !== 'absent') {
        return {
          schema: 'orchestrator-pack/worktree-lifecycle-terminal/v1',
          context: 'explicit-recovery',
          outcome: 'cleanup_deferred',
          pipelineContinues: true,
          classification: first.census.classification,
          decision,
          gates,
          effects,
          postClassification: postFailure.classification,
          processes: fresh.processes,
          terminals: fresh.terminals,
          error: commandError(removal, 'git', removalArgs),
        };
      }
    }

    let branchDeletion: LifecycleTerminalReport['branchDeletion'] = 'not-applicable';
    if (expected.mode === 'branch-bound' && expected.branchName) {
      let branchOwnershipStillSafe = false;
      try {
        const currentPr = readPrIdentity(expected.repositoryRoot, expected.bindingNumber, operations);
        branchOwnershipStillSafe = checkBranchOwnership(expected, currentPr, runner);
      } catch {
        branchOwnershipStillSafe = false;
      }
      if (!branchOwnershipStillSafe) {
        branchDeletion = 'refused';
      } else {
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
    }
    const post = collectCensus(expected, operations);
    const absent = post.classification.classification === 'absent';
    const unrelatedStable = nonTargetFingerprint(expected, post) === beforeNonTarget;
    return {
      schema: 'orchestrator-pack/worktree-lifecycle-terminal/v1',
      context: 'explicit-recovery',
      outcome: absent && unrelatedStable ? 'git_only_recovered' : 'task_degraded',
      pipelineContinues: true,
      classification: first.census.classification,
      decision,
      gates,
      effects,
      postClassification: post.classification,
      processes: fresh.processes,
      terminals: fresh.terminals,
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
  const census = collectCensus(expected, operations);
  if (expected.bindingKind !== 'pr') {
    return deferred(
      'post-merge-cleanup',
      census.classification,
      'post-merge cleanup requires --pr authority, not an issue-only binding',
    );
  }
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
    return deferred(
      'post-merge-cleanup',
      census.classification,
      census.errors.join('; ') || 'disputed worktree identity was preserved',
    );
  }
  const runner = operations.runner ?? defaultRunner;
  const beforeNonTarget = nonTargetFingerprint(expected, census);
  const args = [
    '--experimental-strip-types',
    join(expected.repositoryRoot, 'scripts', 'worktree-teardown.ts'),
    '--worktree',
    expected.path,
    '--pr',
    String(expected.bindingNumber),
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
  if (!apply) {
    return {
      schema: 'orchestrator-pack/worktree-lifecycle-terminal/v1',
      context: 'post-merge-cleanup',
      outcome: result.ok ? 'cleanup_eligible' : 'cleanup_deferred',
      pipelineContinues: true,
      classification: census.classification,
      decision,
      effects: [],
      standardTeardown: child,
      ...(!result.ok ? { error: 'standard teardown dry-run blocked; completed merge/adoption remains successful' } : {}),
    };
  }

  const post = collectCensus(expected, operations);
  const absent = post.classification.classification === 'absent';
  const unrelatedStable = nonTargetFingerprint(expected, post) === beforeNonTarget;
  const complete = absent && unrelatedStable;
  return {
    schema: 'orchestrator-pack/worktree-lifecycle-terminal/v1',
    context: 'post-merge-cleanup',
    outcome: complete ? 'cleanup_complete' : 'task_degraded',
    pipelineContinues: true,
    classification: census.classification,
    decision,
    effects: ['standard guarded teardown attempted'],
    postClassification: post.classification,
    standardTeardown: child,
    ...(!complete
      ? { error: result.ok
          ? 'standard teardown returned success but dual post-read-back did not prove absence with unrelated inventory unchanged'
          : `standard teardown outcome was unknown or failed and read-back remained disputed: ${commandError(result, process.execPath, args)}` }
      : {}),
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
    outcome: census.classification.classification === 'exact_dual'
      ? 'exact_dual_observed'
      : 'replacement_required',
    pipelineContinues: true,
    classification: census.classification,
    decision,
    effects: [],
    terminals: census.terminals.filter((row) => row.worktreePath === expected.path),
    ...(census.errors.length > 0 ? { error: census.errors.join('; ') } : {}),
  };
}
