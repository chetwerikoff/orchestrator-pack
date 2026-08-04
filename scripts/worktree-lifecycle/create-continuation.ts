#!/usr/bin/env node

import '../toolchain/native-entrypoint-preflight.ts';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runProcessSync, type ProcessResult } from '../kernel/subprocess.ts';
import { resolveOrcaExecutable } from '../orca-runtime/native.ts';
import {
  normalizeHeadSha,
  normalizeWorktreePath,
  type ExpectedWorktreeIdentity,
  type GitWorktreeRow,
  type OrcaWorktreeRow,
} from './core.ts';
import {
  collectCensus,
  runLifecycle,
  type CommandInvocation,
  type CommandRunner,
  type LifecycleOperations,
  type LifecycleTerminalReport,
  type TerminalEvidence,
} from './operations.ts';

export const WORKTREE_LIFECYCLE_EXCLUSION_PATH = resolve(
  '/tmp',
  `${['opk', 'worktree', 'teardown'].join('-')}.lock`,
);

export interface CreateContinuationOperations {
  readonly runner?: CommandRunner;
  readonly orcaExecutable?: string;
  readonly lockPath?: string;
}

export interface InventorySnapshot {
  readonly ok: boolean;
  readonly repositoryId: string;
  readonly gitRows: readonly GitWorktreeRow[];
  readonly orcaRows: readonly OrcaWorktreeRow[];
  readonly terminals: readonly TerminalEvidence[];
  readonly errors: readonly string[];
}

interface CommandSummary {
  readonly outcome: ProcessResult['outcome'];
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly acknowledged: boolean;
  readonly error?: string;
}

export interface CreateAttemptReport {
  readonly kind: 'initial' | 'replacement';
  readonly name: string;
  readonly command: CommandSummary;
  readonly newGitPaths: readonly string[];
  readonly newOrcaPaths: readonly string[];
  readonly candidateReports: readonly LifecycleTerminalReport[];
  readonly inventoryErrors: readonly string[];
}

export interface TerminalSpawnReport {
  readonly command: CommandSummary;
  readonly beforeHandles: readonly string[];
  readonly afterHandles: readonly string[];
  readonly readBacks: readonly LifecycleTerminalReport[];
}

export interface WorktreeCreateContinuationReport {
  readonly schema: 'orchestrator-pack/worktree-create-continuation/v2';
  readonly outcome: 'worker_spawned' | 'task_degraded';
  readonly pipelineContinues: true;
  readonly terminalSpawnCompleted: boolean;
  readonly terminalSpawnAuthorized: false;
  readonly issueNumber: number;
  readonly expectedHead: string;
  readonly resumedExisting: boolean;
  readonly selected?: ExpectedWorktreeIdentity;
  readonly selectedReadBack?: LifecycleTerminalReport;
  readonly terminal?: TerminalEvidence;
  readonly attempts: readonly CreateAttemptReport[];
  readonly terminalSpawn?: TerminalSpawnReport;
  readonly effects: readonly string[];
  readonly error?: string;
}

interface LockHandle {
  readonly fd: number;
  readonly token: string;
}

interface SelectedCandidate {
  readonly expected: ExpectedWorktreeIdentity;
  readonly report: LifecycleTerminalReport;
}

interface AttemptResult {
  readonly report: CreateAttemptReport;
  readonly snapshot: InventorySnapshot;
  readonly selected?: SelectedCandidate;
}

function defaultRunner(invocation: CommandInvocation): ProcessResult {
  return runProcessSync({
    command: invocation.command,
    args: invocation.args,
    cwd: invocation.cwd,
    timeoutMs: invocation.timeoutMs,
    inheritParentEnv: true,
  });
}

function invocationError(result: ProcessResult, invocation: CommandInvocation): string {
  const fallback = `${invocation.command} ${invocation.args.join(' ')} exited ${String(result.exitCode)}`;
  return result.stderr.trim() || result.error || fallback;
}

