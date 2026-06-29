import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildSpawnWorktreeGrantRecord,
  evaluateSpawnWorktreeGrantConsume,
} from '../docs/spawn-worktree-grant.mjs';
import {
  evaluateSpawnClaimPrPostCheckout,
  evaluateSpawnWorktreeHeadRefAuthorization,
  resolveGitCommitRefInRepo,
  resolveSpawnDefaultBranchBaseRef,
  rewriteGitWorktreeAddCommitArgv,
} from '../docs/spawn-worktree-git-ref.mjs';
import { resolveTrustedSystemGit, withTempGitRepo } from './_test-git-fixture.js';
import { psString, repoRoot, runPwsh } from './_test-pwsh-helpers.js';

const git = resolveTrustedSystemGit();
const spawnWorktreeGatePath = path.join(repoRoot, 'scripts/lib/Autonomous-SpawnWorktreeGate.ps1');
const boundaryLibPath = path.join(repoRoot, 'scripts/lib/Orchestrator-AutonomousBoundary.ps1');
const captureManifestPath = path.join(
  repoRoot,
  'tests/external-output-references/captures/spawn-worktree-head-ref-oid-binding/capture-manifest.json',
);

function gitIn(dir: string, args: string[]) {
  execFileSync(git, ['-C', dir, ...args], { stdio: 'ignore' });
}

