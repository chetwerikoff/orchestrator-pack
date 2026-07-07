#requires -Version 5.1
<#
.SYNOPSIS
  Fleet guard: registry child launch argv must bind to each child script param block (Issue #659).
#>
[CmdletBinding()]
param(
    [string]$Root = '',
    [string]$RegistryPath = '',
    [string]$ScriptsRoot = '',
    [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'

if (-not $Root) {
    $Root = Split-Path -Parent $PSScriptRoot
}
if (-not $RegistryPath) {
    $RegistryPath = Join-Path $Root 'scripts/orchestrator-side-process-registry.json'
}
if (-not $ScriptsRoot) {
    $ScriptsRoot = Join-Path $Root 'scripts'
}

. (Join-Path $PSScriptRoot 'lib/Orchestrator-SideProcessSupervisor.ps1')

function Invoke-LaunchContractGuard {
    param(
        [string]$GuardRegistryPath,
        [string]$GuardScriptsRoot
    )

    $errorsRef = [ref](@())
    $ok = Test-OrchestratorSideProcessLaunchContract -RegistryPath $GuardRegistryPath `
        -ScriptsRoot $GuardScriptsRoot -OutErrors $errorsRef
    return @{
        ok     = $ok
        errors = @($errorsRef.Value)
    }
}

if ($SelfTest) {
    $fixtureRoot = Join-Path $Root 'scripts/fixtures/side-process-launch-contract'
    $mismatchRegistry = Join-Path $fixtureRoot 'registry-mismatch.json'
    $mismatchScripts = $fixtureRoot

    $mismatch = Invoke-LaunchContractGuard -GuardRegistryPath $mismatchRegistry -GuardScriptsRoot $mismatchScripts
    if ($mismatch.ok) {
        Write-Host '[FAIL] self-test: mismatch fixture must fail launch-contract guard'
        exit 1
    }
    if ($mismatch.errors.Count -lt 1) {
        Write-Host '[FAIL] self-test: mismatch fixture produced no errors'
        exit 1
    }
    if ($mismatch.errors -notmatch 'ProjectId') {
        Write-Host '[FAIL] self-test: mismatch fixture errors must mention ProjectId binding'
        Write-Host ($mismatch.errors -join '; ')
        exit 1
    }

    $aligned = Invoke-LaunchContractGuard -GuardRegistryPath $RegistryPath -GuardScriptsRoot $ScriptsRoot
    if (-not $aligned.ok) {
        Write-Host '[FAIL] self-test: aligned tree must pass launch-contract guard'
        foreach ($err in $aligned.errors) { Write-Host "- $err" }
        exit 1
    }

    Write-Host '[PASS] side-process launch-contract guard self-test (Issue #659)'
    exit 0
}

$result = Invoke-LaunchContractGuard -GuardRegistryPath $RegistryPath -GuardScriptsRoot $ScriptsRoot
if (-not $result.ok) {
    Write-Host '[FAIL] side-process launch-contract guard (Issue #659):'
    foreach ($err in $result.errors) { Write-Host "- $err" }
    exit 1
}

$registry = Get-Content -LiteralPath $RegistryPath -Raw | ConvertFrom-Json
$childCount = @($registry.children).Count
Write-Host "[PASS] side-process launch-contract guard validated $childCount registry children (Issue #659)"
exit 0
