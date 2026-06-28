#requires -Version 5.1
<#
.SYNOPSIS
  Run one Vitest shard for CI with timing and worker-RPC flake detection (Issue #487).
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

if ($Shard -lt 1 -or $Shard -gt $ShardTotal) {
    throw "Shard index must be between 1 and ShardTotal ($ShardTotal); got $Shard"
}

$env:CI = 'true'
$sw = [System.Diagnostics.Stopwatch]::StartNew()

Push-Location $Root
try {
    $output = & npm test -- --shard="$Shard/$ShardTotal" 2>&1
    $exitCode = $LASTEXITCODE
    $text = ($output | Out-String)
    Write-Host $text

    if ($text -match '(?is)onTaskUpdate.*(?:RPC|timeout)|vitest-worker.*onTaskUpdate') {
        Write-Host "[FAIL] Vitest worker onTaskUpdate RPC timeout detected on shard $Shard/$ShardTotal"
        exit 1
    }
}
finally {
    Pop-Location
}

$sw.Stop()
$elapsed = [math]::Round($sw.Elapsed.TotalSeconds, 2)
Write-Host "vitest-shard-timing shard=$Shard total=$ShardTotal elapsed_sec=$elapsed"

exit $exitCode
