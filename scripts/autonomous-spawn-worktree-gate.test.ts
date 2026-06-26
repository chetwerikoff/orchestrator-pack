import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildSpawnWorktreeGrantRecord,
  evaluateBoundaryEscapeSignal,
  evaluateSpawnWorktreeGrantConsume,
  parseGitSpawnWorktreeAddArgv,
  parseSpawnTargetFromArgv,
  deriveSpawnAuthorizedWorktreeNames,
  evaluateSpawnWorktreeBasenameBinding,
  isAoSpawnWorktreeSessionBasename,
  pathIsUnderCanonicalPrefix,
} from '../docs/spawn-worktree-grant.mjs';
import { evaluateAutonomousGitBoundary } from '../docs/autonomous-orchestrator-boundary.mjs';
import { withAoSpawnProbeStub } from './_test-autonomous-ao-stub-fixture.js';
import { repoRoot, runPwsh, psString } from './_test-pwsh-helpers.js';
import { autonomousBashEnv } from './_test-git-fixture.js';

const boundaryLibPath = path.join(repoRoot, 'scripts/lib/Orchestrator-AutonomousBoundary.ps1');
const spawnGateLibPath = path.join(repoRoot, 'scripts/lib/Orchestrator-AutonomousSpawnGate.ps1');
const spawnWorktreeGatePath = path.join(repoRoot, 'scripts/lib/Autonomous-SpawnWorktreeGate.ps1');
const gitGuardPath = path.join(repoRoot, 'scripts/git-autonomous-guard.ps1');
const guardPath = path.join(repoRoot, 'scripts/ao-autonomous-guard.ps1');

function runSpawnGitDenied(argv: string[], extraEnv: Record<string, string> = {}) {
  const output = runPwsh(`
    . ${psString(boundaryLibPath)}
    $env:AO_AUTONOMOUS_ORCHESTRATOR_SURFACE = '1'
    $verdict = Test-AutonomousGitDenied -Argv @(${argv.map((part) => psString(part)).join(',')})
    [pscustomobject]@{ denied = [bool]$verdict.denied; reason = [string]$verdict.reason } | ConvertTo-Json -Compress
  `, extraEnv);
  return JSON.parse(output) as { denied: boolean; reason: string };
}

