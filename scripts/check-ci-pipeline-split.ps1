#requires -Version 5.1
<#
.SYNOPSIS
  Static and live guard for Issue #487 CI pipeline split: shard coverage, fail-closed
  aggregate, worker-RPC regression guard, and current head/run binding.
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

$failures = [System.Collections.Generic.List[string]]::new()

function Add-Fail {
    param([string]$Message)
    $failures.Add($Message) | Out-Null
}

function Get-YamlJobs {
    param([string]$Text)
    $jobs = @{}
    if ($Text -notmatch '(?ms)^jobs:\s*\r?\n(?<body>.*)\z') {
        return $jobs
    }
    $body = $Matches['body']
    $lines = $body -split '\r?\n'
    $current = $null
    $buffer = [System.Collections.Generic.List[string]]::new()
    foreach ($line in $lines) {
        if ($line -match '^  ([A-Za-z0-9_-]+):\s*$') {
            if ($current) {
                $jobs[$current] = ($buffer -join "`n")
            }
            $current = $Matches[1]
            $buffer = [System.Collections.Generic.List[string]]::new()
            continue
        }
        if ($current) {
            $buffer.Add($line) | Out-Null
        }
    }
    if ($current) {
        $jobs[$current] = ($buffer -join "`n")
    }
    return $jobs
}

function Get-JobDisplayName {
    param([string]$JobText)
    if ($JobText -match '(?m)^\s*name:\s*(.+)$') {
        return $Matches[1].Trim()
    }
    return ''
}

$configPath = Join-Path $RepoRoot 'scripts/ci-pipeline-split.config.json'
if (-not (Test-Path -LiteralPath $configPath)) {
    Add-Fail 'missing scripts/ci-pipeline-split.config.json'
    $shardCount = 4
    $aggregateJobName = 'Run pack contract tests'
}
else {
    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    $shardCount = [int]$config.vitestShardCount
    $aggregateJobName = [string]$config.aggregateJobName
    $typecheckJobName = [string]$config.typecheckJobName
    $vitestShardJobPrefix = [string]$config.vitestShardJobPrefix
    $pesterJobName = [string]$config.pesterJobName
    if ($shardCount -lt 2) {
        Add-Fail 'ci-pipeline-split.config.json vitestShardCount must be >= 2'
    }
}

$scopeGuardPath = Join-Path $RepoRoot '.github/workflows/scope-guard.yml'
$vitestConfigPath = Join-Path $RepoRoot 'vitest.config.ts'
$aggregateScript = Join-Path $RepoRoot 'scripts/ci-test-aggregate.ps1'
$shardRunnerScript = Join-Path $RepoRoot 'scripts/run-vitest-shard.ps1'
$rollbackDoc = Join-Path $RepoRoot 'docs/ci-pipeline-split.md'

Write-Host '== CI pipeline split guard (Issue #487) =='

if (-not (Test-Path -LiteralPath $aggregateScript)) {
    Add-Fail 'missing scripts/ci-test-aggregate.ps1'
}
if (-not (Test-Path -LiteralPath $shardRunnerScript)) {
    Add-Fail 'missing scripts/run-vitest-shard.ps1'
}
if (-not (Test-Path -LiteralPath $rollbackDoc)) {
    Add-Fail 'missing docs/ci-pipeline-split.md (rollback and timing evidence)'
}

if (Test-Path -LiteralPath $vitestConfigPath) {
    $vitestText = Get-Content -LiteralPath $vitestConfigPath -Raw
    if ($vitestText -notmatch 'fileParallelism:\s*false') {
        Add-Fail 'vitest.config.ts must keep fileParallelism: false in CI to avoid worker-RPC flake'
    }
    if ($vitestText -notmatch 'maxWorkers:\s*1') {
        Add-Fail 'vitest.config.ts must keep maxWorkers: 1 in CI to avoid worker-RPC flake'
    }
}
else {
    Add-Fail 'missing vitest.config.ts'
}

