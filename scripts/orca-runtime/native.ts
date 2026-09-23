import { accessSync, constants, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, delimiter, join } from 'node:path';

export const orcaWorkerSmokeContractEvidenceDir =
  'tests/external-output-references/captures/orca-worker-smoke';

export const orcaSmokeControlPlaneCodes = [
  'channel_stale_handle',
  'channel_lookup_empty',
  'channel_control_unavailable',
  'channel_control_overwritten',
] as const;

export type OrcaSmokeControlPlaneCode = (typeof orcaSmokeControlPlaneCodes)[number];

export type OrcaOperationName =
  | 'worktree_current'
  | 'worktree_show'
  | 'worktree_remove'
  | 'terminal_create'
  | 'terminal_list'
  | 'terminal_show'
  | 'terminal_send'
  | 'terminal_read'
  | 'terminal_wait'
  | 'terminal_submit'
  | 'terminal_close'
  | 'orchestration_check';

export type OrcaLocalOutcomeCategory =
  | 'process_launch_failed'
  | 'process_signaled'
  | 'empty_stdout'
  | 'invalid_json'
  | 'recognized_control_plane_code'
  | 'supported_operation_failure';

export interface OrcaJsonResponse<T = unknown> {
  ok: boolean;
  result?: T;
  error?: { code?: string; message?: string };
  operation?: OrcaOperationName;
  outcomeCategory?: OrcaLocalOutcomeCategory;
  signal?: NodeJS.Signals;
}

export interface OrcaWorktreeSummary {
  path?: string;
  head?: string;
  branch?: string;
  linkedIssue?: number | null;
  id?: string;
}

export interface OrcaWorktreeCurrent {
  worktree?: OrcaWorktreeSummary;
}

export interface OrcaWorktreeShow {
  worktree?: OrcaWorktreeSummary;
}

export interface OrcaWorktreeRemoveResult {
  removed?: boolean;
  worktree?: OrcaWorktreeSummary;
}

export interface OrcaTerminalHandle {
  handle: string;
  tabId?: string;
  worktreeId?: string;
  title?: string | null;
  command?: string | null;
  ptyId?: string | null;
  incarnationId?: string | null;
}

export interface OrcaTerminalSummary extends OrcaTerminalHandle {
  worktreePath?: string;
  connected?: boolean;
  writable?: boolean;
  status?: 'running' | 'exited' | 'unknown';
}

/** Project an OpenCode command only from the process bound to this exact Orca terminal identity. */
export function projectLiveOpenCodeCommand(
  terminal: Pick<OrcaTerminalSummary, 'handle' | 'worktreeId'>,
  procRoot = '/proc',
  platform = process.platform,
): string | undefined {
  if (platform !== 'linux' || !terminal.handle.trim() || !terminal.worktreeId?.trim()) return undefined;
  let processes;
  try {
    processes = readdirSync(procRoot, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const matches: string[] = [];
  for (const entry of processes) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
    const processRoot = join(procRoot, entry.name);
    try {
      const environment = new Map<string, string>();
      for (const variable of readFileSync(join(processRoot, 'environ'), 'utf8').split('\0')) {
        const separator = variable.indexOf('=');
        if (separator > 0) environment.set(variable.slice(0, separator), variable.slice(separator + 1));
      }
      if (environment.get('ORCA_TERMINAL_HANDLE') !== terminal.handle) continue;
      if (environment.get('ORCA_WORKTREE_ID') !== terminal.worktreeId) continue;
      const argv = readFileSync(join(processRoot, 'cmdline'), 'utf8').split('\0').filter(Boolean);
      const executable = argv[0] ? basename(argv[0]) : '';
      if (executable !== 'opencode') continue;
      matches.push([executable, ...argv.slice(1)].join(' '));
    } catch {
      // Process exit or access denial makes this candidate unavailable, not authoritative.
    }
  }
  return matches.length === 1 ? matches[0] : undefined;
}

export interface OrcaTerminalReadResult {
  /** Legacy pack capture shape. */
  lines?: string[];
  nextCursor?: string | number | null;
  oldestCursor?: string | number;
  source?: 'screen' | 'stream' | 'unknown';
  /** Current upstream Orca shape. */
  terminal?: {
    handle?: string;
    status?: 'running' | 'exited' | 'unknown';
    tail?: string[];
    nextCursor?: string | null;
    oldestCursor?: string;
    latestCursor?: string;
    source?: 'screen' | 'stream' | 'unknown';
  };
}

export interface OrcaTerminalWaitResult {
  wait?: {
    handle?: string;
    condition?: 'exit' | 'tui-idle';
    satisfied?: boolean;
    status?: 'running' | 'exited' | 'unknown';
    exitCode?: number | null;
  };
}

export interface OrcaRunOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly executable?: string;
  readonly runner?: typeof spawnSync;
  readonly timeoutMs?: number;
  readonly killSignal?: NodeJS.Signals;
  readonly inheritParentEnv?: boolean;
}

