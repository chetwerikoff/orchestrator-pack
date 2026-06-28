import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildSpawnWorktreeGrantRecord,
  canonicalRepositoryRootsEqual,
  evaluateSpawnWorktreeGrantConsume,
  resolveGitRepositoryIdentity,
} from '../docs/spawn-worktree-grant.mjs';
import { resolveGitCommitRefInRepo } from '../docs/spawn-worktree-git-ref.mjs';
import { gitFixtureEnv, resolveTrustedSystemGit, withTempGitRepo } from './_test-git-fixture.js';
import { repoRoot, psString } from './_test-pwsh-helpers.js';

const spawnWorktreeGatePath = path.join(repoRoot, 'scripts/lib/Autonomous-SpawnWorktreeGate.ps1');
const boundaryLibPath = path.join(repoRoot, 'scripts/lib/Orchestrator-AutonomousBoundary.ps1');
const captureManifestPath = path.join(
  repoRoot,
  'tests/external-output-references/captures/spawn-worktree-repository-identity-binding/capture-manifest.json',
);

function gitIn(cwd: string, args: string[]) {
  return execFileSync(resolveTrustedSystemGit(), args, {
    cwd,
    encoding: 'utf8',
    env: gitFixtureEnv(),
  });
}

function setupLinkedWorktreePair() {
  const git = resolveTrustedSystemGit();
  const mainRoot = mkdtempSync(path.join(tmpdir(), 'spawn-grant-main-'));
  const linkedRoot = path.join(path.dirname(mainRoot), `${path.basename(mainRoot)}-linked`);
  gitIn(mainRoot, ['init', '-b', 'main']);
  gitIn(mainRoot, ['config', 'user.email', 'spawn-grant@test.local']);
  gitIn(mainRoot, ['config', 'user.name', 'Spawn Grant Test']);
  writeFileSync(path.join(mainRoot, 'README.md'), 'linked-worktree-fixture\n');
  gitIn(mainRoot, ['add', 'README.md']);
  gitIn(mainRoot, ['commit', '-m', 'init']);
  gitIn(mainRoot, ['worktree', 'add', '-b', 'linked-wt', linkedRoot, 'HEAD']);

  const mainResolver = resolveGitRepositoryIdentity(mainRoot);
  const linkedResolver = resolveGitRepositoryIdentity(linkedRoot);
  expect(mainResolver.ok).toBe(true);
  expect(linkedResolver.ok).toBe(true);
  expect(mainResolver.showToplevel).not.toBe(linkedResolver.showToplevel);
  expect(mainResolver.identity).toBe(linkedResolver.identity);

  return {
    mainRoot,
    linkedRoot,
    identity: mainResolver.identity!,
    resolverEvidence: {
      mainShowToplevel: mainResolver.showToplevel!,
      linkedShowToplevel: linkedResolver.showToplevel!,
      mainGitCommonDirRaw: mainResolver.gitCommonDirRaw!,
      linkedGitCommonDirRaw: linkedResolver.gitCommonDirRaw!,
      sharedIdentity: mainResolver.identity!,
    },
    cleanup() {
      try {
        gitIn(mainRoot, ['worktree', 'remove', '--force', linkedRoot]);
      }
      catch {
        // linked worktree may already be removed in ambiguity tests
      }
      rmSync(linkedRoot, { recursive: true, force: true });
      rmSync(mainRoot, { recursive: true, force: true });
    },
  };
}