function summarizeCommand(result: ProcessResult, invocation: CommandInvocation): CommandSummary {
  return {
    outcome: result.outcome,
    ok: result.ok,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    acknowledged: responseAcknowledged(result),
    ...(!result.ok ? { error: invocationError(result, invocation) } : {}),
  };
}

function processStarttime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
  } catch {
    return null;
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function decodeLock(raw: string): { pid: number; starttime: string | null; token: string | null } | null {
  const [pidText, starttimeText, tokenText] = raw.trim().split(/\r?\n/);
  const pid = Number.parseInt(pidText ?? '', 10);
  if (!Number.isInteger(pid) || pid <= 1) return null;
  return { pid, starttime: starttimeText?.trim() || null, token: tokenText?.trim() || null };
}

function lockOwnerAlive(record: ReturnType<typeof decodeLock>): boolean {
  if (!record || !processExists(record.pid)) return false;
  const observed = processStarttime(record.pid);
  return !record.starttime || observed === null || observed === record.starttime;
}

function acquireLifecycleLock(path: string): LockHandle | null {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      const token = randomUUID();
      writeFileSync(fd, `${String(process.pid)}\n${processStarttime(process.pid) ?? ''}\n${token}\n`, 'utf8');
      fsyncSync(fd);
      return { fd, token };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return null;
      let firstRead: string;
      try {
        firstRead = readFileSync(path, 'utf8');
      } catch {
        return null;
      }
      const record = decodeLock(firstRead);
      if (!record || lockOwnerAlive(record)) return null;
      try {
        if (readFileSync(path, 'utf8') !== firstRead) return null;
        unlinkSync(path);
      } catch {
        return null;
      }
    }
  }
  return null;
}

function releaseLifecycleLock(path: string, handle: LockHandle): void {
  try {
    closeSync(handle.fd);
  } catch {
    // Token ownership still guards unlink below.
  }
  try {
    if (decodeLock(readFileSync(path, 'utf8'))?.token === handle.token) unlinkSync(path);
  } catch {
    // Missing-at-release or changed ownership is fail-closed and harmless.
  }
}

function lifecycleOperations(operations: CreateContinuationOperations): LifecycleOperations {
  return {
    ...(operations.runner ? { runner: operations.runner } : {}),
    ...(operations.orcaExecutable ? { orcaExecutable: operations.orcaExecutable } : {}),
    ...(operations.lockPath ? { lockPath: operations.lockPath } : {}),
  };
}

function canonicalNames(issueNumber: number): { primary: string; replacement: string } {
  return {
    primary: `issue-${String(issueNumber)}`,
    replacement: `issue-${String(issueNumber)}-replacement`,
  };
}

function collectInventory(input: {
  repositoryRoot: string;
  issueNumber: number;
  expectedHead: string;
  probeName: string;
  operations: CreateContinuationOperations;
}): InventorySnapshot {
  const probe: ExpectedWorktreeIdentity = {
    repositoryRoot: input.repositoryRoot,
    path: join(input.repositoryRoot, '.opk-worktree-lifecycle-probe', input.probeName),
    headSha: input.expectedHead,
    mode: 'branch-bound',
    branchName: input.probeName,
    bindingKind: 'issue',
    bindingNumber: input.issueNumber,
  };
  const census = collectCensus(probe, lifecycleOperations(input.operations));
  const evidence = census.classification.evidence;
  const repositoryId = census.classification.expected.repositoryId ?? '';
  const errors = [...census.errors];
  if (evidence.git.status !== 'ok' && !errors.some((item) => item.toLowerCase().includes('git'))) {
    errors.push(evidence.git.error ?? 'git inventory unavailable');
  }
  if (evidence.orca.status !== 'ok' && !errors.some((item) => item.toLowerCase().includes('orca'))) {
    errors.push(evidence.orca.error ?? 'Orca inventory unavailable');
  }
  return {
    ok: Boolean(repositoryId)
      && evidence.git.status === 'ok'
      && evidence.orca.status === 'ok'
      && errors.length === 0,
    repositoryId,
    gitRows: evidence.git.rows,
    orcaRows: evidence.orca.rows,
    terminals: census.terminals,
    errors,
  };
}