const orcaCandidates = ['orca-dev', 'orca-ide', 'orca'] as const;

function errnoCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function resultSignal(result: ReturnType<typeof spawnSync>): NodeJS.Signals | undefined {
  return typeof result.signal === 'string' && result.signal.trim()
    ? result.signal as NodeJS.Signals
    : undefined;
}

export function orcaProcessSignaledError(
  signal: NodeJS.Signals,
): NonNullable<OrcaJsonResponse['error']> {
  return {
    code: 'orca_process_signaled',
    message: `orca process interrupted by ${signal}`,
  };
}

function signaledResponse<T>(
  operation: OrcaOperationName | undefined,
  signal: NodeJS.Signals,
): OrcaJsonResponse<T> {
  return {
    ok: false,
    operation,
    outcomeCategory: 'process_signaled',
    signal,
    error: orcaProcessSignaledError(signal),
  };
}

function operationTimeoutResponse<T>(
  operation: OrcaOperationName | undefined,
  args: readonly string[],
  timeoutMs: number | undefined,
): OrcaJsonResponse<T> {
  return {
    ok: false,
    operation,
    outcomeCategory: 'supported_operation_failure',
    error: {
      code: 'orca_operation_timeout',
      message: `orca ${args.join(' ')} exceeded ${timeoutMs ?? 0}ms`,
    },
  };
}

function processLaunchFailedResponse<T>(
  operation: OrcaOperationName | undefined,
  message: string,
): OrcaJsonResponse<T> {
  return {
    ok: false,
    operation,
    outcomeCategory: 'process_launch_failed',
    error: { code: 'orca_process_launch_failed', message },
  };
}

export function isOrcaSmokeControlPlaneCode(
  value: string | undefined,
): value is OrcaSmokeControlPlaneCode {
  return (orcaSmokeControlPlaneCodes as readonly string[]).includes(value ?? '');
}

export function resolveOrcaOperation(args: readonly string[]): OrcaOperationName | undefined {
  if (args[0] === 'worktree' && args[1] === 'current') return 'worktree_current';
  if (args[0] === 'worktree' && args[1] === 'show') return 'worktree_show';
  if (args[0] === 'worktree' && args[1] === 'rm') return 'worktree_remove';
  if (args[0] === 'orchestration' && args[1] === 'check') return 'orchestration_check';
  if (args[0] !== 'terminal') return undefined;
  if (args[1] === 'create') return 'terminal_create';
  if (args[1] === 'list') return 'terminal_list';
  if (args[1] === 'show') return 'terminal_show';
  if (args[1] === 'read') return 'terminal_read';
  if (args[1] === 'wait') return 'terminal_wait';
  if (args[1] === 'close') return 'terminal_close';
  if (args[1] === 'send') return args.includes('--text') ? 'terminal_send' : 'terminal_submit';
  return undefined;
}

export function findExecutableOnPath(name: string, pathEnv = process.env.PATH ?? ''): string | null {
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, name), constants.X_OK);
      return name;
    } catch {
      // Keep scanning PATH.
    }
  }
  return null;
}

