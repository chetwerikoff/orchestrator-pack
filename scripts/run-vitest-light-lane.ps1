#requires -Version 5.1
<#
.SYNOPSIS
  Run classified light Vitest files with bounded in-process parallelism (Issue #556).
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$RuntimeReportPath = Join-Path $Root '.vitest-runtime-report-light.json'
$PlanScript = Join-Path $Root 'scripts/invoke-vitest-ci-lane-plan.mjs'

$env:CI = 'true'
$env:VITEST_CI_LIGHT_LANE = '1'
$env:OPK_TESTMODE_FLEET_WORKSPACE_ROOT = $Root
. (Join-Path $PSScriptRoot 'lib/Set-OpkVitestHarnessEnv.ps1')
Set-OpkVitestHarnessEnv | Out-Null

Push-Location $Root
try {
    $planJson = & node $PlanScript light 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host $planJson
        exit 1
    }

    $plan = $planJson | ConvertFrom-Json
    if ($plan.light.Count -eq 0) {
        Write-Host '[PASS] Vitest light lane: no classified light files'
        exit 0
    }

    $env:VITEST_LIGHT_MAX_WORKERS = [string]$plan.lightMaxWorkers
    if (Test-Path -LiteralPath $RuntimeReportPath) {
        Remove-Item -LiteralPath $RuntimeReportPath -Force
    }

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $fileArgs = @()
    foreach ($file in $plan.light) {
        $fileArgs += $file
    }

    $output = & npm test -- @fileArgs --reporter=default --reporter=json --outputFile=$RuntimeReportPath 2>&1
    $exitCode = $LASTEXITCODE
    $text = ($output | Out-String)
    if ($exitCode -ne 0) {
        Write-Host (($output | Select-Object -Last 500) | Out-String)
    }
    else {
        Write-Host '[PASS] Vitest light test process completed; diagnostic branch suppresses full output'
    }

    if ($text -match '(?is)onTaskUpdate.*(?:RPC|timeout)|vitest-worker.*onTaskUpdate|STACK_TRACE_ERROR') {
        Write-Host '[FAIL] Vitest worker RPC flake signature detected in light lane'
        exit 1
    }

    if ($exitCode -ne 0) {
        exit $exitCode
    }

    if (-not (Test-Path -LiteralPath $RuntimeReportPath)) {
        Write-Host '[FAIL] Vitest runtime report missing for light lane'
        exit 1
    }

    & node (Join-Path $Root 'scripts/enforce-vitest-runtime-budget.mjs') $RuntimeReportPath
    if ($LASTEXITCODE -ne 0) {
        Write-Host '[FAIL] Vitest runtime budget exceeded in light lane'
        exit 1
    }

    $sw.Stop()
    $elapsed = [math]::Round($sw.Elapsed.TotalSeconds, 2)
    Write-Host "vitest-lane-timing lane=light files=$($plan.light.Count) workers=$($plan.lightMaxWorkers) elapsed_sec=$elapsed"
}
finally {
    Pop-Location
}

exit 0
