import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
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

const NETWORK_SANDBOX_UNAVAILABLE = 'network-sandbox-unavailable';
const FILESYSTEM_SANDBOX_UNAVAILABLE = 'filesystem-sandbox-unavailable';
const PR_HEAD_SANDBOX_UNAVAILABLE = 'pr-head-sandbox-unavailable';

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

const READONLY_HOST_BINDS = ['/usr', '/bin', '/lib', '/lib64', '/etc/resolv.conf', '/snap'];

let cachedBwrapSandboxReady: Partial<Record<SandboxMode, boolean>> = {};

function captureWorktreeFingerprint(cwd: string): string {
  const result = spawnSync('git', ['status', '--porcelain'], {
    cwd,
    encoding: 'utf8',
    shell: false,
  });
  return result.stdout ?? '';
}

const SANDBOX_FINGERPRINT_SKIP = new Set(['node_modules']);

function captureDirectoryFingerprint(root: string, options: { skipNodeModules?: boolean } = {}): string {
  const skipNodeModules = options.skipNodeModules !== false;
  const parts: string[] = [];

  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (skipNodeModules && SANDBOX_FINGERPRINT_SKIP.has(entry.name)) {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      try {
        const st = statSync(full);
        const rel = path.relative(root, full).replace(/\\/g, '/');
        parts.push(`${rel}:${st.size}:${Math.trunc(st.mtimeMs)}`);
      } catch {
        // ignore races while the producer runs
      }
    }
  };

  walk(root);
  parts.sort();
  return parts.join('\n');
}

function postconditionViolationResult(): SpawnSyncReturns<string> {
  return {
    pid: 0,
    output: ['', 'read-only-postcondition-violated', ''],
    stdout: '',
    stderr: 'read-only-postcondition-violated',
    status: 1,
    signal: null,
    error: undefined,
  };
}

function captureSandboxDirectoryFingerprint(root: string): string {
  return captureDirectoryFingerprint(root, { skipNodeModules: true });
}

function captureTrustedNodeModulesFingerprint(dependencyRoot: string): string {
  const nodeModules = path.join(dependencyRoot, 'node_modules');
  if (!existsSync(nodeModules)) {
    return '';
  }
  return captureDirectoryFingerprint(nodeModules, { skipNodeModules: false });
}

function guardTrustedDependencyPostcondition(
  dependencyRoot: string,
  beforeFingerprint: string,
  result: SpawnSyncReturns<string>,
): SpawnSyncReturns<string> {
  const afterFingerprint = captureTrustedNodeModulesFingerprint(dependencyRoot);
  if (beforeFingerprint !== afterFingerprint) {
    return postconditionViolationResult();
  }
  return result;
}

function guardSandboxPostcondition(
  disposable: string,
  beforeFingerprint: string,
  result: SpawnSyncReturns<string>,
): SpawnSyncReturns<string> {
  const afterFingerprint = captureSandboxDirectoryFingerprint(disposable);
  if (beforeFingerprint !== afterFingerprint) {
    return postconditionViolationResult();
  }
  return result;
}

function buildIsolatedEnv(
  extraEnv: Record<string, string>,
  options: { binDirs?: string[] } = {},
): NodeJS.ProcessEnv {
  const isolatedHome = mkdtempSync(path.join(tmpdir(), 'reverify-home-'));
  const isolatedTmp = mkdtempSync(path.join(tmpdir(), 'reverify-tmp-'));
  const nodeBin = path.dirname(process.execPath);
  const pathEntries = [
    ...(options.binDirs ?? []),
    nodeBin,
    '/snap/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ].filter((entry) => entry);
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

function isSpawnTimeoutError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ETIMEDOUT',
  );
}

function sandboxUnavailableResult(reason: string): SpawnSyncReturns<string> {
  return {
    pid: 0,
    output: ['', reason, ''],
    stdout: '',
    stderr: reason,
    status: 1,
    signal: null,
    error: undefined,
  };
}

