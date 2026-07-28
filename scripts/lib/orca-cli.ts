import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { runProcessSync } from '../kernel/subprocess.ts';

export interface OrcaJsonResponse<T = unknown> {
  ok: boolean;
  result?: T;
  error?: { code?: string; message?: string };
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
  worktreeId?: string;
  title?: string;
}

export interface OrcaTerminalReadResult {
  lines?: string[];
  nextCursor?: number;
  oldestCursor?: number;
}

const ORCA_CANDIDATES = ['orca-dev', 'orca-ide', 'orca'] as const;

function requireStdout(result: ReturnType<typeof runProcessSync>): string {
  if (!result.ok) {
    throw new Error(result.stderr || result.error || 'process failed');
  }
  return result.stdout;
}

export function resolveOrcaExecutable(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.ORCA_CLI_COMMAND?.trim();
  if (override) {
    return override;
  }
  for (const candidate of ORCA_CANDIDATES) {
    try {
      const resolved = requireStdout(runProcessSync({
        command: 'command',
        args: ['-v', candidate],
        allowEmptyStdout: true,
      })).trim();
      if (resolved) {
        return candidate;
      }
    } catch {
      // try next candidate
    }
  }
  return 'orca';
}

export function runOrcaJson<T>(
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly executable?: string;
    readonly runner?: typeof spawnSync;
  } = {},
): OrcaJsonResponse<T> {
  const runner = options.runner ?? spawnSync;
  const executable = options.executable ?? resolveOrcaExecutable(options.env);
  const result = runner(executable, [...args, '--json'], {
    cwd: options.cwd ?? process.cwd(),
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const stdout = (result.stdout ?? '').trim();
  if (!stdout) {
    return {
      ok: false,
      error: {
        code: 'orca_empty_stdout',
        message: (result.stderr ?? '').trim() || `orca ${args.join(' ')} produced no output`,
      },
    };
  }
  try {
    return JSON.parse(stdout) as OrcaJsonResponse<T>;
  } catch {
    return {
      ok: false,
      error: { code: 'orca_invalid_json', message: stdout.slice(0, 500) },
    };
  }
}

export function probeOrcaWorktree(
  cwd: string,
  options: { readonly executable?: string; readonly runner?: typeof spawnSync } = {},
): {
  ok: boolean;
  worktreePath?: string;
  headSha?: string;
  linkedIssue?: number | null;
  reason?: string;
} {
  const response = runOrcaJson<OrcaWorktreeCurrent>(['worktree', 'current'], {
    cwd,
    executable: options.executable,
    runner: options.runner,
  });
  if (!response.ok) {
    return {
      ok: false,
      reason: response.error?.message ?? response.error?.code ?? 'worktree_current_failed',
    };
  }
  const worktree = response.result?.worktree;
  const worktreePath = worktree?.path?.trim();
  if (!worktreePath) {
    return { ok: false, reason: 'worktree_path_missing' };
  }
  let resolvedCwd = cwd;
  let resolvedWorktree = worktreePath;
  try {
    resolvedCwd = requireStdout(runProcessSync({ command: 'realpath', args: ['-e', cwd] })).trim();
    resolvedWorktree = requireStdout(runProcessSync({ command: 'realpath', args: ['-e', worktreePath] })).trim();
  } catch {
    return { ok: false, reason: 'cwd_not_orca_managed_worktree' };
  }
  if (resolvedCwd !== resolvedWorktree) {
    return { ok: false, reason: 'cwd_not_orca_managed_worktree' };
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
    readonly runner?: typeof spawnSync;
  },
): { ok: true; terminal: OrcaTerminalHandle } | { ok: false; reason: string } {
  const response = runOrcaJson<{ terminal?: OrcaTerminalHandle }>(
    ['terminal', 'create', '--worktree', 'active', '--title', input.title, '--command', input.command],
    { cwd: input.cwd, executable: input.executable, runner: input.runner },
  );
  const handle = response.result?.terminal?.handle?.trim();
  if (!response.ok || !handle) {
    return {
      ok: false,
      reason: response.error?.message ?? response.error?.code ?? 'terminal_create_failed',
    };
  }
  return { ok: true, terminal: { ...response.result!.terminal!, handle } };
}

export function sendOrcaTerminal(
  handle: string,
  text: string,
  options: { readonly cwd?: string; readonly executable?: string; readonly runner?: typeof spawnSync } = {},
): OrcaJsonResponse {
  return runOrcaJson(
    ['terminal', 'send', '--terminal', handle, '--text', text, '--enter'],
    options,
  );
}

export function readOrcaTerminal(
  handle: string,
  options: {
    readonly cwd?: string;
    readonly cursor?: number;
    readonly limit?: number;
    readonly executable?: string;
    readonly runner?: typeof spawnSync;
  } = {},
): OrcaJsonResponse<OrcaTerminalReadResult> {
  const args = ['terminal', 'read', '--terminal', handle];
  if (options.cursor !== undefined) {
    args.push('--cursor', String(options.cursor));
  }
  if (options.limit !== undefined) {
    args.push('--limit', String(options.limit));
  }
  return runOrcaJson<OrcaTerminalReadResult>(args, options);
}

export function waitOrcaTerminal(
  handle: string,
  input: {
    readonly for: 'exit' | 'tui-idle';
    readonly timeoutMs: number;
    readonly cwd?: string;
    readonly executable?: string;
    readonly runner?: typeof spawnSync;
  },
): OrcaJsonResponse {
  return runOrcaJson(
    ['terminal', 'wait', '--terminal', handle, '--for', input.for, '--timeout-ms', String(input.timeoutMs)],
    input,
  );
}

export function closeOrcaTerminal(
  handle: string,
  options: { readonly cwd?: string; readonly executable?: string; readonly runner?: typeof spawnSync } = {},
): OrcaJsonResponse {
  return runOrcaJson(['terminal', 'close', '--terminal', handle], options);
}

export function orcaExecutableLooksAvailable(executable: string): boolean {
  if (executable.includes('/')) {
    return existsSync(executable);
  }
  try {
    requireStdout(runProcessSync({ command: 'command', args: ['-v', executable], allowEmptyStdout: true }));
    return true;
  } catch {
    return false;
  }
}
