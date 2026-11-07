import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  readdirSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { runProcessSync, type ProcessResult } from '../kernel/subprocess.ts';
import { resolveOrcaExecutable } from '../orca-runtime/native.ts';
import { resolveTargetContext } from '../lib/target-context.ts';
import { WRAPPER_PATH } from '../lib/gh-resolve-real-binary.mjs';
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
import {
  acquireLifecycleExclusion,
  DEFAULT_WORKTREE_LIFECYCLE_EXCLUSION_PATH,
  releaseLifecycleExclusion,
  type LifecycleExclusionHandle,
} from './exclusion.ts';
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
  readonly processCensus?: (worktreePath: string) => readonly ProcessEvidence[] | ProcessCensusResult;
}

export interface LifecycleExpectedWorktreeIdentity extends ExpectedWorktreeIdentity {
  readonly finalPrHeadSha?: string;
}

interface NormalizedLifecycleExpected extends ExpectedWorktreeIdentity {
  readonly finalPrHeadSha?: string;
}

export interface ProcessEvidence {
  readonly pid: number;
  readonly ppid: number;
  readonly starttime: string;
  readonly cwd: string | null;
  /** First readable open file descriptor target under the worktree, when that (not the cwd) made the process a holder. */
  readonly fd?: string;
  readonly cwdDenied?: boolean;
  readonly fdDenied?: boolean;
}

/** Observations the census could not make; denied reads are counted, never treated as proof of absence. */
export interface ProcessObservations {
  readonly unreadableCwd: number;
  readonly unreadableFd: number;
  readonly unreadable?: readonly ProcessEvidence[];
}

export interface ProcessCensusResult {
  readonly processes: readonly ProcessEvidence[];
  readonly observations: ProcessObservations;
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
  | 'quiesced_cleanup_deferred'
  | 'unsupported_runtime_preflight'
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
  readonly processObservations?: ProcessObservations;
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
  readonly processObservations: ProcessObservations;
  readonly terminals: readonly TerminalEvidence[];
  readonly errors: readonly string[];
}

function normalizeLifecycleExpected(input: LifecycleExpectedWorktreeIdentity): NormalizedLifecycleExpected {
  const base = normalizeExpectedIdentity(input);
  const finalPrHeadSha = input.finalPrHeadSha
    ? normalizeHeadSha(input.finalPrHeadSha)
    : undefined;
  return {
    ...base,
    ...(finalPrHeadSha ? { finalPrHeadSha } : {}),
  };
}

function authorizedHeads(expected: LifecycleExpectedWorktreeIdentity): readonly string[] {
  return [...new Set([
    normalizeHeadSha(expected.headSha),
    ...(expected.finalPrHeadSha ? [normalizeHeadSha(expected.finalPrHeadSha)] : []),
  ])];
}

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
  const merged: OrcaAgentInventoryRow[] = worktrees.map((worktree) => {
    const matches = agentRows.filter((row) => row.id === worktree.id && row.path === worktree.path);
    const agent = matches.length === 1 ? matches[0] : undefined;
    const malformedFields = new Set(worktree.malformedFields);
    if (matches.length !== 1) malformedFields.add('agents.census');
    for (const field of agent?.malformedFields ?? []) malformedFields.add(field);
    return {
      ...worktree,
      agents: agent?.agents,
      malformedFields: [...malformedFields].sort(),
    };
  });
  for (const row of agentRows) {
    if (!worktrees.some((worktree) => worktree.id === row.id && worktree.path === row.path)) merged.push(row);
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
    if (typeof row.handle !== 'string' || !row.handle.trim()) {
      throw new TypeError(`Orca terminal row ${index} omitted handle`);
    }
    return {
      handle: row.handle.trim(),
      worktreePath: normalizeWorktreePath(row.worktreePath),
      ...(typeof row.tabId === 'string' && row.tabId.trim() ? { tabId: row.tabId.trim() } : {}),
    };
  });
}

/** Filesystem reads the census uses; injectable so denied reads can be exercised without root. */
export interface ProcIo {
  readonly readdirSync: (path: string) => string[];
  readonly readFileSync: (path: string, encoding: 'utf8') => string;
  readonly readlinkSync: (path: string) => string;
}

