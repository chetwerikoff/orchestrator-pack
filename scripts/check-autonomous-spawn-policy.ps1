#requires -Version 5.1
<#
  CI drift guard for autonomous spawn policy (Issue #458).
#>
[CmdletBinding()]
param(
    [string]$RepoRoot = ''
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/Autonomous-GateCommon.ps1')
. (Join-Path $PSScriptRoot 'lib/Orchestrator-AutonomousSpawnGate.ps1')

$RepoRoot = Resolve-PackGateRepoRoot -RepoRoot $RepoRoot -CallerScriptRoot $PSScriptRoot
$policyPath = Get-AutonomousSpawnPolicyPath -PackRoot $RepoRoot
$violations = [System.Collections.Generic.List[string]]::new()

if (-not (Test-Path -LiteralPath $policyPath)) {
    $violations.Add('missing docs/autonomous-spawn-policy.json')
}
else {
    $policyLoad = Get-AutonomousSpawnPolicy -PackRoot $RepoRoot
    if (-not $policyLoad.ok) {
        $violations.Add("spawn policy validation failed: $($policyLoad.reason)")
    }
    elseif (-not $policyLoad.policy.allowSpawnNew -or -not $policyLoad.policy.allowClaimPrResume) {
        $violations.Add('spawn policy must default allowSpawnNew=true and allowClaimPrResume=true')
    }
}

if ($violations.Count -gt 0) {
    Write-Host 'autonomous spawn policy guard failed:'
    $violations | ForEach-Object { Write-Host " - $_" }
    exit 1
}

Write-Host '[PASS] autonomous spawn policy inventory'
exit 0