function spawnDirect(
  resolved: ResolvedAllowlistedCommand,
  payload: {
    cwd: string;
    encoding: 'utf8';
    timeout: number;
    env: NodeJS.ProcessEnv;
    shell: false;
  },
): SpawnSyncReturns<string> {
  return spawnSync(resolved.executable, resolved.args, payload);
}

function bwrapAvailable(): boolean {
  const probe = spawnSync('bwrap', ['--version'], { encoding: 'utf8', shell: false });
  return probe.status === 0;
}


function shouldExcludeFromDirectoryCopy(sourceRoot: string, src: string): boolean {
  const rel = path.relative(sourceRoot, src);
  if (!rel) {
    return false;
  }
  return rel === '.git' || rel.startsWith(`.git${path.sep}`);
}

function copyDirectoryTree(sourceRoot: string, dest: string): boolean {
  try {
    cpSync(sourceRoot, dest, {
      recursive: true,
      filter: (src) => !shouldExcludeFromDirectoryCopy(sourceRoot, src),
    });
    return true;
  } catch {
    return false;
  }
}

function createDisposableWorktreeCopy(cwd: string): string | null {
  const dest = mkdtempSync(path.join(tmpdir(), 'reverify-sandbox-wt-'));
  if (!existsSync(path.join(cwd, '.git'))) {
    if (!copyDirectoryTree(cwd, dest)) {
      rmSync(dest, { recursive: true, force: true });
      return null;
    }
    return dest;
  }

  const archive = spawnSync('git', ['archive', 'HEAD'], {
    cwd,
    shell: false,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (archive.status !== 0 || !archive.stdout || !(archive.stdout as Buffer).length) {
    rmSync(dest, { recursive: true, force: true });
    return null;
  }
  const extract = spawnSync('tar', ['-x', '-C', dest], {
    input: archive.stdout as Buffer,
    shell: false,
  });
  if (extract.status !== 0) {
    rmSync(dest, { recursive: true, force: true });
    return null;
  }
  return dest;
}

function appendNodeModulesBwrapBind(args: string[], sandboxCwd: string, dependencyRoot: string): void {
  const hostNodeModules = path.join(dependencyRoot, 'node_modules');
  if (existsSync(hostNodeModules)) {
    args.push('--ro-bind', hostNodeModules, path.join(sandboxCwd, 'node_modules'));
  }
}

function appendVitestNodeModulesTmpfs(args: string[], sandboxCwd: string): void {
  args.push('--tmpfs', path.join(sandboxCwd, 'node_modules', '.vite-temp'));
  args.push('--tmpfs', path.join(sandboxCwd, 'node_modules', '.vitest'));
}

function withSandboxBinDir(
  env: NodeJS.ProcessEnv,
  sandboxCwd: string,
  options: { assumeBoundNodeModules?: boolean; externalBinDirs?: string[] } = {},
): NodeJS.ProcessEnv {
  const pathEntries: string[] = [...(options.externalBinDirs ?? [])];
  const binDir = path.join(sandboxCwd, 'node_modules', '.bin');
  if (options.assumeBoundNodeModules || existsSync(binDir)) {
    pathEntries.push(binDir);
  }
  if (pathEntries.length === 0) {
    return env;
  }
  const currentPath = env.PATH ?? '';
  return {
    ...env,
    PATH: [...pathEntries, currentPath].filter(Boolean).join(path.delimiter),
  };
}

function buildBwrapSandboxArgs(
  sandboxCwd: string,
  dependencyRoot: string,
  env: NodeJS.ProcessEnv,
  options: { npmVitestProof?: boolean; mode?: SandboxMode } = {},
): string[] {
  const mode = options.mode ?? 'pr-head-new';
  const args: string[] = [
    '--die-with-parent',
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
  ];

  if (mode === 'pr-head-new') {
    args.push('--unshare-net', '--unshare-user', '--unshare-pid');
  }

  for (const hostPath of READONLY_HOST_BINDS) {
    if (existsSync(hostPath)) {
      args.push('--ro-bind', hostPath, hostPath);
    }
  }

  const nodeDir = path.dirname(process.execPath);
  if (existsSync(nodeDir)) {
    args.push('--ro-bind', nodeDir, nodeDir);
  }

  args.push('--bind', sandboxCwd, sandboxCwd);
  appendNodeModulesBwrapBind(args, sandboxCwd, dependencyRoot);
  if (options.npmVitestProof) {
    appendVitestNodeModulesTmpfs(args, sandboxCwd);
  }
  args.push('--chdir', sandboxCwd);

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      continue;
    }
    args.push('--setenv', key, String(value));
  }

  return args;
}

