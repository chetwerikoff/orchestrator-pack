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
  $prNumber = 0
  foreach ($candidate in @($env:AO_REVIEW_START_PR_NUMBER, $env:AO_PR_NUMBER)) {
    if ($candidate -and [int]::TryParse([string]$candidate, [ref]$prNumber)) { break }
  }
  $headSha = ''
  foreach ($candidate in @($env:AO_REVIEW_START_HEAD_SHA, $env:AO_PR_HEAD_SHA, $env:AO_HEAD_SHA)) {
    if (-not [string]::IsNullOrWhiteSpace($candidate)) {
      $headSha = [string]$candidate
      break
    }
  }
  Write-OrchestratorReviewStartPreflightRefusal -AuditRoot $auditRoot -Reason $result.reason -MarkerState ([string]$result.markerState) -PrNumber $prNumber -HeadSha $headSha | Out-Null
  Write-Host "[FAIL] orchestrator review-start gate preflight: $($result.reason) marker=$($result.markerState)"
  exit 1
}

Write-Host '[PASS] orchestrator review-start gate preflight'
exit 0
