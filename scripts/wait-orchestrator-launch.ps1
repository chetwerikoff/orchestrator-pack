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

$orchId = $OrchestratorSessionId
if (-not $orchId) {
    $orchId = if ($env:AO_ORCHESTRATOR_SESSION_ID) { $env:AO_ORCHESTRATOR_SESSION_ID.Trim() } else { 'op-orchestrator' }
}

function Get-OrchestratorFromStatus {
    param([string]$Id, [string]$Proj)

    $args = @('status', '--json', '--reports', 'full')
    if ($Proj) { $args += @('-p', $Proj) }
    $raw = & ao @args 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "ao status failed: $raw"
    }
    $payload = $raw | ConvertFrom-Json
    $sessions = @($payload.data)
    if (-not $sessions -and $payload.sessions) { $sessions = @($payload.sessions) }
    $orch = $sessions | Where-Object { $_.name -eq $Id -or $_.sessionId -eq $Id } | Select-Object -First 1
    if (-not $orch) {
        $orch = $sessions | Where-Object { $_.role -eq 'orchestrator' } | Select-Object -First 1
    }
    return $orch
}

for ($i = 1; $i -le $PollCount; $i++) {
    $orch = Get-OrchestratorFromStatus -Id $orchId -Proj $ProjectId
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
