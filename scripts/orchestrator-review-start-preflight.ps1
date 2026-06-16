#requires -Version 5.1
<#
  Fail-closed preflight for autonomous orchestrator review-starts (Issue #318).
#>
[CmdletBinding()]
param(
    [string]$ConfiguredGateVersion = '',
    [switch]$FixtureMode
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/Orchestrator-AutonomousReviewStartGate.ps1')
. (Join-Path $PSScriptRoot 'lib/Orchestrator-ReviewStartAudit.ps1')

$result = Test-OrchestratorReviewStartGatePreflight -ConfiguredGateVersion $ConfiguredGateVersion -FixtureMode:$FixtureMode
if (-not $result.ok) {
  $auditRoot = Get-OrchestratorReviewStartAuditRoot
  Write-OrchestratorReviewStartPreflightRefusal -AuditRoot $auditRoot -Reason $result.reason -MarkerState ([string]$result.markerState) | Out-Null
  Write-Host "[FAIL] orchestrator review-start gate preflight: $($result.reason) marker=$($result.markerState)"
  exit 1
}

Write-Host '[PASS] orchestrator review-start gate preflight'
exit 0
