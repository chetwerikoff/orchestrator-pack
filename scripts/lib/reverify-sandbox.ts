import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { ResolvedAllowlistedCommand } from './reverify-command-resolution.js';

export interface CommandRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  blocked: boolean;
  blockReason?: string;
}

export type SandboxMode = 'trusted-base' | 'pr-head-new';

const SECRET_ENV_PREFIXES = [
  'GITHUB_',
  'GH_',
  'AWS_',
  'AZURE_',
  'OPENAI_',
  'ANTHROPIC_',
  'CODEX_',
  'NPM_TOKEN',
  'NODE_AUTH_TOKEN',
];

function captureWorktreeFingerprint(cwd: string): string {
  const result = spawnSync('git', ['status', '--porcelain'], {
    cwd,
    encoding: 'utf8',
    shell: false,
  });
  return result.stdout ?? '';
}

function buildIsolatedEnv(extraEnv: Record<string, string>): NodeJS.ProcessEnv {
  const isolatedHome = mkdtempSync(path.join(tmpdir(), 'reverify-home-'));
  const isolatedTmp = mkdtempSync(path.join(tmpdir(), 'reverify-tmp-'));
  const nodeBin = path.dirname(process.execPath);
  const pathEntries = [nodeBin, '/usr/local/bin', '/usr/bin', '/bin'].filter((entry) => entry);
  const env: NodeJS.ProcessEnv = {
    PATH: pathEntries.join(path.delimiter),
    HOME: isolatedHome,
    TMPDIR: isolatedTmp,
    NODE_ENV: 'test',
    ...extraEnv,
  };
  for (const key of Object.keys(process.env)) {
    if (!key) {
      continue;
    }
    if (SECRET_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      continue;
    }
    if (key in env) {
      continue;
    }
    if (key === 'PATH' || key === 'HOME' || key === 'TMPDIR' || key === 'NODE_ENV') {
      continue;
    }
  }
  return env;
}

function spawnIsolated(
  resolved: ResolvedAllowlistedCommand,
  options: {
    cwd: string;
    timeoutMs: number;
    env: NodeJS.ProcessEnv;
    networkRestricted: boolean;
  },
) {
  const payload = {
    cwd: options.cwd,
    encoding: 'utf8' as const,
    timeout: options.timeoutMs,
    env: options.env,
    shell: false as const,
  };

  if (options.networkRestricted && process.platform === 'linux') {
    const unshare = spawnSync(
      'unshare',
      ['-U', '-n', '-r', resolved.executable, ...resolved.args],
      payload,
    );
    if (!unshare.error) {
      return unshare;
    }
  }

  return spawnSync(resolved.executable, resolved.args, payload);
}

export function runSandboxedAllowlistedCommand(
  resolved: ResolvedAllowlistedCommand,
  options: {
    cwd: string;
    timeoutMs: number;
    sandboxMode: SandboxMode;
    forceUnreachable?: boolean;
  },
): CommandRunResult {
  if (options.forceUnreachable) {
    return {
      ok: false,
      stdout: '',
      stderr: 'forced unreachable',
      exitCode: null,
      timedOut: true,
      blocked: false,
    };
  }

  const beforeFingerprint = captureWorktreeFingerprint(options.cwd);
  const env = buildIsolatedEnv(resolved.env);
  const networkRestricted = options.sandboxMode === 'pr-head-new';

  const result = spawnIsolated(resolved, {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    env,
    networkRestricted,
  });

  const afterFingerprint = captureWorktreeFingerprint(options.cwd);
  if (beforeFingerprint !== afterFingerprint) {
    return {
      ok: false,
      stdout: '',
      stderr: 'read-only-postcondition-violated',
      exitCode: null,
      timedOut: false,
      blocked: true,
      blockReason: 'read-only-postcondition-violated',
    };
  }

  return {
    ok: result.status === 0 && !result.error,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status,
    timedOut: Boolean(result.error && (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT'),
    blocked: false,
  };
}
