import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildSpawnWorktreeGrantRecord,
  deriveSpawnAuthorizedWorkerBranches,
  evaluateSpawnWorktreeBranchBinding,
  evaluateSpawnWorktreeGrantConsume,
} from '../docs/spawn-worktree-grant.mjs';
import { headOidSpawnWorktreeRepo, setupSpawnWorktreeRepo } from './_test-spawn-worktree-fixture.js';
import { repoRoot } from './_test-pwsh-helpers.js';

const captureManifestPath = path.join(
  repoRoot,
  'tests/external-output-references/captures/spawn-worktree-branch-operand-binding/capture-manifest.json',
);

function consumeWithBranch(
  grant: Record<string, unknown>,
  branch: string,
  targetBasename: string,
  repo: string,
  baseRef: string,
) {
  const prefix = '/tmp/projects/orchestrator-pack/worktrees';
  const target = `${prefix}/${targetBasename}`;
  return evaluateSpawnWorktreeGrantConsume({
    grant,
    argv: ['worktree', 'add', '-b', branch, target, baseRef],
    canonicalPath: target,
    worktreesPrefix: prefix,
    targetPreexists: false,
    effectiveRepositoryRoot: repo,
    effectiveGitWorktreeRoot: repo,
  });
}

describe('spawn worktree branch-operand binding (#561)', () => {
  it('records production-shaped branch_mismatch when grant lacks branch binding (pre-fix baseline)', () => {
    setupSpawnWorktreeRepo(({ repo, baseRef }) => {
      const built = buildSpawnWorktreeGrantRecord({
        argv: ['spawn', '--issue', '315'],
        grantId: 'grant-pre-fix',
        holder: { pid: 1 },
        sourceRepositoryRoot: repo,
        expectedHeadRef: baseRef,
      });
      expect(built.ok).toBe(true);
      const legacyGrant = {
        ...built.grant,
        authorizedWorkerBranches: [],
        expectedBranch: null,
      };
      const consume = consumeWithBranch(
        legacyGrant as Record<string, unknown>,
        'feat/issue-315',
        'opk-315',
        repo,
        baseRef,
      );
      expect(consume.ok).toBe(false);
      expect(consume.reason).toBe('branch_mismatch');
    });
  });

  it('allows production-shaped spawn-new worker branch under active grant', () => {
    setupSpawnWorktreeRepo(({ repo, baseRef }) => {
      const built = buildSpawnWorktreeGrantRecord({
        argv: ['spawn', '--issue', '561'],
        grantId: 'grant-spawn-new',
        holder: { pid: 1 },
        sourceRepositoryRoot: repo,
        expectedHeadRef: baseRef,
      });
      expect(built.ok).toBe(true);
      expect(built.grant?.authorizedWorkerBranches).toEqual(
        expect.arrayContaining(['feat/issue-561', 'feat/561', 'opk-561']),
      );

      for (const branch of ['feat/issue-561', 'feat/561', 'opk-561']) {
        const consume = consumeWithBranch(
          built.grant as Record<string, unknown>,
          branch,
          'opk-561',
          repo,
          baseRef,
        );
        expect(consume.ok).toBe(true);
        expect(consume.reason).toBe('spawn_worktree_allow');
      }
    });
  });

  it('denies arbitrary, orchestrator, and malformed branch operands before mutation', () => {
    setupSpawnWorktreeRepo(({ repo, baseRef }) => {
      const built = buildSpawnWorktreeGrantRecord({
        argv: ['spawn', '--issue', '561'],
        grantId: 'grant-negative',
        holder: { pid: 1 },
        sourceRepositoryRoot: repo,
        expectedHeadRef: baseRef,
      });
      expect(built.ok).toBe(true);

      for (const branch of ['arbitrary', 'orchestrator/op-orchestrator', 'main', 'feat/issue-999']) {
        const consume = consumeWithBranch(
          built.grant as Record<string, unknown>,
          branch,
          'opk-561',
          repo,
          baseRef,
        );
        expect(consume.ok).toBe(false);
        expect(consume.reason).toBe('branch_mismatch');
      }

      expect(evaluateSpawnWorktreeBranchBinding('', built.grant as Record<string, unknown>).reason).toBe(
        'branch_missing',
      );
    });
  });

  it('shares branch contract for claim-pr worktree add via owner session branch', () => {
    setupSpawnWorktreeRepo(({ repo, baseRef }) => {
      const built = buildSpawnWorktreeGrantRecord({
        argv: ['spawn', '--claim-pr', '493'],
        grantId: 'grant-claim-pr',
        holder: { pid: 1 },
        sourceRepositoryRoot: repo,
        expectedHeadRef: baseRef,
        expectedPrHeadOid: headOidSpawnWorktreeRepo(repo),
        expectedPrRefToken: 'feat/493',
        extraAuthorizedWorktreeNames: ['opk-99'],
      });
      expect(built.ok).toBe(true);
      expect(built.grant?.authorizedWorkerBranches).toEqual(expect.arrayContaining(['opk-99']));

      const allow = consumeWithBranch(
        built.grant as Record<string, unknown>,
        'opk-99',
        'opk-99',
        repo,
        baseRef,
      );
      expect(allow.ok).toBe(true);

      const deny = consumeWithBranch(
        built.grant as Record<string, unknown>,
        'feat/493',
        'opk-99',
        repo,
        baseRef,
      );
      expect(deny.ok).toBe(false);
      expect(deny.reason).toBe('branch_mismatch');
    });
  });

  it('derives issue-linked worker branches from spawn target only', () => {
    const branches = deriveSpawnAuthorizedWorkerBranches(
      { action: 'spawn-new', targetKey: '315', prNumber: null, issueTarget: '315' },
      [],
    );
    expect(branches).toEqual(['feat/issue-315', 'feat/315', 'opk-315']);
  });

  it('replays capture manifest for spawn-new and claim-pr branch operands', () => {
    const manifest = JSON.parse(readFileSync(captureManifestPath, 'utf8')) as {
      spawnNew: { argv: string[]; workerBranch: string; worktreeBasename: string };
      claimPr: { argv: string[]; workerBranch: string; worktreeBasename: string; blockedBy522: boolean };
    };

    setupSpawnWorktreeRepo(({ repo, baseRef }) => {
      const spawnBuilt = buildSpawnWorktreeGrantRecord({
        argv: ['spawn', '--issue', '561'],
        grantId: 'capture-spawn-new',
        holder: { pid: 1 },
        sourceRepositoryRoot: repo,
        expectedHeadRef: baseRef,
      });
      const spawnArgv = manifest.spawnNew.argv.map((part) => (
        part === 'origin/main' ? baseRef : part
      ));
      const spawnConsume = evaluateSpawnWorktreeGrantConsume({
        grant: spawnBuilt.grant,
        argv: spawnArgv,
        canonicalPath: `/tmp/projects/orchestrator-pack/worktrees/${manifest.spawnNew.worktreeBasename}`,
        worktreesPrefix: '/tmp/projects/orchestrator-pack/worktrees',
        targetPreexists: false,
        effectiveRepositoryRoot: repo,
        effectiveGitWorktreeRoot: repo,
      });
      expect(spawnConsume.ok).toBe(true);
      expect(manifest.spawnNew.workerBranch).toBe('feat/issue-561');

      const claimBuilt = buildSpawnWorktreeGrantRecord({
        argv: ['spawn', '--claim-pr', '493'],
        grantId: 'capture-claim-pr',
        holder: { pid: 1 },
        sourceRepositoryRoot: repo,
        expectedHeadRef: baseRef,
        expectedPrHeadOid: headOidSpawnWorktreeRepo(repo),
        expectedPrRefToken: 'feat/493',
        extraAuthorizedWorktreeNames: [manifest.claimPr.worktreeBasename],
      });
      const claimArgv = manifest.claimPr.argv.map((part) => (
        part === 'origin/main' ? baseRef : part
      ));
      const claimConsume = evaluateSpawnWorktreeGrantConsume({
        grant: claimBuilt.grant,
        argv: claimArgv,
        canonicalPath: `/tmp/projects/orchestrator-pack/worktrees/${manifest.claimPr.worktreeBasename}`,
        worktreesPrefix: '/tmp/projects/orchestrator-pack/worktrees',
        targetPreexists: false,
        effectiveRepositoryRoot: repo,
        effectiveGitWorktreeRoot: repo,
      });
      expect(claimConsume.ok).toBe(true);
      expect(manifest.claimPr.blockedBy522).toBe(true);
    });
  });

});
