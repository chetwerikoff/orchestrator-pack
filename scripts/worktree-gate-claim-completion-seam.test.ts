import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { psString, repoRoot, runPwsh } from './_test-pwsh-helpers.js';

const boundaryLibPath = path.join(repoRoot, 'scripts/lib/Orchestrator-AutonomousBoundary.ps1');
const claimLibPath = path.join(repoRoot, 'scripts/lib/Review-StartClaim.ps1');
const lifecycleLibPath = path.join(repoRoot, 'scripts/lib/Review-StartClaimLifecycle.ps1');

function runSeamFixture(script: string) {
  return JSON.parse(runPwsh(script));
}

describe('worktree gate claim completion seam (#454)', () => {
  it('worktree-gate-claim-completion-seam: run-started-no-escalate after gate annotation and post-run completion', () => {
    const aoBase = mkdtempSync(path.join(tmpdir(), 'ao-seam-happy-'));
    const projectId = 'orchestrator-pack';
    const headSha = 'a'.repeat(40);
    const prNumber = 454;
    const workspaces = path.join(aoBase, 'projects', projectId, 'code-reviews', 'workspaces');
    const target = path.join(workspaces, 'opk-rev-454-happy');
    try {
      const result = runSeamFixture(`
        $env:AO_AUTONOMOUS_ORCHESTRATOR_SURFACE = '1'
        $env:AO_BASE_DIR = ${psString(aoBase)}
        $env:AO_PROJECT_ID = ${psString(projectId)}
        . ${psString(claimLibPath)}
        . ${psString(lifecycleLibPath)}
        . ${psString(boundaryLibPath)}
        $ns = Get-ReviewStartClaimProjectNamespace -ProjectId ${psString(projectId)}
        Initialize-ReviewStartClaimNamespace -Namespace $ns
        $claim = Acquire-ReviewStartClaim -PrNumber ${prNumber} -HeadSha ${psString(headSha)} -Surface 'orchestrator-turn' -ProjectId ${psString(projectId)} -ReviewRuns @() -StartReason 'fixture'
        $holderGuid = [string]$claim.claim.holder.processGuid
        $launchPending = Set-ReviewStartClaimLaunchPending -ClaimResult $claim
        $workspaces = ${psString(workspaces)}
        New-Item -ItemType Directory -Path $workspaces -Force | Out-Null
        $target = ${psString(target)}
        $gate = Test-AutonomousGitDenied -Argv @('worktree','add','--detach',$target,${psString(headSha)})
        $activeAfterGate = Read-ReviewStartClaimRecord -Path $claim.path
        $postRuns = @(@{ id = 'run-454'; prNumber = ${prNumber}; targetSha = ${psString(headSha)}; status = 'queued' })
        $complete = Complete-ReviewStartClaimAfterRunInvoke -ClaimResult $claim -ReviewRuns $postRuns
        $terminalFiles = @(Get-ChildItem -LiteralPath (Get-ReviewStartClaimTerminalDir -Namespace $ns) -Filter '*run_started*.json' -ErrorAction SilentlyContinue)
        $worktreeAudit = @(Get-ChildItem -LiteralPath (Get-ReviewStartClaimAuditDir -Namespace $ns) -Filter '*.json' -ErrorAction SilentlyContinue | ForEach-Object {
          $record = Get-Content -LiteralPath $_.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
          if ([string]$record.outcome -eq 'worktree_allow_consumed') { $record }
        })
        $runStartedAudit = @(Get-ChildItem -LiteralPath (Get-ReviewStartClaimAuditDir -Namespace $ns) -Filter '*.json' -ErrorAction SilentlyContinue | ForEach-Object {
          $record = Get-Content -LiteralPath $_.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
          if ([string]$record.outcome -eq 'run_started') { $record }
        })
        [pscustomobject]@{
          gateDenied = [bool]$gate.denied
          gateReason = [string]$gate.reason
          launchPendingOk = [bool]$launchPending.ok
          activeAfterGate = [bool]$activeAfterGate.ok
          holderPreserved = ([string]$activeAfterGate.record.holder.processGuid -eq $holderGuid)
          launchPendingPreserved = ($null -ne $activeAfterGate.record.launchPending)
          worktreeAnnotated = ($null -ne $activeAfterGate.record.worktreeAllowConsumed)
          completeOk = [bool]$complete.ok
          completeReason = [string]$complete.reason
          completeOutcome = [string]$complete.outcome
          terminalCount = $terminalFiles.Count
          terminalOutcome = if ($terminalFiles.Count -gt 0) { (Get-Content -LiteralPath $terminalFiles[0].FullName -Raw -Encoding UTF8 | ConvertFrom-Json).outcome } else { '' }
          terminalWorktree = if ($terminalFiles.Count -gt 0) { $null -ne ((Get-Content -LiteralPath $terminalFiles[0].FullName -Raw -Encoding UTF8 | ConvertFrom-Json).worktreeAllowConsumed) } else { $false }
          worktreeAuditCount = $worktreeAudit.Count
          runStartedAuditCount = $runStartedAudit.Count
          runStartedAuditWorktree = if ($runStartedAudit.Count -gt 0) { $null -ne $runStartedAudit[0].worktreeAllowConsumed } else { $false }
          activeExists = Test-Path -LiteralPath $claim.path
        } | ConvertTo-Json -Compress -Depth 8
      `);

      expect(result.gateDenied).toBe(false);
      expect(result.gateReason).toBe('claimed_worktree_allow');
      expect(result.launchPendingOk).toBe(true);
      expect(result.activeAfterGate).toBe(true);
      expect(result.holderPreserved).toBe(true);
      expect(result.launchPendingPreserved).toBe(true);
      expect(result.worktreeAnnotated).toBe(true);
      expect(result.completeOk).toBe(true);
      expect(result.completeReason).not.toBe('ambiguous_claim');
      expect(result.completeOutcome).toBe('run_started');
      expect(result.terminalCount).toBe(1);
      expect(result.terminalOutcome).toBe('run_started');
      expect(result.terminalWorktree).toBe(true);
      expect(result.worktreeAuditCount).toBe(1);
      expect(result.runStartedAuditCount).toBe(1);
      expect(result.runStartedAuditWorktree).toBe(true);
      expect(result.activeExists).toBe(false);
    } finally {
      rmSync(aoBase, { recursive: true, force: true });
    }
  });

  it('worktree-gate-claim-completion-seam: replay-denied and mutex contention tolerates first authorization', () => {
    const aoBase = mkdtempSync(path.join(tmpdir(), 'ao-seam-replay-'));
    const projectId = 'orchestrator-pack';
    const headSha = 'c'.repeat(40);
    const prNumber = 454;
    const workspaces = path.join(aoBase, 'projects', projectId, 'code-reviews', 'workspaces');
    const targetFirst = path.join(workspaces, 'opk-rev-454-replay-1');
    const targetSecond = path.join(workspaces, 'opk-rev-454-replay-2');
    try {
      const result = runSeamFixture(`
        $env:AO_AUTONOMOUS_ORCHESTRATOR_SURFACE = '1'
        $env:AO_BASE_DIR = ${psString(aoBase)}
        $env:AO_PROJECT_ID = ${psString(projectId)}
        . ${psString(claimLibPath)}
        . ${psString(lifecycleLibPath)}
        . ${psString(boundaryLibPath)}
        $ns = Get-ReviewStartClaimProjectNamespace -ProjectId ${psString(projectId)}
        Initialize-ReviewStartClaimNamespace -Namespace $ns
        $record = New-ReviewStartClaimActiveRecord -PrNumber ${prNumber} -HeadSha ${psString(headSha)} -Surface 'orchestrator-turn' -Reason 'fixture'
        $claimPath = Get-ReviewStartClaimPath -Namespace $ns -PrNumber ${prNumber} -HeadSha ${psString(headSha)}
        Write-ReviewStartClaimAtomic -Path $claimPath -Record $record
        $lockDir = Get-ReviewStartClaimLockDir -Namespace $ns -PrNumber ${prNumber} -HeadSha ${psString(headSha)}
        $held = Enter-ReviewStartClaimMutex -LockDir $lockDir
        $workspaces = ${psString(workspaces)}
        New-Item -ItemType Directory -Path $workspaces -Force | Out-Null
        $targetFirst = ${psString(targetFirst)}
        $contendedJob = Start-Job -ScriptBlock {
          param($boundary, $target, $head, $aoBase, $projectId)
          $env:AO_AUTONOMOUS_ORCHESTRATOR_SURFACE = '1'
          $env:AO_BASE_DIR = $aoBase
          $env:AO_PROJECT_ID = $projectId
          . $boundary
          $verdict = Test-AutonomousGitDenied -Argv @('worktree','add','--detach',$target,$head)
          [pscustomobject]@{ denied = [bool]$verdict.denied; reason = [string]$verdict.reason } | ConvertTo-Json -Compress
        } -ArgumentList ${psString(boundaryLibPath)}, $targetFirst, ${psString(headSha)}, ${psString(aoBase)}, ${psString(projectId)}
        Start-Sleep -Milliseconds 75
        if ($held) { Exit-ReviewStartClaimMutex -LockDir $lockDir }
        $contended = Receive-Job -Job $contendedJob -Wait -AutoRemoveJob | ConvertFrom-Json
        $secondBoundary = Test-AutonomousGitDenied -Argv @('worktree','add','--detach',${psString(targetSecond)},${psString(headSha)})
        $secondGate = Test-AutonomousReviewWorktreeClaimBoundAllow -Argv @('worktree','add','--detach',${psString(targetSecond)},${psString(headSha)})
        $active = Read-ReviewStartClaimRecord -Path $claimPath
        [pscustomobject]@{
          contendedDenied = [bool]$contended.denied
          contendedReason = [string]$contended.reason
          replayDenied = [bool]$secondBoundary.denied
          replayGateReason = [string]$secondGate.reason
          activeExists = Test-Path -LiteralPath $claimPath
          worktreeAnnotated = if ($active.ok) { $null -ne $active.record.worktreeAllowConsumed } else { $false }
        } | ConvertTo-Json -Compress -Depth 6
      `);

      expect(result.contendedDenied).toBe(false);
      expect(result.contendedReason).toBe('claimed_worktree_allow');
      expect(result.replayDenied).toBe(true);
      expect(result.replayGateReason).toBe('claim_already_consumed');
      expect(result.activeExists).toBe(true);
      expect(result.worktreeAnnotated).toBe(true);
    } finally {
      rmSync(aoBase, { recursive: true, force: true });
    }
  });
});
