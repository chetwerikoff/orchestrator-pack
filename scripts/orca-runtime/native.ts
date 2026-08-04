import { accessSync, constants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { delimiter, join } from 'node:path';

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
  error?: { code?: string; message?: string };
  operation?: OrcaOperationName;
  outcomeCategory?: OrcaLocalOutcomeCategory;
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
  ptyId?: string | null;
  incarnationId?: string | null;
}

export interface OrcaTerminalSummary extends OrcaTerminalHandle {
  worktreePath?: string;
  connected?: boolean;
  writable?: boolean;
  status?: 'running' | 'exited' | 'unknown';
}

export interface OrcaTerminalReadResult {
  /** Legacy pack capture shape. */
  lines?: string[];
  nextCursor?: string | number | null;
  oldestCursor?: string | number;
  /** Current upstream Orca shape. */
  terminal?: {
    handle?: string;
    status?: 'running' | 'exited' | 'unknown';
    tail?: string[];
    nextCursor?: string | null;
    oldestCursor?: string;
    latestCursor?: string;
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
}

const ORCA_CANDIDATES = ['orca-dev', 'orca-ide', 'orca'] as const;

function errnoCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

export function isOrcaSmokeControlPlaneCode(
  value: string | undefined,
): value is OrcaSmokeControlPlaneCode {
  return (ORCA_SMOKE_CONTROL_PLANE_CODES as readonly string[]).includes(value ?? '');
}

export function resolveOrcaOperation(args: readonly string[]): OrcaOperationName | undefined {
  if (args[0] === 'worktree' && args[1] === 'current') return 'worktree_current';
  if (args[0] === 'worktree' && args[1] === 'show') return 'worktree_show';
  if (args[0] === 'worktree' && args[1] === 'rm') return 'worktree_remove';
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
      error: { code: 'orca_invalid_json', message: stdout.slice(0, 500) },
    };
  }
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