function isBwrapInternalFailure(result: SpawnSyncReturns<string>): boolean {
  if (result.status === 0 || result.error) {
    return false;
  }
  const stderr = result.stderr ?? '';
  return /(^|\n)bwrap:/m.test(stderr)
    || /Permission denied|Operation not permitted|Can't (bind|mount)|No permissions to creating/i.test(stderr);
}

function ensureBwrapSandboxReady(
  sandboxCwd: string,
  dependencyRoot: string,
  mode: SandboxMode,
): boolean {
  if (cachedBwrapSandboxReady[mode] !== undefined) {
    return cachedBwrapSandboxReady[mode] as boolean;
  }

  const probeEnv = buildIsolatedEnv({});
  const args = buildBwrapSandboxArgs(sandboxCwd, dependencyRoot, probeEnv, { mode });
  const truePath = existsSync('/bin/true') ? '/bin/true' : process.execPath;
  if (truePath === process.execPath) {
    args.push('--', process.execPath, '-e', 'process.exit(0)');
  } else {
    args.push('--', truePath);
  }

  const probe = spawnSync('bwrap', args, {
    encoding: 'utf8',
    timeout: 5000,
    shell: false,
  });
  cachedBwrapSandboxReady[mode] = probe.status === 0 && !probe.error && !isBwrapInternalFailure(probe);
  return cachedBwrapSandboxReady[mode] as boolean;
}

function spawnWithBwrap(
  resolved: ResolvedAllowlistedCommand,
  payload: {
    cwd: string;
    encoding: 'utf8';
    timeout: number;
    env: NodeJS.ProcessEnv;
    shell: false;
    dependencyRoot: string;
    npmVitestProof?: boolean;
    mode: SandboxMode;
  },
): SpawnSyncReturns<string> {
  const args = buildBwrapSandboxArgs(payload.cwd, payload.dependencyRoot, payload.env, {
    npmVitestProof: payload.npmVitestProof,
    mode: payload.mode,
  });
  args.push('--', resolved.executable, ...resolved.args);
  return spawnSync('bwrap', args, payload);
}

function remapResolvedCommandForDisposable(
  resolved: ResolvedAllowlistedCommand,
  originalCwd: string,
  disposableCwd: string,
): ResolvedAllowlistedCommand {
  const remappedArgs = resolved.args.map((arg) => {
    if (path.isAbsolute(arg) && arg.startsWith(originalCwd)) {
      return path.join(disposableCwd, path.relative(originalCwd, arg));
    }
    return arg;
  });
  return {
    ...resolved,
    args: remappedArgs,
  };
}

function spawnTrustedBaseDirect(
  resolved: ResolvedAllowlistedCommand,
  disposable: string,
  originalCwd: string,
  options: {
    timeoutMs: number;
    env: NodeJS.ProcessEnv;
    dependencyRoot: string;
  },
): SpawnSyncReturns<string> {
  const sandboxResolved = remapResolvedCommandForDisposable(resolved, originalCwd, disposable);
  const externalBinDir = path.join(options.dependencyRoot, 'node_modules', '.bin');
  const externalBinDirs = existsSync(externalBinDir) ? [externalBinDir] : [];
  return spawnDirect(sandboxResolved, {
    cwd: disposable,
    encoding: 'utf8',
    timeout: options.timeoutMs,
    env: withSandboxBinDir(options.env, disposable, { externalBinDirs }),
    shell: false,
  });
}