function expectedFromRow(
  row: GitWorktreeRow,
  repositoryRoot: string,
  issueNumber: number,
): ExpectedWorktreeIdentity | null {
  if (row.prunable) return null;
  if (row.detached && !row.branchName) {
    return {
      repositoryRoot,
      path: row.path,
      headSha: row.headSha,
      mode: 'detached-confirmed',
      bindingKind: 'issue',
      bindingNumber: issueNumber,
    };
  }
  if (!row.detached && row.branchName) {
    return {
      repositoryRoot,
      path: row.path,
      headSha: row.headSha,
      mode: 'branch-bound',
      branchName: row.branchName,
      bindingKind: 'issue',
      bindingNumber: issueNumber,
    };
  }
  return null;
}

function targetTerminals(report: LifecycleTerminalReport): TerminalEvidence[] {
  return [...(report.terminals ?? [])];
}

function evaluateCandidates(input: {
  rows: readonly GitWorktreeRow[];
  repositoryRoot: string;
  issueNumber: number;
  expectedHead: string;
  operations: CreateContinuationOperations;
}): { reports: LifecycleTerminalReport[]; selected?: SelectedCandidate } {
  const reports: LifecycleTerminalReport[] = [];
  const ready: SelectedCandidate[] = [];
  for (const row of input.rows) {
    if (row.path === input.repositoryRoot || row.headSha !== input.expectedHead) continue;
    const expected = expectedFromRow(row, input.repositoryRoot, input.issueNumber);
    if (!expected) continue;
    const first = runLifecycle({
      expected,
      context: 'post-create',
      apply: false,
      operations: lifecycleOperations(input.operations),
    });
    reports.push(first);
    if (first.outcome !== 'exact_dual_observed'
      || first.classification.classification !== 'exact_dual'
      || targetTerminals(first).length !== 0) continue;
    const fresh = runLifecycle({
      expected: first.classification.expected,
      context: 'post-create',
      apply: false,
      operations: lifecycleOperations(input.operations),
    });
    reports.push(fresh);
    if (fresh.outcome === 'exact_dual_observed'
      && fresh.classification.classification === 'exact_dual'
      && targetTerminals(fresh).length === 0) {
      ready.push({ expected: fresh.classification.expected, report: fresh });
    }
  }
  return ready.length === 1 ? { reports, selected: ready[0] } : { reports };
}

function responseAcknowledged(result: ProcessResult): boolean {
  try {
    const parsed = JSON.parse(result.stdout.trim()) as { ok?: unknown };
    return parsed.ok === true;
  } catch {
    return false;
  }
}

function createInvocation(input: {
  repositoryRoot: string;
  issueNumber: number;
  expectedHead: string;
  name: string;
  orcaExecutable: string;
}): CommandInvocation {
  return {
    command: input.orcaExecutable,
    args: [
      'worktree', 'create',
      '--name', input.name,
      '--repo', `path:${input.repositoryRoot}`,
      '--base-branch', input.expectedHead,
      '--issue', String(input.issueNumber),
      '--setup', 'skip',
      '--activate',
      '--json',
    ],
    cwd: input.repositoryRoot,
  };
}

function terminalInvocation(input: {
  candidate: SelectedCandidate;
  title: string;
  command: string;
  focus: boolean;
  orcaExecutable: string;
}): CommandInvocation {
  return {
    command: input.orcaExecutable,
    args: [
      'terminal', 'create',
      '--worktree', `path:${input.candidate.expected.path}`,
      '--title', input.title,
      '--command', input.command,
      ...(input.focus ? ['--focus'] : []),
      '--json',
    ],
    cwd: input.candidate.expected.repositoryRoot,
  };
}

