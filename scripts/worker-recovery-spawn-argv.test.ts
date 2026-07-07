import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  AUTONOMOUS_SPAWN_POLICY_VERSION,
  classifySpawnAction,
  parseClaimPrNumberFromSpawnArgv,
} from '../docs/autonomous-orchestrator-boundary.mjs';
import { parseSpawnTargetFromArgv } from '../docs/spawn-worktree-grant.mjs';
import {
  AO_SPAWN_DISPLAY_NAME_MAX_LENGTH,
  validateRunnableSpawnCommand,
} from '../docs/ao-spawn-shape.mjs';
import {
  RECOVERY_SPAWN_DISPLAY_NAME_MAX_LENGTH,
  buildRecoverySpawnArgv,
  classifyRecoverySpawnExit,
  deriveRecoverySpawnDisplayName,
  resolveRecoverySpawnProjectId,
  type BuildRecoverySpawnArgvResult,
  type DeriveRecoverySpawnDisplayNameResult,
} from './lib/worker-recovery-spawn-argv.mjs';
import { autonomousSpawnFixtureProbeEnv, withAoSpawnProbeStub } from './_test-autonomous-ao-stub-fixture.js';
import { psString, repoRoot, runPwsh } from './_test-pwsh-helpers.js';

const recoveryPs1 = path.join(repoRoot, 'scripts/lib/Worker-Recovery.ps1');

function expectBuildOk(built: BuildRecoverySpawnArgvResult) {
  expect(built.ok).toBe(true);
  if (!built.ok) {
    throw new Error(`expected build ok, got ${built.reason}`);
  }
  return built;
}

function expectDisplayNameOk(result: DeriveRecoverySpawnDisplayNameResult) {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`expected display name ok, got ${result.reason}`);
  }
  return result;
}

