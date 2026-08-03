import { spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { runProcessSync } from '../kernel/subprocess.ts';

/** Capture-backed Orca JSON field grounding for Issue #1061. */
export const ORCA_WORKER_SMOKE_CONTRACT_EVIDENCE_DIR =
  'tests/external-output-references/captures/orca-worker-smoke';

export const ORCA_SMOKE_CONTROL_PLANE_CODES = [
  'channel_stale_handle',
  'channel_lookup_empty',
  'channel_control_unavailable',
  'channel_control_overwritten',
] as const;

export type OrcaSmokeControlPlaneCode = (typeof ORCA_SMOKE_CONTROL_PLANE_CODES)[number];

export type OrcaOperationName =
  | 'status'
  | 'worktree_current'
  | 'worktree_remove'
  | 'terminal_list'
  | 'terminal_show'
  | 'terminal_create'
  | 'terminal_send'
  | 'terminal_read'
  | 'terminal_wait'
  | 'terminal_submit'
  | 'terminal_stop'
  | 'terminal_close';

export type OrcaLocalOutcomeCategory =
  | 'process_launch_failed'
  | 'empty_stdout'
  | 'invalid_json'
  | 'recognized_control_plane_code'
  | 'supported_operation_failure';

export interface OrcaJsonResponse<T = unknown> {
  ok: boolean;
  result?: T;
  error?: { code?: string; message?: string; [key: string]: unknown };
  operation?: OrcaOperationName;
  outcomeCategory?: OrcaLocalOutcomeCategory;
}

export interface OrcaWorktreeCurrent {
  worktree?: {
    path?: string;
    head?: string;
    branch?: string;
    linkedIssue?: number | null;
    id?: string;
  };
}

export interface OrcaTerminalHandle {
  handle: string;
  tabId?: string;
  leafId?: string;
  worktreeId?: string;
  worktreePath?: string;
  title?: string;
}

export interface OrcaTerminalReadResult {
  lines?: string[];
  nextCursor?: number;
  oldestCursor?: number;
}

export interface OrcaOperationFailure {
  ok: false;
  reason: string;
  operation: OrcaOperationName;
  outcomeCategory?: OrcaLocalOutcomeCategory;
  errorCode?: string;
}

export type OrcaWorktreeProbeResult =
  | {
    ok: true;
    worktreePath: string;
    headSha?: string;
    linkedIssue?: number | null;
  }
  | OrcaOperationFailure;

export type OrcaTerminalCreateResult =
  | { ok: true; terminal: OrcaTerminalHandle }
  | OrcaOperationFailure;

export interface OrcaRunOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly executable?: string;
  readonly runner?: typeof spawnSync;
  readonly timeoutMs?: number;
  readonly killSignal?: NodeJS.Signals;
}

const ORCA_CANDIDATES = ['orca-dev', 'orca-ide', 'orca'] as const;
const nativeCursorByCompatibilityToken = new Map<number, string | number>();
let nextCompatibilityToken = 1_000_000_000;

function requireStdout(result: ReturnType<typeof runProcessSync>): string {
  if (!result.ok) {
    throw new Error(result.stderr || result.error || 'process failed');
  }
  return result.stdout;
}

function errnoCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isOrcaSmokeControlPlaneCode(
  value: string | undefined,
): value is OrcaSmokeControlPlaneCode {
  return (ORCA_SMOKE_CONTROL_PLANE_CODES as readonly string[]).includes(value ?? '');
}

export function resolveOrcaOperation(args: readonly string[]): OrcaOperationName | undefined {
  if (args[0] === 'status') return 'status';
  if (args[0] === 'worktree' && args[1] === 'current') return 'worktree_current';
  if (args[0] === 'worktree' && (args[1] === 'rm' || args[1] === 'remove')) return 'worktree_remove';
  if (args[0] !== 'terminal') return undefined;
  if (args[1] === 'list') return 'terminal_list';
  if (args[1] === 'show') return 'terminal_show';
  if (args[1] === 'create') return 'terminal_create';
  if (args[1] === 'read') return 'terminal_read';
  if (args[1] === 'wait') return 'terminal_wait';
  if (args[1] === 'stop') return 'terminal_stop';
  if (args[1] === 'close') return 'terminal_close';
  if (args[1] === 'send') return args.includes('--text') ? 'terminal_send' : 'terminal_submit';
  return undefined;
}

export function findExecutableOnPath(name: string, pathEnv = process.env.PATH ?? ''): string | null {
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const full = join(dir, name);
    try {
      accessSync(full, constants.X_OK);
      return name;
    } catch {
      // Keep scanning PATH.
    }
  }
  return null;
}

