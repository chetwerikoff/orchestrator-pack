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

. (Join-Path $PSScriptRoot 'lib/Invoke-OrchestratorEscalationEmit.ps1')

$ErrorActionPreference = 'Stop'
$Script:RecoveryLogPrefix = 'review-run-recovery'
$PackRoot = Split-Path -Parent $PSScriptRoot
$RecoveryCli = Join-Path $PackRoot 'docs/review-run-recovery.mjs'
. (Join-Path $PSScriptRoot 'lib/MechanicalReconcileNode.ps1')
. (Join-Path $PSScriptRoot 'lib/Invoke-AoCliJson.ps1')
. (Join-Path $PSScriptRoot 'lib/Orchestrator-SideProcessProgress.ps1')
. (Join-Path $PSScriptRoot 'lib/Orchestrator-SideEffectFence.ps1')
. (Join-Path $PSScriptRoot 'lib/Review-StartClaim.ps1')

function Test-ReviewRunRecoverySupersededByDaemonReaper {
    if ($env:AO_REVIEW_RECOVERY_MODE -eq 'legacy') { return $false }
    if ($env:AO_REVIEW_RECOVERY_MODE -eq 'daemon') { return $true }
    try {
        $health = Get-AoDaemonHealthJson
        $version = [string]$health.version
        if ($version -match '^0\.10\.') { return $true }
    }
    catch {
        return $false
    }
    return $false
}

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
    if (Test-ReviewRunRecoverySupersededByDaemonReaper) {
        Write-RecoveryLog 'tick skipped: AO 0.10 daemon review path handled by review-stuck-run-reaper (#624)'
        return @{ ok = $true; reason = 'superseded_by_review_stuck_run_reaper'; actions = @() }
    }
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
                    $prNumber = 0
                    $headSha = [string]$action.targetSha
                    if ($null -ne $action.prNumber -and [int]::TryParse([string]$action.prNumber, [ref]$prNumber) -and $prNumber -gt 0 -and $headSha) {
                        $recoveryRuns = @(Get-AoReviewRuns -Project $ProjectId)
                        $claimRelease = Release-ReviewStartClaimForTerminalizedRun -PrNumber $prNumber -HeadSha $headSha `
                            -ProjectId $ProjectId -RunId ([string]$action.runId) -RunCreatedAtUtc ([string]$action.runCreatedAt) `
                            -ReviewRuns $recoveryRuns -LogWriter { param($m) Write-RecoveryLog $m }
                        if (-not $claimRelease.ok -and $claimRelease.reason -notin @('no_active_claim', 'not_active', 'superseded_claim')) {
                            Write-RecoveryLog "claim-release WARN PR #$prNumber head=$($headSha): $($claimRelease.reason) $($claimRelease.detail)"
                        }
                    }
                }
                elseif ($action.escalated -eq $true -or $action.writeFailure) {
                    Write-RecoveryLog "ESCALATE $detail"
                    $runId = if ($action.runId) { [string]$action.runId } else { [string]$action.reviewRunId }
                    $corr = "corr:review-run:$runId"
                    $dedupe = "dedupe:review-run:$runId`:recovery"
                    Invoke-OrchestratorEscalationEmit -EscalationClassId 'escalation-review-run-recovery' `
                        -SourceProcess 'review-run-recovery' -CorrelationKey $corr -DedupeKey $dedupe `
                        -Diagnosis @{ detail = $detail; action = $action } | Out-Null
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