const defaultProcIo: ProcIo = {
  readdirSync: (path) => readdirSync(path),
  readFileSync: (path, encoding) => readFileSync(path, encoding),
  readlinkSync: (path) => readlinkSync(path),
};

function isGone(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
    || (error as NodeJS.ErrnoException).code === 'ESRCH';
}

function isDenied(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'EACCES'
    || (error as NodeJS.ErrnoException).code === 'EPERM';
}

function underTarget(path: string | null, target: string): boolean {
  return path !== null && (path === target || path.startsWith(`${target}/`));
}

/** First readable fd target; denied reads are diagnostic, vanished processes return null. */
function readFdHolder(
  name: string,
  target: string,
  denied: { fdDenied: boolean },
  io: ProcIo,
): string | null | undefined {
  let entries: string[];
  try {
    entries = io.readdirSync(`/proc/${name}/fd`);
  } catch (error) {
    if (isDenied(error)) denied.fdDenied = true;
    else if (isGone(error)) return null;
    else {
      throw new TypeError(`process census could not read /proc/${name}/fd: ${error instanceof Error ? error.message : String(error)}`);
    }
    return undefined;
  }
  for (const entry of entries) {
    let link: string;
    try {
      link = normalizeWorktreePath(io.readlinkSync(`/proc/${name}/fd/${entry}`).replace(/ \(deleted\)$/, ''));
    } catch (error) {
      if (isDenied(error)) denied.fdDenied = true;
      else if (!isGone(error)) {
        throw new TypeError(`process census could not read /proc/${name}/fd/${entry}: ${error instanceof Error ? error.message : String(error)}`);
      }
      continue;
    }
    if (underTarget(link, target)) return link;
  }
  return undefined;
}