function runCreateAttempt(input: {
  kind: 'initial' | 'replacement';
  name: string;
  repositoryRoot: string;
  issueNumber: number;
  expectedHead: string;
  before: InventorySnapshot;
  operations: CreateContinuationOperations;
}): AttemptResult {
  const runner = input.operations.runner ?? defaultRunner;
  const invocation = createInvocation({
    repositoryRoot: input.repositoryRoot,
    issueNumber: input.issueNumber,
    expectedHead: input.expectedHead,
    name: input.name,
    orcaExecutable: input.operations.orcaExecutable ?? resolveOrcaExecutable(),
  });
  const command = runner(invocation);
  const snapshot = collectInventory({
    repositoryRoot: input.repositoryRoot,
    issueNumber: input.issueNumber,
    expectedHead: input.expectedHead,
    probeName: input.name,
    operations: input.operations,
  });
  const oldGitPaths = new Set(input.before.gitRows.map((row) => row.path));
  const oldOrcaPaths = new Set(input.before.orcaRows.map((row) => row.path));
  const newGitRows = snapshot.gitRows.filter((row) => !oldGitPaths.has(row.path));
  const newOrcaRows = snapshot.orcaRows.filter((row) => !oldOrcaPaths.has(row.path));
  const evaluated = snapshot.ok
    ? evaluateCandidates({
        rows: newGitRows,
        repositoryRoot: input.repositoryRoot,
        issueNumber: input.issueNumber,
        expectedHead: input.expectedHead,
        operations: input.operations,
      })
    : { reports: [] as LifecycleTerminalReport[] };
  return {
    report: {
      kind: input.kind,
      name: input.name,
      command: summarizeCommand(command, invocation),
      newGitPaths: newGitRows.map((row) => row.path).sort(),
      newOrcaPaths: newOrcaRows.map((row) => row.path).sort(),
      candidateReports: evaluated.reports,
      inventoryErrors: snapshot.errors,
    },
    snapshot,
    ...(evaluated.selected ? { selected: evaluated.selected } : {}),
  };
}

function terminalHandles(report: LifecycleTerminalReport): string[] {
  return targetTerminals(report)
    .map((row) => row.handle)
    .filter((handle): handle is string => Boolean(handle))
    .sort();
}

function runTerminalSpawn(input: {
  candidate: SelectedCandidate;
  title: string;
  command: string;
  focus: boolean;
  operations: CreateContinuationOperations;
}): { report: TerminalSpawnReport; selectedReadBack: LifecycleTerminalReport; terminal?: TerminalEvidence } {
  const runner = input.operations.runner ?? defaultRunner;
  const beforeHandles = terminalHandles(input.candidate.report);
  const invocation = terminalInvocation({
    candidate: input.candidate,
    title: input.title,
    command: input.command,
    focus: input.focus,
    orcaExecutable: input.operations.orcaExecutable ?? resolveOrcaExecutable(),
  });
  const command = runner(invocation);
  const first = runLifecycle({
    expected: input.candidate.expected,
    context: 'post-create',
    apply: false,
    operations: lifecycleOperations(input.operations),
  });
  const fresh = runLifecycle({
    expected: first.classification.expected,
    context: 'post-create',
    apply: false,
    operations: lifecycleOperations(input.operations),
  });
  const afterHandles = terminalHandles(fresh);
  const newHandles = afterHandles.filter((handle) => !beforeHandles.includes(handle));
  const firstHandles = terminalHandles(first);
  const terminal = newHandles.length === 1
    ? targetTerminals(fresh).find((row) => row.handle === newHandles[0])
    : undefined;
  const proven = first.outcome === 'exact_dual_observed'
    && fresh.outcome === 'exact_dual_observed'
    && first.classification.classification === 'exact_dual'
    && fresh.classification.classification === 'exact_dual'
    && newHandles.length === 1
    && firstHandles.length === beforeHandles.length + 1
    && firstHandles[0] === afterHandles[0]
    && Boolean(terminal);
  return {
    report: {
      command: summarizeCommand(command, invocation),
      beforeHandles,
      afterHandles,
      readBacks: [first, fresh],
    },
    selectedReadBack: fresh,
    ...(proven && terminal ? { terminal } : {}),
  };
}

