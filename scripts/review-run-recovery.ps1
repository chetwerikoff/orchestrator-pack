#requires -Version 5.1
<#
.SYNOPSIS
  Crash-safe review-run recovery tick (Issue #287).

.DESCRIPTION
  Terminalizes non-terminal AO review runs whose reviewer process identity is
  provably dead after the crash-stability grace, or whose identity remains
  ambiguous beyond the stale threshold. It never starts review runs and never
  sends findings.
#>
[CmdletBinding()]
param(
    [string]$ProjectId = 'orchestrator-pack',
    [string]$StoreDir = '',
    [int]$IntervalSeconds = 60,
    [switch]$DryRun,
    [switch]$Once
)

$ErrorActionPreference = 'Stop'
$Script:RecoveryLogPrefix = 'review-run-recovery'
$PackRoot = Split-Path -Parent $PSScriptRoot
$RecoveryCli = Join-Path $PackRoot 'docs/review-run-recovery.mjs'
. (Join-Path $PSScriptRoot 'lib/MechanicalReconcileNode.ps1')
. (Join-Path $PSScriptRoot 'lib/Orchestrator-SideProcessProgress.ps1')
. (Join-Path $PSScriptRoot 'lib/Orchestrator-SideEffectFence.ps1')

function Write-RecoveryLog {
    param([string]$Message)
    $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    Write-Host "[$stamp] $($Script:RecoveryLogPrefix): $Message"
}

function Invoke-RecoveryCli {
    param([string]$Subcommand, [hashtable]$Payload)
    return Invoke-MechanicalNodeFilterCli -FilterCliPath $RecoveryCli -Subcommand $Subcommand `
        -Payload $Payload -Label $Script:RecoveryLogPrefix -JsonDepth 30
}

function Invoke-RecoveryTick {
    $payload = @{
        projectId = $ProjectId
        dryRun    = [bool]$DryRun
    }
    if ($StoreDir) { $payload.storeDir = $StoreDir }
    $payload.config = @{}
    $lockPath = Get-OrchestratorSideEffectLockPath -LockFileName 'review-run-recovery-side-effect.lock'
    Write-OrchestratorSideProcessProgress -ChildId 'review-run-recovery' -Phase 'side_effect'
    $resultHolder = @{ result = $null }
    $fenced = Invoke-OrchestratorSideEffectFenced -LockPath $lockPath -Action {
        $resultHolder.result = Invoke-RecoveryCli -Subcommand 'tick' -Payload $payload
    }
    if (-not $fenced.ok) {
        Write-RecoveryLog 'tick skipped: side-effect lock busy'
        return @{ ok = $false; reason = 'side_effect_busy'; actions = @() }
    }
    return $resultHolder.result
}

$intervalMs = [Math]::Max(5, $IntervalSeconds) * 1000
Write-RecoveryLog "starting (project=$ProjectId, interval=${IntervalSeconds}s, dryRun=$DryRun, once=$Once)"
try {
    do {
        try {
            $result = Invoke-RecoveryTick
            $actions = @($result.actions)
            foreach ($action in $actions) {
                $detail = $action | ConvertTo-Json -Compress -Depth 8
                if ($action.terminalized -eq $true) {
                    Write-RecoveryLog "terminalized $detail"
                }
                elseif ($action.escalated -eq $true -or $action.writeFailure) {
                    Write-RecoveryLog "ESCALATE $detail"
                }
                else {
                    Write-RecoveryLog "observed $detail"
                }
            }
            Write-OrchestratorSideProcessTickSuccess -ChildId 'review-run-recovery'
        }
        catch {
            Write-RecoveryLog "tick error: $_"
            Write-OrchestratorSideProcessTickError -ChildId 'review-run-recovery' -ErrorMessage "$_"
        }
        if ($Once) { break }
        Start-Sleep -Milliseconds $intervalMs
    } while ($true)
}
finally {
    Write-RecoveryLog 'stopped'
}
