#requires -Version 5.1
<#
.SYNOPSIS
  Liveness-based review-start claim reaper (Issue #417).

.DESCRIPTION
  Periodic sweeper that terminalizes active claims whose local holder is provably
  dead with no in-flight covering run and no active launch-pending intent.
#>
[CmdletBinding()]
param(
    [string]$ProjectId = 'orchestrator-pack',
    [int]$IntervalSeconds = 30,
    [switch]$DryRun,
    [switch]$Once
)

$ErrorActionPreference = 'Stop'
$Script:ReaperLogPrefix = 'review-start-claim-reaper'
$PackRoot = Split-Path -Parent $PSScriptRoot

. (Join-Path $PSScriptRoot 'lib/Review-StartClaim.ps1')
. (Join-Path $PSScriptRoot 'lib/Invoke-AoCliJson.ps1')
. (Join-Path $PSScriptRoot 'lib/Orchestrator-SideProcessProgress.ps1')
. (Join-Path $PSScriptRoot 'lib/Orchestrator-SideEffectFence.ps1')

function Write-ClaimReaperLog {
    param([string]$Message)
    $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    Write-Host "[$stamp] $($Script:ReaperLogPrefix): $Message"
}

function Get-ClaimReaperIntervalSeconds {
    $seconds = $IntervalSeconds
    if ($env:AO_REVIEW_CLAIM_REAPER_PERIOD_SECONDS) {
        $parsed = 0
        if ([int]::TryParse($env:AO_REVIEW_CLAIM_REAPER_PERIOD_SECONDS, [ref]$parsed) -and $parsed -gt 0) {
            $seconds = $parsed
        }
    }
    if ($seconds -lt 5) { return 5 }
    if ($seconds -gt 30) { return 30 }
    return $seconds
}

function Invoke-ClaimReaperTick {
    $reviewRuns = @(Get-AoReviewRuns -Project $ProjectId)
    $lockPath = Get-OrchestratorSideEffectLockPath -LockFileName 'review-start-claim-reaper-side-effect.lock'
    Write-OrchestratorSideProcessProgress -ChildId 'review-start-claim-reaper' -Phase 'side_effect'
    $resultHolder = @{ result = $null }
    $fenced = Invoke-OrchestratorSideEffectFenced -LockPath $lockPath -Action {
        if ($DryRun) {
            $namespace = Resolve-ReviewStartClaimNamespace -ProjectId $ProjectId
            $active = @(Get-ReviewStartClaimActiveRecords -Namespace $namespace)
            $resultHolder.result = @{
                ok       = $true
                dryRun   = $true
                scanned  = $active.Count
                batchReads = 1
            }
            return
        }
        $resultHolder.result = Invoke-ReviewStartClaimReaperSweep -ProjectId $ProjectId -ReviewRuns $reviewRuns `
            -LogWriter { param($m) Write-ClaimReaperLog $m }
    }
    if (-not $fenced.ok) {
        Write-ClaimReaperLog 'tick skipped: side-effect lock busy'
        return @{ ok = $false; reason = 'side_effect_busy' }
    }
    return $resultHolder.result
}

$interval = Get-ClaimReaperIntervalSeconds
$intervalMs = $interval * 1000
Write-ClaimReaperLog "starting (project=$ProjectId, interval=${interval}s, dryRun=$DryRun, once=$Once)"
try {
    do {
        try {
            $result = Invoke-ClaimReaperTick
            foreach ($entry in @($result.results)) {
                if ($entry.reclaimed) {
                    Write-ClaimReaperLog "reclaimed key=$($entry.key) outcome=$($entry.outcome)"
                }
            }
            Write-OrchestratorSideProcessTickSuccess -ChildId 'review-start-claim-reaper'
        }
        catch {
            Write-ClaimReaperLog "tick error: $_"
            Write-OrchestratorSideProcessTickError -ChildId 'review-start-claim-reaper' -ErrorMessage "$_"
        }
        if ($Once) { break }
        Start-Sleep -Milliseconds $intervalMs
    } while ($true)
}
finally {
    Write-ClaimReaperLog 'stopped'
}