function spawned(input: {
  issueNumber: number;
  expectedHead: string;
  resumedExisting: boolean;
  selected: SelectedCandidate;
  selectedReadBack: LifecycleTerminalReport;
  terminal: TerminalEvidence;
  attempts: readonly CreateAttemptReport[];
  terminalSpawn: TerminalSpawnReport;
  effects: readonly string[];
}): WorktreeCreateContinuationReport {
  return {
    schema: 'orchestrator-pack/worktree-create-continuation/v2',
    outcome: 'worker_spawned',
    pipelineContinues: true,
    terminalSpawnCompleted: true,
    terminalSpawnAuthorized: false,
    issueNumber: input.issueNumber,
    expectedHead: input.expectedHead,
    resumedExisting: input.resumedExisting,
    selected: input.selected.expected,
    selectedReadBack: input.selectedReadBack,
    terminal: input.terminal,
    attempts: input.attempts,
    terminalSpawn: input.terminalSpawn,
    effects: input.effects,
  };
}

function degraded(input: {
  issueNumber: number;
  expectedHead: string;
  resumedExisting?: boolean;
  selected?: ExpectedWorktreeIdentity;
  selectedReadBack?: LifecycleTerminalReport;
  attempts?: readonly CreateAttemptReport[];
  terminalSpawn?: TerminalSpawnReport;
  effects?: readonly string[];
  error: string;
}): WorktreeCreateContinuationReport {
  return {
    schema: 'orchestrator-pack/worktree-create-continuation/v2',
    outcome: 'task_degraded',
    pipelineContinues: true,
    terminalSpawnCompleted: false,
    terminalSpawnAuthorized: false,
    issueNumber: input.issueNumber,
    expectedHead: input.expectedHead,
    resumedExisting: input.resumedExisting ?? false,
    ...(input.selected ? { selected: input.selected } : {}),
    ...(input.selectedReadBack ? { selectedReadBack: input.selectedReadBack } : {}),
    attempts: input.attempts ?? [],
    ...(input.terminalSpawn ? { terminalSpawn: input.terminalSpawn } : {}),
    effects: input.effects ?? [],
    error: input.error,
  };
}

function issueMarker(value: string | undefined, issueNumber: number): boolean {
  if (!value) return false;
  return new RegExp(`(?:^|[^0-9])${String(issueNumber)}(?:[^0-9]|$)`).test(value);
}

function repositoryIssueRows(
  snapshot: InventorySnapshot,
  issueNumber: number,
): OrcaWorktreeRow[] {
  return snapshot.orcaRows.filter(
    (row) => row.repoId === snapshot.repositoryId && row.linkedIssue === issueNumber,
  );
}

function relatedExistingRows(input: {
  snapshot: InventorySnapshot;
  issueNumber: number;
  expectedHead: string;
  repositoryRoot: string;
}): GitWorktreeRow[] {
  const issuePaths = new Set(
    repositoryIssueRows(input.snapshot, input.issueNumber).map((row) => row.path),
  );
  return input.snapshot.gitRows.filter((row) => row.path !== input.repositoryRoot
    && row.headSha === input.expectedHead
    && (issuePaths.has(row.path)
      || issueMarker(row.branchName, input.issueNumber)
      || issueMarker(basename(row.path), input.issueNumber)));
}

function isReplacementIdentity(row: { path: string; branchName?: string }, issueNumber: number): boolean {
  return issueMarker(row.branchName, issueNumber) || issueMarker(basename(row.path), issueNumber)
    ? /replacement/i.test(`${row.branchName ?? ''} ${basename(row.path)}`)
    : false;
}

function issueStateHasTerminal(snapshot: InventorySnapshot, paths: ReadonlySet<string>): boolean {
  return snapshot.terminals.some((terminal) => paths.has(terminal.worktreePath));
}

