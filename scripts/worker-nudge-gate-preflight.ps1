#requires -Version 5.1
<#
  Fail-closed preflight for autonomous orchestrator worker nudges (Issue #384).
#>
[CmdletBinding()]
param(
    [string]$ConfiguredGateVersion = '',
    [switch]$FixtureMode
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/Worker-AutonomousNudgeGate.ps1')
. (Join-Path $PSScriptRoot 'lib/Worker-NudgeAudit.ps1')

$result = Test-WorkerNudgeGatePreflight -ConfiguredGateVersion $ConfiguredGateVersion -FixtureMode:$FixtureMode
if (-not $result.ok) {
    $auditRoot = Get-WorkerNudgeGateAuditRoot
    Write-WorkerNudgeGatePreflightRefusal -AuditRoot $auditRoot -Reason $result.reason -MarkerState ([string]$result.markerState) | Out-Null
    Write-Host "[FAIL] worker nudge gate preflight: $($result.reason) marker=$($result.markerState)"
    exit 1
}

Write-Host '[PASS] worker nudge gate preflight'
exit 0