function readProcessSnapshot(
  name: string,
  target: string | undefined,
  io: ProcIo,
): ProcessEvidence | null {
  const pid = Number.parseInt(name, 10);
  if (!Number.isInteger(pid) || pid <= 1) return null;
  let stat: string;
  try {
    stat = io.readFileSync(`/proc/${name}/stat`, 'utf8');
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
  let cwdDenied = false;
  try {
    cwd = normalizeWorktreePath(io.readlinkSync(`/proc/${name}/cwd`).replace(/ \(deleted\)$/, ''));
  } catch (error) {
    if (isDenied(error)) cwdDenied = true;
    else if (isGone(error)) return null;
    else {
      throw new TypeError(`process census could not read /proc/${name}/cwd: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const denied = { fdDenied: false };
  const fd = target && !underTarget(cwd, target) ? readFdHolder(name, target, denied, io) : undefined;
  if (fd === null) return null;
  return {
    pid, ppid, starttime, cwd,
    ...(fd ? { fd } : {}),
    ...(cwdDenied ? { cwdDenied } : {}),
    ...(denied.fdDenied ? { fdDenied: true } : {}),
  };
}

/** Shared by lifecycle recovery and teardown: kernel denials are diagnostic, readable holders remain authoritative. */
export function collectProcessSnapshots(worktreePath?: string, io: ProcIo = defaultProcIo): ProcessEvidence[] {
  const target = worktreePath === undefined ? undefined : normalizeWorktreePath(worktreePath);
  let names: string[];
  try {
    names = io.readdirSync('/proc').filter((name) => /^\d+$/.test(name));
  } catch (error) {
    throw new TypeError(`process census could not enumerate /proc: ${error instanceof Error ? error.message : String(error)}`);
  }
  return names
    .map((name) => readProcessSnapshot(name, target, io))
    .filter((row): row is ProcessEvidence => row !== null);
}

export function collectProcessCensus(worktreePath: string, io: ProcIo = defaultProcIo): ProcessCensusResult {
  const target = normalizeWorktreePath(worktreePath);
  const snapshots = collectProcessSnapshots(target, io);
  const selected = new Set(
    snapshots
      .filter((row) => underTarget(row.cwd, target) || row.fd !== undefined)
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
  return {
    processes: snapshots
      .filter((row) => selected.has(row.pid))
      .sort((left, right) => left.pid - right.pid),
    observations: {
      unreadableCwd: snapshots.filter((row) => row.cwdDenied).length,
      unreadableFd: snapshots.filter((row) => row.fdDenied).length,
      unreadable: snapshots.filter((row) => row.cwdDenied || row.fdDenied),
    },
  };
}

export function collectProcessEvidence(worktreePath: string): ProcessEvidence[] {
  return [...collectProcessCensus(worktreePath).processes];
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

function selectAuthorizedClassification(
  expected: NormalizedLifecycleExpected,
  evidence: CensusEvidence,
): WorktreeClassificationReport {
  const reports = authorizedHeads(expected).map((headSha) => classifyWorktree({
    expected: { ...expected, headSha },
    evidence,
  }));
  return reports.find((report) => report.classification === 'exact_dual')
    ?? reports.find((report) => report.classification === 'exact_git_only')
    ?? reports.find((report) => report.classification === 'absent')
    ?? reports[0]!;
}

export function collectCensus(
  expectedInput: LifecycleExpectedWorktreeIdentity,
  operations: LifecycleOperations = {},
): {
  classification: WorktreeClassificationReport;
  agentRows: readonly OrcaAgentInventoryRow[];
  terminals: readonly TerminalEvidence[];
  errors: readonly string[];
} {
  const baseExpected = normalizeLifecycleExpected(expectedInput);
  const runner = operations.runner ?? defaultRunner;
  const orcaExecutable = operations.orcaExecutable ?? resolveOrcaExecutable();
  const errors: string[] = [];

  let gitRows: GitWorktreeRow[] = [];
  let gitStatus: CensusEvidence['git']['status'] = 'ok';
  const gitInventory = runner({
    command: 'git',
    args: ['-C', baseExpected.repositoryRoot, 'worktree', 'list', '--porcelain'],
  });
  if (!gitInventory.ok) {
    gitStatus = 'unavailable';
    errors.push(commandError(gitInventory, 'git', ['worktree', 'list', '--porcelain']));
  } else {
    try {
      gitRows = parseGitWorktreePorcelain(gitInventory.stdout);
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
  const expected: NormalizedLifecycleExpected = {
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
    classification: selectAuthorizedClassification(expected, evidence),
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
  const gh = WRAPPER_PATH;
  const args = [
    'pr',
    'view',
    String(prNumber),
    '--json',
    'headRefName,state,headRefOid,mergeCommit,headRepository,baseRefName',
  ];
  const result = runner({ command: gh, args, cwd: normalizeWorktreePath(repositoryRoot) });
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
    state: row.state.trim().toUpperCase(),
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

function selectedLifecycleDefaultBranch(): string {
  if (process.env.VITEST && !String(process.env.OPK_PROJECT_ID ?? '').trim()) return 'main';
  return resolveTargetContext({ env: process.env }).defaultBranch;
}

function checkMerged(
  expected: NormalizedLifecycleExpected,
  pr: PrIdentity,
  runner: CommandRunner,
): boolean {
  const defaultBranch = selectedLifecycleDefaultBranch();
  // Explicit recovery retains the original conservative ordinary-merge proof.
  // Post-merge H0/H1 cleanup must not require H0 to be an ancestor of current main.
  if (!expected.finalPrHeadSha) {
    const ordinary = gitResult(runner, [
      '-C',
      expected.path,
      'merge-base',
      '--is-ancestor',
      'HEAD',
      `origin/${defaultBranch}`,
    ]);
    if (ordinary.ok && ordinary.exitCode === 0) return true;
  }

  const finalHead = expected.finalPrHeadSha ?? expected.headSha;
  if (
    pr.state !== 'MERGED'
    || pr.headRefOid !== finalHead
    || !pr.mergeCommitOid
    || (pr.baseRefName !== undefined && pr.baseRefName !== defaultBranch)
  ) {
    return false;
  }
  const fetched = gitResult(runner, ['-C', expected.repositoryRoot, 'fetch', 'origin', defaultBranch]);
  if (!fetched.ok) return false;
  const adopted = gitResult(runner, [
    '-C',
    expected.repositoryRoot,
    'merge-base',
    '--is-ancestor',
    pr.mergeCommitOid,
    `origin/${defaultBranch}`,
  ]);
  return adopted.ok && adopted.exitCode === 0;
}

function checkBranchOwnership(
  expected: ExpectedWorktreeIdentity,
  pr: PrIdentity,
  runner: CommandRunner,
): boolean {
  if (expected.mode === 'detached-confirmed') return true;
  if (!pr.headRepository || !expected.branchName) return false;
  const gh = WRAPPER_PATH;
  const args = [
    'pr',
    'list',
    '--state',
    'open',
    '--json',
    'number,headRefName,headRepository',
  ];
  const result = runner({ command: gh, args, cwd: normalizeWorktreePath(expected.repositoryRoot) });
  if (!result.ok) return false;
  try {
    const rows = JSON.parse(result.stdout) as Array<{ number?: number; headRefName?: string }>;
    // Use readPrIdentity's base-repository context. The merged PR's
    // headRepository may be a fork, whose PR list omits PRs into this base.
    // Without a local remote binding, any same-named open PR is an ownership
    // ambiguity (even from another head repository), never deletion authority.
    return rows.filter(
      (row) => normalizeBranchName(row.headRefName) === expected.branchName
        && row.number !== expected.bindingNumber,
    ).length === 0;
  } catch {
    return false;
  }
}

function relevantInventoryFingerprint(
  expected: NormalizedLifecycleExpected,
  census: ReturnType<typeof collectCensus>,
): string {
  const repositoryId = census.classification.expected.repositoryId ?? expected.repositoryId;
  const heads = new Set(authorizedHeads(expected));
  const matches = (row: {
    path: string;
    headSha?: string;
    branchName?: string;
    linkedIssue?: number | null;
    linkedPR?: number | null;
  }) => row.path === expected.path
    || Boolean(row.headSha && heads.has(row.headSha))
    || row.branchName === expected.branchName
    || (expected.bindingKind === 'issue' && row.linkedIssue === expected.bindingNumber)
    || (expected.bindingKind === 'pr' && row.linkedPR === expected.bindingNumber);
  const git = census.classification.evidence.git.rows.filter(
    (row) => row.path === expected.path
      || heads.has(row.headSha)
      || row.branchName === expected.branchName,
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

/** Stable identities only: ordinary sibling activity and additions are not cleanup damage. */
export function unrelatedWorktreeIdentities(
  git: readonly { readonly path: string }[],
  orca: readonly { readonly id?: string; readonly path?: string }[],
  target: string,
): ReadonlyMap<string, string> {
  const identities = new Map<string, string>();
  for (const row of git) {
    const path = normalizeWorktreePath(row.path);
    if (path !== target) identities.set(JSON.stringify(['git', path]), path);
  }
  for (const row of orca) {
    const path = row.path === undefined ? undefined : normalizeWorktreePath(row.path);
    if (path !== target) identities.set(JSON.stringify(['orca', row.id, path]), path ?? row.id ?? '<unknown>');
  }
  return identities;
}

export function missingWorktreePaths(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): string[] {
  return [...new Set([...before].filter(([identity]) => !after.has(identity)).map(([, path]) => path))].sort();
}

function nonTargetIdentities(expected: ExpectedWorktreeIdentity, census: ReturnType<typeof collectCensus>): ReadonlyMap<string, string> {
  const repositoryId = census.classification.expected.repositoryId ?? expected.repositoryId;
  return unrelatedWorktreeIdentities(
    census.classification.evidence.git.rows,
    census.classification.evidence.orca.rows.filter((row) => row.repoId === repositoryId),
    expected.path,
  );
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
  expected: NormalizedLifecycleExpected,
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
  let processObservations: ProcessObservations = { unreadableCwd: 0, unreadableFd: 0 };
  let processCensusOk = true;
  try {
    const censusResult = (operations.processCensus ?? collectProcessCensus)(expected.path);
    if (Array.isArray(censusResult)) {
      processes = censusResult;
    } else {
      const result = censusResult as ProcessCensusResult;
      processes = result.processes;
      processObservations = result.observations;
    }
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
    processObservations,
    terminals,
    errors,
  };
}

function recoverySnapshotFingerprint(snapshot: RecoverySnapshot): string {
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
  expectedInput: LifecycleExpectedWorktreeIdentity,
  apply: boolean,
  operations: LifecycleOperations,
  heldExclusion?: LifecycleExclusionHandle,
): LifecycleTerminalReport {
  const expected = normalizeLifecycleExpected(expectedInput);
  if (expected.finalPrHeadSha && expected.finalPrHeadSha !== expected.headSha) {
    const initial = collectCensus(expected, operations);
    return deferred(
      'explicit-recovery',
      initial.classification,
      'explicit recovery accepts one exact expected head and cannot consume post-merge H0/H1 authority',
    );
  }
  if (expected.bindingKind !== 'pr') {
    const initial = collectCensus(expected, operations);
    return deferred(
      'explicit-recovery',
      initial.classification,
      'destructive recovery requires a PR-bound identity; issue-bound post-create state must use replacement flow',
    );
  }
  const runner = operations.runner ?? defaultRunner;
  const lockPath = operations.lockPath ?? DEFAULT_WORKTREE_LIFECYCLE_EXCLUSION_PATH;
  const lock = heldExclusion ?? acquireLifecycleExclusion(lockPath);
  if (!lock) {
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
      && recoverySnapshotFingerprint(fresh) === recoverySnapshotFingerprint(first);
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
        processObservations: fresh.processObservations,
        terminals: fresh.terminals,
        ...(!allPass ? { error: fresh.errors.join('; ') || 'one or more guarded Git-only recovery gates failed' } : {}),
      };
    }

    const beforeNonTarget = nonTargetIdentities(expected, fresh.census);
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
          processObservations: fresh.processObservations,
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
    const missing = missingWorktreePaths(beforeNonTarget, nonTargetIdentities(expected, post));
    const unrelatedStable = missing.length === 0;
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
      processObservations: fresh.processObservations,
      terminals: fresh.terminals,
      branchDeletion,
      ...(!absent || !unrelatedStable
        ? { error: `post-effect read-back: ${!absent ? 'selected target still present; ' : ''}missing pre-existing unrelated worktrees: ${missing.join(', ') || 'none'}` }
        : {}),
    };
  } finally {
    if (!heldExclusion) releaseLifecycleExclusion(lockPath, lock);
  }
}

function childOutcome(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const outcome = (value as Record<string, unknown>).outcome;
  return typeof outcome === 'string' ? outcome : null;
}

function standardTeardown(
  expectedInput: LifecycleExpectedWorktreeIdentity,
  apply: boolean,
  operations: LifecycleOperations,
): LifecycleTerminalReport {
  const expected = normalizeLifecycleExpected(expectedInput);
  const initial = collectCensus(expected, operations);
  if (expected.bindingKind !== 'pr') {
    return deferred(
      'post-merge-cleanup',
      initial.classification,
      'post-merge cleanup requires --pr authority, not an issue-only binding',
    );
  }
  if (!expected.finalPrHeadSha) {
    return deferred(
      'post-merge-cleanup',
      initial.classification,
      'post-merge cleanup requires a live-bound final PR head',
    );
  }
  const lockPath = operations.lockPath ?? DEFAULT_WORKTREE_LIFECYCLE_EXCLUSION_PATH;
  const lock = acquireLifecycleExclusion(lockPath);
  if (!lock) {
    return deferred('post-merge-cleanup', initial.classification, `lifecycle exclusion lock is held at ${lockPath}`);
  }
  try {
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
    if (
      census.classification.classification !== 'exact_dual'
      && census.classification.classification !== 'exact_git_only'
    ) {
      return deferred(
        'post-merge-cleanup',
        census.classification,
        census.errors.join('; ') || 'disputed worktree identity was preserved',
      );
    }

    const runner = operations.runner ?? defaultRunner;
    const beforeNonTarget = nonTargetIdentities(expected, census);
    const args = [
      '--experimental-strip-types',
      join(dirname(WRAPPER_PATH), 'worktree-teardown.ts'),
      '--post-merge-destructive',
      '--repo-root',
      expected.repositoryRoot,
      '--worktree',
      expected.path,
      '--pr',
      String(expected.bindingNumber),
      '--expected-head',
      expected.headSha,
      '--final-pr-head',
      expected.finalPrHeadSha,
      '--classification',
      census.classification.classification,
      ...(expected.mode === 'branch-bound'
        ? ['--expected-branch', expected.branchName!]
        : ['--detached']),
      '--json',
      '--lifecycle-lock-path',
      lockPath,
      '--lifecycle-lock-token',
      lock.token,
      ...(apply ? ['--apply'] : []),
    ];
    const result = runner({ command: process.execPath, args, cwd: expected.repositoryRoot });
    let child: unknown;
    try {
      child = JSON.parse(result.stdout) as unknown;
    } catch {
      child = { raw_stdout: result.stdout.trim(), raw_stderr: result.stderr.trim() };
    }
    const childStatus = childOutcome(child);

    if (!apply) {
      const outcome: LifecycleOutcome = childStatus === 'cleanup_eligible'
        ? 'cleanup_eligible'
        : childStatus === 'unsupported_runtime_preflight'
          ? 'unsupported_runtime_preflight'
          : childStatus === 'task_degraded'
            ? 'task_degraded'
            : 'cleanup_deferred';
      return {
        schema: 'orchestrator-pack/worktree-lifecycle-terminal/v1',
        context: 'post-merge-cleanup',
        outcome,
        pipelineContinues: true,
        classification: census.classification,
        decision,
        effects: [],
        standardTeardown: child,
        ...(outcome !== 'cleanup_eligible'
          ? { error: `post-merge teardown dry-run returned ${childStatus ?? 'an unreadable outcome'}` }
          : {}),
      };
    }

    const post = collectCensus(expected, operations);
    const absent = post.classification.classification === 'absent';
    const missing = missingWorktreePaths(beforeNonTarget, nonTargetIdentities(expected, post));
    const unrelatedStable = missing.length === 0;
    if (absent && unrelatedStable) {
      return {
        schema: 'orchestrator-pack/worktree-lifecycle-terminal/v1',
        context: 'post-merge-cleanup',
        outcome: 'cleanup_complete',
        pipelineContinues: true,
        classification: census.classification,
        decision,
        effects: ['exact post-merge destructive teardown attempted'],
        postClassification: post.classification,
        standardTeardown: child,
      };
    }

    const boundedOutcome: LifecycleOutcome = childStatus === 'quiesced_cleanup_deferred'
      ? 'quiesced_cleanup_deferred'
      : childStatus === 'unsupported_runtime_preflight'
        ? 'unsupported_runtime_preflight'
        : 'task_degraded';
    return {
      schema: 'orchestrator-pack/worktree-lifecycle-terminal/v1',
      context: 'post-merge-cleanup',
      outcome: boundedOutcome,
      pipelineContinues: true,
      classification: census.classification,
      decision,
      effects: childStatus === 'unsupported_runtime_preflight'
        ? []
        : ['exact post-merge destructive teardown attempted'],
      postClassification: post.classification,
      standardTeardown: child,
      error: (result.ok
        ? `post-merge teardown ended ${childStatus ?? 'without a readable outcome'} and dual read-back did not prove exact absence with pre-existing unrelated worktrees retained`
        : `post-merge teardown outcome was unknown or failed and read-back remained disputed: ${commandError(result, process.execPath, args)}`)
        + (missing.length > 0 ? `; missing pre-existing unrelated worktrees: ${missing.join(', ')}` : ''),
    };
  } finally {
    releaseLifecycleExclusion(lockPath, lock);
  }
}

export function runLifecycle(input: {
  readonly expected: LifecycleExpectedWorktreeIdentity;
  readonly context: LifecycleContext;
  readonly apply: boolean;
  readonly operations?: LifecycleOperations;
}): LifecycleTerminalReport {
  const expected = normalizeLifecycleExpected(input.expected);
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