function spawnOrDegrade(input: {
  candidate: SelectedCandidate;
  resumedExisting: boolean;
  issueNumber: number;
  expectedHead: string;
  terminalTitle: string;
  terminalCommand: string;
  focus: boolean;
  attempts: readonly CreateAttemptReport[];
  effects: readonly string[];
  operations: CreateContinuationOperations;
}): WorktreeCreateContinuationReport {
  const spawnedTerminal = runTerminalSpawn({
    candidate: input.candidate,
    title: input.terminalTitle,
    command: input.terminalCommand,
    focus: input.focus,
    operations: input.operations,
  });
  const effects = [...input.effects, 'orca terminal create attempted'];
  if (!spawnedTerminal.terminal) {
    return degraded({
      issueNumber: input.issueNumber,
      expectedHead: input.expectedHead,
      resumedExisting: input.resumedExisting,
      selected: input.candidate.expected,
      selectedReadBack: spawnedTerminal.selectedReadBack,
      attempts: input.attempts,
      terminalSpawn: spawnedTerminal.report,
      effects,
      error: 'terminal create outcome was not proven as exactly one new handle under the lifecycle exclusion',
    });
  }
  return spawned({
    issueNumber: input.issueNumber,
    expectedHead: input.expectedHead,
    resumedExisting: input.resumedExisting,
    selected: input.candidate,
    selectedReadBack: spawnedTerminal.selectedReadBack,
    terminal: spawnedTerminal.terminal,
    attempts: input.attempts,
    terminalSpawn: spawnedTerminal.report,
    effects,
  });
}