describe('spawn worktree grant (#470)', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('spawn policy allow reaches sanctioned worker-worktree mutation', () => {
    const aoBase = mkdtempSync(path.join(tmpdir(), 'ao-spawn-grant-'));
    tempRoots.push(aoBase);
    const projectId = 'orchestrator-pack';
    const worktrees = path.join(aoBase, 'projects', projectId, 'worktrees');
    mkdirSync(worktrees, { recursive: true });
    const target = path.join(worktrees, 'opk-27');
    const grantId = 'grant-spawn-373';

    const mint = runPwsh(`
      . ${psString(spawnWorktreeGatePath)}
      . ${psString(boundaryLibPath)}
      $env:AO_AUTONOMOUS_ORCHESTRATOR_SURFACE = '1'
      $env:AO_BASE_DIR = ${psString(aoBase)}
      $env:AO_PROJECT_ID = ${psString(projectId)}
      $built = Invoke-SpawnWorktreeGrantCli -Subcommand 'buildGrant' -Payload @{
        argv = @('spawn','373')
        grantId = ${psString(grantId)}
        projectId = ${psString(projectId)}
        holder = @{ pid = $PID; host = 'test'; processGuid = 'fixture'; surface = 'test'; acquiredAtUtc = '2026-01-01T00:00:00Z' }
        extraAuthorizedWorktreeNames = @()
        expectedHeadRef = 'HEAD'
        sourceRepositoryRoot = ${psString(repoRoot)}
      }
      $ns = Get-AutonomousSpawnWorktreeGrantNamespace -ProjectId ${psString(projectId)}
      Write-AutonomousSpawnWorktreeGrantAtomic -Namespace $ns -GrantId ${psString(grantId)} -Record $built.grant | Out-Null
      $env:AO_SPAWN_WORKTREE_GRANT_ID = ${psString(grantId)}
      $verdict = Test-AutonomousGitDenied -Argv @('worktree','add',${psString(target)},'HEAD')
      [pscustomobject]@{ denied = [bool]$verdict.denied; reason = [string]$verdict.reason } | ConvertTo-Json -Compress
    `);
    const parsed = JSON.parse(mint);
    expect(parsed.denied).toBe(false);
    expect(parsed.reason).toBe('spawn_worktree_allow');
  });

  it('denies worker worktree add without sanctioned spawn provenance', () => {
    const verdict = runSpawnGitDenied(['worktree', 'add', '/tmp/opk-spawn-probe', 'HEAD']);
    expect(verdict.denied).toBe(true);
    expect(verdict.reason).toBe('autonomous_mutating_git_denied');
  });

  it('claim-pr spawn mints grant and allows bound worktree add', () => {
    const aoBase = mkdtempSync(path.join(tmpdir(), 'ao-claim-pr-grant-'));
    tempRoots.push(aoBase);
    const projectId = 'orchestrator-pack';
    const worktrees = path.join(aoBase, 'projects', projectId, 'worktrees');
    mkdirSync(worktrees, { recursive: true });
    const target = path.join(worktrees, 'opk-42');

    const output = runPwsh(`
      . ${psString(spawnGateLibPath)}
      $env:AO_AUTONOMOUS_ORCHESTRATOR_SURFACE = '1'
      $env:AO_BASE_DIR = ${psString(aoBase)}
      $env:AO_PROJECT_ID = ${psString(projectId)}
      $spawn = Test-AutonomousSpawnDenied -Argv @('spawn','--claim-pr','999991') -FixtureMode -FixturePolicy @{ version='autonomous-spawn-policy/v1'; allowSpawnNew=$true; allowClaimPrResume=$true }
      if ($spawn.denied) { throw "spawn denied: $($spawn.reason)" }
      if (-not $env:AO_SPAWN_WORKTREE_GRANT_ID) { throw 'missing grant env' }
      . ${psString(boundaryLibPath)}
      $verdict = Test-AutonomousGitDenied -Argv @('worktree','add',${psString(target)},'HEAD')
      [pscustomobject]@{ spawnReason = [string]$spawn.reason; denied = [bool]$verdict.denied; gitReason = [string]$verdict.reason; grantId = [string]$env:AO_SPAWN_WORKTREE_GRANT_ID } | ConvertTo-Json -Compress
    `);
    const parsed = JSON.parse(output);
    expect(parsed.spawnReason).toBe('spawn_policy_allowed');
    expect(parsed.denied).toBe(false);
    expect(parsed.gitReason).toBe('spawn_worktree_allow');
    expect(parsed.grantId).toBeTruthy();
  });

  it('grant consume is single-use', () => {
    const aoBase = mkdtempSync(path.join(tmpdir(), 'ao-grant-single-use-'));
    tempRoots.push(aoBase);
    const projectId = 'orchestrator-pack';
    const worktrees = path.join(aoBase, 'projects', projectId, 'worktrees');
    mkdirSync(worktrees, { recursive: true });
    const target = path.join(worktrees, 'opk-once');
    const grantId = 'grant-once';

    const output = runPwsh(`
      . ${psString(spawnWorktreeGatePath)}
      . ${psString(boundaryLibPath)}
      $env:AO_AUTONOMOUS_ORCHESTRATOR_SURFACE = '1'
      $env:AO_BASE_DIR = ${psString(aoBase)}
      $env:AO_PROJECT_ID = ${psString(projectId)}
      $built = Invoke-SpawnWorktreeGrantCli -Subcommand 'buildGrant' -Payload @{
        argv = @('spawn','opk-once')
        grantId = ${psString(grantId)}
        projectId = ${psString(projectId)}
        holder = @{ pid = $PID; host = 'test'; processGuid = 'fixture'; surface = 'test'; acquiredAtUtc = '2026-01-01T00:00:00Z' }
        extraAuthorizedWorktreeNames = @()
        expectedHeadRef = 'HEAD'
        sourceRepositoryRoot = ${psString(repoRoot)}
      }
      $ns = Get-AutonomousSpawnWorktreeGrantNamespace -ProjectId ${psString(projectId)}
      Write-AutonomousSpawnWorktreeGrantAtomic -Namespace $ns -GrantId ${psString(grantId)} -Record $built.grant | Out-Null
      $env:AO_SPAWN_WORKTREE_GRANT_ID = ${psString(grantId)}
      $first = Test-AutonomousGitDenied -Argv @('worktree','add',${psString(target)},'HEAD')
      $second = Test-AutonomousGitDenied -Argv @('worktree','add',${psString(target)},'HEAD')
      [pscustomobject]@{ firstDenied = [bool]$first.denied; firstReason = [string]$first.reason; secondDenied = [bool]$second.denied; secondReason = [string]$second.reason } | ConvertTo-Json -Compress
    `);
    const parsed = JSON.parse(output);
    expect(parsed.firstDenied).toBe(false);
    expect(parsed.firstReason).toBe('spawn_worktree_allow');
    expect(parsed.secondDenied).toBe(true);
    expect(parsed.secondReason).toMatch(/grant_already_consumed|grant_not_found|grant_consume_busy/);
  });

  it('concurrent consume: only one parallel git child wins the same grant', async () => {
    const aoBase = mkdtempSync(path.join(tmpdir(), 'ao-grant-concurrent-consume-'));
    tempRoots.push(aoBase);
    const projectId = 'orchestrator-pack';
    const worktrees = path.join(aoBase, 'projects', projectId, 'worktrees');
    mkdirSync(worktrees, { recursive: true });
    const targetA = path.join(worktrees, 'opk-race-a');
    const targetB = path.join(worktrees, 'opk-race-b');
    const grantId = 'grant-concurrent';
    const holderPid = String(process.pid);

    const probeScript = (target: string) => `
      . ${psString(spawnWorktreeGatePath)}
      . ${psString(boundaryLibPath)}
      $env:AO_AUTONOMOUS_ORCHESTRATOR_SURFACE = '1'
      $env:AO_BASE_DIR = ${psString(aoBase)}
      $env:AO_PROJECT_ID = ${psString(projectId)}
      $env:AO_SPAWN_WORKTREE_GRANT_ID = ${psString(grantId)}
      $verdict = Test-AutonomousGitDenied -Argv @('worktree','add',${psString(target)},'HEAD')
      [pscustomobject]@{ denied = [bool]$verdict.denied; reason = [string]$verdict.reason } | ConvertTo-Json -Compress
    `;

    runPwsh(`
      . ${psString(spawnWorktreeGatePath)}
      $env:AO_BASE_DIR = ${psString(aoBase)}
      $env:AO_PROJECT_ID = ${psString(projectId)}
      $built = Invoke-SpawnWorktreeGrantCli -Subcommand 'buildGrant' -Payload @{
        argv = @('spawn','opk-race')
        grantId = ${psString(grantId)}
        projectId = ${psString(projectId)}
        holder = @{ pid = ${holderPid}; host = 'test'; processGuid = 'fixture'; surface = 'test'; acquiredAtUtc = '2026-01-01T00:00:00Z' }
        extraAuthorizedWorktreeNames = @('opk-race-a','opk-race-b')
        expectedHeadRef = 'HEAD'
        sourceRepositoryRoot = ${psString(repoRoot)}
      }
      $ns = Get-AutonomousSpawnWorktreeGrantNamespace -ProjectId ${psString(projectId)}
      Write-AutonomousSpawnWorktreeGrantAtomic -Namespace $ns -GrantId ${psString(grantId)} -Record $built.grant | Out-Null
    `);

    const runProbe = (target: string) =>
      new Promise<{ denied: boolean; reason: string }>((resolve, reject) => {
        const child = spawn(
          'pwsh',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', probeScript(target)],
          { cwd: repoRoot, env: process.env },
        );
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => {
          stdout += chunk.toString();
        });
        child.stderr.on('data', (chunk) => {
          stderr += chunk.toString();
        });
        child.on('error', reject);
        child.on('close', (code) => {
          if (code !== 0) {
            reject(new Error(`probe failed code=${code}\n${stdout}\n${stderr}`));
            return;
          }
          resolve(JSON.parse(stdout.trim()) as { denied: boolean; reason: string });
        });
      });

    const [first, second] = await Promise.all([runProbe(targetA), runProbe(targetB)]);
    const winners = [first, second].filter((result) => !result.denied && result.reason === 'spawn_worktree_allow');
    const losers = [first, second].filter((result) => result.denied);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]?.reason).toMatch(/grant_already_consumed|grant_consume_busy/);
  });

  it('serializes concurrent mint for the same spawn target', () => {
    const aoBase = mkdtempSync(path.join(tmpdir(), 'ao-grant-mutex-'));
    tempRoots.push(aoBase);
    const output = runPwsh(`
      . ${psString(spawnWorktreeGatePath)}
      $env:AO_AUTONOMOUS_ORCHESTRATOR_SURFACE = '1'
      $env:AO_BASE_DIR = ${psString(aoBase)}
      $env:AO_PROJECT_ID = 'orchestrator-pack'
      $holder = @{ pid = $PID; host = 'test'; processGuid = 'a'; surface = 'test'; acquiredAtUtc = '2026-01-01T00:00:00Z' }
      $ns = Get-AutonomousSpawnWorktreeGrantNamespace
      $first = Enter-AutonomousSpawnWorktreeTargetLock -Namespace $ns -TargetKey 'opk-470' -Holder $holder
      $second = Enter-AutonomousSpawnWorktreeTargetLock -Namespace $ns -TargetKey 'opk-470' -Holder @{ pid = $PID; host = 'test'; processGuid = 'b'; surface = 'test'; acquiredAtUtc = '2026-01-01T00:00:00Z' }
      [pscustomobject]@{ first = [bool]$first.acquired; second = [bool]$second.acquired; secondReason = [string]$second.reason } | ConvertTo-Json -Compress
    `);
    const parsed = JSON.parse(output);
    expect(parsed.first).toBe(true);
    expect(parsed.second).toBe(false);
    expect(parsed.secondReason).toBe('spawn_target_busy');
  });

  it('path hardening denies escape outside worktrees prefix', () => {
    const built = buildSpawnWorktreeGrantRecord({
      argv: ['spawn', 'opk-470'],
      grantId: 'g1',
      projectId: 'orchestrator-pack',
      holder: { pid: 1 },
      sourceRepositoryRoot: '/tmp/source-repo',
      nowMs: Date.parse('2026-01-01T00:00:00Z'),
    });
    expect(built.ok).toBe(true);
    const verdict = evaluateSpawnWorktreeGrantConsume({
      grant: built.grant,
      argv: ['worktree', 'add', '/tmp/evil/opk-470', 'HEAD'],
      canonicalPath: '/tmp/evil/opk-470',
      worktreesPrefix: '/tmp/ao/projects/orchestrator-pack/worktrees',
      targetPreexists: false,
      effectiveRepositoryRoot: '/tmp/source-repo',
      nowMs: Date.parse('2026-01-01T00:00:01Z'),
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('path_escape');
  });

  it('boundary escape audit detects surface unset after bootstrap', () => {
    const signal = evaluateBoundaryEscapeSignal({
      env: {
        AO_TMUX_NAME: 'op-orchestrator',
        __AO_AUTONOMOUS_SURFACE_BOOTSTRAP: '1',
        AO_AUTONOMOUS_ORCHESTRATOR_SURFACE: '',
        PATH: '/usr/bin:/bin',
      },
      packScriptsDir: '/repo/scripts',
    });
    expect(signal.detected).toBe(true);
    expect(signal.reason).toBe('surface_and_path_cooperative');
    expect(signal.signals).toContain('surface_unset_after_bootstrap');
    expect(signal.signals).toContain('pack_scripts_missing_from_path');
  });

  it('guard integration: allowed spawn sets grant env for downstream git', () => {
    withAoSpawnProbeStub(({ probeFile }) => {
      const result = spawnSync(
        'pwsh',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', guardPath, 'spawn', 'opk-470'],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          env: autonomousBashEnv({ AO_SPAWN_PROBE_FILE: probeFile }),
        },
      );
      expect(result.status).toBe(0);
      expect(`${result.stderr}${result.stdout}`).toMatch(/autonomous spawn worktree grant mint/i);
    });
  });

  it('unsanctioned mutating git still denied on autonomous surface', () => {
    const gitDeny = spawnSync(
      'pwsh',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', gitGuardPath, 'branch', '-m', 'blocked'],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: autonomousBashEnv(),
      },
    );
    expect(gitDeny.status).toBe(93);
    expect(gitDeny.stderr).toMatch(/autonomous tree-mutating git denied/i);
  });

  it('mjs git boundary honors spawn grant allow flag', () => {
    const verdict = evaluateAutonomousGitBoundary({
      argv: ['worktree', 'add', '/tmp/wt', 'HEAD'],
      autonomousSurface: true,
      spawnWorktreeGrantAllow: true,
    });
    expect(verdict.allowed).toBe(true);
    expect(verdict.reason).toBe('spawn_worktree_allow');
  });

  it('parses spawn worktree argv shapes', () => {
    expect(parseGitSpawnWorktreeAddArgv(['worktree', 'add', '/tmp/wt', 'HEAD']).ok).toBe(true);
    expect(parseSpawnTargetFromArgv(['spawn', '470']).targetKey).toBe('470');
    expect(parseSpawnTargetFromArgv(['spawn', '--claim-pr', '42']).targetKey).toBe('pr:42');
    expect(parseSpawnTargetFromArgv(['spawn', '--prompt', 'checkpoint holder prompt']).targetKey).toBe('');
    expect(parseSpawnTargetFromArgv(['spawn', '--prompt', 'checkpoint holder prompt']).issueTarget).toBeNull();
    expect(parseSpawnTargetFromArgv(['spawn', '470', '--prompt', 'extra instructions']).targetKey).toBe('470');
    expect(parseSpawnTargetFromArgv(['spawn', '--agent', 'codex', '470']).targetKey).toBe('470');
    expect(parseSpawnTargetFromArgv(['spawn', '--prompt=inline prompt']).targetKey).toBe('');
    expect(pathIsUnderCanonicalPrefix('/tmp/a/worktrees/opk-1', '/tmp/a/worktrees')).toBe(true);
  });

  it('does not authorize prompt text as spawn worktree basename', () => {
    const promptText = 'checkpoint-2 contract-evidence reverify e2e fixture holder';
    const built = buildSpawnWorktreeGrantRecord({
      argv: ['spawn', '470', '--prompt', promptText],
      grantId: 'grant-prompt-flag',
      projectId: 'orchestrator-pack',
      holder: { pid: 1 },
      sourceRepositoryRoot: '/tmp/source-repo',
    });
    expect(built.ok).toBe(true);
    expect(built.grant?.authorizedWorktreeNames).toEqual(expect.arrayContaining(['470', 'opk-470']));
    expect(built.grant?.authorizedWorktreeNames).not.toContain(promptText);

    const consume = evaluateSpawnWorktreeGrantConsume({
      grant: built.grant,
      argv: ['worktree', 'add', '/tmp/projects/orchestrator-pack/worktrees/opk-470', 'HEAD'],
      canonicalPath: '/tmp/projects/orchestrator-pack/worktrees/opk-470',
      worktreesPrefix: '/tmp/projects/orchestrator-pack/worktrees',
      targetPreexists: false,
      effectiveRepositoryRoot: '/tmp/source-repo',
    });
    expect(consume.ok).toBe(true);
    expect(consume.reason).toBe('spawn_worktree_allow');
  });

  it('authorizes AO session basename when spawn target differs from allocated session id (#472)', () => {
    const prefix = '/tmp/projects/orchestrator-pack/worktrees';
    const target = `${prefix}/opk-27`;
    const built = buildSpawnWorktreeGrantRecord({
      argv: ['spawn', '373'],
      grantId: 'grant-ao-session-basename',
      projectId: 'orchestrator-pack',
      holder: { pid: 1 },
      sourceRepositoryRoot: '/tmp/source-repo',
    });
    expect(built.ok).toBe(true);
    expect(built.grant?.authorizedWorktreeNames).toEqual(expect.arrayContaining(['373', 'opk-373']));
    expect(built.grant?.authorizedWorktreeNames).not.toContain('opk-27');

    const consume = evaluateSpawnWorktreeGrantConsume({
      grant: built.grant,
      argv: ['worktree', 'add', target, 'HEAD'],
      canonicalPath: target,
      worktreesPrefix: prefix,
      targetPreexists: false,
      effectiveRepositoryRoot: '/tmp/source-repo',
    });
    expect(consume.ok).toBe(true);
    expect(consume.reason).toBe('spawn_worktree_allow');
    const allowedNames = Array.isArray(built.grant?.authorizedWorktreeNames)
      ? built.grant.authorizedWorktreeNames.map((name) => String(name))
      : [];
    expect(evaluateSpawnWorktreeBasenameBinding('opk-27', allowedNames)).toEqual({
      ok: true,
      reason: 'ao_session_basename',
    });
  });

  it('claim-pr grant allows AO session basename without minting the session id (#472)', () => {
    const prefix = '/tmp/projects/orchestrator-pack/worktrees';
    const target = `${prefix}/opk-99`;
    const built = buildSpawnWorktreeGrantRecord({
      argv: ['spawn', '--claim-pr', '471'],
      grantId: 'grant-claim-pr-session',
      projectId: 'orchestrator-pack',
      holder: { pid: 1 },
      sourceRepositoryRoot: '/tmp/source-repo',
    });
    expect(built.ok).toBe(true);
    expect(built.grant?.authorizedWorktreeNames).toEqual(['pr-471']);
    expect(built.grant?.authorizedWorktreeNames).not.toContain('opk-99');

    const consume = evaluateSpawnWorktreeGrantConsume({
      grant: built.grant,
      argv: ['worktree', 'add', target, 'HEAD'],
      canonicalPath: target,
      worktreesPrefix: prefix,
      targetPreexists: false,
      effectiveRepositoryRoot: '/tmp/source-repo',
    });
    expect(consume.ok).toBe(true);
    expect(consume.reason).toBe('spawn_worktree_allow');
  });

  it('denies non-AO worktree basenames with drift-visible diagnostics (#472)', () => {
    const prefix = '/tmp/projects/orchestrator-pack/worktrees';
    const built = buildSpawnWorktreeGrantRecord({
      argv: ['spawn', '373'],
      grantId: 'grant-invalid-basename',
      projectId: 'orchestrator-pack',
      holder: { pid: 1 },
      sourceRepositoryRoot: '/tmp/source-repo',
    });
    expect(built.ok).toBe(true);

    for (const badBasename of ['random-worktree', 'opk-not-digits', 'opk-27-evil', '']) {
      const target = `${prefix}/${badBasename}`;
      const consume = evaluateSpawnWorktreeGrantConsume({
        grant: built.grant,
        argv: ['worktree', 'add', target, 'HEAD'],
        canonicalPath: target,
        worktreesPrefix: prefix,
        targetPreexists: false,
        effectiveRepositoryRoot: '/tmp/source-repo',
      });
      expect(consume.ok).toBe(false);
      expect(consume.reason).toBe('worktree_session_basename_invalid');
    }

    expect(isAoSpawnWorktreeSessionBasename('opk-27')).toBe(true);
    expect(isAoSpawnWorktreeSessionBasename('opk-once')).toBe(false);
  });

  it('allows prompt-only spawn-new without minting a worktree grant', () => {
    const output = runPwsh(`
      . ${psString(spawnGateLibPath)}
      $env:AO_AUTONOMOUS_ORCHESTRATOR_SURFACE = '1'
      $spawn = Test-AutonomousSpawnDenied -Argv @('spawn','--prompt','fixture holder prompt') -FixtureMode -FixturePolicy @{ version='autonomous-spawn-policy/v1'; allowSpawnNew=$true; allowClaimPrResume=$true }
      [pscustomobject]@{ denied = [bool]$spawn.denied; reason = [string]$spawn.reason; grantId = [string]$env:AO_SPAWN_WORKTREE_GRANT_ID } | ConvertTo-Json -Compress
    `);
    const parsed = JSON.parse(output);
    expect(parsed.denied).toBe(false);
    expect(parsed.reason).toBe('spawn_policy_allowed');
    expect(parsed.grantId).toBeFalsy();
  });

  it('denies unexpected branch flags on spawn grant consume', () => {
    const prefix = '/tmp/projects/orchestrator-pack/worktrees';
    const target = `${prefix}/opk-470`;
    const built = buildSpawnWorktreeGrantRecord({
      argv: ['spawn', '470'],
      grantId: 'grant-branch',
      projectId: 'orchestrator-pack',
      holder: { pid: 1 },
      sourceRepositoryRoot: '/tmp/source-repo',
    });
    const consume = evaluateSpawnWorktreeGrantConsume({
      grant: built.grant,
      argv: ['worktree', 'add', '-b', 'arbitrary', target, 'HEAD'],
      canonicalPath: target,
      worktreesPrefix: prefix,
      targetPreexists: false,
      effectiveRepositoryRoot: '/tmp/source-repo',
    });
    expect(consume.ok).toBe(false);
    expect(consume.reason).toBe('branch_mismatch');
  });

  it('denies source-selecting git globals on spawn grant consume', () => {
    const prefix = '/tmp/projects/orchestrator-pack/worktrees';
    const target = `${prefix}/opk-470`;
    const built = buildSpawnWorktreeGrantRecord({
      argv: ['spawn', '470'],
      grantId: 'grant-repo-global',
      projectId: 'orchestrator-pack',
      holder: { pid: 1 },
      sourceRepositoryRoot: '/tmp/source-repo',
    });
    const consume = evaluateSpawnWorktreeGrantConsume({
      grant: built.grant,
      argv: ['-C', '/other/repo', 'worktree', 'add', target, 'HEAD'],
      canonicalPath: target,
      worktreesPrefix: prefix,
      targetPreexists: false,
      effectiveRepositoryRoot: '/tmp/source-repo',
    });
    expect(consume.ok).toBe(false);
    expect(consume.reason).toBe('git_source_global_denied');
  });

  it('denies spawn grant consume when repository root mismatches minted binding', () => {
    const prefix = '/tmp/projects/orchestrator-pack/worktrees';
    const target = `${prefix}/opk-470`;
    const built = buildSpawnWorktreeGrantRecord({
      argv: ['spawn', '470'],
      grantId: 'grant-repo-mismatch',
      projectId: 'orchestrator-pack',
      holder: { pid: 1 },
      sourceRepositoryRoot: '/tmp/source-repo',
    });
    const consume = evaluateSpawnWorktreeGrantConsume({
      grant: built.grant,
      argv: ['worktree', 'add', target, 'HEAD'],
      canonicalPath: target,
      worktreesPrefix: prefix,
      targetPreexists: false,
      effectiveRepositoryRoot: '/other/repo',
    });
    expect(consume.ok).toBe(false);
    expect(consume.reason).toBe('repository_root_mismatch');
  });
});
