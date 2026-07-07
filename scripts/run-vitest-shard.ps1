#requires -Version 5.1
<#
.SYNOPSIS
  Run one Vitest shard for CI with timing and worker-RPC flake detection (Issue #487).
  Applies per-shard slow-test budget enforcement (Issue #488).
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [int]$Shard,

    [Parameter(Mandatory = $true)]
    [int]$ShardTotal
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$RuntimeReportPath = Join-Path $Root ".vitest-runtime-report-shard-$Shard.json"

if ($Shard -lt 1 -or $Shard -gt $ShardTotal) {
    throw "Shard index must be between 1 and ShardTotal ($ShardTotal); got $Shard"
}

$env:CI = 'true'
. (Join-Path $PSScriptRoot 'lib/Set-OpkVitestHarnessEnv.ps1')
Set-OpkVitestHarnessEnv | Out-Null
$sw = [System.Diagnostics.Stopwatch]::StartNew()

Push-Location $Root
try {
    if (Test-Path -LiteralPath $RuntimeReportPath) {
        Remove-Item -LiteralPath $RuntimeReportPath -Force
    }
    $output = & npm test -- --shard="$Shard/$ShardTotal" --reporter=default --reporter=json --outputFile=$RuntimeReportPath 2>&1
    $exitCode = $LASTEXITCODE
    $text = ($output | Out-String)
    Write-Host $text

    if ($text -match '(?is)onTaskUpdate.*(?:RPC|timeout)|vitest-worker.*onTaskUpdate') {
        Write-Host "[FAIL] Vitest worker onTaskUpdate RPC timeout detected on shard $Shard/$ShardTotal"
        exit 1
    }

    if ($exitCode -ne 0) {
        exit $exitCode
    }

    if (-not (Test-Path -LiteralPath $RuntimeReportPath)) {
        Write-Host "[FAIL] Vitest runtime report missing for shard $Shard/$ShardTotal"
        exit 1
    }

    & node (Join-Path $Root 'scripts/enforce-vitest-runtime-budget.mjs') $RuntimeReportPath
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[FAIL] Vitest runtime budget exceeded on shard $Shard/$ShardTotal"
        exit 1
    }
}
finally {
    Pop-Location
}

$sw.Stop()
$elapsed = [math]::Round($sw.Elapsed.TotalSeconds, 2)
Write-Host "vitest-shard-timing shard=$Shard total=$ShardTotal elapsed_sec=$elapsed"

exit 0
