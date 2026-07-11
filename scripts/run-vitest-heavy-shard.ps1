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
$BatchingScript = Join-Path $Root 'scripts/lib/vitest-heavy-batching.mjs'
$JsonReportScript = Join-Path $Root 'scripts/lib/vitest-json-report.mjs'

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

function Resolve-PositiveIntOrDefault {
    param(
        [string]$Value,
        [int]$Default
    )

    $parsed = 0
    if ([int]::TryParse($Value, [ref]$parsed) -and $parsed -gt 0) {
        return $parsed
    }
    return $Default
}

function New-HeavyShardBatch {
    param(
        [object[]]$Members,
        [string]$Pool
    )

    $files = @($Members | ForEach-Object { [string]$_.file } | Select-Object -Unique)
    $label = if ($Members.Count -eq 1) {
        [string]$Members[0].label
    }
    else {
        "batch($($Members.Count)): $(([string[]]($Members | ForEach-Object { [string]$_.label })) -join ', ')"
    }
    $testPattern = if ($Members.Count -eq 1) { $Members[0].testPattern } else { $null }
    [pscustomobject]@{
        label       = $label
        pool        = $Pool
        files       = $files
        testPattern = $testPattern
        members     = $Members
    }
}

function Add-OpenHeavyShardBatch {
    param(
        [System.Collections.Generic.List[object]]$Invocations,
        [object[]]$Members,
        [string]$Pool
    )

    if ($Members.Count -gt 0) {
        $Invocations.Add((New-HeavyShardBatch -Members $Members -Pool $Pool)) | Out-Null
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
    $nonIsolateFileBatchSize = Resolve-PositiveIntOrDefault -Value $env:VITEST_HEAVY_FILE_BATCH_SIZE -Default 4
    $isolateTestBatchSize = 1
    $partialReportSeq = 0

    try {
        $invocations = [System.Collections.Generic.List[object]]::new()
        $openMembers = @()
        $openPool = $null
        $baselineInvocationCount = 0

        foreach ($file in $shardPlan.files) {
            $filePlanJson = & node $FileRunPlanScript $file 2>&1
            if ($LASTEXITCODE -ne 0) {
                Write-Host $filePlanJson
                exit 1
            }
            $runPlan = $filePlanJson | ConvertFrom-Json
            $pool = [string]$runPlan.pool
            if ($runPlan.mode -eq 'tests') {
                Add-OpenHeavyShardBatch -Invocations $invocations -Members $openMembers -Pool $openPool
                $openMembers = @()
                $openPool = $null
                foreach ($testTitle in @($runPlan.tests)) {
                    $baselineInvocationCount++
                    $member = [pscustomobject]@{
                        kind        = 'test'
                        file        = [string]$file
                        pool        = $pool
                        label       = "$file > $testTitle"
                        testPattern = [string]$testTitle
                    }
                    $invocations.Add((New-HeavyShardBatch -Members @($member) -Pool $pool)) | Out-Null
                }
                continue
            }

            $baselineInvocationCount++
            $member = [pscustomobject]@{
                kind        = 'file'
                file        = [string]$file
                pool        = $pool
                label       = [string]$file
                testPattern = $null
            }
            if ($openMembers.Count -eq 0) {
                $openPool = $pool
                $openMembers = @($member)
            }
            elseif ($openPool -eq $pool -and $openMembers.Count -lt $nonIsolateFileBatchSize) {
                $openMembers += $member
            }
            else {
                Add-OpenHeavyShardBatch -Invocations $invocations -Members $openMembers -Pool $openPool
                $openPool = $pool
                $openMembers = @($member)
            }
        }
        Add-OpenHeavyShardBatch -Invocations $invocations -Members $openMembers -Pool $openPool

        Write-Host "vitest-heavy-batching shard=$Shard files=$($shardPlan.files.Count) invocations=$($invocations.Count) baseline_invocations=$baselineInvocationCount non_isolate_file_batch_size=$nonIsolateFileBatchSize isolate_test_batch_size=$isolateTestBatchSize"

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
                    $fileArgs = @($invocation.files | ForEach-Object { [string]$_ })
                    $poolArgs = @()
                    if ([string]$invocation.pool -eq 'forks') {
                        $poolArgs += "--pool=$($invocation.pool)"
                    }

                    # Bounded batches amortize npm/vitest process boot while preserving serial
                    # heavy-lane execution and the existing RPC-flake retry posture.
                    $output = & npm test -- @fileArgs @poolArgs @testArgs --reporter=default --reporter=json --outputFile=$partialReportPath 2>&1
                    $text = ($output | Out-String)
                    Write-Host $text

                    if ($text -match '(?is)onTaskUpdate.*(?:RPC|timeout)|vitest-worker.*onTaskUpdate|STACK_TRACE_ERROR') {
                        $hasFailedReport = & node $JsonReportScript has-failed-tests $partialReportPath
                        if ($hasFailedReport -eq '1') {
                            $failedExitCode = if ($LASTEXITCODE -ne 0) { $LASTEXITCODE } else { 1 }
                            Write-Host "[FAIL] Vitest heavy shard $Shard invocation $($invocation.label) reported genuine test failure alongside RPC-flake text; not retrying over a reported failure"
                            break
                        }
                        $cleanReport = & node $JsonReportScript is-clean $partialReportPath
                        if ($cleanReport -eq '1') {
                            Write-Host "[WARN] Post-success vitest-worker onTaskUpdate shutdown flake suppressed for $($invocation.label)"
                            if (-not (Test-Path -LiteralPath $partialReportPath)) {
                                Write-Host "[FAIL] Vitest runtime report missing for heavy shard $Shard invocation $($invocation.label)"
                                exit 1
                            }
                            $plannedJson = @{ members = @($invocation.members) } | ConvertTo-Json -Compress -Depth 6
                            & node $BatchingScript validate-report --report $partialReportPath --repo-root $Root --planned-json $plannedJson
                            if ($LASTEXITCODE -ne 0) {
                                Write-Host "[FAIL] Vitest runtime report for heavy shard $Shard invocation $($invocation.label) does not match planned batch members"
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
                        $hasFailedReport = & node $JsonReportScript has-failed-tests $partialReportPath
                        if ($hasFailedReport -eq '1') {
                            Write-Host "[FAIL] Vitest heavy shard $Shard invocation $($invocation.label) reported a genuine test failure; not retrying a non-flake assertion failure"
                            break
                        }
                        if ($attempt -lt $maxFileAttempts) {
                            Write-Host "[WARN] Vitest heavy shard $Shard invocation $($invocation.label) failed (attempt $attempt/$maxFileAttempts, exit=$failedExitCode); cleaning fleet and retrying..."
                            Invoke-HeavyShardFleetCleanup -Shard $Shard
                            Start-Sleep -Seconds 5
                            continue
                        }
                        Write-Host "[FAIL] Vitest heavy shard $Shard invocation $($invocation.label) failed closed after $attempt attempt(s), exit=$failedExitCode"
                        break
                    }

                    if (-not (Test-Path -LiteralPath $partialReportPath)) {
                        Write-Host "[FAIL] Vitest runtime report missing for heavy shard $Shard invocation $($invocation.label)"
                        exit 1
                    }

                    $plannedJson = @{ members = @($invocation.members) } | ConvertTo-Json -Compress -Depth 6
                    & node $BatchingScript validate-report --report $partialReportPath --repo-root $Root --planned-json $plannedJson
                    if ($LASTEXITCODE -ne 0) {
                        Write-Host "[FAIL] Vitest runtime report for heavy shard $Shard invocation $($invocation.label) does not match planned batch members"
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

        if ($failedExitCode -ne 0) {
            $shardExitCode = $failedExitCode
        }
        else {
            $mergeArgs = @(
                $JsonReportScript,
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
