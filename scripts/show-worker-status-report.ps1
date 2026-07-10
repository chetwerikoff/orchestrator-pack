#requires -Version 5.1
<#
.SYNOPSIS
  Read-only operator projection of pack worker-status store (Issue #720).
#>
param(
    [string]$Project = 'orchestrator-pack',
    [string]$RepoSlug = '',
    [switch]$Json
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/Invoke-AoCliJson.ps1')

$killSwitch = Test-WorkerStatusKillSwitchActive
$readiness = Test-WorkerStatusSiblingReadiness
$sessions = @(Get-WorkerStatusReadOnlyProjection -Project $Project -RepoSlug $RepoSlug)
$nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

$rows = @()
foreach ($session in $sessions) {
    $sessionId = [string]$(
        if ($session.id) { $session.id }
        elseif ($session.name) { $session.name }
        else { $session.sessionId }
    )
    $lastUpdatedMs = 0
    if ($session.workerStatusLastUpdatedMs) {
        $lastUpdatedMs = [int]$session.workerStatusLastUpdatedMs
    }
    $ageMs = if ($lastUpdatedMs -gt 0) { $nowMs - $lastUpdatedMs } else { -1 }
    $rows += [pscustomobject]@{
        sessionId              = $sessionId
        derivedStatus          = [string]$(if ($session.workerStatusDerived) { $session.workerStatusDerived } elseif ($session.status) { $session.status } else { 'unknown' })
        decisionStatus         = [string]$(if ($session.status) { $session.status } else { 'unknown' })
        freshnessAgeMs         = $ageMs
        winningSource          = [string]$(if ($session.workerStatusWinningSource) { $session.workerStatusWinningSource } else { '' })
        stale                  = [bool]$(if ($null -ne $session.workerStatusStale) { [bool]$session.workerStatusStale } else { $false })
        degradedReason         = [string]$(if ($session.workerStatusDegradedReason) { $session.workerStatusDegradedReason } elseif ($session.degradedReason) { $session.degradedReason } else { '' })
        diagnostics            = @($session.workerStatusDiagnostics)
        killSwitchActive       = $killSwitch
        siblingReadinessOk     = [bool]$readiness.ok
    }
}

if ($Json) {
    $payload = @{
        generatedAtMs    = $nowMs
        killSwitchActive = $killSwitch
        siblingReady     = [bool]$readiness.ok
        workers          = $rows
    }
    $payload | ConvertTo-Json -Depth 8
    exit 0
}

Write-Host "worker-status report (read-only) killSwitch=$killSwitch siblingReady=$($readiness.ok)"
foreach ($row in $rows) {
    Write-Host ("{0} status={1} decision={2} ageMs={3} source={4} stale={5} degraded={6}" -f `
            $row.sessionId, $row.derivedStatus, $row.decisionStatus, $row.freshnessAgeMs, `
            $row.winningSource, $row.stale, $row.degradedReason)
    if ($row.diagnostics -and $row.diagnostics.Count -gt 0) {
        Write-Host ("  diagnostics: {0}" -f ($row.diagnostics -join '; '))
    }
}