export function resolveOrcaExecutable(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.ORCA_CLI_COMMAND?.trim();
  if (override) return override;
  const pathEnv = env.PATH ?? process.env.PATH ?? '';
  for (const candidate of ORCA_CANDIDATES) {
    if (findExecutableOnPath(candidate, pathEnv)) return candidate;
  }
  return 'orca';
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
      env: { ...process.env, ...options.env },
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      ...(options.timeoutMs === undefined ? {} : {
        timeout: options.timeoutMs,
        killSignal: options.killSignal ?? 'SIGKILL',
      }),
    });
  } catch (error) {
    return {
      ok: false,
      operation,
      outcomeCategory: 'process_launch_failed',
      error: {
        code: 'orca_process_launch_failed',
        message: error instanceof Error ? error.message : 'orca process launch failed',
      },
    };
  }
  if (result.error) {
    if (errnoCode(result.error) === 'ETIMEDOUT') {
      return {
        ok: false,
        operation,
        outcomeCategory: 'supported_operation_failure',
        error: {
          code: 'orca_operation_timeout',
          message: `orca ${args.join(' ')} exceeded ${options.timeoutMs ?? 0}ms`,
        },
      };
    }
    return {
      ok: false,
      operation,
      outcomeCategory: 'process_launch_failed',
      error: { code: 'orca_process_launch_failed', message: result.error.message },
    };
  }
  const stdout = String(result.stdout ?? '').trim();
  if (!stdout) {
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
  try {
    const parsed = JSON.parse(stdout) as OrcaJsonResponse<T>;
    if (parsed.ok) return { ...parsed, operation };
    const recognizedControlPlaneCode = isOrcaSmokeControlPlaneCode(parsed.error?.code);
    return {
      ...parsed,
      operation,
      outcomeCategory: recognizedControlPlaneCode
        ? 'recognized_control_plane_code'
        : 'supported_operation_failure',
    };
  } catch {
    return {
      ok: false,
      operation,
      outcomeCategory: 'invalid_json',
      error: { code: 'orca_invalid_json', message: stdout.slice(0, 500) },
    };
  }
}

export function probeOrcaWorktree(
  cwd: string,
  options: Pick<OrcaRunOptions, 'executable' | 'runner' | 'timeoutMs'> = {},
): OrcaWorktreeProbeResult {
  const response = runOrcaJson<OrcaWorktreeCurrent>(['worktree', 'current'], { cwd, ...options });
  if (!response.ok) {
    return {
      ok: false,
      operation: 'worktree_current',
      outcomeCategory: response.outcomeCategory,
      errorCode: response.error?.code,
      reason: response.error?.message ?? response.error?.code ?? 'worktree_current_failed',
    };
  }
  const worktree = response.result?.worktree;
  const worktreePath = worktree?.path?.trim();
  if (!worktreePath) {
    return {
      ok: false,
      operation: 'worktree_current',
      outcomeCategory: 'supported_operation_failure',
      errorCode: 'worktree_path_missing',
      reason: 'worktree_path_missing',
    };
  }
  let resolvedCwd = cwd;
  let resolvedWorktree = worktreePath;
  try {
    resolvedCwd = requireStdout(runProcessSync({ command: 'realpath', args: ['-e', cwd] })).trim();
    resolvedWorktree = requireStdout(runProcessSync({ command: 'realpath', args: ['-e', worktreePath] })).trim();
  } catch {
    return { ok: false, operation: 'worktree_current', reason: 'cwd_not_orca_managed_worktree' };
  }
  if (resolvedCwd !== resolvedWorktree) {
    return { ok: false, operation: 'worktree_current', reason: 'cwd_not_orca_managed_worktree' };
  }
  return {
    ok: true,
    worktreePath: resolvedWorktree,
    headSha: worktree?.head?.trim(),
    linkedIssue: worktree?.linkedIssue ?? null,
  };
}

export function createOrcaTerminal(input: {
  readonly cwd: string;
  readonly title: string;
  readonly command: string;
  readonly worktree?: string;
  readonly executable?: string;
  readonly runner?: typeof spawnSync;
  readonly timeoutMs?: number;
}): OrcaTerminalCreateResult {
  const response = runOrcaJson<{ terminal?: OrcaTerminalHandle }>([
    'terminal',
    'create',
    '--worktree',
    input.worktree ?? 'active',
    '--title',
    input.title,
    '--command',
    input.command,
  ], input);
  const handle = response.result?.terminal?.handle?.trim();
  if (!response.ok || !handle) {
    return {
      ok: false,
      operation: 'terminal_create',
      outcomeCategory: response.ok ? 'supported_operation_failure' : response.outcomeCategory,
      errorCode: response.ok ? 'terminal_handle_missing' : response.error?.code,
      reason: response.error?.message ?? response.error?.code ?? 'terminal_create_failed',
    };
  }
  return { ok: true, terminal: { ...response.result!.terminal!, handle } };
}

