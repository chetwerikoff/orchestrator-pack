#requires -Version 5.1
<#
.SYNOPSIS
  Wait for sustained orchestrator launch health (Issue #91).

.DESCRIPTION
  Exits 0 only when the orchestrator session is working with alive runtime for
  PollCount consecutive checks spaced IntervalSec apart (default 4 x 20s = 60s window).
#>
[CmdletBinding()]
param(
    [string]$OrchestratorSessionId = '',
    [string]$ProjectId = '',
    [int]$PollCount = 4,
    [int]$IntervalSec = 20
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/Get-OrchestratorLaunchHealth.ps1')
. (Join-Path $PSScriptRoot 'lib/Invoke-AoCliJson.ps1')

$orchId = $OrchestratorSessionId
if (-not $orchId) {
    $orchId = if ($env:AO_ORCHESTRATOR_SESSION_ID) { $env:AO_ORCHESTRATOR_SESSION_ID.Trim() } else { 'op-orchestrator' }
}

function Get-OrchestratorFromAdapter {
    param([string]$Id, [string]$Proj)

    if ($Id) {
        $rows = @(Get-AoOrchestratorSessions -Project $Proj -IncludeTerminated)
        $orch = $rows | Where-Object { $_.id -eq $Id -or $_.name -eq $Id -or $_.sessionId -eq $Id } | Select-Object -First 1
        if ($orch) { return $orch }
    }
    return @(Get-AoOrchestratorSessions -Project $Proj) | Select-Object -First 1
}

for ($i = 1; $i -le $PollCount; $i++) {
    $orch = Get-OrchestratorFromAdapter -Id $orchId -Proj $ProjectId
    $healthy = Test-OrchestratorSessionLaunchHealthy -Session $orch
    $label = if ($orch) { "$($orch.status)/$($orch.activity)" } else { 'missing' }
    Write-Host ("[{0}/{1}] orchestrator {2}: {3}" -f $i, $PollCount, $orchId, $(if ($healthy) { 'healthy' } else { "not healthy ($label)" }))

    if (-not $healthy) {
        Write-Host "[FAIL] Orchestrator not working+alive on poll $i (need $PollCount consecutive ${IntervalSec}s checks)."
        exit 1
    }

    if ($i -lt $PollCount) {
        Start-Sleep -Seconds $IntervalSec
    }
}

Write-Host "[PASS] Sustained launch health ($PollCount x ${IntervalSec}s)."
exit 0
