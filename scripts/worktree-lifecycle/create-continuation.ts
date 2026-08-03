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
} from './operations.ts';

export const WORKTREE_LIFECYCLE_EXCLUSION_PATH = resolve(
  '/tmp',
  `${['opk', 'worktree', 'teardown'].join('-')}.lock`,
);

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

export interface CreateContinuationOperations {
  readonly runner?: CommandRunner;
  readonly orcaExecutable?: string;
  readonly lockPath?: string;
  readonly replacementToken?: () => string;
}

export interface InventorySnapshot {
  readonly ok: boolean;
  readonly gitRows: readonly GitWorktreeRow[];
  readonly orcaRows: readonly OrcaWorktreeRow[];
  readonly errors: readonly string[];
}

export interface CreateAttemptReport {
  readonly kind: 'initial' | 'replacement';
  readonly name: string;
  readonly command: {
    readonly outcome: ProcessResult['outcome'];
    readonly ok: boolean;
    readonly exitCode: number | null;
    readonly timedOut: boolean;
    readonly acknowledged: boolean;
    readonly error?: string;
  };
  readonly newGitPaths: readonly string[];
  readonly newOrcaPaths: readonly string[];
  readonly candidateReports: readonly LifecycleTerminalReport[];
  readonly inventoryErrors: readonly string[];
}

export interface WorktreeCreateContinuationReport {
  readonly schema: 'orchestrator-pack/worktree-create-continuation/v1';
  readonly outcome: 'ready_to_spawn' | 'task_degraded';
  readonly pipelineContinues: true;
  readonly terminalSpawnAuthorized: boolean;
  readonly issueNumber: number;
  readonly expectedHead: string;
  readonly resumedExisting: boolean;
  readonly selected?: ExpectedWorktreeIdentity;
  readonly selectedReadBack?: LifecycleTerminalReport;
  readonly attempts: readonly CreateAttemptReport[];
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
  const errors = [...census.errors];
  if (evidence.git.status !== 'ok' && !errors.some((item) => item.includes('git'))) {
    errors.push(evidence.git.error ?? 'git inventory unavailable');
  }
  if (evidence.orca.status !== 'ok' && !errors.some((item) => item.toLowerCase().includes('orca'))) {
    errors.push(evidence.orca.error ?? 'Orca inventory unavailable');
  }
  return {
    ok: evidence.git.status === 'ok' && evidence.orca.status === 'ok' && errors.length === 0,
    gitRows: evidence.git.rows,
    orcaRows: evidence.orca.rows,
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
    if (first.outcome !== 'ready_to_spawn'
      || first.classification.classification !== 'exact_dual'
      || !first.decision.terminalSpawnAuthorized) continue;
    const fresh = runLifecycle({
      expected,
      context: 'post-create',
      apply: false,
      operations: lifecycleOperations(input.operations),
    });
    reports.push(fresh);
    if (fresh.outcome === 'ready_to_spawn'
      && fresh.classification.classification === 'exact_dual'
      && fresh.decision.terminalSpawnAuthorized) {
      ready.push({ expected, report: fresh });
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
      command: {
        outcome: command.outcome,
        ok: command.ok,
        exitCode: command.exitCode,
        timedOut: command.timedOut,
        acknowledged: responseAcknowledged(command),
        ...(!command.ok ? { error: invocationError(command, invocation) } : {}),
      },
      newGitPaths: newGitRows.map((row) => row.path).sort(),
      newOrcaPaths: newOrcaRows.map((row) => row.path).sort(),
      candidateReports: evaluated.reports,
      inventoryErrors: snapshot.errors,
    },
    snapshot,
    ...(evaluated.selected ? { selected: evaluated.selected } : {}),
  };
}

function ready(input: {
  issueNumber: number;
  expectedHead: string;
  resumedExisting: boolean;
  selected: SelectedCandidate;
  attempts: readonly CreateAttemptReport[];
  effects: readonly string[];
}): WorktreeCreateContinuationReport {
  return {
    schema: 'orchestrator-pack/worktree-create-continuation/v1',
    outcome: 'ready_to_spawn',
    pipelineContinues: true,
    terminalSpawnAuthorized: true,
    issueNumber: input.issueNumber,
    expectedHead: input.expectedHead,
    resumedExisting: input.resumedExisting,
    selected: input.selected.expected,
    selectedReadBack: input.selected.report,
    attempts: input.attempts,
    effects: input.effects,
  };
}

function degraded(input: {
  issueNumber: number;
  expectedHead: string;
  attempts?: readonly CreateAttemptReport[];
  effects?: readonly string[];
  error: string;
}): WorktreeCreateContinuationReport {
  return {
    schema: 'orchestrator-pack/worktree-create-continuation/v1',
    outcome: 'task_degraded',
    pipelineContinues: true,
    terminalSpawnAuthorized: false,
    issueNumber: input.issueNumber,
    expectedHead: input.expectedHead,
    resumedExisting: false,
    attempts: input.attempts ?? [],
    effects: input.effects ?? [],
    error: input.error,
  };
}

