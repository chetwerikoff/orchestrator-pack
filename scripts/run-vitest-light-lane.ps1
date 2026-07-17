#requires -Version 5.1
<#
.SYNOPSIS
  Run classified light Vitest files with bounded in-process parallelism (Issue #556).
#>
[CmdletBinding()]
param(
    [int]$Shard = 0
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$PlanScript = Join-Path $Root 'scripts/invoke-vitest-ci-lane-plan.mjs'

$env:CI = 'true'
$env:VITEST_CI_LIGHT_LANE = '1'
$env:OPK_TESTMODE_FLEET_WORKSPACE_ROOT = $Root
. (Join-Path $PSScriptRoot 'lib/Set-OpkVitestHarnessEnv.ps1')
Set-OpkVitestHarnessEnv | Out-Null

Push-Location $Root
try {
    function Invoke-LightShardPlan {
        param(
            [object]$Plan,
            [int]$ShardNumber,
            [int]$ShardTotal
        )

        if ($Plan.light.Count -eq 0) {
            Write-Host "[PASS] Vitest light lane shard=${ShardNumber}/${ShardTotal}: no classified light files"
            return
        }

        $env:VITEST_LIGHT_MAX_WORKERS = [string]$Plan.lightMaxWorkers
        $env:VITEST_LIGHT_SHARD = [string]$ShardNumber
        $RuntimeReportPath = Join-Path $Root ".vitest-runtime-report-light-$ShardNumber.json"
        if (Test-Path -LiteralPath $RuntimeReportPath) {
            Remove-Item -LiteralPath $RuntimeReportPath -Force
        }

        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $fileArgs = @()
        foreach ($file in $Plan.light) {
            $fileArgs += $file
        }

        $output = & npm test -- @fileArgs --reporter=default --reporter=json --outputFile=$RuntimeReportPath 2>&1
        $exitCode = $LASTEXITCODE
        $text = ($output | Out-String)
        Write-Host $text

        if ($text -match '(?is)onTaskUpdate.*(?:RPC|timeout)|vitest-worker.*onTaskUpdate|STACK_TRACE_ERROR') {
            Write-Host "[FAIL] Vitest worker RPC flake signature detected in light lane shard=${ShardNumber}/${ShardTotal}"
            exit 1
        }

        if ($exitCode -ne 0) {
            exit $exitCode
        }

        if (-not (Test-Path -LiteralPath $RuntimeReportPath)) {
            Write-Host "[FAIL] Vitest runtime report missing for light lane shard=${ShardNumber}/${ShardTotal}"
            exit 1
        }

        & node (Join-Path $Root 'scripts/enforce-vitest-runtime-budget.mjs') $RuntimeReportPath
        if ($LASTEXITCODE -ne 0) {
            Write-Host "[FAIL] Vitest runtime budget exceeded in light lane shard=${ShardNumber}/${ShardTotal}"
            exit 1
        }

        $sw.Stop()
        $elapsed = [math]::Round($sw.Elapsed.TotalSeconds, 2)
        Write-Host "vitest-lane-timing lane=light shard=${ShardNumber}/${ShardTotal} files=$($Plan.light.Count) workers=$($Plan.lightMaxWorkers) elapsed_sec=$elapsed"
    }

    if ($Shard -gt 0) {
        $planJson = & node $PlanScript light --shard $Shard 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Host $planJson
            exit 1
        }
        $plan = $planJson | ConvertFrom-Json
        Invoke-LightShardPlan -Plan $plan -ShardNumber $plan.shard -ShardTotal $plan.lightShardCount
        exit 0
    }

    $planJson = & node $PlanScript light 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host $planJson
        exit 1
    }
    $plan = $planJson | ConvertFrom-Json
    $lightShards = @($plan.lightShards)
    if ($lightShards.Count -gt 1) {
        foreach ($entry in $lightShards) {
            $shardPlanJson = & node $PlanScript light --shard ([int]$entry.shard) 2>&1
            if ($LASTEXITCODE -ne 0) {
                Write-Host $shardPlanJson
                exit 1
            }
            $shardPlan = $shardPlanJson | ConvertFrom-Json
            Invoke-LightShardPlan -Plan $shardPlan -ShardNumber $shardPlan.shard -ShardTotal $shardPlan.lightShardCount
        }
        exit 0
    }

    Invoke-LightShardPlan -Plan $plan -ShardNumber 1 -ShardTotal 1
}
finally {
    Pop-Location
}

exit 0
