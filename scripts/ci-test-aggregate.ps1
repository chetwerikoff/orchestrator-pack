#requires -Version 5.1
<#
.SYNOPSIS
  Transitional compatibility wrapper for the native Node 22/TypeScript aggregate authority.

.SUNSET
  Remove after all external callers use scripts/vitest-ci-runner.ts aggregate directly.
#>
[CmdletBinding()]
param(
    [string]$TypecheckResult = $env:TYPECHECK_RESULT,
    [string]$VitestLightResult = $env:VITEST_LIGHT_RESULT,
    [string]$VitestHeavyResult = $env:VITEST_HEAVY_RESULT,
    [string]$PesterResult = $env:PESTER_RESULT,
    [string]$VitestTopologyPlanResult = $env:VITEST_TOPOLOGY_PLAN_RESULT,
    [string]$HeadSha = $env:GITHUB_SHA,
    [string]$RunId = $env:GITHUB_RUN_ID
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Runner = Join-Path $Root 'scripts/vitest-ci-runner.ts'
$env:TYPECHECK_RESULT = $TypecheckResult
$env:VITEST_LIGHT_RESULT = $VitestLightResult
$env:VITEST_HEAVY_RESULT = $VitestHeavyResult
$env:VITEST_CONTRACT_RESULT = $PesterResult
$env:VITEST_TOPOLOGY_PLAN_RESULT = $VitestTopologyPlanResult
$env:GITHUB_SHA = $HeadSha
$env:GITHUB_RUN_ID = $RunId

& node --experimental-strip-types $Runner aggregate
exit $LASTEXITCODE
