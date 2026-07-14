import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isMutatingGitArgv } from '../docs/autonomous-orchestrator-boundary.mjs';
import { originSlugFromGitConfig, parseRemoteSlug, readOriginUrlFromGitConfig, resolveGitCommonDir, RESOLVER_GIT_ARGV } from './lib/git-origin-slug.mjs';
import { resolveNameWithOwner, resolveRepoContext, RESOLVER_GIT_ARGV as exportedResolverArgv } from './lib/gh-repo-resolve.mjs';
import { resolveRealGhBinary } from './lib/gh-resolve-real-binary.mjs';
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
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
}
function writeConfigOnlyCheckout(originUrl: string) {
    const dir = mkdtempSync(path.join(tmpdir(), 'gh-repo-config-only-'));
    mkdirSync(path.join(dir, '.git'), { recursive: true });
    writeFileSync(path.join(dir, '.git', 'config'), `[remote "origin"]\n\turl = ${originUrl}\n`);
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
    writeFileSync(path.join(commonGitDir, 'config'), `[remote "origin"]\n\turl = ${originUrl}\n`);
    writeFileSync(path.join(worktreeGitDir, 'commondir'), '../..\n');
    writeFileSync(path.join(checkoutDir, '.git'), `gitdir: ${worktreeGitDir}\n`);
    return { checkoutDir, commonGitDir, worktreeGitDir, cleanupRoot: root };
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
            }
            finally {
                if (prev === undefined) {
                    delete process.env.GH_REPO;
                }
                else {
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
            }
            finally {
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
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
    it('resolves origin slug from the common git dir for linked worktree checkouts', () => {
        const fixture = writeWorktreePointerCheckout(FIXTURE_ORIGIN);
        try {
            expect(resolveGitCommonDir(fixture.checkoutDir)).toBe(fixture.commonGitDir);
            expect(readOriginUrlFromGitConfig(fixture.checkoutDir)).toBe(FIXTURE_ORIGIN);
            expect(originSlugFromGitConfig(fixture.checkoutDir)).toBe(FIXTURE_SLUG);
        }
        finally {
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
