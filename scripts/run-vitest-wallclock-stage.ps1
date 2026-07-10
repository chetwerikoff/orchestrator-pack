#requires -Version 5.1
<#
.SYNOPSIS
  Run post-merge wall-clock Vitest acceptance files serially (Issue #694).
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$RuntimeReportPath = Join-Path $Root '.vitest-runtime-report-wallclock.json'
$PlanScript = Join-Path $Root 'scripts/invoke-vitest-ci-lane-plan.mjs'
$FileRunPlanScript = Join-Path $Root 'scripts/resolve-vitest-heavy-file-run-plan.mjs'

$env:CI = 'true'
$env:OPK_TESTMODE_FLEET_WORKSPACE_ROOT = $Root
Remove-Item Env:VITEST_CI_LIGHT_LANE -ErrorAction SilentlyContinue
. (Join-Path $PSScriptRoot 'lib/Set-OpkVitestHarnessEnv.ps1')
Set-OpkVitestHarnessEnv | Out-Null

Push-Location $Root
try {
    $planJson = & node $PlanScript wallclock 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host $planJson
        exit 1
    }

    $plan = $planJson | ConvertFrom-Json
    if ($plan.files.Count -eq 0) {
        Write-Host '[FAIL] Vitest wall-clock stage: no postMergeWallclock files configured'
        exit 1
    }

    if (Test-Path -LiteralPath $RuntimeReportPath) {
        Remove-Item -LiteralPath $RuntimeReportPath -Force
    }

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $failedExitCode = 0

    foreach ($file in $plan.files) {
        $filePlanJson = & node $FileRunPlanScript $file 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Host $filePlanJson
            exit 1
        }
        $runPlan = $filePlanJson | ConvertFrom-Json
        $pool = [string]$runPlan.pool
        $invocations = @(@{ label = $file; testPattern = $null })
        if ($runPlan.mode -eq 'tests') {
            $invocations = @()
            foreach ($testTitle in @($runPlan.tests)) {
                $invocations += @{ label = "$file > $testTitle"; testPattern = [string]$testTitle }
            }
        }

        foreach ($invocation in $invocations) {
            $testArgs = @()
            if ($invocation.testPattern) {
                $testArgs += '-t'
                $testArgs += $invocation.testPattern
            }
            $testArgs += $file
            $testArgs += '--pool'
            $testArgs += $pool

            $output = & npm test -- @testArgs 2>&1
            $exitCode = $LASTEXITCODE
            $text = ($output | Out-String)
            Write-Host $text

            if ($text -match '(?is)onTaskUpdate.*(?:RPC|timeout)|vitest-worker.*onTaskUpdate|STACK_TRACE_ERROR') {
                Write-Host "[FAIL] Vitest worker RPC flake signature detected in wall-clock file $($invocation.label)"
                $failedExitCode = 1
                break
            }

            if ($exitCode -ne 0) {
                $failedExitCode = $exitCode
                break
            }
        }

        if ($failedExitCode -ne 0) {
            break
        }
    }

    if ($failedExitCode -ne 0) {
        exit $failedExitCode
    }

    $sw.Stop()
    $elapsed = [math]::Round($sw.Elapsed.TotalSeconds, 2)
    Write-Host "vitest-lane-timing lane=wallclock files=$($plan.files.Count) elapsed_sec=$elapsed"
}
finally {
    Pop-Location
}

exit 0