export function resolveOrcaExecutable(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OPK_RUNTIME_CLI_COMMAND?.trim();
  if (override) return override;
  const pathEnv = env.PATH ?? process.env.PATH ?? '';
  for (const candidate of orcaCandidates) {
    if (findExecutableOnPath(candidate, pathEnv)) return candidate;
  }
  return 'orca';
}

export function parseOrcaJsonOutput<T>(
  stdout: string | Buffer,
  operation: OrcaJsonResponse['operation'],
): OrcaJsonResponse<T> {
  const normalized = String(stdout).trim();
  try {
    const parsed = JSON.parse(normalized) as OrcaJsonResponse<T>;
    if (parsed.ok) {
      if (operation === 'terminal_show' && parsed.result && typeof parsed.result === 'object') {
        const result = parsed.result as { terminal?: OrcaTerminalSummary; [key: string]: unknown };
        const terminal = result.terminal;
        if (terminal && typeof terminal === 'object' && !terminal.command?.trim()) {
          const command = projectLiveOpenCodeCommand(terminal);
          if (command) {
            return { ...parsed, operation, result: { ...result, terminal: { ...terminal, command } } as T };
          }
        }
      }
      return { ...parsed, operation };
    }
    return {
      ...parsed,
      operation,
      outcomeCategory: isOrcaSmokeControlPlaneCode(parsed.error?.code)
        ? 'recognized_control_plane_code'
        : 'supported_operation_failure',
    };
  } catch {
    return {
      ok: false,
      operation,
      outcomeCategory: 'invalid_json',
      error: { code: 'orca_invalid_json', message: normalized.slice(0, 500) },
    };
  }
}

export function runOrcaJson<T>(
  args: readonly string[],
  options: OrcaRunOptions = {},
): OrcaJsonResponse<T> {
  const runner = options.runner ?? spawnSync;
  const executable = options.executable ?? resolveOrcaExecutable(options.env);
  const operation = resolveOrcaOperation(args);
  let result: ReturnType<typeof spawnSync>;
  try {
    result = runner(executable, [...args, '--json'], {
      cwd: options.cwd ?? process.cwd(),
      env: options.inheritParentEnv === false
        ? { ...options.env }
        : { ...process.env, ...options.env },
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      ...(options.timeoutMs === undefined ? {} : {
        timeout: options.timeoutMs,
        killSignal: options.killSignal ?? 'SIGKILL',
      }),
    });
  } catch (error) {
    return processLaunchFailedResponse<T>(
      operation,
      error instanceof Error ? error.message : 'orca process launch failed',
    );
  }
  if (result.error && errnoCode(result.error) === 'ETIMEDOUT') {
    return operationTimeoutResponse<T>(operation, args, options.timeoutMs);
  }
  const signal = resultSignal(result);
  if (signal) return signaledResponse<T>(operation, signal);
  if (result.error) {
    return processLaunchFailedResponse<T>(operation, result.error.message);
  }
  const stdout = String(result.stdout ?? '').trim();
  if (!stdout) {
    if (result.status !== 0) {
      return {
        ok: false,
        operation,
        outcomeCategory: 'supported_operation_failure',
        error: {
          code: 'orca_process_exit_without_output',
          message: `orca ${args.join(' ')} exited without JSON output`,
        },
      };
    }
    return {
      ok: false,
      operation,
      outcomeCategory: 'empty_stdout',
      error: {
        code: 'orca_empty_stdout',
        message: String(result.stderr ?? '').trim() || `orca ${args.join(' ')} produced no output`,
      },
    };
  }
  return parseOrcaJsonOutput<T>(stdout, operation);
}

export function orcaExecutableLooksAvailable(
  executable: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (executable.includes('/')) {
    try {
      accessSync(executable, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  return findExecutableOnPath(executable, env.PATH ?? process.env.PATH ?? '') !== null;
}
