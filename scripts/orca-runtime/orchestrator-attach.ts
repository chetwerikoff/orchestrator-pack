import { runProcess } from '../kernel/subprocess.ts';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  bindOperatorPrimary,
  listCurrentWorkerAssignmentRecords,
  readOperatorPrimaryBinding,
  resolveWorkerAssignmentStorePath,
  type WorkerAssignmentRecord,
} from '../lib/worker-assignment-store.ts';
import { resolveTargetContext, TargetContextError, type TargetContext } from '../lib/target-context.ts';

const USAGE = [
  'usage: scripts/opk-orch-start resume <existing-session-id>',
  '       scripts/opk-orch-start attach <terminal-handle> [project-id]',
  '',
].join('\n');

const RUN_ID_RE = /^run_[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u;
const HANDLE_RE = /^[A-Za-z][A-Za-z0-9._:-]{0,199}$/u;
const PROJECT_CORRECTION = 'correct the handle/project/Orca runtime and retry';
const RUN_ID_CORRECTION = 'set OPK_RUN_ID to the existing Run and retry';
const LIST_CORRECTION = 'restore Orca terminal visibility, inspect this Run and retry';
const READBACK_CORRECTION = 'inspect the exact Run and retry the restore only after resolving its coordinator';
const ASSIGNMENT_CORRECTION = 'reconcile the existing local WorkerAssignment/Dispatch and primary pointer, then retry';
const DEAD_STATUS = new Set(['exited', 'closed', 'dead', 'stopped', 'gone', 'terminated']);

export interface NativeCommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type NativeCommand = (args: readonly string[]) => Promise<NativeCommandResult>;

export interface AttachReport {
  readonly ok: boolean;
  readonly message: string;
  readonly requestedHandle: string;
  readonly runId?: string;
  readonly coordinatorHandle?: string | null;
  readonly runUseCount: number;
  readonly primary: 'skipped' | 'bound' | 'replaced' | 'refused' | 'not-attempted';
  readonly pin: 'written' | 'unchanged' | 'refused' | 'not-attempted';
  readonly partial?: {
    readonly runRebound: boolean;
    readonly primary: string;
    readonly pin: string;
  };
}

export interface AttachInput {
  readonly argv: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly runNative?: NativeCommand;
}

interface ResumeResult {
  readonly outcome: string;
}

export interface OrchStartDependencies {
  readonly env?: NodeJS.ProcessEnv;
  readonly resume: (session: string, env: NodeJS.ProcessEnv) => Promise<ResumeResult>;
  readonly runNative?: NativeCommand;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
}

interface TerminalRow {
  readonly handle: string;
  readonly worktreePath: string;
  readonly live: boolean;
}

interface ParsedRun {
  readonly id: string;
  readonly coordinatorHandle: string | null;
}

export function orcaCommand(env: NodeJS.ProcessEnv): NativeCommand {
  return async (args) => {
    const result = await runProcess({ command: 'orca', args, env, inheritParentEnv: false });
    return {
      code: result.exitCode ?? 1,
      stdout: result.stdout,
      stderr: result.stderr || result.error || '',
    };
  };
}

export async function runOpkOrchStart(
  argv: readonly string[],
  dependencies: OrchStartDependencies,
): Promise<number> {
  const env = dependencies.env ?? process.env;
  const stdout = dependencies.stdout ?? ((text: string) => { process.stdout.write(text); });
  const stderr = dependencies.stderr ?? ((text: string) => { process.stderr.write(text); });
  const command = argv[0] ?? '';
  if (command === 'resume') {
    if (argv.length !== 2) {
      stderr(USAGE);
      return 2;
    }
    try {
      const result = await dependencies.resume(argv[1] ?? '', env);
      stdout(`${JSON.stringify(result)}\n`);
      return result.outcome === 'catalog_observed_unverified' ? 0 : 1;
    } catch (error) {
      stderr(`resume refused: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }
  if (command !== 'attach' || argv.length < 2 || argv.length > 3) {
    stderr(USAGE);
    return 2;
  }
  const report = await attachOrchestratorSeat({
    argv,
    env,
    ...(dependencies.runNative ? { runNative: dependencies.runNative } : {}),
  });
  stdout(`${JSON.stringify(report)}\n`);
  if (!report.ok) stderr(`${report.message}\n`);
  return report.ok ? 0 : 1;
}

export async function attachOrchestratorSeat(input: AttachInput): Promise<AttachReport> {
  const requestedHandle = input.argv[1] ?? '';
  const base = {
    requestedHandle,
    runUseCount: 0,
    primary: 'not-attempted' as const,
    pin: 'not-attempted' as const,
  };
  if (!HANDLE_RE.test(requestedHandle) || input.argv.length > 3 || input.argv[0] !== 'attach') {
    return refuse({ ...base, message: USAGE.trim() });
  }
  const env = input.env ?? process.env;
  const runId = (env.OPK_RUN_ID ?? '').trim();
  if (!RUN_ID_RE.test(runId)) {
    return refuse({ ...base, message: RUN_ID_CORRECTION });
  }
  const projectArg = input.argv[2]?.trim() ?? '';
  if (projectArg.startsWith('-')) {
    return refuse({ ...base, runId, message: PROJECT_CORRECTION });
  }
  let target: TargetContext;
  try {
    target = resolveTargetContext({
      ...(projectArg ? { projectId: projectArg } : {}),
      env,
    });
  } catch (error) {
    const detail = error instanceof TargetContextError ? error.message : 'project selection failed';
    return refuse({ ...base, runId, message: `${PROJECT_CORRECTION} (${detail})` });
  }

  const runNative = input.runNative ?? orcaCommand(env);
  let runUseCount = 0;
  const call = async (args: readonly string[]): Promise<unknown | null> => {
    if (args[0] === 'orchestration' && args[1] === 'run-use') runUseCount += 1;
    let result: NativeCommandResult;
    try {
      result = await runNative(args);
    } catch (error) {
      return failNative(error instanceof Error ? error.message : String(error));
    }
    if (result.code !== 0) return failNative(`exit ${String(result.code)}`);
    try {
      const parsed = JSON.parse(result.stdout) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return failNative('invalid JSON');
      const record = parsed as Record<string, unknown>;
      if (record.ok === false) return failNative('ok:false');
      return record.result ?? record;
    } catch (error) {
      return failNative(error instanceof Error ? error.message : 'invalid JSON');
    }
  };

  const shown = await call(['terminal', 'show', '--terminal', requestedHandle, '--json']);
  if (shown instanceof NativeFailure) {
    return refuse({ ...base, runId, runUseCount, message: `${PROJECT_CORRECTION} (${shown.detail})` });
  }
  const showRow = terminalFromShow(shown, requestedHandle);
  if (!showRow) {
    return refuse({ ...base, runId, runUseCount, message: PROJECT_CORRECTION });
  }
  const listed = await call(['terminal', 'list', '--json']);
  if (listed instanceof NativeFailure) {
    return refuse({ ...base, runId, runUseCount, message: `${LIST_CORRECTION} (${listed.detail})` });
  }
  const census = terminalCensus(listed);
  if (!census) {
    return refuse({ ...base, runId, runUseCount, message: LIST_CORRECTION });
  }
  const selected = census.rows.find((row) => row.handle === requestedHandle);
  if (!selected || !selected.live || !sameWorktree(showRow.worktreePath, selected.worktreePath) || !worktreeMatchesProject(selected.worktreePath, target)) {
    return refuse({ ...base, runId, runUseCount, message: PROJECT_CORRECTION });
  }

  // Concise run-show omits coordinator_handle (result is runId/objective/removedWork).
  // --full is the existing native record that carries it, not a new witness.
  const shownRun = await call(['orchestration', 'run-show', '--id', runId, '--full', '--json']);
  if (shownRun instanceof NativeFailure) {
    return refuse({ ...base, runId, runUseCount, message: `${READBACK_CORRECTION} (${shownRun.detail})` });
  }
  const currentRun = parseRun(shownRun, runId);
  if (!currentRun) {
    return refuse({ ...base, runId, runUseCount, message: READBACK_CORRECTION });
  }
  const sameHandle = currentRun.coordinatorHandle === requestedHandle;
  if (!sameHandle && currentRun.coordinatorHandle && census.handles.has(currentRun.coordinatorHandle)) {
    return refuse({
      ...base,
      runId,
      runUseCount,
      coordinatorHandle: currentRun.coordinatorHandle,
      message: `close ${currentRun.coordinatorHandle} or attach from it`,
    });
  }

  const selectedAssignment = await selectAssignment(target, runId, env, call);
  if (selectedAssignment instanceof SelectionFailure) {
    return refuse({
      ...base,
      runId,
      runUseCount,
      coordinatorHandle: currentRun.coordinatorHandle,
      message: `${selectedAssignment.message} ${ASSIGNMENT_CORRECTION}`,
    });
  }
  const pointer = readOperatorPrimaryBinding(
    resolveWorkerAssignmentStorePath(target.projectId, env),
    { projectId: target.projectId, repository: target.repository },
  );
  if (!pointer.ok) {
    return refuse({
      ...base,
      runId,
      runUseCount,
      coordinatorHandle: currentRun.coordinatorHandle,
      message: `operator-primary pointer is untrusted (${pointer.cause}). ${ASSIGNMENT_CORRECTION}`,
    });
  }
  if (pointer.status === 'binding_stale') {
    return refuse({
      ...base,
      runId,
      runUseCount,
      coordinatorHandle: currentRun.coordinatorHandle,
      message: `operator-primary pointer is stale. ${ASSIGNMENT_CORRECTION}`,
    });
  }
  const alreadyPrimary = pointer.status === 'binding_current'
    && pointer.binding.taskId === selectedAssignment.taskId
    && pointer.binding.bindingKey === selectedAssignment.bindingKey
    && pointer.binding.assignmentId === selectedAssignment.assignmentId
    && pointer.binding.assignmentGeneration === selectedAssignment.generation;

  let coordinatorHandle = currentRun.coordinatorHandle;
  let runRebound = false;
  if (!sameHandle) {
    const used = await call(['orchestration', 'run-use', '--id', runId, '--json']);
    if (used instanceof NativeFailure) {
      return refuse({
        ...base,
        runId,
        runUseCount,
        coordinatorHandle,
        message: `run-use failed (${used.detail}). ${READBACK_CORRECTION}`,
        partial: { runRebound: false, primary: 'not-attempted', pin: 'not-attempted' },
      });
    }
    const readback = await call(['orchestration', 'run-show', '--id', runId, '--full', '--json']);
    const confirmed = readback instanceof NativeFailure ? null : parseRun(readback, runId);
    if (!confirmed || confirmed.coordinatorHandle !== requestedHandle) {
      const observed = confirmed?.coordinatorHandle ?? 'unknown';
      return refuse({
        ...base,
        runId,
        runUseCount,
        coordinatorHandle: confirmed?.coordinatorHandle ?? coordinatorHandle,
        message: `run-show coordinator is ${String(observed)} after one run-use. ${READBACK_CORRECTION}`,
        partial: { runRebound: false, primary: 'not-attempted', pin: 'not-attempted' },
      });
    }
    coordinatorHandle = confirmed.coordinatorHandle;
    runRebound = true;
  }

  let primary: AttachReport['primary'] = 'skipped';
  if (!alreadyPrimary) {
    const file = resolveWorkerAssignmentStorePath(target.projectId, env);
    const mutation = await bindOperatorPrimary({
      file,
      expectedProject: { projectId: target.projectId, repository: target.repository },
      taskId: selectedAssignment.taskId,
      bindingKey: selectedAssignment.bindingKey,
      ...(pointer.status === 'binding_current' ? { expectedCurrent: pointer.binding } : {}),
    });
    if (!mutation.ok) {
      return refuse({
        ...base,
        runId,
        runUseCount,
        coordinatorHandle,
        primary: 'refused',
        message: runRebound
          ? `run ${runId} is bound to ${requestedHandle}; operator-primary replace/bind refused (${mutation.reason}). ${ASSIGNMENT_CORRECTION}`
          : `operator-primary replace/bind refused (${mutation.reason}). ${ASSIGNMENT_CORRECTION}`,
        partial: {
          runRebound,
          primary: mutation.reason,
          pin: 'not-attempted',
        },
      });
    }
    primary = pointer.status === 'binding_absent' ? 'bound' : 'replaced';
  }

  const pin = writeProjectPin(env, target.projectId, requestedHandle);
  if (!pin.ok) {
    return refuse({
      ...base,
      runId,
      runUseCount,
      coordinatorHandle,
      primary,
      pin: 'refused',
      message: `${runRebound ? `run ${runId} is bound to ${requestedHandle}; ` : ''}primary ${primary}; pin not written (${pin.reason}). Repair the selected project pin and retry; do not repeat run-use.`,
      partial: { runRebound, primary, pin: pin.reason },
    });
  }
  const pinState = pin.changed ? 'written' : 'unchanged';
  return {
    ok: true,
    requestedHandle,
    runId,
    coordinatorHandle,
    runUseCount,
    primary,
    pin: pinState,
    message: pin.changed
      ? `Run bound / pin written; fleet-wake adoption not verified`
      : `Run bound / pin unchanged; fleet-wake adoption not verified`,
  };
}

class NativeFailure {
  readonly detail: string;
  constructor(detail: string) {
    this.detail = detail;
  }
}

function failNative(detail: string): NativeFailure {
  return new NativeFailure(detail);
}

class SelectionFailure {
  readonly message: string;
  constructor(message: string) {
    this.message = message;
  }
}

function refuse(input: {
  readonly message: string;
  readonly requestedHandle: string;
  readonly runId?: string;
  readonly coordinatorHandle?: string | null;
  readonly runUseCount: number;
  readonly primary?: AttachReport['primary'];
  readonly pin?: AttachReport['pin'];
  readonly partial?: AttachReport['partial'];
}): AttachReport {
  return {
    ok: false,
    message: input.message,
    requestedHandle: input.requestedHandle,
    runUseCount: input.runUseCount,
    primary: input.primary ?? 'not-attempted',
    pin: input.pin ?? 'not-attempted',
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.coordinatorHandle !== undefined ? { coordinatorHandle: input.coordinatorHandle } : {}),
    ...(input.partial ? { partial: input.partial } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function worktreePathOf(row: Record<string, unknown>): string {
  if (typeof row.worktreePath === 'string') return row.worktreePath;
  if (typeof row.worktree_path === 'string') return row.worktree_path;
  const worktree = asRecord(row.worktree);
  if (typeof worktree?.path === 'string') return worktree.path;
  return '';
}

function terminalFromShow(value: unknown, handle: string): TerminalRow | null {
  const result = asRecord(value);
  const terminal = asRecord(result?.terminal) ?? result;
  if (!terminal || terminal.handle !== handle) return null;
  const worktreePath = worktreePathOf(terminal);
  if (!worktreePath) return null;
  return { handle, worktreePath, live: true };
}

function terminalCensus(value: unknown): { readonly rows: readonly TerminalRow[]; readonly handles: ReadonlySet<string> } | null {
  const result = asRecord(value);
  if (!result || result.truncated === true) return null;
  const terminals = result.terminals;
  if (!Array.isArray(terminals)) return null;
  if (typeof result.totalCount === 'number' && result.totalCount !== terminals.length) return null;
  const rows: TerminalRow[] = [];
  const handles = new Set<string>();
  for (const entry of terminals) {
    const row = asRecord(entry);
    const handle = typeof row?.handle === 'string' ? row.handle : '';
    const worktreePath = row ? worktreePathOf(row) : '';
    if (!handle || !worktreePath || handles.has(handle)) return null;
    const status = typeof row?.status === 'string' ? row.status.toLowerCase() : '';
    handles.add(handle);
    rows.push({ handle, worktreePath, live: !DEAD_STATUS.has(status) });
  }
  return { rows, handles };
}

function sameWorktree(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return path.resolve(left) === path.resolve(right);
  }
}

function worktreeMatchesProject(worktreePath: string, target: TargetContext): boolean {
  let resolved = '';
  try {
    resolved = realpathSync(worktreePath);
  } catch {
    return false;
  }
  if (resolved === realpathSync(target.primaryRoot)) return true;
  let pattern: RegExp;
  try {
    pattern = new RegExp(target.orcaWorkspacePattern, 'u');
  } catch {
    return false;
  }
  return pattern.test(worktreePath) || pattern.test(resolved);
}

function parseRun(value: unknown, runId: string): ParsedRun | null {
  const result = asRecord(value);
  const run = asRecord(result?.run);
  if (!run || run.id !== runId || !Object.prototype.hasOwnProperty.call(run, 'coordinator_handle')) return null;
  const coordinator = run.coordinator_handle;
  if (coordinator === null || coordinator === '') return { id: runId, coordinatorHandle: null };
  if (typeof coordinator !== 'string') return null;
  return { id: runId, coordinatorHandle: coordinator };
}

async function selectAssignment(
  target: TargetContext,
  runId: string,
  env: NodeJS.ProcessEnv,
  call: (args: readonly string[]) => Promise<unknown | NativeFailure>,
): Promise<WorkerAssignmentRecord | SelectionFailure> {
  const file = resolveWorkerAssignmentStorePath(target.projectId, env);
  const census = listCurrentWorkerAssignmentRecords(file);
  if (!census) return new SelectionFailure(`no trusted WorkerAssignment census for ${target.projectId} run ${runId}.`);
  const local = census.filter((row) => row.projectId === target.projectId
    && row.repository.toLowerCase() === target.repository
    && row.kind === 'local'
    && row.provider === 'orca'
    && row.role === 'orchestrator'
    && row.taskId.trim() !== ''
    && row.bindingKey.trim() !== ''
    && row.assignmentId.trim() !== ''
    && Number.isInteger(row.generation)
    && row.generation > 0);
  const listed = await call(['orchestration', 'task-list', '--run', runId, '--json']);
  if (listed instanceof NativeFailure) {
    return new SelectionFailure(`task-list for run ${runId} is unavailable (${listed.detail}).`);
  }
  const taskIds = taskIdsOf(listed);
  if (!taskIds) return new SelectionFailure(`task-list for run ${runId} is ambiguous.`);
  const members = local.filter((row) => taskIds.includes(row.taskId));
  const eligible: WorkerAssignmentRecord[] = [];
  for (const row of members) {
    const dispatch = await call(['orchestration', 'dispatch-show', '--task', row.taskId, '--json']);
    if (dispatch instanceof NativeFailure || !dispatchMatches(dispatch, row.taskId, row.bindingKey, runId)) continue;
    const worker = await call(['orchestration', 'worker-show', '--dispatch', row.bindingKey, '--json']);
    if (worker instanceof NativeFailure || !workerMatches(worker, row.taskId, row.bindingKey, runId)) continue;
    eligible.push(row);
  }
  if (eligible.length !== 1) {
    return new SelectionFailure(eligible.length === 0
      ? `no unique eligible local Orca orchestrator assignment for ${target.projectId} run ${runId}.`
      : `${String(eligible.length)} eligible local Orca orchestrator assignments for ${target.projectId} run ${runId}.`);
  }
  return eligible[0]!;
}

function taskIdsOf(value: unknown): readonly string[] | null {
  const result = asRecord(value);
  const tasks = result?.tasks;
  if (!Array.isArray(tasks)) return null;
  const ids: string[] = [];
  for (const task of tasks) {
    if (typeof task === 'string' && task) {
      ids.push(task);
      continue;
    }
    const row = asRecord(task);
    const id = typeof row?.id === 'string' ? row.id : typeof row?.taskId === 'string' ? row.taskId : '';
    if (!id) return null;
    ids.push(id);
  }
  return ids;
}

function idEquals(row: Record<string, unknown>, keys: readonly string[], expected: string): boolean {
  for (const key of keys) {
    if (key in row && row[key] !== expected) return false;
  }
  return keys.some((key) => row[key] === expected);
}

function dispatchMatches(value: unknown, taskId: string, bindingKey: string, runId: string): boolean {
  const result = asRecord(value);
  const dispatch = asRecord(result?.dispatch);
  if (!dispatch || dispatch.id !== bindingKey) return false;
  if (!idEquals(dispatch, ['taskId', 'task_id'], taskId)) return false;
  if (('runId' in dispatch && dispatch.runId !== runId) || ('run_id' in dispatch && dispatch.run_id !== runId)) return false;
  return true;
}

function workerMatches(value: unknown, taskId: string, bindingKey: string, runId: string): boolean {
  const result = asRecord(value);
  if (!result) return false;
  const nested = asRecord(result.dispatch);
  if (nested) return dispatchMatches(result, taskId, bindingKey, runId);
  if (!idEquals(result, ['dispatchId', 'dispatch_id'], bindingKey)) return false;
  if (!idEquals(result, ['taskId', 'task_id'], taskId)) return false;
  if (('runId' in result && result.runId !== runId) || ('run_id' in result && result.run_id !== runId)) return false;
  return true;
}

function fleetEnvFile(env: NodeJS.ProcessEnv, projectId: string): string {
  const home = (env.HOME ?? '').trim() || homedir();
  return path.join(home, '.config', 'orchestrator-fleet', `${projectId}.env`);
}

function writeProjectPin(
  env: NodeJS.ProcessEnv,
  projectId: string,
  handle: string,
): { readonly ok: true; readonly changed: boolean } | { readonly ok: false; readonly reason: string } {
  if (!HANDLE_RE.test(handle)) return { ok: false, reason: 'handle is not a simple pin value' };
  const file = fleetEnvFile(env, projectId);
  const directory = path.dirname(file);
  try {
    if (isSymlink(file) || isSymlink(directory)) return { ok: false, reason: 'pin path is a symlink' };
    if (exists(directory) && !lstatSync(directory).isDirectory()) return { ok: false, reason: 'pin directory is not a directory' };
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (isSymlink(file)) return { ok: false, reason: 'pin path is a symlink' };
    let current = '';
    if (exists(file)) {
      const info = lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink()) return { ok: false, reason: 'pin path is not a regular file' };
      current = readFileSync(file, 'utf8');
    }
    const rendered = renderPin(current, handle);
    if (!rendered.ok) return rendered;
    if (!rendered.changed && exists(file) && (lstatSync(file).mode & 0o777) === 0o600) {
      return { ok: true, changed: false };
    }
    const temporary = path.join(directory, `.${projectId}.env.${String(process.pid)}.${randomBytes(4).toString('hex')}`);
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      writeSync(fd, rendered.body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(temporary, file);
    } catch (error) {
      try { unlinkSync(temporary); } catch { /* the failed temp is best-effort */ }
      throw error;
    }
    chmodSync(file, 0o600);
    return { ok: true, changed: true };
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : 'pin write failed';
    return { ok: false, reason: code };
  }
}

function exists(file: string): boolean {
  try {
    lstatSync(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function isSymlink(file: string): boolean {
  try {
    return lstatSync(file).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function renderPin(
  current: string,
  handle: string,
): { readonly ok: true; readonly body: string; readonly changed: boolean } | { readonly ok: false; readonly reason: string } {
  const normalized = current.replace(/\r\n/gu, '\n');
  const hadTrailingNewline = normalized.endsWith('\n') || normalized === '';
  const lines = normalized === '' ? [] : normalized.replace(/\n$/u, '').split('\n');
  const pinIndexes = lines.flatMap((line, index) => /^\s*ORCH_HANDLE\b/u.test(line) ? [index] : []);
  if (pinIndexes.length > 1) return { ok: false, reason: 'duplicate ORCH_HANDLE' };
  let previous: string | null = null;
  if (pinIndexes.length === 1) {
    const match = /^\s*ORCH_HANDLE\s*=\s*(.*?)\s*$/u.exec(lines[pinIndexes[0]!] ?? '');
    if (!match) return { ok: false, reason: 'malformed ORCH_HANDLE' };
    let value = match[1] ?? '';
    if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
      value = value.slice(1, -1);
    }
    if (!value || /[\s'"\\\u0000-\u001f\u007f]/u.test(value)) return { ok: false, reason: 'malformed ORCH_HANDLE' };
    previous = value;
    lines[pinIndexes[0]!] = `ORCH_HANDLE=${handle}`;
  } else {
    lines.push(`ORCH_HANDLE=${handle}`);
  }
  const body = `${lines.join('\n')}${hadTrailingNewline || lines.length > 0 ? '\n' : ''}`;
  return { ok: true, body, changed: previous !== handle };
}

