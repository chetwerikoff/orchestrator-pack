import { spawn, spawnSync, type ChildProcessByStdio, type SpawnSyncReturns } from 'node:child_process';
import type { Readable } from 'node:stream';
import { constants as osConstants } from 'node:os';

export type ProcessOutcome =
  | 'exit'
  | 'signal'
  | 'timeout'
  | 'cancelled'
  | 'spawn-failure'
  | 'consumer-error';

export interface ProcessResult {
  readonly outcome: ProcessOutcome;
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly error?: string;
}

export interface RunProcessOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<NodeJS.ProcessEnv>;
  readonly inheritParentEnv?: boolean;
  readonly timeoutMs?: number;
  readonly killGraceMs?: number;
  readonly signal?: AbortSignal;
  readonly encoding?: BufferEncoding;
  readonly allowEmptyStdout?: boolean;
  readonly onStdoutChunk?: (chunk: string) => void | Promise<void>;
  readonly onStderrChunk?: (chunk: string) => void | Promise<void>;
  readonly onSpawn?: (pid: number) => void;
}

export interface RunProcessSyncOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<NodeJS.ProcessEnv>;
  readonly inheritParentEnv?: boolean;
  readonly encoding?: BufferEncoding;
}

interface TerminalIntent {
  readonly outcome: Extract<ProcessOutcome, 'timeout' | 'cancelled' | 'consumer-error'>;
  readonly error?: string;
}

const DEFAULT_KILL_GRACE_MS = 250;
const FINAL_CLOSE_GRACE_MS = 1_000;

function minimalEnvironment(overrides: Readonly<NodeJS.ProcessEnv> | undefined): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'SystemRoot', 'COMSPEC', 'PATHEXT']) {
    const value = process.env[key];
    if (value !== undefined) base[key] = value;
  }
  return { ...base, ...overrides };
}

function errnoCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function groupExists(pid: number): boolean {
  if (process.platform === 'win32') return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return errnoCode(error) === 'EPERM';
  }
}

