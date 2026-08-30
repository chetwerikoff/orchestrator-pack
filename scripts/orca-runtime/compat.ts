import { runProcessSync } from '../kernel/subprocess.ts';
import {
  runOrcaJson,
  type OrcaJsonResponse,
  type OrcaLocalOutcomeCategory,
  type OrcaOperationName,
  type OrcaRunOptions,
  type OrcaTerminalHandle,
  type OrcaTerminalReadResult as NativeOrcaTerminalReadResult,
  type OrcaWorktreeCurrent,
} from './native.ts';

export interface OrcaTerminalReadResult {
  lines?: string[];
  nextCursor?: number;
  oldestCursor?: number;
  source?: 'screen' | 'stream' | 'unknown';
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

interface LegacyCursorState {
  next: number;
  readonly byCompat: Map<number, string>;
  readonly byNative: Map<string, number>;
}

const legacyCursorState = new Map<string, LegacyCursorState>();

function cursorState(handle: string): LegacyCursorState {
  let state = legacyCursorState.get(handle);
  if (!state) {
    state = { next: 1, byCompat: new Map(), byNative: new Map() };
    legacyCursorState.set(handle, state);
  }
  return state;
}

function toCompatibilityCursor(handle: string, nativeCursor: string): number {
  const state = cursorState(handle);
  const existing = state.byNative.get(nativeCursor);
  if (existing !== undefined) return existing;
  const compatibilityCursor = state.next++;
  state.byNative.set(nativeCursor, compatibilityCursor);
  state.byCompat.set(compatibilityCursor, nativeCursor);
  return compatibilityCursor;
}

function toNativeCursor(handle: string, compatibilityCursor: number): string {
  return cursorState(handle).byCompat.get(compatibilityCursor) ?? String(compatibilityCursor);
}

function normalizeLegacyRead(
  handle: string,
  response: OrcaJsonResponse<NativeOrcaTerminalReadResult>,
): OrcaJsonResponse<OrcaTerminalReadResult> {
  if (!response.ok) {
    return {
      ok: false,
      ...(response.error ? { error: response.error } : {}),
      ...(response.operation ? { operation: response.operation } : {}),
      ...(response.outcomeCategory ? { outcomeCategory: response.outcomeCategory } : {}),
    };
  }
  const result = response.result;
  const current = result?.terminal;
  if (current) {
    if (!Array.isArray(current.tail)
      || !current.tail.every((line) => typeof line === 'string')
      || (current.nextCursor !== null && typeof current.nextCursor !== 'string')
      || (current.source !== undefined
        && current.source !== 'screen'
        && current.source !== 'stream'
        && current.source !== 'unknown')) {
      return {
        ok: false,
        operation: 'terminal_read',
        outcomeCategory: 'supported_operation_failure',
        error: {
          code: 'orca_terminal_read_shape_unsupported',
          message: 'Orca terminal read response does not match a supported shape',
        },
      };
    }
    const source = current.source ?? 'unknown';
    return {
      ...response,
      result: {
        lines: [...current.tail],
        source,
        ...(source === 'screen' || current.nextCursor === null
          ? {}
          : { nextCursor: toCompatibilityCursor(handle, current.nextCursor) }),
        ...(source === 'screen' || typeof current.oldestCursor !== 'string'
          ? {}
          : { oldestCursor: toCompatibilityCursor(handle, current.oldestCursor) }),
      },
    };
  }

  if (!Array.isArray(result?.lines)
    || !result.lines.every((line) => typeof line === 'string')) {
    return {
      ok: false,
      operation: 'terminal_read',
      outcomeCategory: 'supported_operation_failure',
      error: {
        code: 'orca_terminal_read_shape_unsupported',
        message: 'Orca terminal read response does not match a supported shape',
      },
    };
  }
  const resultSource = result.source;
  if (resultSource !== undefined
    && resultSource !== 'screen'
    && resultSource !== 'stream'
    && resultSource !== 'unknown') {
    return {
      ok: false,
      operation: 'terminal_read',
      outcomeCategory: 'supported_operation_failure',
      error: {
        code: 'orca_terminal_read_shape_unsupported',
        message: 'Orca terminal read response does not match a supported shape',
      },
    };
  }
  const source = resultSource ?? 'unknown';
  const normalizeCursor = (value: string | number | null | undefined): number | undefined => {
    if (source === 'screen') return undefined;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') return toCompatibilityCursor(handle, value);
    return undefined;
  };
  const nextCursor = normalizeCursor(result.nextCursor);
  const oldestCursor = normalizeCursor(result.oldestCursor);
  return {
    ...response,
    result: {
      lines: [...result.lines],
      source,
      ...(nextCursor === undefined ? {} : { nextCursor }),
      ...(oldestCursor === undefined ? {} : { oldestCursor }),
    },
  };
}

function requireStdout(result: ReturnType<typeof runProcessSync>): string {
  if (!result.ok) {
    throw new Error(result.stderr || result.error || 'process failed');
  }
  return result.stdout;
}

/** Compatibility facade for the existing smoke caller while callers migrate in #1248. */
export function probeOrcaWorktree(
  cwd: string,
  options: { readonly executable?: string; readonly runner?: OrcaRunOptions['runner']; readonly timeoutMs?: number } = {},
): OrcaWorktreeProbeResult {
  const response = runOrcaJson<OrcaWorktreeCurrent>(['worktree', 'current'], {
    cwd,
    executable: options.executable,
    runner: options.runner,
    timeoutMs: options.timeoutMs,
  });
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

export function createOrcaTerminal(
  input: {
    readonly cwd: string;
    readonly title: string;
    readonly command: string;
    readonly executable?: string;
    readonly runner?: OrcaRunOptions['runner'];
    readonly timeoutMs?: number;
  },
): OrcaTerminalCreateResult {
  const response = runOrcaJson<{ terminal?: OrcaTerminalHandle }>(
    ['terminal', 'create', '--worktree', 'active', '--title', input.title, '--command', input.command],
    input,
  );
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

export function readOrcaTerminal(
  handle: string,
  options: OrcaRunOptions & { readonly cursor?: number; readonly limit?: number } = {},
): OrcaJsonResponse<OrcaTerminalReadResult> {
  const args = ['terminal', 'read', '--terminal', handle];
  if (options.cursor !== undefined) args.push('--cursor', toNativeCursor(handle, options.cursor));
  if (options.limit !== undefined) args.push('--limit', String(options.limit));
  return normalizeLegacyRead(
    handle,
    runOrcaJson<NativeOrcaTerminalReadResult>(args, options),
  );
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
  const response = runOrcaJson(['terminal', 'close', '--terminal', handle], options);
  if (response.ok) legacyCursorState.delete(handle);
  return response;
}
