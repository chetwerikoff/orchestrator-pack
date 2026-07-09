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
$MergeScript = Join-Path $Root 'scripts/merge-vitest-json-reports.mjs'
$RpcScanScript = Join-Path $Root 'scripts/lib/scan-vitest-worker-rpc.mjs'
$LanesConfigPath = Join-Path $Root 'scripts/vitest-ci-lanes.config.json'
$heavyVitestPoolByFile = @{}
$heavyVitestPerFilePool = 'threads'
if (Test-Path -LiteralPath $LanesConfigPath) {
    $lanesConfig = Get-Content -LiteralPath $LanesConfigPath -Raw | ConvertFrom-Json
    if ($lanesConfig.heavyVitestPerFilePool) {
        $heavyVitestPerFilePool = [string]$lanesConfig.heavyVitestPerFilePool
    }
    if ($lanesConfig.heavyVitestPoolByFile) {
        foreach ($property in $lanesConfig.heavyVitestPoolByFile.PSObject.Properties) {
            $heavyVitestPoolByFile[$property.Name] = [string]$property.Value
        }
    }
}

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
    $partialReports = [System.Collections.Generic.List[string]]::new()
    $ordinal = 0
    $exitCode = 0
    $maxFileAttempts = if ($env:CI -eq 'true') { 5 } else { 1 }

    foreach ($file in $shardPlan.files) {
        $ordinal += 1
        $partialReport = Join-Path $Root ".vitest-runtime-report-heavy-$Shard-part-$ordinal.json"
        $filePassed = $false

        for ($attempt = 1; $attempt -le $maxFileAttempts; $attempt++) {
            if (Test-Path -LiteralPath $partialReport) {
                Remove-Item -LiteralPath $partialReport -Force
            }

            # One Vitest process per file avoids long-lived worker onTaskUpdate RPC timeouts
            # when many subprocess-heavy suites share a single runner invocation (#597/#695).
            # Per-file runs default to threads (vitest.config heavy lane uses forks for legacy
            # bundled invocations only). Per-file pool overrides live in vitest-ci-lanes.config.json.
            $pool = $heavyVitestPerFilePool
            if ($heavyVitestPoolByFile.ContainsKey($file)) {
                $pool = $heavyVitestPoolByFile[$file]
            }
            $vitestArgs = @($file, "--pool=$pool")
            $output = & npm test -- @vitestArgs --reporter=default --reporter=json --outputFile=$partialReport 2>&1
            $text = ($output | Out-String)
            Write-Host $text

            if ($text -match '(?is)onTaskUpdate.*(?:RPC|timeout)|vitest-worker.*onTaskUpdate|STACK_TRACE_ERROR') {
                $cleanReport = & node (Join-Path $Root 'scripts/lib/vitest-json-report.mjs') is-clean $partialReport
                if ($cleanReport -eq '1') {
                    Write-Host "[WARN] Post-success vitest-worker onTaskUpdate shutdown flake suppressed for $file"
                    if (-not (Test-Path -LiteralPath $partialReport)) {
                        Write-Host "[FAIL] Vitest runtime report missing for heavy shard $Shard file $file"
                        exit 1
                    }
                    $filePassed = $true
                    break
                }
                if ($attempt -lt $maxFileAttempts) {
                    Write-Host "[WARN] Vitest worker RPC flake on heavy shard $Shard file $file (attempt $attempt/$maxFileAttempts); retrying..."
                    Start-Sleep -Seconds 5
                    continue
                }
                Write-Host "[FAIL] Vitest worker onTaskUpdate RPC timeout detected on heavy shard $Shard file $file"
                exit 1
            }

            $rpcLog = Join-Path $Root ".vitest-heavy-shard-$Shard-rpc-scan-$ordinal.log"
            try {
                [System.IO.File]::WriteAllText($rpcLog, $text)
                & node $RpcScanScript $rpcLog
                if ($LASTEXITCODE -ne 0) {
                    if ($attempt -lt $maxFileAttempts) {
                        Write-Host "[WARN] Vitest worker RPC scan failed on heavy shard $Shard file $file (attempt $attempt/$maxFileAttempts); retrying..."
                        Start-Sleep -Seconds 5
                        continue
                    }
                    Write-Host "[FAIL] Vitest worker onTaskUpdate RPC timeout detected on heavy shard $Shard file $file"
                    exit 1
                }
            }
            finally {
                if (Test-Path -LiteralPath $rpcLog) {
                    Remove-Item -LiteralPath $rpcLog -Force
                }
            }

            if ($LASTEXITCODE -ne 0) {
                $exitCode = $LASTEXITCODE
                break
            }

            if (-not (Test-Path -LiteralPath $partialReport)) {
                Write-Host "[FAIL] Vitest runtime report missing for heavy shard $Shard file $file"
                exit 1
            }

            $filePassed = $true
            break
        }

        if (-not $filePassed) {
            continue
        }

        $partialReports.Add($partialReport) | Out-Null
    }

    if ($exitCode -ne 0) {
        exit $exitCode
    }

    $mergeArgs = @($MergeScript, $RuntimeReportPath) + [string[]]$partialReports
    & node @mergeArgs
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[FAIL] Vitest JSON report merge failed on heavy shard $Shard"
        exit 1
    }

    foreach ($partialReport in $partialReports) {
        if (Test-Path -LiteralPath $partialReport) {
            Remove-Item -LiteralPath $partialReport -Force
        }
    }

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