if (-not (Test-Path -LiteralPath $scopeGuardPath)) {
    Add-Fail 'missing .github/workflows/scope-guard.yml'
}
else {
    $scopeText = Get-Content -LiteralPath $scopeGuardPath -Raw
    $jobs = Get-YamlJobs -Text $scopeText

    if ($scopeText -match '(?m)^\s*tests:\s*$' -and $scopeText -match 'test-all\.ps1') {
        Add-Fail 'scope-guard.yml still defines monolithic tests job with test-all.ps1; use sharded pipeline (Issue #487)'
    }

    if (-not $jobs.ContainsKey('test-vitest')) {
        Add-Fail 'scope-guard.yml missing test-vitest matrix job'
    }
    if (-not $jobs.ContainsKey('test-typecheck')) {
        Add-Fail 'scope-guard.yml missing test-typecheck job (fast structural lane)'
    }
    if (-not $jobs.ContainsKey('test-pester')) {
        Add-Fail 'scope-guard.yml missing test-pester job'
    }
    if (-not $jobs.ContainsKey('test-aggregate')) {
        Add-Fail 'scope-guard.yml missing test-aggregate job'
    }

    if ($jobs.ContainsKey('test-vitest')) {
        $vitestJob = $jobs['test-vitest']
        if ($vitestJob -notmatch 'strategy:\s*' -or $vitestJob -notmatch 'matrix:\s*') {
            Add-Fail 'test-vitest job must use a matrix strategy for shards'
        }
        if ($vitestJob -match 'continue-on-error:\s*true') {
            Add-Fail 'test-vitest job must not use continue-on-error: true'
        }
        if ($vitestJob -notmatch 'run-vitest-shard\.ps1') {
            Add-Fail 'test-vitest job must invoke scripts/run-vitest-shard.ps1'
        }
        $matrixMatches = [regex]::Matches($vitestJob, '(?m)^\s*shard:\s*\[([^\]]+)\]')
        if ($matrixMatches.Count -eq 0) {
            Add-Fail 'test-vitest matrix must declare shard indices'
        }
        else {
            $indices = @()
            foreach ($entry in ($matrixMatches[0].Groups[1].Value -split ',')) {
                $trim = $entry.Trim()
                if ($trim -match '^\d+$') {
                    $indices += [int]$trim
                }
            }
            if ($indices.Count -ne $shardCount) {
                Add-Fail "test-vitest matrix shard count ($($indices.Count)) does not match config ($shardCount)"
            }
            $expected = 1..$shardCount
            foreach ($idx in $expected) {
                if ($indices -notcontains $idx) {
                    Add-Fail "test-vitest matrix missing shard index $idx"
                }
            }
        }
        $displayName = Get-JobDisplayName -JobText $vitestJob
        if ($displayName -and $displayName -notmatch [regex]::Escape($vitestShardJobPrefix)) {
            Add-Fail "test-vitest display name must include '$vitestShardJobPrefix'"
        }
    }

    if ($jobs.ContainsKey('test-typecheck')) {
        $typecheckJob = $jobs['test-typecheck']
        if ($typecheckJob -notmatch 'tsc\b.*--noEmit|--noEmit') {
            Add-Fail 'test-typecheck job must run tsc --noEmit'
        }
        $displayName = Get-JobDisplayName -JobText $typecheckJob
        if ($displayName -and $displayName -ne $typecheckJobName) {
            Add-Fail "test-typecheck display name must be '$typecheckJobName'"
        }
    }

    if ($jobs.ContainsKey('test-pester')) {
        $pesterJob = $jobs['test-pester']
        if ($pesterJob -notmatch 'test-all\.ps1.*-SkipNpm|-SkipNpm.*test-all\.ps1') {
            Add-Fail 'test-pester job must run scripts/test-all.ps1 -SkipNpm'
        }
        if ($pesterJob -match 'continue-on-error:\s*true') {
            Add-Fail 'test-pester job must not use continue-on-error: true'
        }
        $displayName = Get-JobDisplayName -JobText $pesterJob
        if ($displayName -and $displayName -ne $pesterJobName) {
            Add-Fail "test-pester display name must be '$pesterJobName'"
        }
    }

    if ($jobs.ContainsKey('test-aggregate')) {
        $aggregateJob = $jobs['test-aggregate']
        if ($aggregateJob -notmatch 'ci-test-aggregate\.ps1') {
            Add-Fail 'test-aggregate job must invoke scripts/ci-test-aggregate.ps1'
        }
        if ($aggregateJob -notmatch 'needs:.*test-vitest' -or $aggregateJob -notmatch 'needs:.*test-typecheck' -or $aggregateJob -notmatch 'needs:.*test-pester') {
            Add-Fail 'test-aggregate job must need test-typecheck, test-vitest, and test-pester'
        }
        if ($aggregateJob -notmatch 'GITHUB_SHA' -or $aggregateJob -notmatch 'GITHUB_RUN_ID') {
            Add-Fail 'test-aggregate job must bind GITHUB_SHA and GITHUB_RUN_ID for current head/run'
        }
        if ($aggregateJob -match 'continue-on-error:\s*true') {
            Add-Fail 'test-aggregate job must not use continue-on-error: true'
        }
        $displayName = Get-JobDisplayName -JobText $aggregateJob
        if ($displayName -and $displayName -ne $aggregateJobName) {
            Add-Fail "test-aggregate display name must remain '$aggregateJobName' (required check migration)"
        }
    }

    if ($scopeText -notmatch 'check-ci-pipeline-split\.ps1') {
        Add-Fail 'scope-guard.yml must invoke scripts/check-ci-pipeline-split.ps1'
    }
}

