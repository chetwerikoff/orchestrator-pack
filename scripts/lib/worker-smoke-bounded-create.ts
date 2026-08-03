import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { resolveOrcaExecutable, type OrcaTerminalHandle } from './orca-cli.ts';
import { SMOKE_CREATE_TIMEOUT_MS } from './worker-smoke-lifecycle.ts';

export type BoundedOrcaCreateResult =
  | {
    ok: true;
    terminal: OrcaTerminalHandle;
    elapsedMs: number;
  }
  | {
    ok: false;
    reason: string;
    errorCode: string;
    ambiguousUnbound: boolean;
    elapsedMs: number;
  };

export function createBoundedOrcaTerminal(input: {
  cwd: string;
  title: string;
  command: string;
  executable?: string;
  timeoutMs?: number;
  now?: () => number;
  runner?: typeof spawnSync;
}): BoundedOrcaCreateResult {
  const now = input.now ?? (() => Date.now());
  const startedAt = now();
  const executable = input.executable ?? resolveOrcaExecutable();
  const timeoutMs = input.timeoutMs ?? SMOKE_CREATE_TIMEOUT_MS;
  const runner = input.runner ?? spawnSync;
  let result: SpawnSyncReturns<string>;
  try {
    result = runner(executable, [
      'terminal',
      'create',
      '--worktree',
      'active',
      '--title',
      input.title,
      '--command',
      input.command,
      '--json',
    ], {
      cwd: input.cwd,
      env: process.env,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: timeoutMs,
      // spawnSync does not return after a timeout until the child exits. SIGTERM can be
      // ignored, so use the non-catchable signal to keep the create phase genuinely bounded.
      killSignal: 'SIGKILL',
    });
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'orca terminal create launch failed',
      errorCode: 'orca_process_launch_failed',
      ambiguousUnbound: true,
      elapsedMs: Math.max(0, now() - startedAt),
    };
  }
  const elapsedMs = Math.max(0, now() - startedAt);
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    return {
      ok: false,
      reason: result.error.message,
      errorCode: code === 'ETIMEDOUT' ? 'orca_create_timeout' : 'orca_process_launch_failed',
      ambiguousUnbound: true,
      elapsedMs,
    };
  }
  const stdout = String(result.stdout ?? '').trim();
  if (!stdout) {
    return {
      ok: false,
      reason: String(result.stderr ?? '').trim() || 'orca terminal create produced no output',
      errorCode: 'orca_empty_stdout',
      ambiguousUnbound: true,
      elapsedMs,
    };
  }
  let parsed: {
    ok?: boolean;
    result?: { terminal?: OrcaTerminalHandle };
    error?: { code?: string; message?: string };
  };
  try {
    parsed = JSON.parse(stdout) as typeof parsed;
  } catch {
    return {
      ok: false,
      reason: stdout.slice(0, 500),
      errorCode: 'orca_invalid_json',
      ambiguousUnbound: true,
      elapsedMs,
    };
  }
  const handle = parsed.result?.terminal?.handle?.trim();
  if (!parsed.ok || !handle) {
    return {
      ok: false,
      reason: parsed.error?.message ?? parsed.error?.code ?? 'terminal_create_failed',
      errorCode: parsed.error?.code ?? (parsed.ok ? 'terminal_handle_missing' : 'terminal_create_failed'),
      ambiguousUnbound: true,
      elapsedMs,
    };
  }
  return {
    ok: true,
    terminal: { ...parsed.result!.terminal!, handle },
    elapsedMs,
  };
}