export function sendOrcaTerminal(
  handle: string,
  text: string,
  options: OrcaRunOptions = {},
): OrcaJsonResponse {
  return runOrcaJson(['terminal', 'send', '--terminal', handle, '--text', text, '--enter'], options);
}

export function submitOrcaTerminalComposer(
  handle: string,
  options: OrcaRunOptions = {},
): OrcaJsonResponse {
  return runOrcaJson(['terminal', 'send', '--terminal', handle, '--enter'], options);
}

function compatibilityCursor(nativeCursor: string | number): number {
  if (typeof nativeCursor === 'number' && Number.isSafeInteger(nativeCursor) && nativeCursor >= 0) {
    nativeCursorByCompatibilityToken.set(nativeCursor, nativeCursor);
    return nativeCursor;
  }
  const token = nextCompatibilityToken;
  nextCompatibilityToken += 1;
  nativeCursorByCompatibilityToken.set(token, nativeCursor);
  return token;
}

export function readOrcaTerminal(
  handle: string,
  options: OrcaRunOptions & { readonly cursor?: number; readonly limit?: number } = {},
): OrcaJsonResponse<OrcaTerminalReadResult> {
  const args = ['terminal', 'read', '--terminal', handle];
  if (options.cursor !== undefined) {
    args.push('--cursor', String(nativeCursorByCompatibilityToken.get(options.cursor) ?? options.cursor));
  }
  if (options.limit !== undefined) args.push('--limit', String(options.limit));
  const response = runOrcaJson<unknown>(args, options);
  if (!response.ok) return response as OrcaJsonResponse<OrcaTerminalReadResult>;
  const result = isObject(response.result) ? response.result : null;
  const terminal = result && isObject(result.terminal) ? result.terminal : null;
  const lines = Array.isArray(result?.lines)
    ? result.lines
    : Array.isArray(terminal?.tail)
      ? terminal.tail
      : null;
  const nativeNextCursor = result && 'nextCursor' in result
    ? result.nextCursor
    : terminal && 'nextCursor' in terminal
      ? terminal.nextCursor
      : undefined;
  const nativeOldestCursor = result && 'oldestCursor' in result
    ? result.oldestCursor
    : terminal && 'oldestCursor' in terminal
      ? terminal.oldestCursor
      : undefined;
  if (
    !lines
    || lines.some((line) => typeof line !== 'string')
    || (nativeNextCursor !== undefined && nativeNextCursor !== null
      && typeof nativeNextCursor !== 'string' && typeof nativeNextCursor !== 'number')
  ) {
    return {
      ok: false,
      operation: 'terminal_read',
      outcomeCategory: 'supported_operation_failure',
      error: {
        code: 'orca_terminal_read_unsupported',
        message: 'orca terminal read response shape is unsupported',
      },
    };
  }
  return {
    ok: true,
    operation: 'terminal_read',
    result: {
      lines: lines as string[],
      ...(nativeNextCursor === undefined || nativeNextCursor === null
        ? {}
        : { nextCursor: compatibilityCursor(nativeNextCursor) }),
      ...(typeof nativeOldestCursor === 'number'
        ? { oldestCursor: nativeOldestCursor }
        : {}),
    },
  };
}

export function waitOrcaTerminal(
  handle: string,
  input: OrcaRunOptions & { readonly for: 'exit' | 'tui-idle'; readonly timeoutMs: number },
): OrcaJsonResponse {
  return runOrcaJson(
    ['terminal', 'wait', '--terminal', handle, '--for', input.for, '--timeout-ms', String(input.timeoutMs)],
    { ...input, timeoutMs: input.timeoutMs + 1_000 },
  );
}

export function closeOrcaTerminal(
  handle: string,
  options: OrcaRunOptions = {},
): OrcaJsonResponse {
  return runOrcaJson(['terminal', 'close', '--terminal', handle], options);
}

export function orcaExecutableLooksAvailable(
  executable: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (executable.includes('/') || executable.includes('\\')) {
    try {
      accessSync(executable, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  return findExecutableOnPath(executable, env.PATH ?? process.env.PATH ?? '') !== null;
}
