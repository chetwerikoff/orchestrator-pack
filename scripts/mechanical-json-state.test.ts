import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '..');
const coverageScript = path.join(repoRoot, 'scripts/check-side-process-state-coverage.ps1');
const reflectionKeys = [
  'Keys',
  'Values',
  'Count',
  'SyncRoot',
  'IsFixedSize',
  'IsReadOnly',
  'IsSynchronized',
];

function runPwsh(args: string[]): { stdout: string; status: number | null } {
  const result = execFileSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { stdout: result, status: 0 };
}

describe('mechanical JSON state coverage guard', () => {
  it('passes discovery-based fixture coverage check', () => {
    const { status } = runPwsh(['-File', coverageScript]);
    expect(status).toBe(0);
  });
});

describe('supervisor health classification (Issue #248)', () => {
  const healthLib = path.join(repoRoot, 'scripts/lib/Orchestrator-SideProcessHealth.ps1');

  function runHealthProbe(scriptBody: string): string {
    return execFileSync(
      'pwsh',
      ['-NoProfile', '-Command', `. '${healthLib.replace(/'/g, "''")}'; ${scriptBody}`],
      { cwd: repoRoot, encoding: 'utf8' },
    ).trim();
  }

  it('classifies sustained tick errors as degraded with reason', () => {
    const status = runHealthProbe(`
      $v = Get-OrchestratorSideProcessHealthVerdict -ChildEntry @{ RequiresOrchestratorSession = $false } -Paths @{} -SupervisorPhase 'running' -ChildAlive $true -Progress ([pscustomobject]@{ recentOutcomes = @('error','error','error'); lastError = 'synthetic sustained tick failure'; pid = 42; lastProgressMs = $([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) }) -ChildPid 42 -StallThresholdMs 60000
      Write-Output $v.Status
    `);
    expect(status).toBe('degraded');
  });

  it('returns working after transient error then success', () => {
    const status = runHealthProbe(`
      $v = Get-OrchestratorSideProcessHealthVerdict -ChildEntry @{ RequiresOrchestratorSession = $false } -Paths @{} -SupervisorPhase 'running' -ChildAlive $true -Progress ([pscustomobject]@{ recentOutcomes = @('error','success'); lastError = ''; pid = 42; lastProgressMs = $([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) }) -ChildPid 42 -StallThresholdMs 60000
      Write-Output $v.Status
    `);
    expect(status).toBe('working');
  });

  it('reports waiting for session-dependent child when supervisor is waiting', () => {
    const status = runHealthProbe(`
      $v = Get-OrchestratorSideProcessHealthVerdict -ChildEntry @{ RequiresOrchestratorSession = $true } -Paths @{} -SupervisorPhase 'waiting' -ChildAlive $false
      Write-Output $v.Status
    `);
    expect(status).toBe('waiting');
  });

  it('serializes nested childRecovery with sufficient JSON depth', () => {
    const supervisorLib = path.join(repoRoot, 'scripts/lib/Orchestrator-SideProcessSupervisor.ps1');
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-state-depth-'));
    const statePath = path.join(stateDir, 'supervisor-state.json');
    try {
      const attempts = execFileSync(
        'pwsh',
        [
          '-NoProfile',
          '-Command',
          `. '${supervisorLib.replace(/'/g, "''")}'; $paths = @{ StateJson = '${statePath.replace(/'/g, "''")}' }; Set-OrchestratorWakeSupervisorChildRecoveryState -Paths $paths -ChildId 'review-send-reconcile' -RecoveryEntry @{ attempts = 2; terminal = $false; reason = 'synthetic' }; $read = Get-OrchestratorWakeSupervisorChildRecoveryState -Paths $paths -ChildId 'review-send-reconcile'; Write-Output $read.attempts`,
        ],
        { cwd: repoRoot, encoding: 'utf8' },
      ).trim();
      expect(attempts).toBe('2');
      const raw = fs.readFileSync(statePath, 'utf8');
      expect(raw).toContain('"attempts":2');
      expect(raw).toContain('"terminal":false');
      expect(raw).toContain('"reason":"synthetic"');
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('reports stalled when alive child has no progress past grace window', () => {
    const status = runHealthProbe(`
      $startedMs = [DateTimeOffset]::UtcNow.AddMinutes(-5).ToUnixTimeMilliseconds()
      $v = Get-OrchestratorSideProcessHealthVerdict -ChildEntry @{ RequiresOrchestratorSession = $false } -Paths @{} -SupervisorPhase 'running' -ChildAlive $true -Progress $null -ChildPid 42 -StallThresholdMs 60000 -ChildStartedMs $startedMs
      Write-Output $v.Status
    `);
    expect(status).toBe('stalled');
  });
});

describe('reflection key pollution', () => {
  it('never persists CLR reflection keys through write/read cycle', () => {
    const libScript = path.join(repoRoot, 'scripts/lib/MechanicalReconcileNode.ps1');
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mech-state-probe-'));
    const statePath = path.join(stateDir, 'probe-state.json');
    try {
      const probe = `
. '${libScript.replace(/'/g, "''")}'
$default = @{ sent = @{}; lastTickMs = $null }
$state = Get-MechanicalJsonStateFile -Path '${statePath.replace(/'/g, "''")}' -DefaultState $default
$state.sent['probe'] = @{ id = 'x' }
Set-MechanicalJsonStateFile -Path '${statePath.replace(/'/g, "''")}' -State $state -DefaultState $default -JsonDepth 30
$roundTrip = Get-MechanicalJsonStateFile -Path '${statePath.replace(/'/g, "''")}' -DefaultState $default
Set-MechanicalJsonStateFile -Path '${statePath.replace(/'/g, "''")}' -State $roundTrip -DefaultState $default -JsonDepth 30
Get-Content -LiteralPath '${statePath.replace(/'/g, "''")}' -Raw
`;
      const raw = execFileSync('pwsh', ['-NoProfile', '-Command', probe], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
      for (const key of reflectionKeys) {
        expect(raw).not.toContain(`"${key}"`);
      }
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