describe('worker recovery AO 0.10.2 spawn argv (#638)', () => {
  it('builds claim-pr-resume argv with --project, --name, --claim-pr, and --no-takeover', () => {
    const built = buildRecoverySpawnArgv({
      spawnAction: 'claim-pr-resume',
      projectId: 'orchestrator-pack',
      prNumber: 589,
    });
    expect(built).toEqual({
      ok: true,
      projectId: 'orchestrator-pack',
      displayName: 'wr-pr589',
      argv: [
        'spawn',
        '--project',
        'orchestrator-pack',
        '--name',
        'wr-pr589',
        '--claim-pr',
        '589',
        '--no-takeover',
      ],
    });
    expect(validateRunnableSpawnCommand(`ao ${expectBuildOk(built).argv.join(' ')}`)).toEqual([]);
  });

  it('builds spawn-new argv with positional issue for grant parsing and --issue for AO CLI', () => {
    const built = buildRecoverySpawnArgv({
      spawnAction: 'spawn-new',
      projectId: 'orchestrator-pack',
      issueNumber: 638,
    });
    expect(built).toEqual({
      ok: true,
      projectId: 'orchestrator-pack',
      displayName: 'wr-i638',
      argv: [
        'spawn',
        '638',
        '--project',
        'orchestrator-pack',
        '--name',
        'wr-i638',
        '--issue',
        '638',
      ],
    });
    const builtOk = expectBuildOk(built);
    expect(builtOk.argv[1]).toBe('638');
    expect(builtOk.argv[builtOk.argv.indexOf('--issue') + 1]).toBe('638');
    expect(parseSpawnTargetFromArgv(builtOk.argv)).toMatchObject({
      action: 'spawn-new',
      targetKey: '638',
      issueTarget: '638',
    });
    expect(validateRunnableSpawnCommand(`ao ${builtOk.argv.join(' ')}`)).toEqual([]);
  });

  it('keeps recovery display names within the AO 0.10.x limit', () => {
    const issueName = expectDisplayNameOk(deriveRecoverySpawnDisplayName({
      spawnAction: 'spawn-new',
      issueNumber: 999999,
    }));
    const prName = expectDisplayNameOk(deriveRecoverySpawnDisplayName({
      spawnAction: 'claim-pr-resume',
      prNumber: 999999,
    }));
    expect(issueName.name.length).toBeLessThanOrEqual(RECOVERY_SPAWN_DISPLAY_NAME_MAX_LENGTH);
    expect(prName.name.length).toBeLessThanOrEqual(RECOVERY_SPAWN_DISPLAY_NAME_MAX_LENGTH);
    expect(RECOVERY_SPAWN_DISPLAY_NAME_MAX_LENGTH).toBe(AO_SPAWN_DISPLAY_NAME_MAX_LENGTH);
  });

  it('resolves --project from dead session worktree record before fallback', () => {
    expect(
      resolveRecoverySpawnProjectId({
        worktreeRecord: { projectId: 'orchestrator-pack' },
        aoSessionRow: { projectId: 'other-project' },
        fallbackProjectId: 'fallback',
      }),
    ).toEqual({ ok: true, projectId: 'orchestrator-pack' });
    expect(
      resolveRecoverySpawnProjectId({
        worktreeRecord: null,
        aoSessionRow: { projectId: 'orchestrator-pack' },
        fallbackProjectId: 'fallback',
      }),
    ).toEqual({ ok: true, projectId: 'orchestrator-pack' });
  });

  it('resolves --project from AO session row when synthesized worktree record lacks projectId', () => {
    expect(
      resolveRecoverySpawnProjectId({
        worktreeRecord: { sessionId: 'opk-638', head: 'abc123' },
        aoSessionRow: { projectId: 'other-pack' },
        fallbackProjectId: 'orchestrator-pack',
      }),
    ).toEqual({ ok: true, projectId: 'other-pack' });
  });

  it('classifies new argv shapes for spawn policy routing', () => {
    const spawnNewArgv = expectBuildOk(buildRecoverySpawnArgv({
      spawnAction: 'spawn-new',
      projectId: 'orchestrator-pack',
      issueNumber: 638,
    })).argv;
    const claimArgv = expectBuildOk(buildRecoverySpawnArgv({
      spawnAction: 'claim-pr-resume',
      projectId: 'orchestrator-pack',
      prNumber: 589,
    })).argv;

    expect(classifySpawnAction(spawnNewArgv)).toBe('spawn-new');
    expect(classifySpawnAction(claimArgv)).toBe('claim-pr-resume');
    expect(parseClaimPrNumberFromSpawnArgv(claimArgv)).toBe(589);
  });

  it('classifies --no-takeover refusal as bounded defer/escalate reason', () => {
    const classified = classifyRecoverySpawnExit({
      exitCode: 1,
      spawnAction: 'claim-pr-resume',
      stdout: 'spawn refused: another active session already owns the claimed PR (--no-takeover)',
      stderr: '',
    });
    expect(classified).toEqual({
      ok: false,
      reason: 'claim_pr_active_owner_refused',
      defer: true,
    });
  });

  it('worker recovery spawn: gate precedes ao invocation in Invoke-WorkerRecoverySpawn', () => {
    const recoveryText = readFileSync(recoveryPs1, 'utf8');
    const fnStart = recoveryText.indexOf('function Invoke-WorkerRecoverySpawn');
    const fnEnd = recoveryText.indexOf('\nfunction Invoke-WorkerRecovery {', fnStart + 1);
    const body = recoveryText.slice(fnStart, fnEnd);
    expect(body.indexOf('Test-AutonomousSpawnDenied')).toBeLessThan(body.indexOf('& ao @argv'));
    expect(body).toMatch(/Build-WorkerRecoverySpawnArgv/);
  });

  it('worker recovery spawn: pre-route gate uses the same AO 0.10.2 argv builder', () => {
    const recoveryText = readFileSync(recoveryPs1, 'utf8');
    expect(recoveryText).toMatch(/worker-recovery-spawn-argv\.mjs/);
    expect(recoveryText).toMatch(/Invoke-WorkerRecoverySpawnArgvCli/);
    expect(recoveryText).toMatch(/Resolve-WorkerRecoverySpawnProjectId/);
    expect(recoveryText).toMatch(/grantDenied\s*=\s*\[bool\]\$spawnGate\.denied/);
  });

  it('worker recovery spawn: accepts PSCustomObject worktree records for project resolution', () => {
    const script = `
      . '${recoveryPs1.replace(/'/g, "''")}'
      $record = '{"sessionId":"opk-638","projectId":"orchestrator-pack"}' | ConvertFrom-Json
      $result = Resolve-WorkerRecoverySpawnProjectId -WorktreeRecord $record -FallbackProjectId 'fallback-project'
      [pscustomobject]@{ ok = [bool]$result.ok; projectId = [string]$result.projectId } | ConvertTo-Json -Compress
    `;
    const parsed = JSON.parse(runPwsh(script)) as { ok: boolean; projectId: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.projectId).toBe('orchestrator-pack');
  });

  it('worker recovery spawn: prefers AO session project when synthesized worktree record lacks projectId', () => {
    const script = `
      . '${recoveryPs1.replace(/'/g, "''")}'
      $record = '{"sessionId":"opk-638","head":"abc123"}' | ConvertFrom-Json
      $aoRow = '{"projectId":"other-pack"}' | ConvertFrom-Json
      $result = Resolve-WorkerRecoverySpawnProjectId -WorktreeRecord $record -AoSessionRow $aoRow -FallbackProjectId 'orchestrator-pack'
      [pscustomobject]@{ ok = [bool]$result.ok; projectId = [string]$result.projectId } | ConvertTo-Json -Compress
    `;
    const parsed = JSON.parse(runPwsh(script)) as { ok: boolean; projectId: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.projectId).toBe('other-pack');
  });
});