function Get-VitestListFilesForShard {
    param(
        [int]$Shard,
        [int]$Total,
        [string]$Root
    )
    $vitestBin = Join-Path $Root 'node_modules/.bin/vitest'
    if (-not (Test-Path -LiteralPath $vitestBin)) {
        throw 'node_modules vitest binary missing; run npm ci before live coverage check'
    }
    $prevCi = $env:CI
    $env:CI = 'true'
    try {
        $raw = & $vitestBin list --shard="$Shard/$Total" 2>&1 | Out-String
    }
    finally {
        if ($null -ne $prevCi) { $env:CI = $prevCi } else { Remove-Item Env:CI -ErrorAction SilentlyContinue }
    }
    $files = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($line in ($raw -split '\r?\n')) {
        if ($line -match '^(.+\.test\.ts)\s+>') {
            $rel = $Matches[1].Replace('\', '/')
            [void]$files.Add($rel)
        }
    }
    return $files
}

if (-not $SkipLiveCoverage) {
    $npm = Get-Command npm -ErrorAction SilentlyContinue
    $vitestBin = Join-Path $RepoRoot 'node_modules/.bin/vitest'
    if ($npm -and (Test-Path -LiteralPath $vitestBin)) {
        Write-Host 'Running live Vitest shard coverage equivalence check...'
        $union = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        $duplicates = [System.Collections.Generic.List[string]]::new()
        for ($shard = 1; $shard -le $shardCount; $shard++) {
            $files = Get-VitestListFilesForShard -Shard $shard -Total $shardCount -Root $RepoRoot
            Write-Host "  shard $shard/$shardCount -> $($files.Count) files"
            foreach ($file in $files) {
                if ($union.Contains($file)) {
                    $duplicates.Add($file) | Out-Null
                }
                else {
                    [void]$union.Add($file)
                }
            }
        }

        $serialFiles = Get-VitestListFilesForShard -Shard 1 -Total 1 -Root $RepoRoot
        foreach ($file in $serialFiles) {
            if (-not $union.Contains($file)) {
                Add-Fail "shard union missing serial Vitest file: $file"
            }
        }
        foreach ($file in $union) {
            if (-not $serialFiles.Contains($file)) {
                Add-Fail "shard union has unexpected file not in serial discovery: $file"
            }
        }
        foreach ($dup in $duplicates) {
            Add-Fail "duplicate Vitest file across shards: $dup"
        }
        Write-Host "  serial discovery: $($serialFiles.Count) files; shard union: $($union.Count) files"
    }
    else {
        Write-Host 'Skipping live shard coverage (npm/vitest unavailable)'
    }
}

# Negative aggregate fixture: fail-closed states must not pass
$aggregateScriptPath = Join-Path $RepoRoot 'scripts/ci-test-aggregate.ps1'
$negativeCases = @(
    @{ TypecheckResult = 'failure'; VitestResult = 'success'; PesterResult = 'success'; HeadSha = 'abc'; RunId = '1' },
    @{ TypecheckResult = 'success'; VitestResult = 'failure'; PesterResult = 'success'; HeadSha = 'abc'; RunId = '1' },
    @{ TypecheckResult = 'success'; VitestResult = 'success'; PesterResult = 'cancelled'; HeadSha = 'abc'; RunId = '1' },
    @{ TypecheckResult = 'success'; VitestResult = 'skipped'; PesterResult = 'success'; HeadSha = 'abc'; RunId = '1' },
    @{ TypecheckResult = 'success'; VitestResult = 'success'; PesterResult = 'success'; HeadSha = ''; RunId = '1' }
)
foreach ($case in $negativeCases) {
    & $aggregateScriptPath `
        -TypecheckResult $case.TypecheckResult `
        -VitestResult $case.VitestResult `
        -PesterResult $case.PesterResult `
        -HeadSha $case.HeadSha `
        -RunId $case.RunId 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Add-Fail 'ci-test-aggregate.ps1 must fail closed on red/missing/skipped/cancelled/missing-head cases'
        break
    }
}
& $aggregateScriptPath -TypecheckResult 'success' -VitestResult 'success' -PesterResult 'success' -HeadSha 'abc' -RunId '1' 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Add-Fail 'ci-test-aggregate.ps1 must pass when all upstream lanes are success with head/run binding'
}

if ($failures.Count -gt 0) {
    Write-Host '[FAIL] CI pipeline split guard:'
    foreach ($item in $failures) {
        Write-Host " - $item"
    }
    exit 1
}

Write-Host '[PASS] CI pipeline split shard coverage, aggregate fail-closed, and worker-RPC guard OK.'
exit 0