function spawnTrustedBaseIsolated(
  resolved: ResolvedAllowlistedCommand,
  options: {
    cwd: string;
    dependencyRoot: string;
    timeoutMs: number;
    env: NodeJS.ProcessEnv;
    npmVitestProof?: boolean;
  },
): SpawnSyncReturns<string> {
  const disposable = createDisposableWorktreeCopy(options.cwd);
  if (!disposable) {
    return sandboxUnavailableResult(FILESYSTEM_SANDBOX_UNAVAILABLE);
  }

  const beforeSandboxFingerprint = captureSandboxDirectoryFingerprint(disposable);

  try {
    const canUseBwrap = process.platform === 'linux'
      && bwrapAvailable()
      && ensureBwrapSandboxReady(disposable, options.dependencyRoot, 'trusted-base');

    if (canUseBwrap) {
      const sandboxResolved = remapResolvedCommandForDisposable(resolved, options.cwd, disposable);
      const payload = {
        cwd: disposable,
        encoding: 'utf8' as const,
        timeout: options.timeoutMs,
        env: withSandboxBinDir(options.env, disposable, { assumeBoundNodeModules: true }),
        shell: false as const,
        dependencyRoot: options.dependencyRoot,
        npmVitestProof: options.npmVitestProof,
        mode: 'trusted-base' as const,
      };

      const isolated = spawnWithBwrap(sandboxResolved, payload);
      if (isSpawnTimeoutError(isolated.error)) {
        return guardSandboxPostcondition(disposable, beforeSandboxFingerprint, isolated);
      }
      if (!isolated.error && !isBwrapInternalFailure(isolated)) {
        return guardSandboxPostcondition(disposable, beforeSandboxFingerprint, isolated);
      }
    }

    const beforeDependencyFingerprint = captureTrustedNodeModulesFingerprint(options.dependencyRoot);
    const directResult = spawnTrustedBaseDirect(resolved, disposable, options.cwd, {
      timeoutMs: options.timeoutMs,
      env: options.env,
      dependencyRoot: options.dependencyRoot,
    });
    return guardSandboxPostcondition(
      disposable,
      beforeSandboxFingerprint,
      guardTrustedDependencyPostcondition(
        options.dependencyRoot,
        beforeDependencyFingerprint,
        directResult,
      ),
    );
  } finally {
    rmSync(disposable, { recursive: true, force: true });
  }
}

function spawnPrHeadIsolated(
  resolved: ResolvedAllowlistedCommand,
  options: {
    cwd: string;
    dependencyRoot: string;
    timeoutMs: number;
    env: NodeJS.ProcessEnv;
    npmVitestProof?: boolean;
  },
): SpawnSyncReturns<string> {
  if (process.platform !== 'linux' || !bwrapAvailable()) {
    return sandboxUnavailableResult(NETWORK_SANDBOX_UNAVAILABLE);
  }

  const disposable = createDisposableWorktreeCopy(options.cwd);
  if (!disposable) {
    return sandboxUnavailableResult(PR_HEAD_SANDBOX_UNAVAILABLE);
  }

  const beforeSandboxFingerprint = captureSandboxDirectoryFingerprint(disposable);

  // Bwrap ro-binds dependencyRoot/node_modules at disposable/node_modules; skip host symlink.
  if (!ensureBwrapSandboxReady(disposable, options.dependencyRoot, 'pr-head-new')) {
    rmSync(disposable, { recursive: true, force: true });
    return sandboxUnavailableResult(NETWORK_SANDBOX_UNAVAILABLE);
  }

  const sandboxResolved = remapResolvedCommandForDisposable(resolved, options.cwd, disposable);
  const payload = {
    cwd: disposable,
    encoding: 'utf8' as const,
    timeout: options.timeoutMs,
    env: withSandboxBinDir(options.env, disposable, { assumeBoundNodeModules: true }),
    shell: false as const,
    dependencyRoot: options.dependencyRoot,
    npmVitestProof: options.npmVitestProof,
    mode: 'pr-head-new' as const,
  };

  try {
    const isolated = spawnWithBwrap(sandboxResolved, payload);
    if (isSpawnTimeoutError(isolated.error)) {
      return guardSandboxPostcondition(disposable, beforeSandboxFingerprint, isolated);
    }
    if (isolated.error || isBwrapInternalFailure(isolated)) {
      return sandboxUnavailableResult(NETWORK_SANDBOX_UNAVAILABLE);
    }
    return guardSandboxPostcondition(disposable, beforeSandboxFingerprint, isolated);
  } finally {
    rmSync(disposable, { recursive: true, force: true });
  }
}

