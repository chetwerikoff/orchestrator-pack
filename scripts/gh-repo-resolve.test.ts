import { describe, expect, it } from 'vitest';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isMutatingGitArgv } from '../docs/autonomous-orchestrator-boundary.mjs';
import {
  originSlugFromGitConfig,
  parseRemoteSlug,
  readOriginUrlFromGitConfig,
  resolveGitCommonDir,
  RESOLVER_GIT_ARGV,
} from './lib/git-origin-slug.mjs';
import { resolveNameWithOwner, resolveRepoContext, RESOLVER_GIT_ARGV as exportedResolverArgv } from './lib/gh-repo-resolve.mjs';
import { resolveRealGhBinary } from './lib/gh-resolve-real-binary.mjs';
import {
  createIsolatedInterposerPack,
  stripInterposerBashEnvBlockers,
  writeIsolatedAutonomousRealBinariesConfig,
} from './_test-interposer-pack-fixture.js';
import { gitFixtureEnv, resolveTrustedSystemGit } from './_test-git-fixture.js';
import { repoRoot } from './_test-pwsh-helpers.js';

const TOKEN_SENTINEL = 'ghp_SENTINEL_TOKEN_DO_NOT_LEAK';
const FIXTURE_SLUG = 'fixture-owner/fixture-repo';
const FIXTURE_ORIGIN = `https://${TOKEN_SENTINEL}@github.com/${FIXTURE_SLUG}.git`;

