#requires -Version 5.1
<#
.SYNOPSIS
  AO 0.10 stuck review-run liveness reaper tick (Issue #624).

.DESCRIPTION
  Detects same-head review runs stuck in status=running when the reviewer pane is
  absent/stale. Invokes fail-stale-run only when upstream exposes that surface.
  Never submits fabricated review results.
#>
[CmdletBinding()]
param(
    [string]$ProjectId = 'orchestrator-pack',
    [int]$IntervalSeconds = 60,
    [switch]$DryRun,
    [switch]$Once
)

$ErrorActionPreference = 'Stop'
$Script:ReaperLogPrefix = 'review-stuck-run-reaper'

. (Join-Path $PSScriptRoot 'lib/Invoke-ReviewStuckRunReaper.ps1')
. (Join-Path $PSScriptRoot 'lib/Orchestrator-SideProcessProgress.ps1')
. (Join-Path $PSScriptRoot 'lib/Orchestrator-SideEffectFence.ps1')

function Write-StuckRunReaperLog {
    param([string]$Message)
    $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    Write-Host "[$stamp] $($Script:ReaperLogPrefix): $Message"
}

function Invoke-StuckRunReaperTick {
    $lockPath = Get-OrchestratorSideEffectLockPath -LockFileName 'review-stuck-run-reaper-side-effect.lock'
    Write-OrchestratorSideProcessProgress -ChildId 'review-stuck-run-reaper' -Phase 'side_effect'
    $resultHolder = @{ result = $null }
    $fenced = Invoke-OrchestratorSideEffectFenced -LockPath $lockPath -Action {
        $resultHolder.result = Invoke-ReviewStuckRunReaperTick -ProjectId $ProjectId -DryRun:$DryRun
    }
    if (-not $fenced.ok) {
        Write-StuckRunReaperLog 'tick skipped: side-effect lock busy'
        return @{ ok = $false; reason = 'side_effect_busy'; actions = @() }
    }
    return $resultHolder.result
}

$intervalMs = [Math]::Max(5, $IntervalSeconds) * 1000
Write-StuckRunReaperLog "starting (project=$ProjectId, interval=${IntervalSeconds}s, dryRun=$DryRun, once=$Once)"
try {
    do {
        try {
            $result = Invoke-StuckRunReaperTick
            foreach ($action in @($result.actions)) {
                $line = [string]$action.alertLine
                if ($line) {
                    Write-StuckRunReaperLog $line
                }
                if ($action.recovery -and $action.recovery.invoked -eq $true) {
                    $detail = $action.recovery | ConvertTo-Json -Compress -Depth 6
                    Write-StuckRunReaperLog "recovery $detail"
                }
                if ($action.recovery -and $action.recovery.upstream) {
                    Write-StuckRunReaperLog "fail-stale surface absent; upstream $($action.recovery.upstream)"
                }
            }
            if ($result.upstream) {
                Write-StuckRunReaperLog "alert-only mode; upstream prerequisite $result.upstream"
            }
            Write-OrchestratorSideProcessTickSuccess -ChildId 'review-stuck-run-reaper'
        }
        catch {
            Write-StuckRunReaperLog "tick error: $_"
            Write-OrchestratorSideProcessTickError -ChildId 'review-stuck-run-reaper' -ErrorMessage "$_"
        }
        if ($Once) { break }
        Start-Sleep -Milliseconds $intervalMs
    } while ($true)
}
finally {
    Write-StuckRunReaperLog 'stopped'
}