export function runCreateContinuation(input: {
  readonly repositoryRoot: string;
  readonly issueNumber: number;
  readonly expectedHead: string;
  readonly terminalTitle: string;
  readonly terminalCommand: string;
  readonly focus?: boolean;
  readonly operations?: CreateContinuationOperations;
}): WorktreeCreateContinuationReport {
  const operations = input.operations ?? {};
  const repositoryRoot = normalizeWorktreePath(input.repositoryRoot);
  const expectedHead = normalizeHeadSha(input.expectedHead);
  if (!Number.isInteger(input.issueNumber) || input.issueNumber <= 0) {
    throw new TypeError('issueNumber must be a positive integer');
  }
  if (!input.terminalTitle.trim()) throw new TypeError('terminalTitle must be non-empty');
  if (!input.terminalCommand.trim()) throw new TypeError('terminalCommand must be non-empty');
  const names = canonicalNames(input.issueNumber);
  const lockPath = operations.lockPath ?? WORKTREE_LIFECYCLE_EXCLUSION_PATH;
  const lock = acquireLifecycleLock(lockPath);
  if (!lock) {
    return degraded({
      issueNumber: input.issueNumber,
      expectedHead,
      error: `worktree lifecycle exclusion is held or unreadable at ${lockPath}`,
    });
  }

  try {
    let snapshot = collectInventory({
      repositoryRoot,
      issueNumber: input.issueNumber,
      expectedHead,
      probeName: names.primary,
      operations,
    });
    if (!snapshot.ok) {
      return degraded({
        issueNumber: input.issueNumber,
        expectedHead,
        error: `pre-create dual inventory unavailable: ${snapshot.errors.join('; ')}`,
      });
    }

    let relatedRows = relatedExistingRows({
      snapshot,
      issueNumber: input.issueNumber,
      expectedHead,
      repositoryRoot,
    });
    const issueOrcaRows = repositoryIssueRows(snapshot, input.issueNumber);
    const relatedPaths = new Set([...relatedRows.map((row) => row.path), ...issueOrcaRows.map((row) => row.path)]);
    if (issueStateHasTerminal(snapshot, relatedPaths)) {
      return degraded({
        issueNumber: input.issueNumber,
        expectedHead,
        error: 'an existing or ambiguous Issue-family terminal prevents another worker spawn',
      });
    }
    if (relatedRows.length > 1 || issueOrcaRows.length > 1) {
      return degraded({
        issueNumber: input.issueNumber,
        expectedHead,
        error: 'multiple pre-existing Issue-family candidates are disputed; no additional create is authorized',
      });
    }

    const existing = evaluateCandidates({
      rows: relatedRows,
      repositoryRoot,
      issueNumber: input.issueNumber,
      expectedHead,
      operations,
    });
    if (existing.selected) {
      return spawnOrDegrade({
        candidate: existing.selected,
        resumedExisting: true,
        issueNumber: input.issueNumber,
        expectedHead,
        terminalTitle: input.terminalTitle,
        terminalCommand: input.terminalCommand,
        focus: input.focus ?? true,
        attempts: [],
        effects: [],
        operations,
      });
    }

    const preexistingReplacement = relatedRows.some((row) => isReplacementIdentity(row, input.issueNumber))
      || issueOrcaRows.some((row) => isReplacementIdentity(row, input.issueNumber));
    if (preexistingReplacement) {
      return degraded({
        issueNumber: input.issueNumber,
        expectedHead,
        error: 'a pre-existing disputed replacement is preserved; no third create is authorized',
      });
    }

    const attempts: CreateAttemptReport[] = [];
    const effects: string[] = [];
    if (relatedRows.length === 0 && issueOrcaRows.length === 0) {
      const initial = runCreateAttempt({
        kind: 'initial',
        name: names.primary,
        repositoryRoot,
        issueNumber: input.issueNumber,
        expectedHead,
        before: snapshot,
        operations,
      });
      attempts.push(initial.report);
      effects.push(`orca worktree create attempted: ${names.primary}`);
      if (initial.selected) {
        return spawnOrDegrade({
          candidate: initial.selected,
          resumedExisting: false,
          issueNumber: input.issueNumber,
          expectedHead,
          terminalTitle: input.terminalTitle,
          terminalCommand: input.terminalCommand,
          focus: input.focus ?? true,
          attempts,
          effects,
          operations,
        });
      }
      if (!initial.snapshot.ok) {
        return degraded({
          issueNumber: input.issueNumber,
          expectedHead,
          attempts,
          effects,
          error: `post-initial-create inventory unavailable: ${initial.snapshot.errors.join('; ')}`,
        });
      }
      snapshot = initial.snapshot;
      relatedRows = relatedExistingRows({
        snapshot,
        issueNumber: input.issueNumber,
        expectedHead,
        repositoryRoot,
      });
    }

    if (relatedRows.some((row) => isReplacementIdentity(row, input.issueNumber))) {
      return degraded({
        issueNumber: input.issueNumber,
        expectedHead,
        attempts,
        effects,
        error: 'the single replacement already exists in disputed state; no third create is authorized',
      });
    }
    const finalAttempt = runCreateAttempt({
      kind: 'replacement',
      name: names.replacement,
      repositoryRoot,
      issueNumber: input.issueNumber,
      expectedHead,
      before: snapshot,
      operations,
    });
    attempts.push(finalAttempt.report);
    effects.push(`orca worktree create attempted: ${names.replacement}`);
    if (finalAttempt.selected) {
      return spawnOrDegrade({
        candidate: finalAttempt.selected,
        resumedExisting: false,
        issueNumber: input.issueNumber,
        expectedHead,
        terminalTitle: input.terminalTitle,
        terminalCommand: input.terminalCommand,
        focus: input.focus ?? true,
        attempts,
        effects,
        operations,
      });
    }
    return degraded({
      issueNumber: input.issueNumber,
      expectedHead,
      attempts,
      effects,
      error: finalAttempt.snapshot.ok
        ? 'initial/current state and the single isolated replacement did not reach exact dual agreement'
        : `post-replacement inventory unavailable: ${finalAttempt.snapshot.errors.join('; ')}`,
    });
  } finally {
    releaseLifecycleLock(lockPath, lock);
  }
}

interface ParsedArgs {
  repositoryRoot: string | null;
  issueNumber: number | null;
  expectedHead: string | null;
  terminalTitle: string | null;
  terminalCommand: string | null;
  focus: boolean;
  apply: boolean;
  json: boolean;
}