describe('spawn worktree repository identity binding (#511)', () => {
  const tempRoots: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of tempRoots.splice(0)) {
      cleanup();
    }
  });

  it('allows same shared repo identity across linked worktree and main checkout', () => {
    const fixture = setupLinkedWorktreePair();
    tempRoots.push(fixture.cleanup);

    const prefix = '/tmp/projects/orchestrator-pack/worktrees';
    const target = `${prefix}/opk-511`;
    const headOid = resolveGitCommitRefInRepo(fixture.mainRoot, 'HEAD').commitOid!;

    const built = buildSpawnWorktreeGrantRecord({
      argv: ['spawn', '511'],
      grantId: 'grant-linked-worktree',
      projectId: 'orchestrator-pack',
      holder: { pid: 1 },
      sourceRepositoryRoot: fixture.identity,
      expectedHeadRef: 'HEAD',
      expectedCommitOid: headOid,
    });
    expect(built.ok).toBe(true);

    const consume = evaluateSpawnWorktreeGrantConsume({
      grant: built.grant,
      argv: ['worktree', 'add', target, 'HEAD'],
      canonicalPath: target,
      worktreesPrefix: prefix,
      targetPreexists: false,
      effectiveRepositoryRoot: fixture.identity,
    });
    expect(consume.ok).toBe(true);
    expect(consume.reason).toBe('spawn_worktree_allow');
  });

  it('denies cross-repository consume before tree mutation', () => {
    withTempGitRepo((repoA) => {
      withTempGitRepo((repoB) => {
        const identityA = resolveGitRepositoryIdentity(repoA);
        const identityB = resolveGitRepositoryIdentity(repoB);
        expect(identityA.ok).toBe(true);
        expect(identityB.ok).toBe(true);
        expect(identityA.identity).not.toBe(identityB.identity);

        const prefix = '/tmp/projects/orchestrator-pack/worktrees';
        const target = `${prefix}/opk-511`;
        const built = buildSpawnWorktreeGrantRecord({
          argv: ['spawn', '511'],
          grantId: 'grant-cross-repo',
          projectId: 'orchestrator-pack',
          holder: { pid: 1 },
          sourceRepositoryRoot: identityA.identity!,
        });
        expect(built.ok).toBe(true);

        const consume = evaluateSpawnWorktreeGrantConsume({
          grant: built.grant,
          argv: ['worktree', 'add', target, 'HEAD'],
          canonicalPath: target,
          worktreesPrefix: prefix,
          targetPreexists: false,
          effectiveRepositoryRoot: identityB.identity!,
        });
        expect(consume.ok).toBe(false);
        expect(consume.reason).toBe('repository_root_mismatch');
      });
    });
  });

  it('grounds fixtures in real git resolver output', () => {
    const fixture = setupLinkedWorktreePair();
    tempRoots.push(fixture.cleanup);

    expect(fixture.resolverEvidence.mainShowToplevel).toBeTruthy();
    expect(fixture.resolverEvidence.linkedShowToplevel).toBeTruthy();
    expect(fixture.resolverEvidence.mainGitCommonDirRaw).toBeTruthy();
    expect(fixture.resolverEvidence.linkedGitCommonDirRaw).toBeTruthy();
    expect(fixture.resolverEvidence.sharedIdentity).toContain('.git');
    expect(canonicalRepositoryRootsEqual(
      fixture.resolverEvidence.sharedIdentity,
      fixture.resolverEvidence.sharedIdentity,
    )).toBe(true);

    expect(existsSync(captureManifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(captureManifestPath, 'utf8')) as {
      resolverEvidenceShape: {
        mainShowToplevel: string;
        linkedShowToplevel: string;
        mainGitCommonDirRaw: string;
        linkedGitCommonDirRaw: string;
      };
    };
    expect(manifest.resolverEvidenceShape.mainShowToplevel).toBe('__REAL_SHOW_TOPLEVEL_MAIN__');
    expect(manifest.resolverEvidenceShape.linkedShowToplevel).toBe('__REAL_SHOW_TOPLEVEL_LINKED__');
    expect(manifest.resolverEvidenceShape.mainGitCommonDirRaw).toBe('__REAL_GIT_COMMON_DIR_MAIN__');
    expect(manifest.resolverEvidenceShape.linkedGitCommonDirRaw).toBe('__REAL_GIT_COMMON_DIR_LINKED__');
    expect(fixture.resolverEvidence.mainShowToplevel).not.toBe(fixture.resolverEvidence.linkedShowToplevel);
  });

  it('fails closed on ambiguous or unresolvable repository identity', () => {
    const fixture = setupLinkedWorktreePair();
    tempRoots.push(fixture.cleanup);

    const symlinkRoot = path.join(path.dirname(fixture.mainRoot), `${path.basename(fixture.mainRoot)}-symlink`);
    symlinkSync(fixture.mainRoot, symlinkRoot);
    tempRoots.push(() => rmSync(symlinkRoot, { force: true }));

    const fromSymlink = resolveGitRepositoryIdentity(symlinkRoot);
    expect(fromSymlink.ok).toBe(true);
    expect(fromSymlink.identity).toBe(fixture.identity);

    gitIn(fixture.mainRoot, ['worktree', 'remove', '--force', fixture.linkedRoot]);
    rmSync(fixture.linkedRoot, { recursive: true, force: true });

    const staleLinked = resolveGitRepositoryIdentity(fixture.linkedRoot);
    expect(staleLinked.ok).toBe(false);
    expect(staleLinked.reason).toBe('repository_root_unresolvable');

    const prefix = '/tmp/projects/orchestrator-pack/worktrees';
    const target = `${prefix}/opk-511`;
    const built = buildSpawnWorktreeGrantRecord({
      argv: ['spawn', '511'],
      grantId: 'grant-stale-linked',
      projectId: 'orchestrator-pack',
      holder: { pid: 1 },
      sourceRepositoryRoot: fixture.identity,
    });
    expect(built.ok).toBe(true);

    const consume = evaluateSpawnWorktreeGrantConsume({
      grant: built.grant,
      argv: ['worktree', 'add', target, 'HEAD'],
      canonicalPath: target,
      worktreesPrefix: prefix,
      targetPreexists: false,
      effectiveRepositoryRoot: '',
    });
    expect(consume.ok).toBe(false);
    expect(consume.reason).toBe('repository_root_unresolvable');
  });

  it('PowerShell mint from linked worktree and consume from main checkout share identity', () => {
    const fixture = setupLinkedWorktreePair();
    tempRoots.push(fixture.cleanup);

    const aoBase = mkdtempSync(path.join(tmpdir(), 'ao-repo-identity-'));
    tempRoots.push(() => rmSync(aoBase, { recursive: true, force: true }));
    const projectId = 'orchestrator-pack';
    const worktrees = path.join(aoBase, 'projects', projectId, 'worktrees');
    const target = path.join(worktrees, 'opk-511');
    const grantId = 'grant-ps-linked-main';

    const script = `
      . ${psString(spawnWorktreeGatePath)}
      . ${psString(boundaryLibPath)}
      Set-Location ${psString(fixture.linkedRoot)}
      $sourceRepo = Resolve-AutonomousSpawnWorktreeSourceRepositoryRoot
      if (-not $sourceRepo.ok) { throw "mint resolver failed: $($sourceRepo.reason)" }
      $env:AO_BASE_DIR = ${psString(aoBase)}
      $env:AO_PROJECT_ID = ${psString(projectId)}
      $built = Invoke-SpawnWorktreeGrantCli -Subcommand 'buildGrant' -Payload @{
        argv = @('spawn','511')
        grantId = ${psString(grantId)}
        projectId = ${psString(projectId)}
        holder = @{ pid = $PID }
        sourceRepositoryRoot = [string]$sourceRepo.path
        expectedHeadRef = 'HEAD'
      }
      if (-not $built.ok) { throw "buildGrant failed: $($built.reason)" }
      $ns = Get-AutonomousSpawnWorktreeGrantNamespace
      Write-AutonomousSpawnWorktreeGrantAtomic -Namespace $ns -GrantId ${psString(grantId)} -Record $built.grant | Out-Null
      Set-Location ${psString(fixture.mainRoot)}
      $env:AO_AUTONOMOUS_ORCHESTRATOR_SURFACE = '1'
      $env:AO_SPAWN_WORKTREE_GRANT_ID = ${psString(grantId)}
      $verdict = Test-AutonomousGitDenied -Argv @('worktree','add',${psString(target)},'HEAD')
      [pscustomobject]@{
        mintIdentity = [string]$sourceRepo.path
        denied = [bool]$verdict.denied
        reason = [string]$verdict.reason
      } | ConvertTo-Json -Compress
    `;

    const result = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      cwd: fixture.linkedRoot,
      encoding: 'utf8',
      env: { ...process.env, AO_SPAWN_WORKTREE_FIXTURE_MODE: '1' },
    });
    if (result.status !== 0) {
      throw new Error(`pwsh failed ${result.status}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
    }
    const parsed = JSON.parse(result.stdout.trim()) as { mintIdentity: string; denied: boolean; reason: string };
    expect(parsed.mintIdentity).toBe(fixture.identity);
    expect(parsed.denied, parsed.reason).toBe(false);
    expect(parsed.reason).toBe('spawn_worktree_allow');
  });
});