function headOid(dir: string) {
  return execFileSync(git, ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim().toLowerCase();
}

function shortUniqueOid(dir: string) {
  const full = headOid(dir);
  for (let len = 7; len <= 12; len += 1) {
    const prefix = full.slice(0, len);
    try {
      execFileSync(git, ['-C', dir, 'rev-parse', '--verify', '--end-of-options', prefix], { stdio: 'ignore' });
      return prefix;
    }
    catch {
      // keep lengthening until unique
    }
  }
  return full.slice(0, 12);
}

function findAmbiguousShortOidPrefix(dir: string, blobCount = 1500) {
  const oids = [headOid(dir)];
  for (let i = 0; i < blobCount; i += 1) {
    const hash = spawnSync(git, ['-C', dir, 'hash-object', '-w', '--stdin'], {
      input: `spawn-worktree-ambiguous-fixture-blob-${i}`,
      encoding: 'utf8',
    });
    if (hash.status === 0 && hash.stdout.trim()) {
      oids.push(hash.stdout.trim().toLowerCase());
    }
  }
  for (let len = 4; len <= 7; len += 1) {
    const buckets = new Map<string, number>();
    for (const oid of oids) {
      const prefix = oid.slice(0, len);
      buckets.set(prefix, (buckets.get(prefix) ?? 0) + 1);
    }
    for (const [prefix, count] of buckets) {
      if (count >= 2) {
        const resolved = resolveGitCommitRefInRepo(dir, prefix);
        if (!resolved.ok && resolved.reason === 'head_ref_ambiguous') {
          return prefix;
        }
      }
    }
  }
  throw new Error('ambiguous short-OID fixture setup failed');
}

function setupSpawnRepo(run: (ctx: { repo: string; mainOid: string; baseRef: string }) => void) {
  withTempGitRepo((repo) => {
    writeFileSync(path.join(repo, 'feature.txt'), 'feature\n');
    gitIn(repo, ['add', 'feature.txt']);
    gitIn(repo, ['commit', '-m', 'feature']);
    const mainOid = headOid(repo);
    gitIn(repo, ['branch', 'feature-branch']);
    gitIn(repo, ['update-ref', 'refs/heads/main', mainOid]);
    gitIn(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    gitIn(repo, ['remote', 'add', 'origin', repo]);
    gitIn(repo, ['update-ref', 'refs/remotes/origin/main', mainOid]);
    const baseRef = resolveSpawnDefaultBranchBaseRef(repo).refToken ?? 'refs/heads/main';
    run({ repo, mainOid, baseRef });
  });
}

describe('spawn worktree head-ref OID binding (#493)', () => {
  it('fixtureMode resolves HEAD when default branch refs are absent', () => {
    withTempGitRepo((repo) => {
      const commit = headOid(repo);
      gitIn(repo, ['checkout', '--detach', 'HEAD']);
      gitIn(repo, ['update-ref', '-d', 'refs/heads/main']);
      expect(resolveSpawnDefaultBranchBaseRef(repo, 'main', false).ok).toBe(false);
      const fixture = resolveSpawnDefaultBranchBaseRef(repo, 'main', true);
      expect(fixture.ok).toBe(true);
      expect(fixture.refToken).toBe('HEAD');
      expect(resolveGitCommitRefInRepo(repo, fixture.refToken ?? '').commitOid).toBe(commit);
    });
  });

  it('literal HEAD vs origin/main spellings allow when OID matches', () => {
    setupSpawnRepo(({ repo, mainOid, baseRef }) => {
      const built = buildSpawnWorktreeGrantRecord({
        argv: ['spawn', '493'],
        grantId: 'grant-head-spellings',
        holder: { pid: 1 },
        sourceRepositoryRoot: repo,
        expectedHeadRef: 'HEAD',
      });
      expect(built.ok).toBe(true);
      expect(built.grant?.expectedCommitOid).toBe(mainOid);

      for (const commitToken of ['HEAD', baseRef, 'refs/heads/main', mainOid, shortUniqueOid(repo), 'feature-branch']) {
        const consume = evaluateSpawnWorktreeGrantConsume({
          grant: built.grant,
          argv: ['worktree', 'add', '/tmp/projects/orchestrator-pack/worktrees/opk-493', commitToken],
          canonicalPath: '/tmp/projects/orchestrator-pack/worktrees/opk-493',
          worktreesPrefix: '/tmp/projects/orchestrator-pack/worktrees',
          targetPreexists: false,
          effectiveRepositoryRoot: repo,
        });
        expect(consume.ok, commitToken).toBe(true);
        expect(consume.normalizedCommitOid).toBe(mainOid);
      }
    });
  });

  it('proves pre-fix literal comparison class would deny equivalent spellings', () => {
    setupSpawnRepo(({ repo, baseRef }) => {
      const auth = evaluateSpawnWorktreeHeadRefAuthorization({
        repoRoot: repo,
        expectedRefToken: 'HEAD',
        actualRefToken: baseRef,
      });
      expect(auth.ok).toBe(true);
      expect(auth.expectedRefToken).toBe('HEAD');
      expect(auth.actualRefToken).toBe(baseRef);
      expect(auth.expectedRefToken).not.toBe(auth.actualRefToken);
    });
  });

  it('allows split expectedRepoRoot/actualRepoRoot without legacy repoRoot', () => {
    setupSpawnRepo(({ repo, baseRef }) => {
      const auth = evaluateSpawnWorktreeHeadRefAuthorization({
        expectedRepoRoot: repo,
        actualRepoRoot: repo,
        expectedRefToken: 'HEAD',
        actualRefToken: baseRef,
      });
      expect(auth.ok).toBe(true);
      expect(auth.reason).toBe('head_ref_oid_allow');
    });
  });

  it('denies different commit, unresolvable, ambiguous, and wrong-repo refs', () => {
    setupSpawnRepo(({ repo, mainOid, baseRef }) => {
      writeFileSync(path.join(repo, 'other.txt'), 'other\n');
      gitIn(repo, ['add', 'other.txt']);
      gitIn(repo, ['commit', '-m', 'other']);
      const otherOid = headOid(repo);
      gitIn(repo, ['update-ref', 'refs/heads/main', mainOid]);
      gitIn(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main']);

      const built = buildSpawnWorktreeGrantRecord({
        argv: ['spawn', '493'],
        grantId: 'grant-negative',
        holder: { pid: 1 },
        sourceRepositoryRoot: repo,
        expectedHeadRef: baseRef,
      });
      expect(built.ok).toBe(true);

      const denyOther = evaluateSpawnWorktreeGrantConsume({
        grant: built.grant,
        argv: ['worktree', 'add', '/tmp/projects/orchestrator-pack/worktrees/opk-493', otherOid],
        canonicalPath: '/tmp/projects/orchestrator-pack/worktrees/opk-493',
        worktreesPrefix: '/tmp/projects/orchestrator-pack/worktrees',
        targetPreexists: false,
        effectiveRepositoryRoot: repo,
      });
      expect(denyOther.ok).toBe(false);
      expect(denyOther.reason).toBe('head_oid_mismatch');

      const denyMissing = evaluateSpawnWorktreeGrantConsume({
        grant: built.grant,
        argv: ['worktree', 'add', '/tmp/projects/orchestrator-pack/worktrees/opk-493', 'not-a-ref'],
        canonicalPath: '/tmp/projects/orchestrator-pack/worktrees/opk-493',
        worktreesPrefix: '/tmp/projects/orchestrator-pack/worktrees',
        targetPreexists: false,
        effectiveRepositoryRoot: repo,
      });
      expect(denyMissing.ok).toBe(false);
      expect(denyMissing.reason).toBe('head_ref_unresolvable');

      withTempGitRepo((otherRepo) => {
        const denyWrongBinding = evaluateSpawnWorktreeGrantConsume({
          grant: built.grant,
          argv: ['worktree', 'add', '/tmp/projects/orchestrator-pack/worktrees/opk-493', baseRef],
          canonicalPath: '/tmp/projects/orchestrator-pack/worktrees/opk-493',
          worktreesPrefix: '/tmp/projects/orchestrator-pack/worktrees',
          targetPreexists: false,
          effectiveRepositoryRoot: otherRepo,
        });
        expect(denyWrongBinding.ok).toBe(false);
        expect(denyWrongBinding.reason).toBe('repository_root_mismatch');
      });

      const blobOid = execFileSync(git, ['-C', repo, 'hash-object', '-w', path.join(repo, 'README.md')], {
        encoding: 'utf8',
      }).trim();
      const denyBlob = evaluateSpawnWorktreeGrantConsume({
        grant: built.grant,
        argv: ['worktree', 'add', '/tmp/projects/orchestrator-pack/worktrees/opk-493', blobOid],
        canonicalPath: '/tmp/projects/orchestrator-pack/worktrees/opk-493',
        worktreesPrefix: '/tmp/projects/orchestrator-pack/worktrees',
        targetPreexists: false,
        effectiveRepositoryRoot: repo,
      });
      expect(denyBlob.ok).toBe(false);
      expect(denyBlob.reason).toBe('head_ref_not_commit');

      const ambiguousPrefix = findAmbiguousShortOidPrefix(repo);
      const denyAmbiguous = evaluateSpawnWorktreeGrantConsume({
        grant: built.grant,
        argv: ['worktree', 'add', '/tmp/projects/orchestrator-pack/worktrees/opk-493', ambiguousPrefix],
        canonicalPath: '/tmp/projects/orchestrator-pack/worktrees/opk-493',
        worktreesPrefix: '/tmp/projects/orchestrator-pack/worktrees',
        targetPreexists: false,
        effectiveRepositoryRoot: repo,
      });
      expect(denyAmbiguous.ok).toBe(false);
      expect(denyAmbiguous.reason).toBe('head_ref_ambiguous');
      expect(resolveGitCommitRefInRepo(repo, ambiguousPrefix).reason).toBe('head_ref_ambiguous');
    });
  });

  it('rewrites worktree add argv to normalized full OID (mutable-ref race closure)', () => {
    setupSpawnRepo(({ repo, mainOid, baseRef }) => {
      const rewritten = rewriteGitWorktreeAddCommitArgv(
        ['worktree', 'add', '-b', 'opk-493', '/tmp/projects/orchestrator-pack/worktrees/opk-493', baseRef],
        mainOid,
      );
      expect(rewritten.at(-1)).toBe(mainOid);
      expect(rewritten).not.toContain(baseRef);
    });
  });

  it('claim-pr default-branch worktree add binds OID and post-checkout verifies PR head', () => {
    setupSpawnRepo(({ repo, mainOid, baseRef }) => {
      const prHead = mainOid;
      const built = buildSpawnWorktreeGrantRecord({
        argv: ['spawn', '--claim-pr', '493'],
        grantId: 'grant-claim-pr-493',
        holder: { pid: 1 },
        sourceRepositoryRoot: repo,
        expectedHeadRef: baseRef,
        expectedPrHeadOid: prHead,
        expectedPrRefToken: 'fixture-pr-493',
      });
      expect(built.ok).toBe(true);
      expect(built.grant?.expectedCommitOid).toBe(mainOid);

      const consume = evaluateSpawnWorktreeGrantConsume({
        grant: built.grant,
        argv: ['worktree', 'add', '/tmp/projects/orchestrator-pack/worktrees/opk-99', baseRef],
        canonicalPath: '/tmp/projects/orchestrator-pack/worktrees/opk-99',
        worktreesPrefix: '/tmp/projects/orchestrator-pack/worktrees',
        targetPreexists: false,
        effectiveRepositoryRoot: repo,
      });
      expect(consume.ok).toBe(true);

      const workspace = mkdtempSync(path.join(tmpdir(), 'claim-pr-wt-'));
      try {
        gitIn(repo, ['worktree', 'add', '-b', 'opk-99', workspace, mainOid]);
        const verify = evaluateSpawnClaimPrPostCheckout({
          workspaceRoot: workspace,
          expectedPrHeadOid: prHead,
          prNumber: 493,
          prRefToken: 'fixture-pr-493',
        });
        expect(verify.ok).toBe(true);
      }
      finally {
        gitIn(repo, ['worktree', 'remove', '--force', workspace]);
        rmSync(workspace, { recursive: true, force: true });
      }
    });
  });

  it('replays capture manifest for spawn-new and claim-pr argv evidence', () => {
    expect(existsSync(captureManifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(captureManifestPath, 'utf8')) as {
      aoPackageVersion: string;
      spawnNew: { gateEntrypoint: string; argv: string[]; headRefToken: string; baseRefToken: string };
      claimPr: {
        gateEntrypoint: string;
        defaultBranchBaseRefToken: string;
        defaultBranchStartOid: string;
        expectedPrHeadOid: string;
        expectedPrRefToken: string;
        worktreeAddArgv: string[];
        workerHandoffBeforeCheckoutVerified: boolean;
        postClaimCheckout: {
          ok: boolean;
          reason: string;
          expectedPrHeadOid: string;
          actualWorkspaceHeadOid: string;
        };
      };
    };

    setupSpawnRepo(({ repo, mainOid, baseRef }) => {
      expect(manifest.spawnNew.baseRefToken).toBe('origin/main');
      expect(manifest.spawnNew.baseRefToken).not.toBe(manifest.spawnNew.headRefToken);
      expect(resolveGitCommitRefInRepo(repo, baseRef).commitOid).toBe(mainOid);

      const spawnArgv = manifest.spawnNew.argv.map((part) => (part === 'origin/main' ? baseRef : part));
      const built = buildSpawnWorktreeGrantRecord({
        argv: ['spawn', '493'],
        grantId: 'capture-spawn-new',
        holder: { pid: 1 },
        sourceRepositoryRoot: repo,
        expectedHeadRef: baseRef,
        expectedBranch: 'opk-493',
      });
      const consume = evaluateSpawnWorktreeGrantConsume({
        grant: built.grant,
        argv: spawnArgv,
        canonicalPath: '/tmp/projects/orchestrator-pack/worktrees/opk-493',
        worktreesPrefix: '/tmp/projects/orchestrator-pack/worktrees',
        targetPreexists: false,
        effectiveRepositoryRoot: repo,
      });
      expect(consume.ok).toBe(true);
      expect(manifest.aoPackageVersion).toMatch(/^0\.9\./);
      expect(manifest.spawnNew.gateEntrypoint).toContain('git-autonomous-guard.ps1');
      expect(manifest.claimPr.gateEntrypoint).toContain('git-autonomous-guard.ps1');

      expect(manifest.claimPr.defaultBranchBaseRefToken).toBe('origin/main');
      expect(manifest.claimPr.defaultBranchStartOid).toMatch(/^[0-9a-f]{40}$/i);
      expect(manifest.claimPr.expectedPrHeadOid).toMatch(/^[0-9a-f]{40}$/i);
      expect(manifest.claimPr.postClaimCheckout.ok).toBe(true);
      expect(manifest.claimPr.postClaimCheckout.reason).toBe('claim_pr_post_checkout_allow');
      expect(manifest.claimPr.postClaimCheckout.expectedPrHeadOid).toBe(manifest.claimPr.expectedPrHeadOid);
      expect(manifest.claimPr.postClaimCheckout.actualWorkspaceHeadOid).toBe(manifest.claimPr.expectedPrHeadOid);
      expect(manifest.claimPr.workerHandoffBeforeCheckoutVerified).toBe(false);

      const claimArgv = manifest.claimPr.worktreeAddArgv.map((part) => (
        part === manifest.claimPr.defaultBranchBaseRefToken ? baseRef : part
      ));
      const claimBuilt = buildSpawnWorktreeGrantRecord({
        argv: ['spawn', '--claim-pr', '493'],
        grantId: 'capture-claim-pr',
        holder: { pid: 1 },
        sourceRepositoryRoot: repo,
        expectedHeadRef: baseRef,
        expectedBranch: 'opk-99',
        expectedPrHeadOid: manifest.claimPr.expectedPrHeadOid,
        expectedPrRefToken: manifest.claimPr.expectedPrRefToken,
      });
      expect(claimBuilt.grant?.expectedCommitOid).toBe(mainOid);
      expect(claimBuilt.grant?.expectedPrHeadOid).toBe(manifest.claimPr.expectedPrHeadOid);

      const claimConsume = evaluateSpawnWorktreeGrantConsume({
        grant: claimBuilt.grant,
        argv: claimArgv,
        canonicalPath: '/tmp/projects/orchestrator-pack/worktrees/opk-99',
        worktreesPrefix: '/tmp/projects/orchestrator-pack/worktrees',
        targetPreexists: false,
        effectiveRepositoryRoot: repo,
      });
      expect(claimConsume.ok).toBe(true);

      const workspace = mkdtempSync(path.join(tmpdir(), 'capture-claim-pr-wt-'));
      try {
        gitIn(repo, ['worktree', 'add', '-b', 'opk-99', workspace, mainOid]);
        const fixtureVerify = evaluateSpawnClaimPrPostCheckout({
          workspaceRoot: workspace,
          expectedPrHeadOid: mainOid,
          prNumber: 493,
          prRefToken: manifest.claimPr.expectedPrRefToken,
        });
        expect(fixtureVerify.ok).toBe(manifest.claimPr.postClaimCheckout.ok);
        expect(fixtureVerify.reason).toBe(manifest.claimPr.postClaimCheckout.reason);
        expect(fixtureVerify.actualWorkspaceHeadOid).toBe(mainOid);

        if (mainOid !== manifest.claimPr.postClaimCheckout.expectedPrHeadOid) {
          const capturedVerify = evaluateSpawnClaimPrPostCheckout({
            workspaceRoot: workspace,
            expectedPrHeadOid: manifest.claimPr.postClaimCheckout.expectedPrHeadOid,
            prNumber: 493,
            prRefToken: manifest.claimPr.expectedPrRefToken,
          });
          expect(capturedVerify.ok).toBe(false);
          expect(capturedVerify.reason).toBe('claim_pr_head_oid_mismatch');
        }
      }
      finally {
        gitIn(repo, ['worktree', 'remove', '--force', workspace]);
        rmSync(workspace, { recursive: true, force: true });
      }
    });
  });

  it('PowerShell mint resolves default-branch base ref for spawn-new integration', () => {
    const aoBase = mkdtempSync(path.join(tmpdir(), 'ao-head-ref-oid-'));
    const projectId = 'orchestrator-pack';
    const worktrees = path.join(aoBase, 'projects', projectId, 'worktrees');
    const baseRefResult = resolveSpawnDefaultBranchBaseRef(repoRoot, 'main', true);
    const baseRef = baseRefResult.ok ? (baseRefResult.refToken ?? 'HEAD') : 'HEAD';
    const expectedOid = resolveGitCommitRefInRepo(repoRoot, baseRef).commitOid ?? headOid(repoRoot);
    const target = path.join(worktrees, 'opk-493');
    try {
      const output = runPwsh(`
        . ${psString(spawnWorktreeGatePath)}
        . ${psString(boundaryLibPath)}
        $env:AO_AUTONOMOUS_ORCHESTRATOR_SURFACE = '1'
        $env:AO_SPAWN_WORKTREE_FIXTURE_MODE = '1'
        $env:AO_BASE_DIR = ${psString(aoBase)}
        $env:AO_PROJECT_ID = ${psString(projectId)}
        $built = Invoke-SpawnWorktreeGrantCli -Subcommand 'buildGrant' -Payload @{
          argv = @('spawn','493')
          grantId = 'ps-grant-493'
          projectId = ${psString(projectId)}
          holder = @{ pid = $PID; host = 'test'; processGuid = 'fixture'; surface = 'test'; acquiredAtUtc = '2026-01-01T00:00:00Z' }
          extraAuthorizedWorktreeNames = @()
          expectedHeadRef = ${psString(baseRef)}
          sourceRepositoryRoot = [string](Resolve-AutonomousSpawnWorktreeSourceRepositoryRoot).path
          sourceGitWorktreeRoot = [string](Resolve-AutonomousSpawnWorktreeSourceGitWorktreeRoot).path
        }
        $ns = Get-AutonomousSpawnWorktreeGrantNamespace -ProjectId ${psString(projectId)}
        Write-AutonomousSpawnWorktreeGrantAtomic -Namespace $ns -GrantId 'ps-grant-493' -Record $built.grant | Out-Null
        $env:AO_SPAWN_WORKTREE_GRANT_ID = 'ps-grant-493'
        $verdict = Test-AutonomousGitDenied -Argv @('worktree','add',${psString(target)},${psString(baseRef)})
        [pscustomobject]@{ denied = [bool]$verdict.denied; reason = [string]$verdict.reason; normalizedCommitOid = [string]$verdict.normalizedCommitOid } | ConvertTo-Json -Compress
      `);
      const parsed = JSON.parse(output) as { denied: boolean; reason: string; normalizedCommitOid: string };
      expect(parsed.denied).toBe(false);
      expect(parsed.reason).toBe('spawn_worktree_allow');
      expect(parsed.normalizedCommitOid).toBe(expectedOid);
    }
    finally {
      rmSync(aoBase, { recursive: true, force: true });
    }
  });
});
