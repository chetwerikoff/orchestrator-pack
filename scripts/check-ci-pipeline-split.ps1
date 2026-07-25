#requires -Version 5.1
<#
.SYNOPSIS
  Validate the surviving Vitest CI topology after the Issue #906 estate cut.

.DESCRIPTION
  The historical pipeline-split core and its runtime-history, wall-clock, and
  supervisor fixture contracts were retired with their owners by Issue #906.
  The protected scope-guard workflow still invokes this stable entrypoint, so it
  now validates the surviving topology through the TypeScript planner itself.
  It also protects the #695 dynamic-matrix contract on the #691 runtime-history
  refresh path so that producer fan-out cannot drift back to a hand-maintained
  shard list.
#>
[CmdletBinding()]
param(
    [string]$RepoRoot = '',
    [switch]$SkipLiveCoverage
)

$ErrorActionPreference = 'Stop'
if (-not $RepoRoot) {
    $RepoRoot = Split-Path -Parent $PSScriptRoot
}
$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
$planner = Join-Path $RepoRoot 'scripts/emit-vitest-heavy-topology.mjs'
$config = Join-Path $RepoRoot 'scripts/vitest-ci-lanes.config.json'
$refreshWorkflow = Join-Path $RepoRoot '.github/workflows/vitest-runtime-history-refresh.yml'

foreach ($required in @($planner, $config, $refreshWorkflow)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "missing surviving CI topology prerequisite: $required"
    }
}

$refreshText = Get-Content -LiteralPath $refreshWorkflow -Raw
$requiredRefreshFragments = @(
    'plan-vitest-ci-topology:',
    'heavy_shard_count: ${{ steps.plan.outputs.heavy_shard_count }}',
    'heavy_shard_matrix: ${{ steps.plan.outputs.heavy_shard_matrix }}',
    'node scripts/emit-vitest-heavy-topology.mjs --gha-output --skip-oversized-guard',
    'name: Vitest heavy shard ${{ matrix.shard }}/${{ needs.plan-vitest-ci-topology.outputs.heavy_shard_count }}',
    'shard: ${{ fromJson(needs.plan-vitest-ci-topology.outputs.heavy_shard_matrix) }}',
    'OPK_VITEST_TOPOLOGY_PLAN_PATH: ${{ github.workspace }}/scripts/vitest-heavy-topology.plan.json',
    'needs: [plan-vitest-ci-topology, test-vitest-heavy]',
    'for ($shard = 1; $shard -le $shardCount; $shard++)'
)
foreach ($fragment in $requiredRefreshFragments) {
    if (-not $refreshText.Contains($fragment)) {
        throw "runtime-history refresh lost #695 dynamic topology binding: missing '$fragment'"
    }
}

$heavyJobMatch = [regex]::Match(
    $refreshText,
    '(?ms)^  test-vitest-heavy:\r?\n(?<body>.*?)(?=^  refresh-runtime-history:)'
)
$heavyCheckoutPattern = '(?ms)^      - name: Checkout\r?\n        uses: actions/checkout@v4\r?\n        with:\r?\n          fetch-depth: 0(?:\r?\n|$)'
if (-not $heavyJobMatch.Success -or $heavyJobMatch.Groups['body'].Value -notmatch $heavyCheckoutPattern) {
    throw 'runtime-history heavy shards must use fetch-depth: 0 because the heavy lane contains history-sensitive Git proofs'
}

if ($refreshText -match 'shard:\s*\[\s*1\s*,\s*2\s*,\s*3\s*,\s*4\s*,\s*5\s*,\s*6\s*,\s*7\s*\]') {
    throw 'runtime-history refresh must not restore a fixed 1..7 heavy shard matrix; consume the plan-derived matrix'
}
if ($refreshText.Contains('for ($shard = 1; $shard -le 7; $shard++)')) {
    throw 'runtime-history refresh must stage the plan-derived heavy shard count, not a fixed 7-report set'
}

$previousOutput = $env:GITHUB_OUTPUT
$outputFile = New-TemporaryFile
try {
    $env:GITHUB_OUTPUT = $outputFile.FullName
    Push-Location $RepoRoot
    try {
        & node $planner --gha-output --skip-oversized-guard
    }
    finally {
        Pop-Location
    }
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}
finally {
    if ($null -eq $previousOutput) {
        Remove-Item Env:GITHUB_OUTPUT -ErrorAction SilentlyContinue
    }
    else {
        $env:GITHUB_OUTPUT = $previousOutput
    }
    Remove-Item -LiteralPath $outputFile.FullName -Force -ErrorAction SilentlyContinue
}

Write-Host 'CI pipeline split compatibility guard passed (Issue #906 surviving topology; #695/#982 dynamic matrix; #984 full-depth runtime-history heavy checkout).'
exit 0