function parseArgs(argv = process.argv.slice(2)): ParsedArgs {
  const parsed: ParsedArgs = {
    repositoryRoot: null,
    issueNumber: null,
    expectedHead: null,
    terminalTitle: null,
    terminalCommand: null,
    focus: true,
    apply: false,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--apply') parsed.apply = true;
    else if (token === '--json') parsed.json = true;
    else if (token === '--no-focus') parsed.focus = false;
    else if (token === '--repo-root') parsed.repositoryRoot = argv[++index] ?? null;
    else if (token === '--expected-head') parsed.expectedHead = argv[++index] ?? null;
    else if (token === '--terminal-title') parsed.terminalTitle = argv[++index] ?? null;
    else if (token === '--terminal-command') parsed.terminalCommand = argv[++index] ?? null;
    else if (token === '--issue') {
      const value = Number.parseInt(argv[++index] ?? '', 10);
      parsed.issueNumber = Number.isInteger(value) && value > 0 ? value : null;
    } else {
      throw new TypeError(`unknown argument: ${String(token)}`);
    }
  }
  return parsed;
}

function usageError(args: ParsedArgs): string | null {
  if (!args.repositoryRoot) return '--repo-root is required';
  if (!args.issueNumber) return '--issue must be a positive integer';
  if (!args.expectedHead) return '--expected-head is required and must be a full 40-hex SHA';
  if (!args.terminalTitle?.trim()) return '--terminal-title is required';
  if (!args.terminalCommand?.trim()) return '--terminal-command is required';
  if (!args.apply) return '--apply is required because this command owns create and terminal effects';
  return null;
}

function emitHuman(report: WorktreeCreateContinuationReport): void {
  console.log(`Outcome: ${report.outcome}`);
  console.log(`Pipeline continues: ${report.pipelineContinues ? 'yes' : 'no'}`);
  console.log(`Terminal spawn completed: ${report.terminalSpawnCompleted ? 'yes' : 'no'}`);
  if (report.selected) console.log(`Selected worktree: ${report.selected.path}`);
  if (report.terminal?.handle) console.log(`Terminal handle: ${report.terminal.handle}`);
  console.log(`Create attempts: ${String(report.attempts.length)}`);
  if (report.error) console.log(`Detail: ${report.error}`);
}

function main(): void {
  let args: ParsedArgs;
  try {
    args = parseArgs();
  } catch (error) {
    args = {
      repositoryRoot: null,
      issueNumber: null,
      expectedHead: null,
      terminalTitle: null,
      terminalCommand: null,
      focus: true,
      apply: false,
      json: process.argv.includes('--json'),
    };
    const payload = {
      schema: 'orchestrator-pack/worktree-create-continuation-cli-error/v1',
      outcome: 'invalid_arguments',
      pipelineContinues: true,
      error: error instanceof Error ? error.message : String(error),
    };
    if (args.json) console.log(JSON.stringify(payload, null, 2));
    else console.error(`Invalid arguments: ${payload.error}`);
    process.exitCode = 2;
    return;
  }
  const error = usageError(args);
  if (error) {
    const payload = {
      schema: 'orchestrator-pack/worktree-create-continuation-cli-error/v1',
      outcome: 'invalid_arguments',
      pipelineContinues: true,
      error,
    };
    if (args.json) console.log(JSON.stringify(payload, null, 2));
    else console.error(`Invalid arguments: ${error}`);
    process.exitCode = 2;
    return;
  }
  try {
    const report = runCreateContinuation({
      repositoryRoot: args.repositoryRoot!,
      issueNumber: args.issueNumber!,
      expectedHead: args.expectedHead!,
      terminalTitle: args.terminalTitle!,
      terminalCommand: args.terminalCommand!,
      focus: args.focus,
    });
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else emitHuman(report);
    process.exitCode = 0;
  } catch (caught) {
    const payload = {
      schema: 'orchestrator-pack/worktree-create-continuation-cli-error/v1',
      outcome: 'task_degraded',
      pipelineContinues: true,
      error: caught instanceof Error ? caught.message : String(caught),
    };
    if (args.json) console.log(JSON.stringify(payload, null, 2));
    else console.error(`Create continuation degraded: ${payload.error}`);
    process.exitCode = 0;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