function spawnIsolated(
  resolved: ResolvedAllowlistedCommand,
  options: {
    cwd: string;
    dependencyRoot: string;
    timeoutMs: number;
    env: NodeJS.ProcessEnv;
    networkRestricted: boolean;
    npmVitestProof?: boolean;
  },
): SpawnSyncReturns<string> {
  if (options.networkRestricted) {
    return spawnPrHeadIsolated(resolved, options);
  }

  return spawnTrustedBaseIsolated(resolved, options);
}

function isSandboxBlocked(stderr: string, networkRestricted: boolean): string | null {
  if (stderr.includes(FILESYSTEM_SANDBOX_UNAVAILABLE)) {
    return FILESYSTEM_SANDBOX_UNAVAILABLE;
  }
  if (!networkRestricted) {
    return null;
  }
  for (const reason of [PR_HEAD_SANDBOX_UNAVAILABLE, NETWORK_SANDBOX_UNAVAILABLE]) {
    if (stderr.includes(reason)) {
      return reason;
    }
  }
  return null;
}

export function runSandboxedAllowlistedCommand(
  resolved: ResolvedAllowlistedCommand,
  options: {
    cwd: string;
    dependencyRoot?: string;
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

  const dependencyRoot = options.dependencyRoot ?? options.cwd;
  const beforeFingerprint = captureWorktreeFingerprint(options.cwd);
  const localBinDir = path.join(dependencyRoot, 'node_modules', '.bin');
  const binDirs = existsSync(localBinDir) ? [localBinDir] : [];
  const env = buildIsolatedEnv(resolved.env, { binDirs });
  const networkRestricted = options.sandboxMode === 'pr-head-new';

  const npmVitestProof = resolved.allowlistId.startsWith('npm test --');
  const result = spawnIsolated(resolved, {
    cwd: options.cwd,
    dependencyRoot,
    timeoutMs: options.timeoutMs,
    env,
    networkRestricted,
    npmVitestProof,
  });

  const stderr = result.stderr ?? '';
  const blockReason = isSandboxBlocked(stderr, networkRestricted)
    ?? (stderr.includes('read-only-postcondition-violated') ? 'read-only-postcondition-violated' : null);
  if (blockReason) {
    return {
      ok: false,
      stdout: '',
      stderr: blockReason,
      exitCode: result.status,
      timedOut: false,
      blocked: true,
      blockReason,
    };
  }

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
    stderr,
    exitCode: result.status,
    timedOut: Boolean(result.error && (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT'),
    blocked: false,
  };
}

export function isPrHeadNetworkSandboxAvailable(): boolean {
  return process.platform === 'linux' && bwrapAvailable();
}

export function resetBwrapSandboxProbeCacheForTests(): void {
  cachedBwrapSandboxReady = {};
}
