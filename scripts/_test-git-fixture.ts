import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const TRUSTED_SYSTEM_GIT_CANDIDATES = ['/usr/bin/git', '/bin/git', '/usr/local/bin/git'] as const;

export function resolveTrustedSystemGit(): string {
  for (const candidate of TRUSTED_SYSTEM_GIT_CANDIDATES) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return 'git';
}

function sanitizeFixturePath(pathValue: string | undefined): string {
  const segments = (pathValue ?? '/usr/local/bin:/usr/bin:/bin')
    .split(':')
    .filter((segment) => segment && !segment.endsWith('/scripts'));
  return segments.length > 0 ? segments.join(':') : '/usr/bin:/bin';
}

export function gitFixtureEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const {
    AO_SESSION_ID: _surface,
    AO_TMUX_NAME: _tmux,
    BASH_ENV: _bashEnv,
    AO_REAL_BINARY: _aoReal,
    GIT_REAL_BINARY: _gitReal,
    GIT_SYSTEM_BINARY: _gitSystem,
    ...rest
  } = baseEnv;

  return {
    ...rest,
    PATH: sanitizeFixturePath(rest.PATH),
    AO_SESSION_ID: '',
  };
}

/** Isolated env for bash interposer probes — strips operator BASH_ENV/coworker chain. */
export function autonomousBashEnv(
  overrides: NodeJS.ProcessEnv = {},
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...gitFixtureEnv(baseEnv),
    AO_SESSION_ID: '1',
    ...overrides,
  };
}

function runTrustedGitFixture(git: string, args: string[], cwd: string): void {
  const result = spawnSync(git, args, {
    cwd,
    encoding: 'utf8',
    env: gitFixtureEnv(),
  });
  if (result.status !== 0) {
    throw new Error(
      `git fixture setup failed: ${git} ${args.join(' ')} (exit ${result.status ?? 'null'}): ${result.stderr || result.stdout}`,
    );
  }
}

export function withTempGitRepo(run: (dir: string) => void) {
  const git = resolveTrustedSystemGit();
  const dir = mkdtempSync(path.join(tmpdir(), 'autonomous-boundary-'));
  try {
    runTrustedGitFixture(git, ['init', '-b', 'main'], dir);
    runTrustedGitFixture(git, ['config', 'user.email', 'test@example.com'], dir);
    runTrustedGitFixture(git, ['config', 'user.name', 'Test'], dir);
    writeFileSync(path.join(dir, 'README.md'), 'test\n');
    runTrustedGitFixture(git, ['add', 'README.md'], dir);
    runTrustedGitFixture(git, ['commit', '-m', 'init'], dir);
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
