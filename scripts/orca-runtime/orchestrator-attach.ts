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
import { orcaJsonArgv, resolveOrcaExecutable } from './native.ts';
import { resolveTargetContext, TargetContextError, type TargetContext } from '../lib/target-context.ts';

const USAGE = [
  'usage: scripts/opk-orch-start resume <existing-session-id>',
  '       scripts/opk-orch-start attach <terminal-handle> [project-id]',
  '       scripts/opk-orch-start precheck [project-id]',
  '',
].join('\n');

const RUN_ID_RE = /^run_[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u;
const HANDLE_RE = /^[A-Za-z][A-Za-z0-9._:-]{0,199}$/u;
const PROJECT_CORRECTION = 'correct the handle/project/Orca runtime and retry';
const RUN_ID_CORRECTION = 'set OPK_RUN_ID to the existing Run and retry';
const LIST_CORRECTION = 'restore Orca terminal visibility, inspect this Run and retry';
const READBACK_CORRECTION = 'inspect the exact Run and retry the restore only after resolving its coordinator';
const SELECTION_CORRECTION = 'reconcile the exact existing project Run natively, put one literal OPK_RUN_ID=<run id> entry in the selected project file ~/.config/orchestrator-fleet/<projectId>.env, then retry';
const CALLER_CORRECTION = 'invoke attach from the designated seat: its runtime-issued ORCA_TERMINAL_HANDLE must equal the requested handle';
const PIN_CORRECTION = 'close that terminal or attach from it, or reconcile the selected project pin, then retry';

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
  readonly pin: 'written' | 'unchanged' | 'refused' | 'not-attempted';
  readonly partial?: {
    readonly runRebound: boolean | 'unknown';
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
    const result = await runProcess({
      command: resolveOrcaExecutable(env),
      args,
      env,
      inheritParentEnv: false,
    });
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
  if (command === 'precheck') {
    const check = await checkOrchestratorPrelaunch({
      argv,
      env,
      ...(dependencies.runNative ? { runNative: dependencies.runNative } : {}),
    });
    stdout(`${JSON.stringify(check)}\n`);
    if (!check.ok) stderr(`${check.message}\n`);
    return check.ok ? 0 : 1;
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
  };
  if (!HANDLE_RE.test(requestedHandle) || input.argv.length > 3 || input.argv[0] !== 'attach') {
    return refuse({ ...base, message: USAGE.trim() });
  }
  const env = input.env ?? process.env;
  const projectArg = input.argv[2]?.trim() ?? '';
  if (projectArg.startsWith('-')) {
    return refuse({ ...base, message: PROJECT_CORRECTION });
  }
  let target: TargetContext;
  try {
    target = resolveTargetContext({
      ...(projectArg ? { projectId: projectArg } : {}),
      env,
    });
  } catch (error) {
    const detail = error instanceof TargetContextError ? error.message : 'project selection failed';
    return refuse({ ...base, message: `${PROJECT_CORRECTION} (${detail})` });
  }

  // The selected Run is the operator's literal OPK_RUN_ID in the selected project file;
  // the caller's inherited OPK_RUN_ID must equal it. Never inferred from a handle or row.
  const selection = readSelectedProjectFile(fleetEnvFile(env, target.projectId));
  if (!selection.ok) {
    return refuse({ ...base, message: `${selection.reason}. ${SELECTION_CORRECTION}` });
  }
  const runId = selection.runId;
  const callerRun = (env.OPK_RUN_ID ?? '').trim();
  if (callerRun !== runId) {
    return refuse({ ...base, runId, message: `caller OPK_RUN_ID does not equal the selected project Run. ${RUN_ID_CORRECTION}` });
  }
  // Runtime-issued caller identity: native run-use binds the invoking terminal.
  if ((env.ORCA_TERMINAL_HANDLE ?? '').trim() !== requestedHandle) {
    return refuse({ ...base, runId, message: CALLER_CORRECTION });
  }

  const runNative = input.runNative ?? orcaCommand(env);
  let runUseCount = 0;
  const call = async (args: readonly string[]): Promise<unknown | null> => {
    const logical = args[args.length - 1] === '--json' ? args.slice(0, -1) : args;
    const argv = orcaJsonArgv(logical);
    if (logical[0] === 'orchestration' && logical[1] === 'run-use') runUseCount += 1;
    let result: NativeCommandResult;
    try {
      result = await runNative(argv);
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
  const oldRow = currentRun.coordinatorHandle
    ? census.rows.find((row) => row.handle === currentRun.coordinatorHandle)
    : undefined;
  if (!sameHandle && oldRow) {
    return refuse({
      ...base,
      runId,
      runUseCount,
      coordinatorHandle: currentRun.coordinatorHandle,
      message: oldRow.live
        ? `close ${currentRun.coordinatorHandle} or attach from it`
        : `former coordinator ${currentRun.coordinatorHandle} is still listed. ${LIST_CORRECTION}`,
    });
  }
  // A pin naming another still-listed terminal is a conflicting live seat; a pin
  // absent from the complete census is stale and repairable.
  if (selection.handle !== null && selection.handle !== requestedHandle
    && census.rows.some((row) => row.handle === selection.handle)) {
    return refuse({
      ...base,
      runId,
      runUseCount,
      coordinatorHandle: currentRun.coordinatorHandle,
      pin: 'refused',
      message: `selected pin names ${selection.handle}, which is still listed. ${PIN_CORRECTION}`,
    });
  }

  let coordinatorHandle = currentRun.coordinatorHandle;
  let runRebound: boolean | 'unknown' = false;
  const pinRedirect = redirectedPinAncestor(env, target.projectId);
  if (pinRedirect) {
    return refuse({
      ...base,
      runId,
      runUseCount,
      coordinatorHandle,
      pin: 'refused',
      message: `selected pin path is redirected (${pinRedirect}). Repair the selected project pin and retry; do not repeat run-use.`,
    });
  }
  // The selected pair can change while the awaited native reads run; recheck it before each effect.
  const selectionChanged = (): string | null => {
    const now = readSelectedProjectFile(fleetEnvFile(env, target.projectId));
    if (!now.ok) return `selected project file changed or unreadable (${now.reason})`;
    if (now.runId !== runId || now.handle !== selection.handle) return 'selected project file changed during attach';
    return null;
  };
  if (!sameHandle) {
    const changedBeforeUse = selectionChanged();
    if (changedBeforeUse) {
      return refuse({
        ...base, runId, runUseCount, coordinatorHandle, pin: 'refused',
        message: `${changedBeforeUse}; nothing was changed. ${SELECTION_CORRECTION}`,
      });
    }
    const used = await call(['orchestration', 'run-use', '--id', runId, '--json']);
    if (used instanceof NativeFailure) {
      return refuse({
        ...base,
        runId,
        runUseCount,
        coordinatorHandle,
        message: `run-use reported failure (${used.detail}); the Run coordinator is unverified. ${READBACK_CORRECTION}`,
        partial: { runRebound: 'unknown', pin: 'not-attempted' },
      });
    }
    const readback = await call(['orchestration', 'run-show', '--id', runId, '--full', '--json']);
    const confirmed = readback instanceof NativeFailure ? null : parseRun(readback, runId);
    if (!confirmed || confirmed.coordinatorHandle !== requestedHandle) {
      const observed = confirmed ? String(confirmed.coordinatorHandle) : 'unknown';
      const positivelyUnchanged = confirmed !== null && confirmed.coordinatorHandle === currentRun.coordinatorHandle;
      return refuse({
        ...base,
        runId,
        runUseCount,
        coordinatorHandle: confirmed?.coordinatorHandle ?? null,
        message: confirmed
          ? `run-show coordinator is ${observed} after one run-use. ${READBACK_CORRECTION}`
          : `run-use was invoked but run-show did not confirm the coordinator. ${READBACK_CORRECTION}`,
        partial: {
          runRebound: positivelyUnchanged ? false : 'unknown',
          pin: 'not-attempted',
        },
      });
    }
    coordinatorHandle = confirmed.coordinatorHandle;
    runRebound = true;
  }

  // Only ORCH_HANDLE is written; the operator's OPK_RUN_ID and other entries are preserved.
  const changedBeforePin = selectionChanged();
  if (changedBeforePin) {
    return refuse({
      ...base, runId, runUseCount, coordinatorHandle, pin: 'refused',
      message: `${runRebound ? `run ${runId} is bound to ${requestedHandle}; ` : ''}${changedBeforePin}; pin not written. Repair the selected project file and retry; do not repeat run-use.`,
      partial: { runRebound, pin: 'selection-changed' },
    });
  }
  const pin = writeProjectPin(env, target.projectId, requestedHandle, runId);
  if (!pin.ok) {
    return refuse({
      ...base,
      runId,
      runUseCount,
      coordinatorHandle,
      pin: 'refused',
      message: `${runRebound ? `run ${runId} is bound to ${requestedHandle}; ` : ''}pin not written (${pin.reason}). Repair the selected project pin and retry; do not repeat run-use.`,
      partial: { runRebound, pin: pin.reason },
    });
  }
  const pinState = pin.changed ? 'written' : 'unchanged';
  return {
    ok: true,
    requestedHandle,
    runId,
    coordinatorHandle,
    runUseCount,
    pin: pinState,
    message: pin.changed
      ? `Run bound / pin written; fleet-wake adoption not verified`
      : `Run bound / pin unchanged; fleet-wake adoption not verified`,
  };
}

export interface PrelaunchReport {
  readonly ok: boolean;
  readonly message: string;
  readonly runId?: string;
  readonly incumbentHandle?: string;
}

/**
 * Read-only pre-launch check for the operator-local launcher: refuses before any seat/Run/unit
 * is created when the operator-selected Run still has a live coordinator or the pin names one.
 * It covers the configured Run and bound pin only, never other Runs or simultaneous starts.
 */
export async function checkOrchestratorPrelaunch(input: {
  readonly argv: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly runNative?: NativeCommand;
}): Promise<PrelaunchReport> {
  const env = input.env ?? process.env;
  const projectArg = input.argv[1]?.trim() ?? '';
  if (input.argv[0] !== 'precheck' || input.argv.length > 2 || projectArg.startsWith('-')) {
    return { ok: false, message: USAGE.trim() };
  }
  let target: TargetContext;
  try {
    target = resolveTargetContext({ ...(projectArg ? { projectId: projectArg } : {}), env });
  } catch (error) {
    const detail = error instanceof TargetContextError ? error.message : 'project selection failed';
    return { ok: false, message: `${PROJECT_CORRECTION} (${detail})` };
  }
  const selection = readSelectedProjectFile(fleetEnvFile(env, target.projectId));
  if (!selection.ok) return { ok: false, message: `${selection.reason}. ${SELECTION_CORRECTION}` };
  const runId = selection.runId;
  const runNative = input.runNative ?? orcaCommand(env);
  const read = async (logical: readonly string[]): Promise<unknown | null> => {
    try {
      const result = await runNative(orcaJsonArgv(logical));
      if (result.code !== 0) return null;
      const parsed = JSON.parse(result.stdout) as unknown;
      const record = asRecord(parsed);
      if (!record || record.ok === false) return null;
      return record.result ?? record;
    } catch {
      return null;
    }
  };
  const listed = await read(['terminal', 'list']);
  const census = listed === null ? null : terminalCensus(listed);
  if (!census) return { ok: false, runId, message: `terminal census is unreadable. ${LIST_CORRECTION}` };
  const shownRun = await read(['orchestration', 'run-show', '--id', runId, '--full']);
  const run = shownRun === null ? null : parseRun(shownRun, runId);
  if (!run) return { ok: false, runId, message: `Run ${runId} is unreadable. ${READBACK_CORRECTION}` };
  const live = (handle: string | null): boolean => handle !== null
    && census.rows.some((row) => row.handle === handle && row.live);
  const listedHandle = (handle: string | null): boolean => handle !== null
    && census.rows.some((row) => row.handle === handle);
  if (live(run.coordinatorHandle)) {
    return {
      ok: false,
      runId,
      incumbentHandle: run.coordinatorHandle ?? '',
      message: `live incumbent coordinator ${String(run.coordinatorHandle)} for Run ${runId}; close it or attach from it`,
    };
  }
  if (selection.handle !== null && listedHandle(selection.handle)) {
    return {
      ok: false,
      runId,
      incumbentHandle: selection.handle,
      message: `selected pin names ${selection.handle}, which is still listed but is not the Run coordinator. ${PIN_CORRECTION}`,
    };
  }
  if (listedHandle(run.coordinatorHandle)) {
    return {
      ok: false,
      runId,
      message: `former coordinator ${String(run.coordinatorHandle)} is still listed. ${LIST_CORRECTION}`,
    };
  }
  return {
    ok: true,
    runId,
    message: `no live configured incumbent for Run ${runId}; other Runs/seats of this project and simultaneous starts are not checked`,
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

function refuse(input: {
  readonly message: string;
  readonly requestedHandle: string;
  readonly runId?: string;
  readonly coordinatorHandle?: string | null;
  readonly runUseCount: number;
  readonly pin?: AttachReport['pin'];
  readonly partial?: AttachReport['partial'];
}): AttachReport {
  return {
    ok: false,
    message: input.message,
    requestedHandle: input.requestedHandle,
    runUseCount: input.runUseCount,
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

const LIVE_TERMINAL_STATUS = new Set(['running', 'active', 'open', 'connected']);

function rowIsLive(row: Record<string, unknown>): boolean {
  const status = typeof row.status === 'string' ? row.status.toLowerCase() : '';
  if (LIVE_TERMINAL_STATUS.has(status)) return true;
  if (status) return false;
  return row.connected === true;
}

function terminalCensus(value: unknown): { readonly rows: readonly TerminalRow[]; readonly handles: ReadonlySet<string> } | null {
  const result = asRecord(value);
  if (!result || result.truncated !== false) return null;
  const terminals = result.terminals;
  if (!Array.isArray(terminals)) return null;
  if (!Number.isInteger(result.totalCount) || Number(result.totalCount) < 0 || result.totalCount !== terminals.length) return null;
  const rows: TerminalRow[] = [];
  const handles = new Set<string>();
  for (const entry of terminals) {
    const row = asRecord(entry);
    const handle = typeof row?.handle === 'string' ? row.handle : '';
    const worktreePath = row ? worktreePathOf(row) : '';
    if (!row || !handle || !worktreePath || handles.has(handle)) return null;
    handles.add(handle);
    rows.push({ handle, worktreePath, live: rowIsLive(row) });
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
  try {
    return realpathSync(worktreePath) === realpathSync(target.primaryRoot);
  } catch {
    return false;
  }
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

/** The selected project file (~/.config/orchestrator-fleet/<id>.env) that owns OPK_RUN_ID and ORCH_HANDLE. */
export function fleetEnvFile(env: NodeJS.ProcessEnv, projectId: string): string {
  const home = (env.HOME ?? '').trim() || homedir();
  return path.join(home, '.config', 'orchestrator-fleet', `${projectId}.env`);
}

function writeProjectPin(
  env: NodeJS.ProcessEnv,
  projectId: string,
  handle: string,
  expectedRunId: string,
): { readonly ok: true; readonly changed: boolean } | { readonly ok: false; readonly reason: string } {
  if (!HANDLE_RE.test(handle)) return { ok: false, reason: 'handle is not a simple pin value' };
  const file = fleetEnvFile(env, projectId);
  // The operator-selected Run must still be the one in the file; a missing or changed file is
  // never recreated or overwritten from a stale selection.
  const before = readSelectedProjectFile(file);
  if (!before.ok) return { ok: false, reason: `selected project file changed during attach (${before.reason})` };
  if (before.runId !== expectedRunId) return { ok: false, reason: 'selected project Run changed during attach' };
  const directory = path.dirname(file);
  try {
    const redirected = redirectedPinAncestor(env, projectId);
    if (redirected) return { ok: false, reason: redirected };
    if (exists(directory) && !lstatSync(directory).isDirectory()) return { ok: false, reason: 'pin directory is not a directory' };
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    let current = '';
    if (exists(file)) {
      const info = lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink()) return { ok: false, reason: 'pin path is not a regular file' };
      current = readFileSync(file, 'utf8');
    }
    const rendered = renderPin(current, handle);
    if (!rendered.ok) return rendered;
    if (!rendered.changed && exists(file) && (lstatSync(file).mode & 0o777) === 0o600) {
      return readBackPin(file, expectedRunId, handle, false);
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
    return readBackPin(file, expectedRunId, handle, true);
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : 'pin write failed';
    return { ok: false, reason: code };
  }
}

/** After a pin write the file must still hold exactly the selected Run and the requested pin. */
function readBackPin(
  file: string, runId: string, handle: string, changed: boolean,
): { readonly ok: true; readonly changed: boolean } | { readonly ok: false; readonly reason: string } {
  const after = readSelectedProjectFile(file);
  if (!after.ok || after.runId !== runId || after.handle !== handle) {
    return { ok: false, reason: 'pin readback did not match the selected Run and requested handle' };
  }
  return { ok: true, changed };
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

function redirectedPinAncestor(env: NodeJS.ProcessEnv, projectId: string): string | null {
  let current = path.resolve(fleetEnvFile(env, projectId));
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    if (isSymlink(current)) return 'pin path is a symlink';
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function isSymlink(file: string): boolean {
  try {
    return lstatSync(file).isSymbolicLink();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
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


export type SelectedProjectFile =
  | { readonly ok: true; readonly runId: string; readonly handle: string | null }
  | { readonly ok: false; readonly reason: string };

type EntryRead = { readonly status: 'absent' } | { readonly status: 'bad'; readonly reason: string } | { readonly status: 'ok'; readonly value: string };

function readEntry(lines: readonly string[], key: string): EntryRead {
  const matching = lines.filter((line) => new RegExp(`^\\s*${key}\\b`, 'u').test(line));
  if (matching.length === 0) return { status: 'absent' };
  if (matching.length > 1) return { status: 'bad', reason: `duplicate ${key}` };
  const match = new RegExp(`^\\s*${key}\\s*=\\s*(.*?)\\s*$`, 'u').exec(matching[0]!);
  if (!match) return { status: 'bad', reason: `malformed ${key}` };
  let value = match[1] ?? '';
  if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
    value = value.slice(1, -1);
  }
  if (!value || /[\s'"\\\u0000-\u001f\u007f]/u.test(value)) return { status: 'bad', reason: `malformed ${key}` };
  return { status: 'ok', value };
}

/**
 * Strict read of the operator-selected pair in the selected project file: exactly one literal
 * OPK_RUN_ID (required) and at most one ORCH_HANDLE. Redirected, duplicate, malformed, absent or
 * unreadable input is a refusal, never a guess. Read fresh at each effect boundary.
 */
export function readSelectedProjectFile(file: string): SelectedProjectFile {
  try {
    let current = path.resolve(file);
    const seen = new Set<string>();
    while (!seen.has(current)) {
      seen.add(current);
      if (isSymlink(current)) return { ok: false, reason: 'selected project file path is redirected' };
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    const info = lstatSync(file);
    if (!info.isFile()) return { ok: false, reason: 'selected project file is not a regular file' };
    const lines = readFileSync(file, 'utf8').replace(/\r\n/gu, '\n').split('\n');
    const run = readEntry(lines, 'OPK_RUN_ID');
    if (run.status === 'absent') return { ok: false, reason: 'selected project file has no OPK_RUN_ID' };
    if (run.status === 'bad') return { ok: false, reason: `selected project file: ${run.reason}` };
    if (!RUN_ID_RE.test(run.value)) return { ok: false, reason: 'selected project file: malformed OPK_RUN_ID' };
    const pin = readEntry(lines, 'ORCH_HANDLE');
    if (pin.status === 'bad') return { ok: false, reason: `selected project file: ${pin.reason}` };
    if (pin.status === 'ok' && !HANDLE_RE.test(pin.value)) return { ok: false, reason: 'selected project file: malformed ORCH_HANDLE' };
    return { ok: true, runId: run.value, handle: pin.status === 'ok' ? pin.value : null };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { ok: false, reason: `selected project file is unreadable (${typeof code === 'string' ? code : 'error'})` };
  }
}

/** Current Run coordinator from native `run-show --full`, or undefined when unreadable. */
export function parseRunCoordinator(value: unknown, runId: string): string | null | undefined {
  const record = asRecord(value);
  const result = asRecord(record?.result) ?? record;
  const parsed = parseRun(result, runId);
  return parsed ? parsed.coordinatorHandle : undefined;
}

/** Synchronous native `run-show --full` read of the Run coordinator; undefined when unreadable. */
export function readRunCoordinatorVia(
  executor: (args: readonly string[]) => { readonly ok: boolean; readonly stdout: string },
  runId: string,
): string | null | undefined {
  try {
    const response = executor(['orchestration', 'run-show', '--id', runId, '--full', '--json']);
    if (!response.ok) return undefined;
    return parseRunCoordinator(JSON.parse(response.stdout) as unknown, runId);
  } catch { return undefined; }
}