function withOriginFixture(originUrl: string, run: (repoDir: string) => void) {
  const git = resolveTrustedSystemGit();
  const dir = mkdtempSync(path.join(tmpdir(), 'gh-repo-resolve-'));
  try {
    spawnSync(git, ['init', '-b', 'main'], { cwd: dir, env: gitFixtureEnv() });
    spawnSync(git, ['remote', 'add', 'origin', originUrl], { cwd: dir, env: gitFixtureEnv() });
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeConfigOnlyCheckout(originUrl: string) {
  const dir = mkdtempSync(path.join(tmpdir(), 'gh-repo-config-only-'));
  mkdirSync(path.join(dir, '.git'), { recursive: true });
  writeFileSync(
    path.join(dir, '.git', 'config'),
    `[remote "origin"]\n\turl = ${originUrl}\n`,
  );
  return dir;
}

function writeWorktreePointerCheckout(originUrl: string) {
  const root = mkdtempSync(path.join(tmpdir(), 'gh-repo-worktree-'));
  const commonGitDir = path.join(root, 'main', '.git');
  const worktreeName = 'opk-fixture';
  const worktreeGitDir = path.join(commonGitDir, 'worktrees', worktreeName);
  const checkoutDir = path.join(root, 'worktree-checkout');
  mkdirSync(worktreeGitDir, { recursive: true });
  mkdirSync(checkoutDir, { recursive: true });
  writeFileSync(
    path.join(commonGitDir, 'config'),
    `[remote "origin"]\n\turl = ${originUrl}\n`,
  );
  writeFileSync(path.join(worktreeGitDir, 'commondir'), '../..\n');
  writeFileSync(
    path.join(checkoutDir, '.git'),
    `gitdir: ${worktreeGitDir}\n`,
  );
  return { checkoutDir, commonGitDir, worktreeGitDir, cleanupRoot: root };
}

function autonomousSurfaceEnv(packScriptsDir: string, extra: Record<string, string | undefined> = {}) {
  return {
    ...stripInterposerBashEnvBlockers(process.env),
    AO_SESSION_ID: '1',
    AO_TMUX_NAME: 'opk-orchestrator',
    AO_COMMAND_RUNTIME_PREFLIGHT_SKIP: '1',
    PATH: `${packScriptsDir}:${process.env.PATH ?? ''}`,
    ...extra,
  };
}

describe('gh repo resolver git argv guard (Issue #599)', () => {
  it('exports resolver git argv for classification guard', () => {
    expect(exportedResolverArgv).toBe(RESOLVER_GIT_ARGV);
  });

  it('classifies every resolver git argv as read-only on the autonomous boundary', () => {
    for (const argv of RESOLVER_GIT_ARGV) {
      expect(isMutatingGitArgv([...argv])).toBe(false);
    }
  });

  it('demonstrates the regression class: git remote get-url is boundary-denied', () => {
    expect(isMutatingGitArgv(['remote', 'get-url', 'origin'])).toBe(true);
  });
});

describe('gh repo resolver slug derivation (Issue #599)', () => {
  const realGh = resolveRealGhBinary(path.join(import.meta.dirname, 'gh'));

  it('derives slug via sanctioned git config --get remote.origin.url', () => {
    withOriginFixture('https://github.com/chetwerikoff/orchestrator-pack.git', (repoDir) => {
      delete process.env.GH_REPO;
      const ctx = resolveRepoContext({ realGh, cwd: repoDir });
      expect(ctx.slug).toBe('chetwerikoff/orchestrator-pack');
    });
  });

  it('honors explicit --repo over git-derived slug', () => {
    withOriginFixture('https://github.com/chetwerikoff/orchestrator-pack.git', (repoDir) => {
      const ctx = resolveRepoContext({
        realGh,
        cwd: repoDir,
        repoFlag: 'flag-owner/flag-repo',
      });
      expect(ctx.slug).toBe('flag-owner/flag-repo');
    });
  });

  it('honors pre-set GH_REPO over git-derived slug', () => {
    withOriginFixture('https://github.com/chetwerikoff/orchestrator-pack.git', (repoDir) => {
      const prev = process.env.GH_REPO;
      process.env.GH_REPO = 'env-owner/env-repo';
      try {
        const ctx = resolveRepoContext({ realGh, cwd: repoDir });
        expect(ctx.slug).toBe('env-owner/env-repo');
      } finally {
        if (prev === undefined) {
          delete process.env.GH_REPO;
        } else {
          process.env.GH_REPO = prev;
        }
      }
    });
  });

  it('does not leak credential material from origin URL in resolver output', () => {
    withOriginFixture(FIXTURE_ORIGIN, (repoDir) => {
      delete process.env.GH_REPO;
      const captured: string[] = [];
      const originalWrite = process.stdout.write.bind(process.stdout);
      const originalErrWrite = process.stderr.write.bind(process.stderr);
      process.stdout.write = ((chunk: string | Uint8Array) => {
        captured.push(String(chunk));
        return true;
      }) as typeof process.stdout.write;
      process.stderr.write = ((chunk: string | Uint8Array) => {
        captured.push(String(chunk));
        return true;
      }) as typeof process.stderr.write;
      try {
        const slug = resolveNameWithOwner({ realGh, cwd: repoDir });
        expect(slug).toBe(FIXTURE_SLUG);
        expect(captured.join('')).not.toContain(TOKEN_SENTINEL);
      } finally {
        process.stdout.write = originalWrite;
        process.stderr.write = originalErrWrite;
      }
    });
  });
});

describe('git config origin slug reader (Issue #599)', () => {
  it('parses owner/repo from token-bearing HTTPS origin URLs', () => {
    expect(parseRemoteSlug(FIXTURE_ORIGIN)).toBe(FIXTURE_SLUG);
  });

  it('reads origin slug directly from git config without git subprocess', () => {
    const dir = writeConfigOnlyCheckout(FIXTURE_ORIGIN);
    try {
      expect(readOriginUrlFromGitConfig(dir)).toBe(FIXTURE_ORIGIN);
      expect(originSlugFromGitConfig(dir)).toBe(FIXTURE_SLUG);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves origin slug from the common git dir for linked worktree checkouts', () => {
    const fixture = writeWorktreePointerCheckout(FIXTURE_ORIGIN);
    try {
      expect(resolveGitCommonDir(fixture.checkoutDir)).toBe(fixture.commonGitDir);
      expect(readOriginUrlFromGitConfig(fixture.checkoutDir)).toBe(FIXTURE_ORIGIN);
      expect(originSlugFromGitConfig(fixture.checkoutDir)).toBe(FIXTURE_SLUG);
    } finally {
      rmSync(fixture.cleanupRoot, { recursive: true, force: true });
    }
  });

  it('reads origin slug from live AO worktree checkout when present', () => {
    const commonDir = resolveGitCommonDir(repoRoot);
    if (!commonDir || !commonDir.endsWith(`${path.sep}.git`)) {
      return;
    }
    expect(readOriginUrlFromGitConfig(repoRoot)).toMatch(/github\.com[/:][^/]+\/[^/]+/);
    expect(originSlugFromGitConfig(repoRoot)).toMatch(/^[^/]+\/[^/]+$/);
  });
});

describe('surface bootstrap GH_REPO export (Issue #599)', () => {
  it('exports GH_REPO from checkout origin when unset', () => {
    const pack = createIsolatedInterposerPack();
    try {
      mkdirSync(path.join(pack.packRoot, '.git'), { recursive: true });
      writeFileSync(
        path.join(pack.packRoot, '.git', 'config'),
        `[remote "origin"]\n\turl = https://github.com/bootstrap-owner/bootstrap-repo.git\n`,
      );
      writeIsolatedAutonomousRealBinariesConfig(pack, path.join(pack.packRoot, 'ao-stub.sh'));
      writeFileSync(path.join(pack.packRoot, 'ao-stub.sh'), '#!/usr/bin/env bash\nexit 0\n');
      chmodSync(path.join(pack.packRoot, 'ao-stub.sh'), 0o755);

      const script = [
        `export AO_COMMAND_RUNTIME_PREFLIGHT_SKIP=1`,
        `unset GH_REPO`,
        `source "${pack.bootstrapPath}"`,
        `printf '%s' "$GH_REPO"`,
      ].join('\n');
      const result = spawnSync('/bin/bash', ['-c', script], {
        cwd: pack.packRoot,
        encoding: 'utf8',
        env: autonomousSurfaceEnv(pack.scriptsDir, { GH_REPO: undefined }),
      });
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('bootstrap-owner/bootstrap-repo');
      expect(result.stderr).not.toContain('bootstrap-owner/bootstrap-repo.git');
    } finally {
      pack.cleanup();
    }
  });

  it('preserves a pre-set GH_REPO', () => {
    const pack = createIsolatedInterposerPack();
    try {
      writeIsolatedAutonomousRealBinariesConfig(pack, path.join(pack.packRoot, 'ao-stub.sh'));
      writeFileSync(path.join(pack.packRoot, 'ao-stub.sh'), '#!/usr/bin/env bash\nexit 0\n');
      chmodSync(path.join(pack.packRoot, 'ao-stub.sh'), 0o755);

      const script = [
        `export AO_COMMAND_RUNTIME_PREFLIGHT_SKIP=1`,
        `export GH_REPO='preset-owner/preset-repo'`,
        `source "${pack.bootstrapPath}"`,
        `printf '%s' "$GH_REPO"`,
      ].join('\n');
      const result = spawnSync('/bin/bash', ['-c', script], {
        cwd: pack.packRoot,
        encoding: 'utf8',
        env: autonomousSurfaceEnv(pack.scriptsDir),
      });
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('preset-owner/preset-repo');
    } finally {
      pack.cleanup();
    }
  });

  it('does not leak credential material from origin URL on bootstrap stdout/stderr', () => {
    const pack = createIsolatedInterposerPack();
    try {
      mkdirSync(path.join(pack.packRoot, '.git'), { recursive: true });
      writeFileSync(
        path.join(pack.packRoot, '.git', 'config'),
        `[remote "origin"]\n\turl = ${FIXTURE_ORIGIN}\n`,
      );
      writeIsolatedAutonomousRealBinariesConfig(pack, path.join(pack.packRoot, 'ao-stub.sh'));
      writeFileSync(path.join(pack.packRoot, 'ao-stub.sh'), '#!/usr/bin/env bash\nexit 0\n');
      chmodSync(path.join(pack.packRoot, 'ao-stub.sh'), 0o755);

      const script = [
        `export AO_COMMAND_RUNTIME_PREFLIGHT_SKIP=1`,
        `unset GH_REPO`,
        `source "${pack.bootstrapPath}"`,
        `printf '%s' "$GH_REPO"`,
      ].join('\n');
      const result = spawnSync('/bin/bash', ['-c', script], {
        cwd: pack.packRoot,
        encoding: 'utf8',
        env: autonomousSurfaceEnv(pack.scriptsDir, { GH_REPO: undefined }),
      });
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(FIXTURE_SLUG);
      expect(result.stdout).not.toContain(TOKEN_SENTINEL);
      expect(result.stderr).not.toContain(TOKEN_SENTINEL);
    } finally {
      pack.cleanup();
    }
  });
});

describe('autonomous surface slug resolution end-to-end (Issue #599)', () => {
  it('allows sanctioned git config read and denies git remote get-url on the surface', () => {
    const pack = createIsolatedInterposerPack();
    withOriginFixture('https://github.com/chetwerikoff/orchestrator-pack.git', (repoDir) => {
      try {
        writeIsolatedAutonomousRealBinariesConfig(pack, path.join(pack.packRoot, 'ao-stub.sh'));
        writeFileSync(path.join(pack.packRoot, 'ao-stub.sh'), '#!/usr/bin/env bash\nexit 0\n');
        chmodSync(path.join(pack.packRoot, 'ao-stub.sh'), 0o755);

        const allowed = spawnSync('bash', [pack.gitShimPath, 'config', '--get', 'remote.origin.url'], {
          cwd: repoDir,
          encoding: 'utf8',
          env: autonomousSurfaceEnv(pack.scriptsDir),
        });
        expect(allowed.status).toBe(0);
        expect(allowed.stdout.trim()).toContain('github.com/chetwerikoff/orchestrator-pack');

        const denied = spawnSync('bash', [pack.gitShimPath, 'remote', 'get-url', 'origin'], {
          cwd: repoDir,
          encoding: 'utf8',
          env: autonomousSurfaceEnv(pack.scriptsDir),
        });
        expect(denied.status).toBe(93);

        delete process.env.GH_REPO;
        const realGh = resolveRealGhBinary(path.join(pack.scriptsDir, 'gh'));
        const slug = resolveNameWithOwner({ realGh, cwd: repoDir });
        expect(slug).toBe('chetwerikoff/orchestrator-pack');
      } finally {
        pack.cleanup();
      }
    });
  });

  it('gh repo view slug resolution succeeds without could-not-resolve throw', () => {
    const pack = createIsolatedInterposerPack();
    withOriginFixture('https://github.com/chetwerikoff/orchestrator-pack.git', (repoDir) => {
      try {
        cpSync(path.join(repoRoot, 'scripts/lib/gh-repo-resolve.mjs'), path.join(pack.scriptsDir, 'lib/gh-repo-resolve.mjs'));
        cpSync(path.join(repoRoot, 'scripts/lib/git-origin-slug.mjs'), path.join(pack.scriptsDir, 'lib/git-origin-slug.mjs'));
        cpSync(path.join(repoRoot, 'scripts/lib/gh-resolve-real-binary.mjs'), path.join(pack.scriptsDir, 'lib/gh-resolve-real-binary.mjs'));
        cpSync(path.join(repoRoot, 'scripts/lib/gh-rest-routes.mjs'), path.join(pack.scriptsDir, 'lib/gh-rest-routes.mjs'));
        cpSync(path.join(repoRoot, 'scripts/lib/gh-wrapper.mjs'), path.join(pack.scriptsDir, 'lib/gh-wrapper.mjs'));
        cpSync(path.join(repoRoot, 'scripts/gh'), path.join(pack.scriptsDir, 'gh'));
        chmodSync(path.join(pack.scriptsDir, 'gh'), 0o755);
        writeIsolatedAutonomousRealBinariesConfig(pack, path.join(pack.packRoot, 'ao-stub.sh'));
        writeFileSync(path.join(pack.packRoot, 'ao-stub.sh'), '#!/usr/bin/env bash\nexit 0\n');
        chmodSync(path.join(pack.packRoot, 'ao-stub.sh'), 0o755);

        const probe = spawnSync(
          'node',
          [
            '-e',
            `import { resolveNameWithOwner } from './lib/gh-repo-resolve.mjs';
import { resolveRealGhBinary } from './lib/gh-resolve-real-binary.mjs';
const realGh = resolveRealGhBinary(new URL('./gh', import.meta.url).pathname);
try {
  const slug = resolveNameWithOwner({ realGh, cwd: process.argv[1] });
  process.stdout.write(slug);
} catch (err) {
  process.stderr.write(String(err?.message ?? err));
  process.exit(1);
}`,
            repoDir,
          ],
          {
            cwd: pack.scriptsDir,
            encoding: 'utf8',
            env: autonomousSurfaceEnv(pack.scriptsDir, { GH_REPO: undefined }),
          },
        );
        expect(probe.status).toBe(0);
        expect(probe.stdout.trim()).toBe('chetwerikoff/orchestrator-pack');
        expect(probe.stderr).not.toContain('could not resolve repository slug');
      } finally {
        pack.cleanup();
      }
    });
  });
});
