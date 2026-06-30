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

$env:CI = 'true'
Remove-Item Env:VITEST_CI_LIGHT_LANE -ErrorAction SilentlyContinue

Push-Location $Root
try {
    $planJson = node -e "
import { buildLanePlan } from './scripts/lib/vitest-ci-lanes.mjs';
const plan = buildLanePlan();
if (!plan.ok) {
  console.error(plan.errors.join('\n'));
  process.exit(1);
}
const shard = plan.heavyShards.find(s => s.shard === $Shard);
if (!shard) {
  console.error('heavy shard $Shard not found (count=' + plan.config.heavyShardCount + ')');
  process.exit(1);
}
console.log(JSON.stringify(shard));
" 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host $planJson
        exit 1
    }

    $shardPlan = $planJson | ConvertFrom-Json
    if ($shardPlan.files.Count -eq 0) {
        Write-Host "[PASS] Vitest heavy shard $Shard: no files assigned"
        exit 0
    }

    if (Test-Path -LiteralPath $RuntimeReportPath) {
        Remove-Item -LiteralPath $RuntimeReportPath -Force
    }

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $fileArgs = @()
    foreach ($file in $shardPlan.files) {
        $fileArgs += $file
    }

    $output = & npm test -- @fileArgs --reporter=default --reporter=json --outputFile=$RuntimeReportPath 2>&1
    $exitCode = $LASTEXITCODE
    $text = ($output | Out-String)
    Write-Host $text

    if ($text -match '(?is)onTaskUpdate.*(?:RPC|timeout)|vitest-worker.*onTaskUpdate|STACK_TRACE_ERROR') {
        Write-Host "[FAIL] Vitest worker onTaskUpdate RPC timeout detected on heavy shard $Shard"
        exit 1
    }

    if ($exitCode -ne 0) {
        exit $exitCode
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
