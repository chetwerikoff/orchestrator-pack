#requires -Version 5.1
<#
.SYNOPSIS
  Run one runtime-weighted heavy Vitest shard serially in-runner (Issue #556).
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [int]$Shard
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$RuntimeReportPath = Join-Path $Root ".vitest-runtime-report-heavy-$Shard.json"
$PlanScript = Join-Path $Root 'scripts/invoke-vitest-ci-lane-plan.mjs'

$env:CI = 'true'
Remove-Item Env:VITEST_CI_LIGHT_LANE -ErrorAction SilentlyContinue
. (Join-Path $PSScriptRoot 'lib/Set-OpkVitestHarnessEnv.ps1')
Set-OpkVitestHarnessEnv | Out-Null

Push-Location $Root
try {
    $planJson = & node $PlanScript heavy --shard $Shard 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host $planJson
        exit 1
    }

    $shardPlan = $planJson | ConvertFrom-Json
    if ($shardPlan.files.Count -eq 0) {
        Write-Host "[PASS] Vitest heavy shard ${Shard}: no files assigned"
        exit 0
    }

    if (Test-Path -LiteralPath $RuntimeReportPath) {
        Remove-Item -LiteralPath $RuntimeReportPath -Force
    }

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $partialReports = @()
    $shardIndex = 0
    foreach ($file in $shardPlan.files) {
        $shardIndex++
        $partialReport = Join-Path $Root ".vitest-runtime-report-heavy-$Shard-part-$shardIndex.json"
        if (Test-Path -LiteralPath $partialReport) {
            Remove-Item -LiteralPath $partialReport -Force
        }

        # One file per Vitest invocation: birpc onTaskUpdate times out at 60s while subprocess
        # suites (e.g. autonomous-orchestrator-boundary) legitimately exceed that per test.
        # threads pool + maxWorkers=1 stays serial; fresh worker per file avoids RPC starvation.
        $output = & npm test -- $file --pool=threads --reporter=default --reporter=json --outputFile=$partialReport 2>&1
        $exitCode = $LASTEXITCODE
        $text = ($output | Out-String)
        Write-Host $text

        if ($text -match '(?is)onTaskUpdate.*(?:RPC|timeout)|vitest-worker.*onTaskUpdate|STACK_TRACE_ERROR') {
            Write-Host "[FAIL] Vitest worker onTaskUpdate RPC timeout detected on heavy shard $Shard file $file"
            exit 1
        }

        if ($exitCode -ne 0) {
            exit $exitCode
        }

        if (-not (Test-Path -LiteralPath $partialReport)) {
            Write-Host "[FAIL] Vitest runtime report missing for heavy shard $Shard file $file"
            exit 1
        }

        $partialReports += $partialReport
    }

    & node (Join-Path $Root 'scripts/merge-vitest-json-reports.mjs') $RuntimeReportPath @partialReports
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[FAIL] Vitest report merge failed on heavy shard $Shard"
        exit 1
    }

    foreach ($partialReport in $partialReports) {
        if (Test-Path -LiteralPath $partialReport) {
            Remove-Item -LiteralPath $partialReport -Force
        }
    }

    if (-not (Test-Path -LiteralPath $RuntimeReportPath)) {
        Write-Host "[FAIL] Vitest runtime report missing for heavy shard $Shard"
        exit 1
    }

    & node (Join-Path $Root 'scripts/enforce-vitest-runtime-budget.mjs') $RuntimeReportPath
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[FAIL] Vitest runtime budget exceeded on heavy shard $Shard"
        exit 1
    }

    $sw.Stop()
    $elapsed = [math]::Round($sw.Elapsed.TotalSeconds, 2)
    Write-Host "vitest-lane-timing lane=heavy shard=$Shard files=$($shardPlan.files.Count) weight_ms=$($shardPlan.totalRuntimeMs) elapsed_sec=$elapsed"
}
finally {
    Pop-Location
}

exit 0