describe('worker recovery spawn no-bypass matrix (#638 AC#4)', () => {
  const identityCases = [
    {
      label: 'spawn-new missing issue',
      spawnAction: 'spawn-new',
      projectId: 'orchestrator-pack',
      issueNumber: 0,
      prNumber: 0,
      expectedReason: 'missing_issue_number',
    },
    {
      label: 'claim-pr-resume missing pr',
      spawnAction: 'claim-pr-resume',
      projectId: 'orchestrator-pack',
      issueNumber: 0,
      prNumber: 0,
      expectedReason: 'missing_pr_number',
    },
    {
      label: 'unknown spawn action',
      spawnAction: 'not-a-spawn',
      projectId: 'orchestrator-pack',
      issueNumber: 522,
      prNumber: 0,
      expectedReason: 'unknown_spawn_action',
    },
  ] as const;

  it.each(identityCases)('$label returns before ao spawn', ({ spawnAction, projectId, issueNumber, prNumber, expectedReason }) => {
    withAoSpawnProbeStub(({ probeFile, pack }) => {
      const recoveryScript = path.join(pack.scriptsDir, 'lib', 'Worker-Recovery.ps1');
      const script = `
        . '${recoveryScript.replace(/'/g, "''")}'
        $result = Invoke-WorkerRecoverySpawn -SpawnAction ${psString(spawnAction)} -ProjectId ${psString(projectId)} `
        + `-IssueNumber ${issueNumber} -PrNumber ${prNumber} -PackRoot ${psString(pack.packRoot)} `
        + `-SpawnPolicy @{ allowSpawnNew=$true; allowClaimPrResume=$true }
        [pscustomobject]@{ reason = [string]$result.reason; grantDenied = [bool]$result.grantDenied; started = [bool]$result.started } | ConvertTo-Json -Compress
      `;
      const result = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        cwd: pack.packRoot,
        encoding: 'utf8',
        env: autonomousSpawnFixtureProbeEnv(),
      });
      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout.trim()) as { reason: string; grantDenied: boolean; started: boolean };
      expect(parsed.reason).toBe(expectedReason);
      expect(parsed.grantDenied).toBe(true);
      expect(parsed.started).toBe(false);
      expect(existsSync(probeFile)).toBe(false);
    });
  });

  it('gate-denied spawn-new never reaches ao spawn', () => {
    withAoSpawnProbeStub(({ probeFile, pack }) => {
      const recoveryScript = path.join(pack.scriptsDir, 'lib', 'Worker-Recovery.ps1');
      const script = `
        . '${recoveryScript.replace(/'/g, "''")}'
        $env:AO_AUTONOMOUS_ORCHESTRATOR_SURFACE = '1'
        $result = Invoke-WorkerRecoverySpawn -SpawnAction 'spawn-new' -ProjectId 'orchestrator-pack' `
        + `-IssueNumber 638 -PackRoot ${psString(pack.packRoot)} `
        + `-SpawnPolicy @{ version='${AUTONOMOUS_SPAWN_POLICY_VERSION}'; allowSpawnNew=$false; allowClaimPrResume=$true } -FixtureMode
        [pscustomobject]@{ reason = [string]$result.reason; grantDenied = [bool]$result.grantDenied; started = [bool]$result.started } | ConvertTo-Json -Compress
      `;
      const result = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        cwd: pack.packRoot,
        encoding: 'utf8',
        env: autonomousSpawnFixtureProbeEnv(),
      });
      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout.trim()) as { reason: string; grantDenied: boolean; started: boolean };
      expect(parsed.grantDenied).toBe(true);
      expect(parsed.reason).toMatch(/spawn_policy_allowSpawnNew_false/);
      expect(parsed.started).toBe(false);
      expect(existsSync(probeFile)).toBe(false);
    });
  });

  it('gate-denied claim-pr-resume never reaches ao spawn', () => {
    withAoSpawnProbeStub(({ probeFile, pack }) => {
      const recoveryScript = path.join(pack.scriptsDir, 'lib', 'Worker-Recovery.ps1');
      const script = `
        . '${recoveryScript.replace(/'/g, "''")}'
        $env:AO_AUTONOMOUS_ORCHESTRATOR_SURFACE = '1'
        $result = Invoke-WorkerRecoverySpawn -SpawnAction 'claim-pr-resume' -ProjectId 'orchestrator-pack' `
        + `-PrNumber 589 -PackRoot ${psString(pack.packRoot)} `
        + `-SpawnPolicy @{ version='${AUTONOMOUS_SPAWN_POLICY_VERSION}'; allowSpawnNew=$true; allowClaimPrResume=$false } -FixtureMode
        [pscustomobject]@{ reason = [string]$result.reason; grantDenied = [bool]$result.grantDenied; started = [bool]$result.started } | ConvertTo-Json -Compress
      `;
      const result = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        cwd: pack.packRoot,
        encoding: 'utf8',
        env: autonomousSpawnFixtureProbeEnv(),
      });
      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout.trim()) as { reason: string; grantDenied: boolean; started: boolean };
      expect(parsed.grantDenied).toBe(true);
      expect(parsed.reason).toMatch(/spawn_policy_allowClaimPrResume_false/);
      expect(parsed.started).toBe(false);
      expect(existsSync(probeFile)).toBe(false);
    });
  });
});
