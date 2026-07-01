import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SPAWN_WORKTREE_GRANT_MAX_FINALIZATION_ATTEMPTS,
  buildSpawnWorktreeGrantRecord,
  classifySpawnWorktreeGrantFailureDiagnosis,
  evaluateSpawnWorktreeGrantConsume,
  evaluateSpawnWorktreeGrantFinalize,
} from '../docs/spawn-worktree-grant.mjs';
import { gitFixtureEnv, resolveTrustedSystemGit } from './_test-git-fixture.js';
import { psString, repoRoot, runPwsh } from './_test-pwsh-helpers.js';

const trustedSystemGit = resolveTrustedSystemGit();

function fixturePwshEnv(): Record<string, string> {
  return { ...gitFixtureEnv() } as Record<string, string>;
}

function runTrustedGit(args: string[]) {
  execFileSync(trustedSystemGit, args, { cwd: repoRoot, env: gitFixtureEnv(), stdio: 'ignore' });
}

const spawnWorktreeGatePath = path.join(repoRoot, 'scripts/lib/Autonomous-SpawnWorktreeGate.ps1');
const boundaryLibPath = path.join(repoRoot, 'scripts/lib/Orchestrator-AutonomousBoundary.ps1');
const tempRoots: string[] = [];
afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root && existsSync(root)) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe('spawn worktree grant finalization (#567)', () => {
  it('grant-consumed-before-durable-worker: reserve allows bounded same-lineage retry before finalize', () => {
    const aoBase = mkdtempSync(path.join(tmpdir(), 'ao-grant-finalize-retry-'));
    tempRoots.push(aoBase);
    const projectId = 'orchestrator-pack';
    const worktrees = path.join(aoBase, 'projects', projectId, 'worktrees');
    mkdirSync(worktrees, { recursive: true });
    const target = path.join(worktrees, 'opk-567');
    const grantId = 'grant-finalize-retry';

    const output = runPwsh(`
      . ${psString(spawnWorktreeGatePath)}
      . ${psString(boundaryLibPath)}
      $env:AO_AUTONOMOUS_ORCHESTRATOR_SURFACE = '1'
      $env:AO_BASE_DIR = ${psString(aoBase)}
      $env:AO_PROJECT_ID = ${psString(projectId)}
      $built = Invoke-SpawnWorktreeGrantCli -Subcommand 'buildGrant' -Payload @{
        argv = @('spawn','567')
        grantId = ${psString(grantId)}
        projectId = ${psString(projectId)}
        holder = @{ pid = $PID; host = 'test'; processGuid = 'fixture-567'; surface = 'test'; acquiredAtUtc = '2026-01-01T00:00:00Z' }
        extraAuthorizedWorktreeNames = @('opk-567')
        expectedHeadRef = 'HEAD'
        sourceRepositoryRoot = [string](Resolve-AutonomousSpawnWorktreeSourceRepositoryRoot).path
        sourceGitWorktreeRoot = [string](Resolve-AutonomousSpawnWorktreeSourceGitWorktreeRoot).path
      }
      $ns = Get-AutonomousSpawnWorktreeGrantNamespace -ProjectId ${psString(projectId)}
      Write-AutonomousSpawnWorktreeGrantAtomic -Namespace $ns -GrantId ${psString(grantId)} -Record $built.grant | Out-Null
      $env:AO_SPAWN_WORKTREE_GRANT_ID = ${psString(grantId)}
      $first = Test-AutonomousGitDenied -Argv @('worktree','add',${psString(target)},'HEAD')
      $second = Test-AutonomousGitDenied -Argv @('worktree','add',${psString(target)},'HEAD')
      $read = Read-AutonomousSpawnWorktreeGrantRecord -Path (Find-AutonomousSpawnWorktreeGrantById -GrantId ${psString(grantId)}).path
      [pscustomobject]@{
        firstDenied = [bool]$first.denied
        firstReason = [string]$first.reason
        secondDenied = [bool]$second.denied
        secondReason = [string]$second.reason
        consumed = [bool]$read.record.consumed
        reserved = ($null -ne $read.record.worktreeAllowReserved)
        reservedPath = [string]$read.record.worktreeAllowReserved.worktreeCanonicalPath
      } | ConvertTo-Json -Compress
    `);
    const parsed = JSON.parse(output);
    expect(parsed.firstDenied).toBe(false);
    expect(parsed.firstReason).toBe('spawn_worktree_allow');
    expect(parsed.secondDenied).toBe(false);
    expect(parsed.secondReason).toBe('spawn_worktree_allow');
    expect(parsed.consumed).toBe(false);
    expect(parsed.reserved).toBe(true);
    expect(parsed.reservedPath).toBe(target);
  });

  it('commit-after-real-add: terminal consumed is written only after durable git worktree add', () => {
    const aoBase = mkdtempSync(path.join(tmpdir(), 'ao-grant-finalize-commit-'));
    tempRoots.push(aoBase);
    const projectId = 'orchestrator-pack';
    const worktrees = path.join(aoBase, 'projects', projectId, 'worktrees');
    mkdirSync(worktrees, { recursive: true });
    const target = path.join(worktrees, 'opk-567-commit');
    const grantId = 'grant-finalize-commit';

    const reserveOutput = runPwsh(
      `
      . ${psString(spawnWorktreeGatePath)}
      $env:AO_BASE_DIR = ${psString(aoBase)}
      $env:AO_PROJECT_ID = ${psString(projectId)}
      $built = Invoke-SpawnWorktreeGrantCli -Subcommand 'buildGrant' -Payload @{
        argv = @('spawn','567')
        grantId = ${psString(grantId)}
        projectId = ${psString(projectId)}
        holder = @{ pid = $PID; host = 'test'; processGuid = 'fixture-567-commit'; surface = 'test'; acquiredAtUtc = '2026-01-01T00:00:00Z' }
        extraAuthorizedWorktreeNames = @('opk-567-commit')
        expectedHeadRef = 'HEAD'
        sourceRepositoryRoot = [string](Resolve-AutonomousSpawnWorktreeSourceRepositoryRoot).path
        sourceGitWorktreeRoot = [string](Resolve-AutonomousSpawnWorktreeSourceGitWorktreeRoot).path
      }
      $ns = Get-AutonomousSpawnWorktreeGrantNamespace -ProjectId ${psString(projectId)}
      Write-AutonomousSpawnWorktreeGrantAtomic -Namespace $ns -GrantId ${psString(grantId)} -Record $built.grant | Out-Null
      $lookup = Find-AutonomousSpawnWorktreeGrantById -GrantId ${psString(grantId)}
      $reserve = Consume-AutonomousSpawnWorktreeGrant -GrantLookup $lookup -Argv @('worktree','add',${psString(target)},'HEAD') -CanonicalPath ${psString(target)} -TargetPreexists $false
      $afterReserve = Read-AutonomousSpawnWorktreeGrantRecord -Path $lookup.path
      [pscustomobject]@{
        reserveOk = [bool]$reserve.ok
        reserved = ($null -ne $afterReserve.record.worktreeAllowReserved)
        consumedAfterReserve = [bool]$afterReserve.record.consumed
      } | ConvertTo-Json -Compress
    `,
      fixturePwshEnv(),
    );
    const reserved = JSON.parse(reserveOutput);
    expect(reserved.reserveOk).toBe(true);
    expect(reserved.reserved).toBe(true);
    expect(reserved.consumedAfterReserve).toBe(false);

    try {
      runTrustedGit(['-C', repoRoot, 'worktree', 'add', target, 'HEAD']);

      const finalizeOutput = runPwsh(
        `
        . ${psString(spawnWorktreeGatePath)}
        $env:AO_BASE_DIR = ${psString(aoBase)}
        $env:AO_PROJECT_ID = ${psString(projectId)}
        $lookup = Find-AutonomousSpawnWorktreeGrantById -GrantId ${psString(grantId)}
        $finalize = Finalize-AutonomousSpawnWorktreeGrant -GrantId ${psString(grantId)} -CanonicalPath ${psString(target)}
        $afterFinalize = Read-AutonomousSpawnWorktreeGrantRecord -Path $lookup.path
        [pscustomobject]@{
          finalizeOk = [bool]$finalize.ok
          consumedAfterFinalize = [bool]$afterFinalize.record.consumed
          consumedPath = [string]$afterFinalize.record.consumedCanonicalPath
          worktreeExists = Test-Path -LiteralPath ${psString(target)}
        } | ConvertTo-Json -Compress
      `,
        fixturePwshEnv(),
      );
      const parsed = JSON.parse(finalizeOutput);
      expect(parsed.finalizeOk).toBe(true);
      expect(parsed.consumedAfterFinalize).toBe(true);
      expect(parsed.consumedPath).toBe(target);
      expect(parsed.worktreeExists).toBe(true);
    } finally {
      try {
        runTrustedGit(['-C', repoRoot, 'worktree', 'remove', '--force', target]);
      } catch {
        // Best-effort cleanup when add never succeeded.
      }
    }
  });

  it('replay-deny-preserved: consumed grant from another path still denies before mutation', () => {
    const built = buildSpawnWorktreeGrantRecord({
      argv: ['spawn', '567'],
      grantId: 'g-finalized',
      projectId: 'orchestrator-pack',
      holder: { pid: 1, processGuid: 'holder-a' },
      extraAuthorizedWorktreeNames: ['opk-567-a', 'opk-567-b'],
      sourceRepositoryRoot: repoRoot,
      sourceGitWorktreeRoot: repoRoot,
      nowMs: Date.parse('2026-01-01T00:00:00Z'),
    });
    expect(built.ok).toBe(true);
    const grant = {
      ...built.grant!,
      consumed: true,
      consumedCanonicalPath: path.join('/tmp/ao/projects/orchestrator-pack/worktrees/opk-567-a'),
      worktreeAllowReserved: {
        worktreeCanonicalPath: path.join('/tmp/ao/projects/orchestrator-pack/worktrees/opk-567-a'),
        attemptCount: 1,
      },
    };
    const prefix = '/tmp/ao/projects/orchestrator-pack/worktrees';
    const replay = evaluateSpawnWorktreeGrantConsume({
      grant,
      argv: ['worktree', 'add', path.join(prefix, 'opk-567-b'), 'HEAD'],
      canonicalPath: path.join(prefix, 'opk-567-b'),
      worktreesPrefix: prefix,
      targetPreexists: false,
      effectiveRepositoryRoot: repoRoot,
      effectiveGitWorktreeRoot: repoRoot,
      nowMs: Date.parse('2026-01-01T00:00:01Z'),
    });
    expect(replay.ok).toBe(false);
    expect(replay.reason).toBe('grant_already_consumed');
  });

  it('manual spawn success is not autonomous closure evidence', () => {
    const diagnosis = classifySpawnWorktreeGrantFailureDiagnosis({
      boundaryReason: 'grant_already_consumed',
      githubReadsSucceeded: true,
      stderr: 'autonomous tree-mutating git denied by boundary gate: grant_already_consumed',
    });
    expect(diagnosis.kind).toBe('spawn_grant_finalization');
    expect(diagnosis.reason).toBe('grant_already_consumed');
    const manualSurface = runPwsh(`
      . ${psString(path.join(repoRoot, 'scripts/lib/Orchestrator-AutonomousSpawnGate.ps1'))}
      Remove-Item Env:AO_AUTONOMOUS_ORCHESTRATOR_SURFACE -ErrorAction SilentlyContinue
      $env:AO_AUTONOMOUS_ORCHESTRATOR_SURFACE = ''
      $spawn = Test-AutonomousSpawnDenied -Argv @('spawn','567') -FixtureMode
      [pscustomobject]@{ denied = [bool]$spawn.denied; reason = [string]$spawn.reason } | ConvertTo-Json -Compress
    `);
    const parsed = JSON.parse(manualSurface);
    expect(parsed.denied).toBe(false);
    expect(parsed.reason).toBe('manual_surface');
  });

  it('diagnostics separate auth from grant finalization when GitHub reads succeeded', () => {
    const diagnosis = classifySpawnWorktreeGrantFailureDiagnosis({
      boundaryReason: 'grant_finalization_attempts_exhausted',
      githubReadsSucceeded: true,
      stderr: 'GitHub CLI is not authenticated. autonomous tree-mutating git denied by boundary gate: grant_finalization_attempts_exhausted',
    });
    expect(diagnosis.kind).toBe('spawn_grant_finalization');
    expect(diagnosis.reason).toBe('grant_finalization_attempts_exhausted');
    expect(diagnosis.misclassifiedAsGhAuth).toBe(true);
  });

  it('bounded retry stops after max finalization attempts', () => {
    const built = buildSpawnWorktreeGrantRecord({
      argv: ['spawn', '567'],
      grantId: 'g-exhausted',
      projectId: 'orchestrator-pack',
      holder: { pid: 1, processGuid: 'holder-retry' },
      extraAuthorizedWorktreeNames: ['opk-567-retry'],
      sourceRepositoryRoot: repoRoot,
      sourceGitWorktreeRoot: repoRoot,
      nowMs: Date.parse('2026-01-01T00:00:00Z'),
    });
    expect(built.ok).toBe(true);
    const prefix = '/tmp/ao/projects/orchestrator-pack/worktrees';
    const target = path.join(prefix, 'opk-567-retry');
    const grant = {
      ...built.grant!,
      worktreeAllowReserved: {
        worktreeCanonicalPath: target,
        attemptCount: SPAWN_WORKTREE_GRANT_MAX_FINALIZATION_ATTEMPTS,
      },
    };
    const verdict = evaluateSpawnWorktreeGrantConsume({
      grant,
      argv: ['worktree', 'add', target, 'HEAD'],
      canonicalPath: target,
      worktreesPrefix: prefix,
      targetPreexists: false,
      effectiveRepositoryRoot: repoRoot,
      effectiveGitWorktreeRoot: repoRoot,
      nowMs: Date.parse('2026-01-01T00:00:01Z'),
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('grant_finalization_attempts_exhausted');
  });

  it('evaluateFinalize rejects commit when worktree is not durable', () => {
    const built = buildSpawnWorktreeGrantRecord({
      argv: ['spawn', '567'],
      grantId: 'g-not-durable',
      projectId: 'orchestrator-pack',
      holder: { pid: 1 },
      sourceRepositoryRoot: repoRoot,
      sourceGitWorktreeRoot: repoRoot,
      nowMs: Date.parse('2026-01-01T00:00:00Z'),
    });
    const target = '/tmp/ao/projects/orchestrator-pack/worktrees/opk-567-missing';
    const grant = {
      ...built.grant!,
      worktreeAllowReserved: { worktreeCanonicalPath: target, attemptCount: 1 },
    };
    const verdict = evaluateSpawnWorktreeGrantFinalize({
      grant,
      canonicalPath: target,
      worktreeDurable: false,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('grant_finalize_worktree_not_durable');
  });
});
