#requires -Version 5.1
<#
.SYNOPSIS
  Static and live guard for Issue #487/#556 CI pipeline split: lane classification,
  runtime-weighted heavy shards, bounded light parallelism, fail-closed aggregate,
  worker-RPC regression guard, and current head/run binding.
#>
[CmdletBinding()]
param(
    [string]$RepoRoot = '',
    [switch]$SkipLiveCoverage
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/ci-workflow-yaml.ps1')
if (-not $RepoRoot) {
    $RepoRoot = Split-Path -Parent $PSScriptRoot
}
$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path

$failures = [System.Collections.Generic.List[string]]::new()

function Add-Fail {
    param([string]$Message)
    $failures.Add($Message) | Out-Null
}

$configPath = Join-Path $RepoRoot 'scripts/ci-pipeline-split.config.json'
$lanesConfigPath = Join-Path $RepoRoot 'scripts/vitest-ci-lanes.config.json'
$runtimeHistoryPath = Join-Path $RepoRoot 'scripts/vitest-runtime-history.json'
$lanesLib = Join-Path $RepoRoot 'scripts/lib/vitest-ci-lanes.mjs'
$budgetConfigPath = Join-Path $RepoRoot 'scripts/test-runtime-budget.config.json'

if (-not (Test-Path -LiteralPath $configPath)) {
    Add-Fail 'missing scripts/ci-pipeline-split.config.json'
    $heavyShardCount = 7
    $aggregateJobName = 'Run pack contract tests'
    $lightLaneJobName = 'Vitest light lane'
    $heavyShardJobPrefix = 'Vitest heavy shard'
    $typecheckJobName = 'Type-check pack sources'
    $pesterJobName = 'Pester regression'
}
else {
    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    $heavyShardCount = [int]$config.heavyShardCount
    $aggregateJobName = [string]$config.aggregateJobName
    $lightLaneJobName = [string]$config.lightLaneJobName
    $heavyShardJobPrefix = [string]$config.heavyShardJobPrefix
    $typecheckJobName = [string]$config.typecheckJobName
    $pesterJobName = [string]$config.pesterJobName
    if ($heavyShardCount -lt 1) {
        Add-Fail 'ci-pipeline-split.config.json heavyShardCount must be >= 1'
    }
}

$scopeGuardPath = Join-Path $RepoRoot '.github/workflows/scope-guard.yml'
$vitestConfigPath = Join-Path $RepoRoot 'vitest.config.ts'
$aggregateScript = Join-Path $RepoRoot 'scripts/ci-test-aggregate.ps1'
$lightLaneScript = Join-Path $RepoRoot 'scripts/run-vitest-light-lane.ps1'
$heavyShardScript = Join-Path $RepoRoot 'scripts/run-vitest-heavy-shard.ps1'
$rollbackDoc = Join-Path $RepoRoot 'docs/ci-pipeline-split.md'

Write-Host '== CI pipeline split guard (Issues #487/#556) =='

foreach ($required in @($aggregateScript, $lightLaneScript, $heavyShardScript, $lanesConfigPath, $runtimeHistoryPath, $lanesLib, $rollbackDoc)) {
    if (-not (Test-Path -LiteralPath $required)) {
        Add-Fail "missing required artifact: $(Split-Path -Leaf $required)"
    }
}

if (Test-Path -LiteralPath $vitestConfigPath) {
    $vitestText = Get-Content -LiteralPath $vitestConfigPath -Raw
    if ($vitestText -notmatch 'VITEST_CI_LIGHT_LANE') {
        Add-Fail 'vitest.config.ts must gate bounded parallelism on VITEST_CI_LIGHT_LANE'
    }
    if ($vitestText -notmatch 'fileParallelism:\s*false') {
        Add-Fail 'vitest.config.ts must keep serial fileParallelism for non-light CI lanes'
    }
    if ($vitestText -notmatch 'maxWorkers:\s*1') {
        Add-Fail 'vitest.config.ts must keep maxWorkers: 1 for non-light CI lanes'
    }
    if ($vitestText -notmatch 'fileParallelism:\s*true') {
        Add-Fail 'vitest.config.ts must allow fileParallelism: true for the light lane'
    }
}
else {
    Add-Fail 'missing vitest.config.ts'
}

if ((Test-Path -LiteralPath $budgetConfigPath) -and (Test-Path -LiteralPath $vitestConfigPath)) {
    $budget = Get-Content -LiteralPath $budgetConfigPath -Raw | ConvertFrom-Json
    $perTestMs = [int]$budget.perTestMs
    $vitestText = Get-Content -LiteralPath $vitestConfigPath -Raw
    if ($vitestText -match 'testTimeout:\s*ci\s*\?\s*([\d_]+)') {
        $ciTimeout = [int]($Matches[1] -replace '_', '')
        if ($ciTimeout -lt $perTestMs) {
            Add-Fail "vitest.config.ts CI testTimeout ($ciTimeout ms) is below slow-test budget perTestMs ($perTestMs ms)"
        }
    }
    else {
        Add-Fail 'vitest.config.ts must declare CI testTimeout aligned with slow-test budget'
    }
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

    if (-not $jobs.ContainsKey('test-vitest-light')) {
        Add-Fail 'scope-guard.yml missing test-vitest-light job'
    }
    if (-not $jobs.ContainsKey('test-vitest-heavy')) {
        Add-Fail 'scope-guard.yml missing test-vitest-heavy matrix job'
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

    if ($jobs.ContainsKey('test-vitest-light')) {
        $lightJob = $jobs['test-vitest-light']
        if ($lightJob -notmatch 'run-vitest-light-lane\.ps1') {
            Add-Fail 'test-vitest-light job must invoke scripts/run-vitest-light-lane.ps1'
        }
        if ($lightJob -match 'continue-on-error:\s*true') {
            Add-Fail 'test-vitest-light job must not use continue-on-error: true'
        }
        $displayName = Get-JobDisplayName -JobText $lightJob
        if ($displayName -and $displayName -ne $lightLaneJobName) {
            Add-Fail "test-vitest-light display name must be '$lightLaneJobName'"
        }
    }

    if ($jobs.ContainsKey('test-vitest-heavy')) {
        $heavyJob = $jobs['test-vitest-heavy']
        if ($heavyJob -notmatch 'strategy:\s*' -or $heavyJob -notmatch 'matrix:\s*') {
            Add-Fail 'test-vitest-heavy job must use a matrix strategy for shards'
        }
        if ($heavyJob -match 'continue-on-error:\s*true') {
            Add-Fail 'test-vitest-heavy job must not use continue-on-error: true'
        }
        if ($heavyJob -notmatch 'run-vitest-heavy-shard\.ps1') {
            Add-Fail 'test-vitest-heavy job must invoke scripts/run-vitest-heavy-shard.ps1'
        }
        $matrixMatches = [regex]::Matches($heavyJob, '(?m)^\s*shard:\s*\[([^\]]+)\]')
        if ($matrixMatches.Count -eq 0) {
            Add-Fail 'test-vitest-heavy matrix must declare shard indices'
        }
        else {
            $indices = @()
            foreach ($entry in ($matrixMatches[0].Groups[1].Value -split ',')) {
                $trim = $entry.Trim()
                if ($trim -match '^\d+$') {
                    $indices += [int]$trim
                }
            }
            if ($indices.Count -ne $heavyShardCount) {
                Add-Fail "test-vitest-heavy matrix shard count ($($indices.Count)) does not match config ($heavyShardCount)"
            }
            $expected = 1..$heavyShardCount
            foreach ($idx in $expected) {
                if ($indices -notcontains $idx) {
                    Add-Fail "test-vitest-heavy matrix missing shard index $idx"
                }
            }
        }
        $displayName = Get-JobDisplayName -JobText $heavyJob
        if ($displayName -and $displayName -notmatch [regex]::Escape($heavyShardJobPrefix)) {
            Add-Fail "test-vitest-heavy display name must include '$heavyShardJobPrefix'"
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
        if ($aggregateJob -notmatch 'needs:.*test-vitest-light' -or $aggregateJob -notmatch 'needs:.*test-vitest-heavy' -or $aggregateJob -notmatch 'needs:.*test-typecheck' -or $aggregateJob -notmatch 'needs:.*test-pester') {
            Add-Fail 'test-aggregate job must need test-typecheck, test-vitest-light, test-vitest-heavy, and test-pester'
        }
        if ($aggregateJob -notmatch 'VITEST_LIGHT_RESULT' -or $aggregateJob -notmatch 'VITEST_HEAVY_RESULT') {
            Add-Fail 'test-aggregate job must bind VITEST_LIGHT_RESULT and VITEST_HEAVY_RESULT'
        }
        if ($aggregateJob -notmatch 'GITHUB_SHA' -or $aggregateJob -notmatch 'GITHUB_RUN_ID') {
            Add-Fail 'test-aggregate job must bind GITHUB_SHA and GITHUB_RUN_ID for current head/run'
        }
        if ($aggregateJob -match 'continue-on-error:\s*true') {
            Add-Fail 'test-aggregate job must not use continue-on-error: true'
        }
        if ($aggregateJob -match '!cancelled\(\)') {
            Add-Fail 'test-aggregate job must not gate on !cancelled(); run under always() so cancelled upstream lanes fail closed'
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

function Invoke-LanePlan {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) {
        throw 'node is required for lane plan validation'
    }
    $raw = & node -e "
import { buildLanePlan } from './scripts/lib/vitest-ci-lanes.mjs';
const plan = buildLanePlan('$($RepoRoot.Replace('\', '/'))');
console.log(JSON.stringify(plan));
" 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
        throw $raw
    }
    return $raw | ConvertFrom-Json
}

if ((Test-Path -LiteralPath $lanesLib) -and (Get-Command node -ErrorAction SilentlyContinue)) {
    try {
        $plan = Invoke-LanePlan
        if (-not $plan.ok) {
            foreach ($err in $plan.errors) {
                Add-Fail $err
            }
        }
        else {
            Write-Host "  discovered: $($plan.discovered.Count) files; light: $($plan.light.Count); heavy: $($plan.heavy.Count)"
            $union = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
            $duplicates = [System.Collections.Generic.List[string]]::new()
            foreach ($file in $plan.light) {
                if ($union.Contains($file)) { $duplicates.Add($file) | Out-Null } else { [void]$union.Add($file) }
            }
            foreach ($shard in $plan.heavyShards) {
                foreach ($file in $shard.files) {
                    if ($union.Contains($file)) {
                        $duplicates.Add($file) | Out-Null
                    }
                    else {
                        [void]$union.Add($file)
                    }
                }
            }
            foreach ($file in $plan.discovered) {
                if (-not $union.Contains($file)) {
                    Add-Fail "lane union missing discovered Vitest file: $file"
                }
            }
            foreach ($file in $union) {
                if ($plan.discovered -notcontains $file) {
                    Add-Fail "lane union has unexpected file not in discovery: $file"
                }
            }
            foreach ($dup in $duplicates) {
                Add-Fail "duplicate Vitest file across lanes/shards: $dup"
            }
            if ($plan.heavyShards.Count -ne $heavyShardCount) {
                Add-Fail "heavy shard assignment count ($($plan.heavyShards.Count)) does not match config ($heavyShardCount)"
            }

            # Negative fixture: heavy file cannot be classified light without review.
            $negativeHeavy = 'scripts/orchestrator-wake-supervisor.test.ts'
            if ($plan.config.classification.$negativeHeavy -eq 'light') {
                Add-Fail "negative fixture: $negativeHeavy must not be classified light"
            }

            # Negative fixture: synthetic unclassified file must fail plan validation.
            $syntheticPlan = & node -e "
import { discoverVitestFiles, validateClassification, loadLanesConfig } from './scripts/lib/vitest-ci-lanes.mjs';
const root = '$($RepoRoot.Replace('\', '/'))';
const config = loadLanesConfig(root);
const discovered = [...discoverVitestFiles(root), 'scripts/__classification_required_fixture__.test.ts'];
const errors = validateClassification(discovered, config.classification);
console.log(errors.join('\n'));
process.exit(errors.length > 0 ? 0 : 1);
" 2>&1 | Out-String
            if ($LASTEXITCODE -ne 0) {
                Add-Fail 'negative fixture: unclassified test file must fail classification-required gate'
            }
        }
    }
    catch {
        Add-Fail "lane plan validation failed: $_"
    }
}
elseif (-not $SkipLiveCoverage) {
    Write-Host 'Skipping live lane coverage (node/lanes lib unavailable)'
}

# Negative aggregate fixture: fail-closed states must not pass
$aggregateScriptPath = Join-Path $RepoRoot 'scripts/ci-test-aggregate.ps1'
$negativeCases = @(
    @{ TypecheckResult = 'failure'; VitestLightResult = 'success'; VitestHeavyResult = 'success'; PesterResult = 'success'; HeadSha = 'abc'; RunId = '1' },
    @{ TypecheckResult = 'success'; VitestLightResult = 'failure'; VitestHeavyResult = 'success'; PesterResult = 'success'; HeadSha = 'abc'; RunId = '1' },
    @{ TypecheckResult = 'success'; VitestLightResult = 'success'; VitestHeavyResult = 'cancelled'; PesterResult = 'success'; HeadSha = 'abc'; RunId = '1' },
    @{ TypecheckResult = 'success'; VitestLightResult = 'skipped'; VitestHeavyResult = 'success'; PesterResult = 'success'; HeadSha = 'abc'; RunId = '1' },
    @{ TypecheckResult = 'success'; VitestLightResult = 'success'; VitestHeavyResult = 'success'; PesterResult = 'success'; HeadSha = ''; RunId = '1' }
)
foreach ($case in $negativeCases) {
    & $aggregateScriptPath `
        -TypecheckResult $case.TypecheckResult `
        -VitestLightResult $case.VitestLightResult `
        -VitestHeavyResult $case.VitestHeavyResult `
        -PesterResult $case.PesterResult `
        -HeadSha $case.HeadSha `
        -RunId $case.RunId 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Add-Fail 'ci-test-aggregate.ps1 must fail closed on red/missing/skipped/cancelled/missing-head cases'
        break
    }
}
& $aggregateScriptPath -TypecheckResult 'success' -VitestLightResult 'success' -VitestHeavyResult 'success' -PesterResult 'success' -HeadSha 'abc' -RunId '1' 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Add-Fail 'ci-test-aggregate.ps1 must pass when all upstream lanes are success with head/run binding'
}

Write-Host '[PASS] CI pipeline split lane classification, weighted heavy shards, aggregate fail-closed, and worker-RPC guard OK.'

# Issue #691 — runtime-history refresh producer guards
Write-Host '== CI runtime-history refresh guard (Issue #691) =='

$refreshMergeFixture = Join-Path $RepoRoot 'scripts/lib/vitest-runtime-history-merge.fixture.mjs'
$refreshWorkflowPath = Join-Path $RepoRoot '.github/workflows/vitest-runtime-history-refresh.yml'
$refreshScriptPath = Join-Path $RepoRoot 'scripts/refresh-vitest-runtime-history.mjs'

foreach ($required in @($refreshMergeFixture, $refreshWorkflowPath, $refreshScriptPath)) {
    if (-not (Test-Path -LiteralPath $required)) {
        Add-Fail "missing runtime-history refresh artifact: $(Split-Path -Leaf $required)"
    }
}

if (Test-Path -LiteralPath $refreshMergeFixture) {
    $fixtureOutput = & node $refreshMergeFixture 2>&1 | Out-String
    Write-Host $fixtureOutput
    if ($LASTEXITCODE -ne 0) {
        Add-Fail 'runtime-history refresh fixture suite failed'
    }
}

if (Test-Path -LiteralPath $refreshWorkflowPath) {
    $refreshText = Get-Content -LiteralPath $refreshWorkflowPath -Raw
    if ($refreshText -match '(?m)^on:\s*[\s\S]*pull_request:') {
        Add-Fail 'vitest-runtime-history-refresh.yml must not trigger on pull_request'
    }
    if ($refreshText -notmatch '(?m)^\s*push:\s*' -or $refreshText -notmatch 'branches:\s*[\s\S]*main') {
        Add-Fail 'vitest-runtime-history-refresh.yml must trigger on push to main'
    }
    if ($refreshText -notmatch 'schedule:') {
        Add-Fail 'vitest-runtime-history-refresh.yml must declare a schedule trigger'
    }
    if ($refreshText -notmatch 'workflow_dispatch:') {
        Add-Fail 'vitest-runtime-history-refresh.yml must declare workflow_dispatch'
    }
    if ($refreshText -notmatch 'concurrency:') {
        Add-Fail 'vitest-runtime-history-refresh.yml must declare a concurrency guard'
    }

    $refreshJobs = Get-YamlJobs -Text $refreshText
    if (-not $refreshJobs.ContainsKey('test-vitest-heavy')) {
        Add-Fail 'vitest-runtime-history-refresh.yml missing test-vitest-heavy job'
    }
    if (-not $refreshJobs.ContainsKey('refresh-runtime-history')) {
        Add-Fail 'vitest-runtime-history-refresh.yml missing refresh-runtime-history job'
    }
    if ($refreshJobs.ContainsKey('refresh-runtime-history')) {
        $refreshJob = $refreshJobs['refresh-runtime-history']
        if ($refreshJob -notmatch 'needs:.*test-vitest-heavy') {
            Add-Fail 'refresh-runtime-history job must need test-vitest-heavy'
        }
        if ($refreshJob -notmatch 'download-artifact@v4' -or $refreshJob -notmatch 'vitest-heavy-report') {
            Add-Fail 'refresh-runtime-history job must download heavy-shard JSON artifacts'
        }
        if ($refreshJob -notmatch 'refresh-vitest-runtime-history\.ps1') {
            Add-Fail 'refresh-runtime-history job must invoke scripts/refresh-vitest-runtime-history.ps1'
        }
    }
    if ($refreshJobs.ContainsKey('test-vitest-heavy')) {
        $heavyRefreshJob = $refreshJobs['test-vitest-heavy']
        if ($heavyRefreshJob -notmatch 'upload-artifact@v4' -or $heavyRefreshJob -notmatch 'vitest-heavy-report') {
            Add-Fail 'test-vitest-heavy refresh workflow job must upload heavy shard runtime reports'
        }
        if ($heavyRefreshJob -notmatch 'run-vitest-heavy-shard\.ps1') {
            Add-Fail 'test-vitest-heavy refresh workflow job must invoke run-vitest-heavy-shard.ps1'
        }
    }
}

if ($failures.Count -gt 0) {
    Write-Host '[FAIL] CI pipeline split guard:'
    foreach ($item in $failures) {
        Write-Host " - $item"
    }
    exit 1
}

Write-Host '[PASS] CI runtime-history refresh producer guards OK.'
exit 0