function replacementName(name: string, operations: CreateContinuationOperations): string {
  const raw = (operations.replacementToken ?? randomUUID)();
  const token = raw.replace(/[^A-Za-z0-9]/g, '').slice(0, 10) || 'bounded';
  const suffix = `-replacement-${token}`;
  return `${name.slice(0, Math.max(1, 80 - suffix.length))}${suffix}`;
}

function relatedExistingRows(input: {
  snapshot: InventorySnapshot;
  issueNumber: number;
  expectedHead: string;
  primaryName: string;
  repositoryRoot: string;
}): GitWorktreeRow[] {
  const issuePaths = new Set(
    input.snapshot.orcaRows
      .filter((row) => row.linkedIssue === input.issueNumber)
      .map((row) => row.path),
  );
  return input.snapshot.gitRows.filter((row) => row.path !== input.repositoryRoot
    && row.headSha === input.expectedHead
    && (issuePaths.has(row.path)
      || row.branchName === input.primaryName
      || basename(row.path) === input.primaryName));
}

export function runCreateContinuation(input: {
  readonly repositoryRoot: string;
  readonly issueNumber: number;
  readonly expectedHead: string;
  readonly name: string;
  readonly operations?: CreateContinuationOperations;
}): WorktreeCreateContinuationReport {
  const operations = input.operations ?? {};
  const repositoryRoot = normalizeWorktreePath(input.repositoryRoot);
  const expectedHead = normalizeHeadSha(input.expectedHead);
  if (!Number.isInteger(input.issueNumber) || input.issueNumber <= 0) {
    throw new TypeError('issueNumber must be a positive integer');
  }
  if (!NAME_PATTERN.test(input.name)) {
    throw new TypeError('name must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/');
  }
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
      probeName: input.name,
      operations,
    });
    if (!snapshot.ok) {
      return degraded({
        issueNumber: input.issueNumber,
        expectedHead,
        error: `pre-create dual inventory unavailable: ${snapshot.errors.join('; ')}`,
      });
    }

    const relatedRows = relatedExistingRows({
      snapshot,
      issueNumber: input.issueNumber,
      expectedHead,
      primaryName: input.name,
      repositoryRoot,
    });
    const existing = evaluateCandidates({
      rows: relatedRows,
      repositoryRoot,
      issueNumber: input.issueNumber,
      expectedHead,
      operations,
    });
    if (existing.selected) {
      return ready({
        issueNumber: input.issueNumber,
        expectedHead,
        resumedExisting: true,
        selected: existing.selected,
        attempts: [],
        effects: [],
      });
    }

    const attempts: CreateAttemptReport[] = [];
    const effects: string[] = [];
    const hasIssueOrPrimaryState = relatedRows.length > 0
      || snapshot.orcaRows.some((row) => row.linkedIssue === input.issueNumber);
    if (!hasIssueOrPrimaryState) {
      const initial = runCreateAttempt({
        kind: 'initial',
        name: input.name,
        repositoryRoot,
        issueNumber: input.issueNumber,
        expectedHead,
        before: snapshot,
        operations,
      });
      attempts.push(initial.report);
      effects.push(`orca worktree create attempted: ${input.name}`);
      if (initial.selected) {
        return ready({
          issueNumber: input.issueNumber,
          expectedHead,
          resumedExisting: false,
          selected: initial.selected,
          attempts,
          effects,
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
    }

    const replacement = replacementName(input.name, operations);
    const finalAttempt = runCreateAttempt({
      kind: 'replacement',
      name: replacement,
      repositoryRoot,
      issueNumber: input.issueNumber,
      expectedHead,
      before: snapshot,
      operations,
    });
    attempts.push(finalAttempt.report);
    effects.push(`orca worktree create attempted: ${replacement}`);
    if (finalAttempt.selected) {
      return ready({
        issueNumber: input.issueNumber,
        expectedHead,
        resumedExisting: false,
        selected: finalAttempt.selected,
        attempts,
        effects,
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
  name: string | null;
  apply: boolean;
  json: boolean;
}

function parseArgs(argv = process.argv.slice(2)): ParsedArgs {
  const parsed: ParsedArgs = {
    repositoryRoot: null,
    issueNumber: null,
    expectedHead: null,
    name: null,
    apply: false,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--apply') parsed.apply = true;
    else if (token === '--json') parsed.json = true;
    else if (token === '--repo-root') parsed.repositoryRoot = argv[++index] ?? null;
    else if (token === '--expected-head') parsed.expectedHead = argv[++index] ?? null;
    else if (token === '--name') parsed.name = argv[++index] ?? null;
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
  if (!args.name || !NAME_PATTERN.test(args.name)) return '--name must be a safe Orca worktree name';
  if (!args.apply) return '--apply is required because this command owns the bounded create effect';
  return null;
}

function emitHuman(report: WorktreeCreateContinuationReport): void {
  console.log(`Outcome: ${report.outcome}`);
  console.log(`Pipeline continues: ${report.pipelineContinues ? 'yes' : 'no'}`);
  console.log(`Terminal spawn authorized: ${report.terminalSpawnAuthorized ? 'yes' : 'no'}`);
  if (report.selected) console.log(`Selected worktree: ${report.selected.path}`);
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
      name: null,
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
      name: args.name!,
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
