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
$FileRunPlanScript = Join-Path $Root 'scripts/resolve-vitest-heavy-file-run-plan.mjs'

$env:CI = 'true'
$env:VITEST_HEAVY_SHARD = [string]$Shard
$env:OPK_TESTMODE_FLEET_WORKSPACE_ROOT = $Root
Remove-Item Env:VITEST_CI_LIGHT_LANE -ErrorAction SilentlyContinue
. (Join-Path $PSScriptRoot 'lib/Set-OpkVitestHarnessEnv.ps1')
Set-OpkVitestHarnessEnv | Out-Null
. (Join-Path $PSScriptRoot 'lib/TestMode-FleetLease.ps1')

function Invoke-HeavyShardFleetCleanup {
    param([int]$Shard)

    $reaperScript = Join-Path $Root 'scripts/invoke-testmode-fleet-reaper.ps1'
    $laneContexts = @(Get-TestModeVitestLaneLeaseContexts -Shard ([string]$Shard))
    if ($laneContexts.Count -eq 0) {
        Import-TestModeVitestLaneLeaseContext -Shard ([string]$Shard) | Out-Null
        if ($env:AO_TESTMODE_FLEET_LANE_LEASE_ID) {
            $laneContexts = @([pscustomobject]@{
                leaseId   = [string]$env:AO_TESTMODE_FLEET_LANE_LEASE_ID
                leaseRoot = [string]$env:OPK_TESTMODE_LEASE_ROOT
            })
        }
    }

    foreach ($ctx in $laneContexts) {
        if ($ctx.leaseRoot) { $env:OPK_TESTMODE_LEASE_ROOT = [string]$ctx.leaseRoot }
        if ($ctx.leaseId) { $env:AO_TESTMODE_FLEET_LANE_LEASE_ID = [string]$ctx.leaseId }
        & pwsh -NoProfile -ExecutionPolicy Bypass -File $reaperScript cleanup 2>&1 | Write-Host
    }
}

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
    $partialReports = [System.Collections.Generic.List[string]]::new()
    $failedExitCode = 0
    $shardExitCode = 0
    $maxFileAttempts = if ($env:CI -eq 'true') { 5 } else { 1 }
    $partialReportSeq = 0

    try {
        foreach ($file in $shardPlan.files) {
            $filePlanJson = & node $FileRunPlanScript $file 2>&1
            if ($LASTEXITCODE -ne 0) {
                Write-Host $filePlanJson
                exit 1
            }
            $runPlan = $filePlanJson | ConvertFrom-Json
            $pool = [string]$runPlan.pool
            $invocations = @(
                @{ label = $file; testPattern = $null }
            )
            if ($runPlan.mode -eq 'tests') {
                $invocations = @()
                foreach ($testTitle in @($runPlan.tests)) {
                    $invocations += @{ label = "$file > $testTitle"; testPattern = [string]$testTitle }
                }
            }

            foreach ($invocation in $invocations) {
                $partialReportSeq++
                $safeLabel = ($invocation.label -replace '[^\w.\-]+', '_')
                $partialReportPath = Join-Path $Root ".vitest-runtime-report-heavy-$Shard-$partialReportSeq-$safeLabel.json"
                $invocationPassed = $false

                for ($attempt = 1; $attempt -le $maxFileAttempts; $attempt++) {
                    if (Test-Path -LiteralPath $partialReportPath) {
                        Remove-Item -LiteralPath $partialReportPath -Force
                    }

                    $testArgs = @()
                    if ($invocation.testPattern) {
                        $testArgs += '-t'
                        $testArgs += [string]$invocation.testPattern
                    }
                    $poolArgs = @()
                    if ($pool -eq 'forks') {
                        $poolArgs += "--pool=$pool"
                    }

                    # One invocation per heavy file or per isolated test so long suites do not
                    # starve vitest-worker onTaskUpdate RPC (#487/#556/#648).
                    $output = & npm test -- $file @poolArgs @testArgs --reporter=default --reporter=json --outputFile=$partialReportPath 2>&1
                    $text = ($output | Out-String)
                    Write-Host $text

                    if ($text -match '(?is)onTaskUpdate.*(?:RPC|timeout)|vitest-worker.*onTaskUpdate|STACK_TRACE_ERROR') {
                        $cleanReport = & node (Join-Path $Root 'scripts/lib/vitest-json-report.mjs') is-clean $partialReportPath
                        if ($cleanReport -eq '1') {
                            Write-Host "[WARN] Post-success vitest-worker onTaskUpdate shutdown flake suppressed for $($invocation.label)"
                            if (-not (Test-Path -LiteralPath $partialReportPath)) {
                                Write-Host "[FAIL] Vitest runtime report missing for heavy shard $Shard invocation $($invocation.label)"
                                exit 1
                            }
                            $invocationPassed = $true
                            break
                        }
                        if ($attempt -lt $maxFileAttempts) {
                            Write-Host "[WARN] Vitest worker RPC flake on heavy shard $Shard invocation $($invocation.label) (attempt $attempt/$maxFileAttempts); retrying..."
                            Invoke-HeavyShardFleetCleanup -Shard $Shard
                            Start-Sleep -Seconds 5
                            continue
                        }
                        Write-Host "[FAIL] Vitest worker onTaskUpdate RPC timeout detected on heavy shard $Shard invocation $($invocation.label)"
                        exit 1
                    }

                    if ($LASTEXITCODE -ne 0) {
                        $failedExitCode = $LASTEXITCODE
                        if ($attempt -lt $maxFileAttempts) {
                            Write-Host "[WARN] Vitest heavy shard $Shard invocation $($invocation.label) failed (attempt $attempt/$maxFileAttempts, exit=$failedExitCode); cleaning fleet and retrying..."
                            Invoke-HeavyShardFleetCleanup -Shard $Shard
                            Start-Sleep -Seconds 5
                            continue
                        }
                        break
                    }

                    if (-not (Test-Path -LiteralPath $partialReportPath)) {
                        Write-Host "[FAIL] Vitest runtime report missing for heavy shard $Shard invocation $($invocation.label)"
                        exit 1
                    }

                    $invocationPassed = $true
                    break
                }

                if (-not $invocationPassed) {
                    Invoke-HeavyShardFleetCleanup -Shard $Shard
                    continue
                }

                $partialReports.Add($partialReportPath) | Out-Null
            }
        }

        if ($failedExitCode -ne 0) {
            $shardExitCode = $failedExitCode
        }
        else {
            $mergeArgs = @(
                (Join-Path $Root 'scripts/lib/vitest-json-report.mjs'),
                'merge',
                '--output',
                $RuntimeReportPath
            ) + $partialReports
            & node @mergeArgs
            if ($LASTEXITCODE -ne 0) {
                Write-Host "[FAIL] Vitest heavy shard $Shard failed to merge per-file JSON reports"
                $shardExitCode = 1
            }
            else {
                $metaPath = "$RuntimeReportPath.meta.json"
                $meta = @{
                    commitSha = if ($env:GITHUB_SHA) { $env:GITHUB_SHA } else { '' }
                    shard     = $Shard
                    success   = $true
                    runId     = if ($env:GITHUB_RUN_ID) { $env:GITHUB_RUN_ID } else { '' }
                }
                $meta | ConvertTo-Json -Compress | Set-Content -LiteralPath $metaPath -Encoding utf8

                & node (Join-Path $Root 'scripts/enforce-vitest-runtime-budget.mjs') $RuntimeReportPath
                if ($LASTEXITCODE -ne 0) {
                    Write-Host "[FAIL] Vitest runtime budget exceeded on heavy shard $Shard"
                    $shardExitCode = 1
                }
                else {
                    $sw.Stop()
                    $elapsed = [math]::Round($sw.Elapsed.TotalSeconds, 2)
                    Write-Host "vitest-lane-timing lane=heavy shard=$Shard files=$($shardPlan.files.Count) weight_ms=$($shardPlan.totalRuntimeMs) elapsed_sec=$elapsed"
                }
            }
        }
    }
    finally {
        foreach ($partialReportPath in $partialReports) {
            if (Test-Path -LiteralPath $partialReportPath) {
                Remove-Item -LiteralPath $partialReportPath -Force -ErrorAction SilentlyContinue
            }
        }
    }

    $hygieneExitCode = 0
    $reaperScript = Join-Path $Root 'scripts/invoke-testmode-fleet-reaper.ps1'
    $laneContexts = @(Get-TestModeVitestLaneLeaseContexts -Shard ([string]$Shard))
    if ($laneContexts.Count -eq 0) {
        Import-TestModeVitestLaneLeaseContext -Shard ([string]$Shard) | Out-Null
        if ($env:AO_TESTMODE_FLEET_LANE_LEASE_ID) {
            $laneContexts = @([pscustomobject]@{
                leaseId   = [string]$env:AO_TESTMODE_FLEET_LANE_LEASE_ID
                leaseRoot = [string]$env:OPK_TESTMODE_LEASE_ROOT
            })
        }
    }

    $hygieneFailed = $false
    foreach ($ctx in $laneContexts) {
        if ($ctx.leaseRoot) { $env:OPK_TESTMODE_LEASE_ROOT = [string]$ctx.leaseRoot }
        if ($ctx.leaseId) { $env:AO_TESTMODE_FLEET_LANE_LEASE_ID = [string]$ctx.leaseId }

        $observeJson = & pwsh -NoProfile -ExecutionPolicy Bypass -File $reaperScript observe 2>&1
        if ($LASTEXITCODE -ne 0) {
            $hygieneFailed = $true
            Write-Host "[FAIL] TestMode fleet hygiene: surviving this-run/shard-scoped pwsh detected for lease $($ctx.leaseId)"
            Write-Host $observeJson
        }
    }

    if ($hygieneFailed) {
        foreach ($ctx in $laneContexts) {
            if ($ctx.leaseRoot) { $env:OPK_TESTMODE_LEASE_ROOT = [string]$ctx.leaseRoot }
            if ($ctx.leaseId) { $env:AO_TESTMODE_FLEET_LANE_LEASE_ID = [string]$ctx.leaseId }
            & pwsh -NoProfile -ExecutionPolicy Bypass -File $reaperScript cleanup 2>&1 | Write-Host
        }
        $hygieneExitCode = 2
    }

    if ($hygieneExitCode -ne 0) {
        exit $hygieneExitCode
    }
    if ($shardExitCode -ne 0) {
        exit $shardExitCode
    }
}
finally {
    Pop-Location
}

exit 0
