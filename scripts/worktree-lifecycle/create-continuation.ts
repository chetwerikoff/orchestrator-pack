#!/usr/bin/env node

import '../toolchain/native-entrypoint-preflight.ts';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runProcessSync, type ProcessResult } from '../kernel/subprocess.ts';
import { resolveOrcaExecutable } from '../orca-runtime/native.ts';
import {
  normalizeHeadSha,
  normalizeWorktreePath,
  parseGitWorktreePorcelain,
  parseOrcaWorktreePayload,
  type ExpectedWorktreeIdentity,
  type GitWorktreeRow,
  type OrcaWorktreeRow,
} from './core.ts';
import {
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

interface AttemptResult {
  readonly report: CreateAttemptReport;
  readonly snapshot: InventorySnapshot;
  readonly selected?: {
    expected: ExpectedWorktreeIdentity;
    report: LifecycleTerminalReport;
  };
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

function commandError(result: ProcessResult, invocation: CommandInvocation): string {
  return result.stderr.trim()
    || result.error
    || `${invocation.command} ${invocation.args.join(' ')} exited ${String(result.exitCode)}`;
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new TypeError(`${label} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function processStarttime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return fields[19] ?? null;
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

function parseLockRecord(raw: string): { pid: number; starttime: string | null; token: string | null } | null {
  const lines = raw.trim().split(/\r?\n/);
  const pid = Number.parseInt(lines[0] ?? '', 10);
  if (!Number.isInteger(pid) || pid <= 1) return null;
  return {
    pid,
    starttime: lines[1]?.trim() || null,
    token: lines[2]?.trim() || null,
  };
}

function lockOwnerAlive(record: ReturnType<typeof parseLockRecord>): boolean {
  if (!record || !processExists(record.pid)) return false;
  if (!record.starttime) return true;
  const observed = processStarttime(record.pid);
  return observed === null || observed === record.starttime;
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
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') return null;
      let firstRead: string;
      try {
        firstRead = readFileSync(path, 'utf8');
      } catch {
        return null;
      }
      const record = parseLockRecord(firstRead);
      if (record === null || lockOwnerAlive(record)) return null;
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
    // The token check below still prevents unlinking a replacement owner.
  }
  try {
    const record = parseLockRecord(readFileSync(path, 'utf8'));
    if (record?.token === handle.token) unlinkSync(path);
  } catch {
    // Missing-at-release is harmless; mismatched ownership remains fail-closed.
  }
}

function collectInventory(
  repositoryRoot: string,
  operations: CreateContinuationOperations,
): InventorySnapshot {
  const runner = operations.runner ?? defaultRunner;
  const orcaExecutable = operations.orcaExecutable ?? resolveOrcaExecutable();
  const errors: string[] = [];
  let gitRows: GitWorktreeRow[] = [];
  let orcaRows: OrcaWorktreeRow[] = [];

  const gitInvocation: CommandInvocation = {
    command: 'git',
    args: ['-C', repositoryRoot, 'worktree', 'list', '--porcelain'],
  };
  const gitResult = runner(gitInvocation);
  if (!gitResult.ok) {
    errors.push(commandError(gitResult, gitInvocation));
  } else {
    try {
      gitRows = parseGitWorktreePorcelain(gitResult.stdout);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  const orcaInvocation: CommandInvocation = {
    command: orcaExecutable,
    args: ['worktree', 'list', '--json'],
  };
  const orcaResult = runner(orcaInvocation);
  if (!orcaResult.ok) {
    errors.push(commandError(orcaResult, orcaInvocation));
  } else {
    try {
      orcaRows = parseOrcaWorktreePayload(parseJson(orcaResult.stdout, 'orca worktree list'));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  return { ok: errors.length === 0, gitRows, orcaRows, errors };
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

function lifecycleOperations(
  operations: CreateContinuationOperations,
): LifecycleOperations {
  return {
    ...(operations.runner ? { runner: operations.runner } : {}),
    ...(operations.orcaExecutable ? { orcaExecutable: operations.orcaExecutable } : {}),
    ...(operations.lockPath ? { lockPath: operations.lockPath } : {}),
  };
}

function evaluateCandidateRows(input: {
  rows: readonly GitWorktreeRow[];
  repositoryRoot: string;
  issueNumber: number;
  expectedHead: string;
  operations: CreateContinuationOperations;
}): {
  reports: LifecycleTerminalReport[];
  selected?: { expected: ExpectedWorktreeIdentity; report: LifecycleTerminalReport };
} {
  const reports: LifecycleTerminalReport[] = [];
  const evaluated: Array<{ expected: ExpectedWorktreeIdentity; report: LifecycleTerminalReport }> = [];
  for (const row of input.rows) {
    if (row.headSha !== input.expectedHead || row.path === input.repositoryRoot) continue;
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
      || !first.decision.terminalSpawnAuthorized) {
      continue;
    }
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
      evaluated.push({ expected, report: fresh });
    }
  }
  return evaluated.length === 1 && input.rows.length === 1
    ? { reports, selected: evaluated[0] }
    : { reports };
}

function acknowledged(result: ProcessResult): boolean {
  if (!result.stdout.trim()) return false;
  try {
    const payload = JSON.parse(result.stdout) as { ok?: unknown };
    return payload.ok === true;
  } catch {
    return false;
  }
}

function createCommand(
  repositoryRoot: string,
  issueNumber: number,
  expectedHead: string,
  name: string,
  orcaExecutable: string,
): CommandInvocation {
  return {
    command: orcaExecutable,
    args: [
      'worktree',
      'create',
      '--name',
      name,
      '--repo',
      `path:${repositoryRoot}`,
      '--base-branch',
      expectedHead,
      '--issue',
      String(issueNumber),
      '--setup',
      'skip',
      '--activate',
      '--json',
    ],
    cwd: repositoryRoot,
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
  const orcaExecutable = input.operations.orcaExecutable ?? resolveOrcaExecutable();
  const invocation = createCommand(
    input.repositoryRoot,
    input.issueNumber,
    input.expectedHead,
    input.name,
    orcaExecutable,
  );
  const commandResult = runner(invocation);
  const snapshot = collectInventory(input.repositoryRoot, input.operations);
  const beforeGitPaths = new Set(input.before.gitRows.map((row) => row.path));
  const beforeOrcaPaths = new Set(input.before.orcaRows.map((row) => row.path));
  const newGitRows = snapshot.gitRows.filter((row) => !beforeGitPaths.has(row.path));
  const newOrcaRows = snapshot.orcaRows.filter((row) => !beforeOrcaPaths.has(row.path));
  const evaluated = snapshot.ok
    ? evaluateCandidateRows({
        rows: newGitRows,
        repositoryRoot: input.repositoryRoot,
        issueNumber: input.issueNumber,
        expectedHead: input.expectedHead,
        operations: input.operations,
      })
    : { reports: [] as LifecycleTerminalReport[] };
  const report: CreateAttemptReport = {
    kind: input.kind,
    name: input.name,
    command: {
      outcome: commandResult.outcome,
      ok: commandResult.ok,
      exitCode: commandResult.exitCode,
      timedOut: commandResult.timedOut,
      acknowledged: acknowledged(commandResult),
      ...(!commandResult.ok ? { error: commandError(commandResult, invocation) } : {}),
    },
    newGitPaths: newGitRows.map((row) => row.path).sort(),
    newOrcaPaths: newOrcaRows.map((row) => row.path).sort(),
    candidateReports: evaluated.reports,
    inventoryErrors: snapshot.errors,
  };
  return {
    report,
    snapshot,
    ...(evaluated.selected ? { selected: evaluated.selected } : {}),
  };
}

function ready(input: {
  issueNumber: number;
  expectedHead: string;
  resumedExisting: boolean;
  selected: { expected: ExpectedWorktreeIdentity; report: LifecycleTerminalReport };
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
  const token = (operations.replacementToken ?? randomUUID)()
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, 10);
  const suffix = `-replacement-${token || 'bounded'}`;
  return `${name.slice(0, Math.max(1, 80 - suffix.length))}${suffix}`;
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
    let snapshot = collectInventory(repositoryRoot, operations);
    if (!snapshot.ok) {
      return degraded({
        issueNumber: input.issueNumber,
        expectedHead,
        error: `pre-create dual inventory unavailable: ${snapshot.errors.join('; ')}`,
      });
    }

    const existingGitRows = snapshot.gitRows.filter(
      (row) => row.path !== repositoryRoot && row.headSha === expectedHead,
    );
    const existingOrcaRows = snapshot.orcaRows.filter(
      (row) => row.linkedIssue === input.issueNumber || row.headSha === expectedHead,
    );
    const existing = evaluateCandidateRows({
      rows: existingGitRows,
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
    const hasDisputedExisting = existingGitRows.length > 0 || existingOrcaRows.length > 0;
    if (!hasDisputedExisting) {
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
    const replacementAttempt = runCreateAttempt({
      kind: 'replacement',
      name: replacement,
      repositoryRoot,
      issueNumber: input.issueNumber,
      expectedHead,
      before: snapshot,
      operations,
    });
    attempts.push(replacementAttempt.report);
    effects.push(`orca worktree create attempted: ${replacement}`);
    if (replacementAttempt.selected) {
      return ready({
        issueNumber: input.issueNumber,
        expectedHead,
        resumedExisting: false,
        selected: replacementAttempt.selected,
        attempts,
        effects,
      });
    }
    return degraded({
      issueNumber: input.issueNumber,
      expectedHead,
      attempts,
      effects,
      error: replacementAttempt.snapshot.ok
        ? 'initial/current state and the single isolated replacement did not reach exact dual agreement'
        : `post-replacement inventory unavailable: ${replacementAttempt.snapshot.errors.join('; ')}`,
    });
  } finally {
    releaseLifecycleLock(lockPath, lock);
  }
}

interface ParsedArgs {
  readonly repositoryRoot: string | null;
  readonly issueNumber: number | null;
  readonly expectedHead: string | null;
  readonly name: string | null;
  readonly apply: boolean;
  readonly json: boolean;
}

function valueAfter(argv: readonly string[], name: string): string | null {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1] ?? null;
}

function positiveInteger(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseArgs(argv = process.argv.slice(2)): ParsedArgs {
  return {
    repositoryRoot: valueAfter(argv, '--repo-root'),
    issueNumber: positiveInteger(valueAfter(argv, '--issue')),
    expectedHead: valueAfter(argv, '--expected-head'),
    name: valueAfter(argv, '--name'),
    apply: argv.includes('--apply'),
    json: argv.includes('--json'),
  };
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
  const args = parseArgs();
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

if (process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
