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
    $partialReports = [System.Collections.Generic.List[string]]::new()
    $failedExitCode = 0
    $maxFileAttempts = if ($env:CI -eq 'true') { 5 } else { 1 }

    try {
        foreach ($file in $shardPlan.files) {
            $safeName = ($file -replace '[^\w.\-]+', '_')
            $partialReportPath = Join-Path $Root ".vitest-runtime-report-heavy-$Shard-$safeName.json"
            $filePassed = $false

            for ($attempt = 1; $attempt -le $maxFileAttempts; $attempt++) {
                if (Test-Path -LiteralPath $partialReportPath) {
                    Remove-Item -LiteralPath $partialReportPath -Force
                }

                # Run one heavy file per Vitest invocation so long shard suites do not
                # starve vitest-worker onTaskUpdate RPC (#487/#556; shard 6 flake class).
                # Pool comes from vitest.config.ts (forks, serial heavy lane) — do not
                # override with --pool=threads; that pool class reintroduces RPC timeouts.
                $output = & npm test -- $file --reporter=default --reporter=json --outputFile=$partialReportPath 2>&1
                $text = ($output | Out-String)
                Write-Host $text

                if ($text -match '(?is)onTaskUpdate.*(?:RPC|timeout)|vitest-worker.*onTaskUpdate|STACK_TRACE_ERROR') {
                    if ($attempt -lt $maxFileAttempts) {
                        Write-Host "[WARN] Vitest worker RPC flake on heavy shard $Shard file $file (attempt $attempt/$maxFileAttempts); retrying..."
                        Start-Sleep -Seconds 5
                        continue
                    }
                    Write-Host "[FAIL] Vitest worker onTaskUpdate RPC timeout detected on heavy shard $Shard (file: $file)"
                    exit 1
                }

                if ($LASTEXITCODE -ne 0) {
                    $failedExitCode = $LASTEXITCODE
                    break
                }

                if (-not (Test-Path -LiteralPath $partialReportPath)) {
                    Write-Host "[FAIL] Vitest runtime report missing for heavy shard $Shard file $file"
                    exit 1
                }

                $filePassed = $true
                break
            }

            if (-not $filePassed) {
                continue
            }

            $partialReports.Add($partialReportPath) | Out-Null
        }

        if ($failedExitCode -ne 0) {
            exit $failedExitCode
        }

        $mergeArgs = @(
            (Join-Path $Root 'scripts/lib/vitest-json-report.mjs'),
            'merge',
            '--output',
            $RuntimeReportPath
        ) + $partialReports
        & node @mergeArgs
        if ($LASTEXITCODE -ne 0) {
            Write-Host "[FAIL] Vitest heavy shard $Shard failed to merge per-file JSON reports"
            exit 1
        }
    }
    finally {
        foreach ($partialReportPath in $partialReports) {
            if (Test-Path -LiteralPath $partialReportPath) {
                Remove-Item -LiteralPath $partialReportPath -Force -ErrorAction SilentlyContinue
            }
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