function signalTree(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === 'win32') {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if (errnoCode(error) !== 'ESRCH') throw error;
    }
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (errnoCode(error) !== 'ESRCH') throw error;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function terminateProcessTree(pid: number, killGraceMs: number): Promise<void> {
  signalTree(pid, 'SIGTERM');
  await delay(killGraceMs);
  if (groupExists(pid)) {
    signalTree(pid, 'SIGKILL');
    await delay(20);
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runProcess(options: RunProcessOptions): Promise<ProcessResult> {
  if (!options.command.trim()) throw new TypeError('command must be a non-empty executable path or name');
  if (options.args && !Array.isArray(options.args)) throw new TypeError('args must be an argument array');
  if (options.timeoutMs !== undefined && options.timeoutMs < 0) {
    throw new RangeError('timeoutMs must be non-negative');
  }

  if (options.signal?.aborted) {
    return {
      outcome: 'cancelled',
      ok: false,
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      cancelled: true,
    };
  }

  const encoding = options.encoding ?? 'utf8';
  const env = options.inheritParentEnv
    ? { ...process.env, ...options.env }
    : minimalEnvironment(options.env);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let child: ChildProcessByStdio<null, Readable, Readable>;

  try {
    child = spawn(options.command, [...(options.args ?? [])], {
      cwd: options.cwd,
      env,
      shell: false,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    return {
      outcome: 'spawn-failure',
      ok: false,
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      cancelled: false,
      error: describeError(error),
    };
  }

  const pid = child.pid;
  if (pid === undefined) {
    const spawnError = await new Promise<Error>((resolve) => {
      child.once('error', resolve);
    });
    return {
      outcome: 'spawn-failure',
      ok: false,
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      cancelled: false,
      error: spawnError.message,
    };
  }

  let intent: TerminalIntent | undefined;
  let cleanupPromise: Promise<void> | undefined;
  let consumerChain = Promise.resolve();
  let processTerminalObserved = false;

  const requestTermination = (nextIntent: TerminalIntent): void => {
    if (intent) return;
    if (processTerminalObserved && nextIntent.outcome !== 'consumer-error') return;
    intent = nextIntent;
    cleanupPromise = terminateProcessTree(pid, options.killGraceMs ?? DEFAULT_KILL_GRACE_MS).catch(
      (error: unknown) => {
        const currentIntent = intent;
        if (currentIntent && !currentIntent.error) {
          intent = {
            outcome: currentIntent.outcome,
            error: `process-tree cleanup failed: ${describeError(error)}`,
          };
        }
      },
    );
  };

  const consume = (
    target: Buffer[],
    callback: ((chunk: string) => void | Promise<void>) | undefined,
    chunk: Buffer,
  ): void => {
    target.push(Buffer.from(chunk));
    if (!callback) return;
    const text = chunk.toString(encoding);
    consumerChain = consumerChain
      .then(() => callback(text))
      .catch((error: unknown) => {
        requestTermination({ outcome: 'consumer-error', error: describeError(error) });
      });
  };

  child.stdout.on('data', (chunk: Buffer) => consume(stdout, options.onStdoutChunk, chunk));
  child.stderr.on('data', (chunk: Buffer) => consume(stderr, options.onStderrChunk, chunk));

  const timeout = options.timeoutMs === undefined
    ? undefined
    : setTimeout(() => requestTermination({ outcome: 'timeout' }), options.timeoutMs);
  timeout?.unref();

  const abort = (): void => requestTermination({ outcome: 'cancelled' });
  options.signal?.addEventListener('abort', abort, { once: true });

  const observedPromise = new Promise<
    | { readonly type: 'error'; readonly error: Error }
    | { readonly type: 'close'; readonly code: number | null; readonly signal: NodeJS.Signals | null }
  >((resolve) => {
    let resolved = false;
    const finish = (
      value:
        | { readonly type: 'error'; readonly error: Error }
        | { readonly type: 'close'; readonly code: number | null; readonly signal: NodeJS.Signals | null },
    ): void => {
      if (resolved) return;
      resolved = true;
      processTerminalObserved = true;
      resolve(value);
    };
    child.once('error', (error) => finish({ type: 'error', error }));
    child.once('close', (code, signal) => finish({ type: 'close', code, signal }));
  });

  try {
    options.onSpawn?.(pid);
  } catch (error) {
    requestTermination({ outcome: 'consumer-error', error: `onSpawn failed: ${describeError(error)}` });
  }

  const observed = await observedPromise;

  if (timeout) clearTimeout(timeout);
  options.signal?.removeEventListener('abort', abort);
  await consumerChain;

  if (cleanupPromise !== undefined) {
    await Promise.race([cleanupPromise, delay(FINAL_CLOSE_GRACE_MS)]);
  }

  const stdoutText = Buffer.concat(stdout).toString(encoding);
  const stderrText = Buffer.concat(stderr).toString(encoding);

  if (observed.type === 'error' && !intent) {
    return {
      outcome: 'spawn-failure',
      ok: false,
      exitCode: null,
      signal: null,
      stdout: stdoutText,
      stderr: stderrText,
      timedOut: false,
      cancelled: false,
      error: observed.error.message,
    };
  }

  if (intent) {
    return {
      outcome: intent.outcome,
      ok: false,
      exitCode: observed.type === 'close' ? observed.code : null,
      signal: observed.type === 'close' ? observed.signal : null,
      stdout: stdoutText,
      stderr: stderrText,
      timedOut: intent.outcome === 'timeout',
      cancelled: intent.outcome === 'cancelled',
      ...(intent.error ? { error: intent.error } : {}),
    };
  }

  if (observed.type === 'error') {
    return {
      outcome: 'spawn-failure',
      ok: false,
      exitCode: null,
      signal: null,
      stdout: stdoutText,
      stderr: stderrText,
      timedOut: false,
      cancelled: false,
      error: observed.error.message,
    };
  }

  const outcome: ProcessOutcome = observed.signal ? 'signal' : 'exit';
  const hasAcceptedOutput = options.allowEmptyStdout === true || stdoutText.length > 0;
  return {
    outcome,
    ok: outcome === 'exit' && observed.code === 0 && hasAcceptedOutput,
    exitCode: observed.code,
    signal: observed.signal,
    stdout: stdoutText,
    stderr: stderrText,
    timedOut: false,
    cancelled: false,
  };
}

export function runProcessSync(options: RunProcessSyncOptions): ProcessResult {
  if (!options.command.trim()) throw new TypeError('command must be a non-empty executable path or name');
  if (options.args && !Array.isArray(options.args)) throw new TypeError('args must be an argument array');

  const encoding = options.encoding ?? 'utf8';
  const env = options.inheritParentEnv
    ? { ...process.env, ...options.env }
    : minimalEnvironment(options.env);

  let child: SpawnSyncReturns<string>;
  try {
    child = spawnSync(options.command, [...(options.args ?? [])], {
      cwd: options.cwd,
      env,
      shell: false,
      windowsHide: true,
      encoding,
    });
  } catch (error) {
    return {
      outcome: 'spawn-failure',
      ok: false,
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      cancelled: false,
      error: describeError(error),
    };
  }

  if (child.error) {
    return {
      outcome: 'spawn-failure',
      ok: false,
      exitCode: null,
      signal: null,
      stdout: child.stdout ?? '',
      stderr: child.stderr ?? '',
      timedOut: false,
      cancelled: false,
      error: describeError(child.error),
    };
  }

  const signal = child.signal as NodeJS.Signals | null;
  return {
    outcome: signal ? 'signal' : 'exit',
    ok: child.status === 0,
    exitCode: child.status,
    signal,
    stdout: child.stdout ?? '',
    stderr: child.stderr ?? '',
    timedOut: false,
    cancelled: false,
  };
}

export const linuxSignalNumbers = osConstants.signals;
