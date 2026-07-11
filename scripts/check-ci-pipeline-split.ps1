#requires -Version 5.1
<#
.SYNOPSIS
  Static and live guard for Issue #487/#556/#695 CI pipeline split: lane classification,
  weight-derived heavy shards, bounded light parallelism, oversized-file floor guard,
  fail-closed aggregate, worker-RPC regression guard, and current head/run binding.
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
$topologyLib = Join-Path $RepoRoot 'scripts/lib/vitest-heavy-topology.mjs'
$topologyEmitScript = Join-Path $RepoRoot 'scripts/emit-vitest-heavy-topology.mjs'
$budgetConfigPath = Join-Path $RepoRoot 'scripts/test-runtime-budget.config.json'

if (-not (Test-Path -LiteralPath $configPath)) {
    Add-Fail 'missing scripts/ci-pipeline-split.config.json'
    $fallbackHeavyShardCount = 7
    $aggregateJobName = 'Run pack contract tests'
    $lightLaneJobName = 'Vitest light lane'
    $heavyShardJobPrefix = 'Vitest heavy shard'
    $typecheckJobName = 'Type-check pack sources'
    $pesterJobName = 'Pester regression'
}
else {
    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    $fallbackHeavyShardCount = [int]($config.fallbackHeavyShardCount ?? $config.heavyShardCount)
    $aggregateJobName = [string]$config.aggregateJobName
    $lightLaneJobName = [string]$config.lightLaneJobName
    $heavyShardJobPrefix = [string]$config.heavyShardJobPrefix
    $typecheckJobName = [string]$config.typecheckJobName
    $pesterJobName = [string]$config.pesterJobName
    if ($fallbackHeavyShardCount -lt 1) {
        Add-Fail 'ci-pipeline-split.config.json fallbackHeavyShardCount must be >= 1'
    }
}

$scopeGuardPath = Join-Path $RepoRoot '.github/workflows/scope-guard.yml'
$vitestConfigPath = Join-Path $RepoRoot 'vitest.config.ts'
$aggregateScript = Join-Path $RepoRoot 'scripts/ci-test-aggregate.ps1'
$lightLaneScript = Join-Path $RepoRoot 'scripts/run-vitest-light-lane.ps1'
$heavyShardScript = Join-Path $RepoRoot 'scripts/run-vitest-heavy-shard.ps1'
$rollbackDoc = Join-Path $RepoRoot 'docs/ci-pipeline-split.md'
$prScopeScenarioScript = Join-Path $RepoRoot 'scripts/check-vitest-pr-scope-scenarios.mjs'

Write-Host '== CI pipeline split guard (Issues #487/#556/#695) =='

foreach ($required in @($aggregateScript, $lightLaneScript, $heavyShardScript, $lanesConfigPath, $runtimeHistoryPath, $lanesLib, $topologyLib, $topologyEmitScript, $rollbackDoc, $prScopeScenarioScript)) {
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

    if (-not $jobs.ContainsKey('plan-vitest-ci-topology')) {
        Add-Fail 'scope-guard.yml missing plan-vitest-ci-topology job (Issue #695 derived heavy matrix)'
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

    if ($jobs.ContainsKey('plan-vitest-ci-topology')) {
        $planJob = $jobs['plan-vitest-ci-topology']
        if ($planJob -notmatch 'emit-vitest-heavy-topology\.mjs') {
            Add-Fail 'plan-vitest-ci-topology job must invoke scripts/emit-vitest-heavy-topology.mjs'
        }
        if ($planJob -notmatch 'emit-pr-changed-paths-manifest\.mjs') {
            Add-Fail 'plan-vitest-ci-topology job must emit the widened changed-path manifest exactly once'
        }
        if ($planJob -match "git diff .*'\*\.test\.ts'") {
            Add-Fail 'plan-vitest-ci-topology must not retain a test-only git diff export'
        }
        if ($planJob -notmatch 'OPK_VITEST_PR_SCOPE_MODE') {
            Add-Fail 'plan-vitest-ci-topology job must bind OPK_VITEST_PR_SCOPE_MODE for shadow-mode kill-switch control'
        }
        if ($planJob -notmatch 'heavy_shard_count') {
            Add-Fail 'plan-vitest-ci-topology job must expose heavy_shard_count output'
        }
        if ($planJob -notmatch 'heavy_shard_matrix') {
            Add-Fail 'plan-vitest-ci-topology job must expose heavy_shard_matrix output'
        }
        if ($planJob -notmatch 'vitest-heavy-topology') {
            Add-Fail 'plan-vitest-ci-topology job must upload vitest-heavy-topology artifact'
        }
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
        if ($heavyJob -notmatch 'plan-vitest-ci-topology') {
            Add-Fail 'test-vitest-heavy job must need plan-vitest-ci-topology for derived matrix'
        }
        if ($heavyJob -notmatch 'download-artifact@v4' -or $heavyJob -notmatch 'vitest-heavy-topology') {
            Add-Fail 'test-vitest-heavy job must download the saved heavy topology artifact before execution'
        }
        if ($heavyJob -notmatch 'OPK_VITEST_TOPOLOGY_PLAN_PATH') {
            Add-Fail 'test-vitest-heavy job must point shard execution at the saved topology plan artifact'
        }
        if ($heavyJob -match 'shard:\s*\[1,\s*2,\s*3') {
            Add-Fail 'test-vitest-heavy matrix must be derived from plan output, not hand-listed shard indices'
        }
        if ($heavyJob -notmatch 'fromJson\(needs\.plan-vitest-ci-topology\.outputs\.heavy_shard_matrix\)') {
            Add-Fail 'test-vitest-heavy matrix must consume needs.plan-vitest-ci-topology.outputs.heavy_shard_matrix'
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
        if ($aggregateJob -notmatch 'plan-vitest-ci-topology') {
            Add-Fail 'test-aggregate job must need plan-vitest-ci-topology (Issue #695)'
        }
        if ($aggregateJob -notmatch 'VITEST_LIGHT_RESULT' -or $aggregateJob -notmatch 'VITEST_HEAVY_RESULT') {
            Add-Fail 'test-aggregate job must bind VITEST_LIGHT_RESULT and VITEST_HEAVY_RESULT'
        }
        if ($aggregateJob -notmatch 'VITEST_TOPOLOGY_PLAN_RESULT') {
            Add-Fail 'test-aggregate job must bind VITEST_TOPOLOGY_PLAN_RESULT (Issue #695)'
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

function Invoke-HeavyTopology {
    param([string[]]$ChangedFiles = @())
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) {
        throw 'node is required for heavy topology validation'
    }
    $changedJson = if ($ChangedFiles.Count -eq 0) { '[]' } else { ($ChangedFiles | ConvertTo-Json -Compress) }
    $raw = & node -e "
import { buildHeavyTopology, formatOversizedGuardFailures } from './scripts/lib/vitest-heavy-topology.mjs';
const changedFiles = $changedJson;
const result = buildHeavyTopology('$($RepoRoot.Replace('\', '/'))', { changedFiles });
if (!result.ok) {
  console.log(JSON.stringify({ ok: false, errors: result.errors }));
  process.exit(0);
}
const guardFailures = formatOversizedGuardFailures(result);
console.log(JSON.stringify({ ok: true, topology: result.topology, guardFailures }));
" 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
        throw $raw
    }
    return $raw | ConvertFrom-Json
}

$derivedHeavyShardCount = $null
if ((Test-Path -LiteralPath $topologyLib) -and (Get-Command node -ErrorAction SilentlyContinue)) {
    try {
        $topologyPayload = Invoke-HeavyTopology
        if (-not $topologyPayload.ok) {
            foreach ($err in $topologyPayload.errors) {
                Add-Fail $err
            }
        }
        else {
            $derivedHeavyShardCount = [int]$topologyPayload.topology.heavyShardCount
            $matrixLength = [int]$topologyPayload.topology.heavyShardMatrix.Count
            if ($matrixLength -ne $derivedHeavyShardCount) {
                Add-Fail "topology artifact matrix length ($matrixLength) does not match derived heavyShardCount ($derivedHeavyShardCount)"
            }
            if ($topologyPayload.topology.parity.count -ne $topologyPayload.topology.parity.matrixLength) {
                Add-Fail 'topology artifact parity.count must equal parity.matrixLength'
            }
            Write-Host "  derived heavyShardCount: $derivedHeavyShardCount (fallbackClassification=$($topologyPayload.topology.fallbackClassification))"
            if ($topologyPayload.topology.underProvisioned) {
                Write-Host "  [WARN] topology under-provisioned: rawDerivedCount=$($topologyPayload.topology.rawDerivedCount) capped at maxShardCount"
            }
            foreach ($guardFailure in $topologyPayload.guardFailures) {
                Add-Fail $guardFailure
            }
        }
    }
    catch {
        Add-Fail "heavy topology validation failed: $_"
    }
}

if ((Test-Path -LiteralPath $prScopeScenarioScript) -and (Get-Command node -ErrorAction SilentlyContinue)) {
    try {
        $scenarioJson = & node $prScopeScenarioScript 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0) {
            Add-Fail "vitest PR-scope scenario matrix failed: $scenarioJson"
        }
        else {
            $scenario = $scenarioJson | ConvertFrom-Json
            if (-not $scenario.ok) {
                foreach ($case in $scenario.cases) {
                    if (-not $case.ok) {
                        Add-Fail "pr-scope scenario mismatch: $($case.name)"
                    }
                }
            }
        }
    }
    catch {
        Add-Fail "vitest PR-scope scenario matrix errored: $_"
    }
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
            Write-Host "  discovered: $($plan.discovered.Count) files; light: $($plan.light.Count); heavy: $($plan.heavy.Count); postMergeWallclock: $($plan.postMergeWallclock.Count); parked: $($plan.parked.Count)"
            $union = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
            $duplicates = [System.Collections.Generic.List[string]]::new()
            foreach ($file in $plan.light) {
                if ($union.Contains($file)) { $duplicates.Add($file) | Out-Null } else { [void]$union.Add($file) }
            }
            foreach ($file in $plan.postMergeWallclock) {
                if ($union.Contains($file)) {
                    $duplicates.Add($file) | Out-Null
                }
                else {
                    [void]$union.Add($file)
                }
            }
            foreach ($file in $plan.parked) {
                if ($union.Contains($file)) {
                    $duplicates.Add($file) | Out-Null
                }
                else {
                    [void]$union.Add($file)
                }
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
            if ($null -ne $derivedHeavyShardCount -and $plan.heavyShards.Count -ne $derivedHeavyShardCount) {
                Add-Fail "heavy shard assignment count ($($plan.heavyShards.Count)) does not match derived topology ($derivedHeavyShardCount)"
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
    @{ TypecheckResult = 'failure'; VitestLightResult = 'success'; VitestHeavyResult = 'success'; VitestTopologyPlanResult = 'success'; PesterResult = 'success'; HeadSha = 'abc'; RunId = '1' },
    @{ TypecheckResult = 'success'; VitestLightResult = 'failure'; VitestHeavyResult = 'success'; VitestTopologyPlanResult = 'success'; PesterResult = 'success'; HeadSha = 'abc'; RunId = '1' },
    @{ TypecheckResult = 'success'; VitestLightResult = 'success'; VitestHeavyResult = 'cancelled'; VitestTopologyPlanResult = 'success'; PesterResult = 'success'; HeadSha = 'abc'; RunId = '1' },
    @{ TypecheckResult = 'success'; VitestLightResult = 'skipped'; VitestHeavyResult = 'success'; VitestTopologyPlanResult = 'success'; PesterResult = 'success'; HeadSha = 'abc'; RunId = '1' },
    @{ TypecheckResult = 'success'; VitestLightResult = 'success'; VitestHeavyResult = 'success'; VitestTopologyPlanResult = 'success'; PesterResult = 'success'; HeadSha = ''; RunId = '1' }
)
foreach ($case in $negativeCases) {
    & $aggregateScriptPath `
        -TypecheckResult $case.TypecheckResult `
        -VitestLightResult $case.VitestLightResult `
        -VitestHeavyResult $case.VitestHeavyResult `
        -VitestTopologyPlanResult $case.VitestTopologyPlanResult `
        -PesterResult $case.PesterResult `
        -HeadSha $case.HeadSha `
        -RunId $case.RunId 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Add-Fail 'ci-test-aggregate.ps1 must fail closed on red/missing/skipped/cancelled/missing-head cases'
        break
    }
}
& $aggregateScriptPath -TypecheckResult 'success' -VitestLightResult 'success' -VitestHeavyResult 'success' -VitestTopologyPlanResult 'success' -PesterResult 'success' -HeadSha 'abc' -RunId '1' 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Add-Fail 'ci-test-aggregate.ps1 must pass when all upstream lanes are success with head/run binding'
}

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
    if ($refreshText -notmatch "refs/heads/main" -or $refreshText -notmatch 'workflow_dispatch') {
        Add-Fail 'vitest-runtime-history-refresh.yml must restrict workflow_dispatch to refs/heads/main'
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
        if ($heavyRefreshJob -notmatch 'include-hidden-files:\s*true') {
            Add-Fail 'test-vitest-heavy refresh workflow upload must set include-hidden-files: true (reports are dotfiles)'
        }
        if ($heavyRefreshJob -notmatch 'if-no-files-found:\s*error') {
            Add-Fail 'test-vitest-heavy refresh workflow upload must set if-no-files-found: error'
        }
        if ($heavyRefreshJob -notmatch 'run-vitest-heavy-shard\.ps1') {
            Add-Fail 'test-vitest-heavy refresh workflow job must invoke run-vitest-heavy-shard.ps1'
        }
    }
}


$rpcArtifactValidator = Join-Path $RepoRoot 'scripts/lib/validate-supervisor-heavy-lane-rpc-artifacts.mjs'
if (Test-Path -LiteralPath $rpcArtifactValidator) {
    if (-not $env:PR_HEAD_SHA) {
        $secondParent = git -C $RepoRoot rev-parse --verify HEAD^2 2>$null
        if ($LASTEXITCODE -eq 0 -and $secondParent) {
            $env:PR_HEAD_SHA = $secondParent
        }
    }
    $rpcOutput = & node $rpcArtifactValidator 2>&1 | Out-String
    if ($rpcOutput.Trim()) { Write-Host $rpcOutput.Trim() }
    if ($LASTEXITCODE -ne 0) {
        Add-Fail 'supervisor heavy-lane RPC repeat-run artifact validation failed (Issue #693)'
    }
}

# Issue #694 — wall-clock e2e stage split guards
Write-Host '== CI wall-clock e2e split guard (Issue #694) =='

$wallclockManifestPath = Join-Path $RepoRoot 'scripts/vitest-wallclock-e2e-split.manifest.json'
$wallclockPreMovePath = Join-Path $RepoRoot 'scripts/vitest-wallclock-e2e-split.pre-move-manifest.json'
$wallclockSplitLib = Join-Path $RepoRoot 'scripts/lib/vitest-wallclock-e2e-split.mjs'
$wallclockWorkflowPath = Join-Path $RepoRoot '.github/workflows/vitest-wallclock-e2e.yml'
$wallclockRunnerScript = Join-Path $RepoRoot 'scripts/run-vitest-wallclock-stage.ps1'
$wallclockAggregateScript = Join-Path $RepoRoot 'scripts/ci-wallclock-e2e-aggregate.ps1'
$wallclockNotifyScript = Join-Path $RepoRoot 'scripts/ci-wallclock-e2e-notify.ps1'
$wallclockContainmentScript = Join-Path $RepoRoot 'scripts/emit-wallclock-e2e-containment.mjs'

foreach ($required in @(
        $wallclockManifestPath,
        $wallclockPreMovePath,
        $wallclockSplitLib,
        $wallclockWorkflowPath,
        $wallclockRunnerScript,
        $wallclockAggregateScript,
        $wallclockNotifyScript,
        $wallclockContainmentScript
    )) {
    if (-not (Test-Path -LiteralPath $required)) {
        Add-Fail "missing wall-clock split artifact: $(Split-Path -Leaf $required)"
    }
}

if ((Test-Path -LiteralPath $wallclockSplitLib) -and (Get-Command node -ErrorAction SilentlyContinue)) {
    try {
        $coverageJson = & node -e "
import { buildCoverageDeltaReport, validateRollbackDocumentation, validateRollbackOrderViolationFixture } from './scripts/lib/vitest-wallclock-e2e-split.mjs';
const coverage = buildCoverageDeltaReport('$($RepoRoot.Replace('\', '/'))');
const rollbackDoc = validateRollbackDocumentation('$($RepoRoot.Replace('\', '/'))');
const rollbackOrder = validateRollbackOrderViolationFixture();
console.log(JSON.stringify({ coverage, rollbackDoc, rollbackOrder }));
" 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0) {
            Add-Fail "wall-clock coverage-delta evaluation failed: $coverageJson"
        }
        else {
            $payload = $coverageJson | ConvertFrom-Json
            if (-not $payload.coverage.ok) {
                foreach ($err in $payload.coverage.errors) {
                    Add-Fail "wall-clock coverage-delta: $err"
                }
            }
            else {
                Write-Host "  coverage-delta: prRetained=$($payload.coverage.report.prRetainedCount) postMerge=$($payload.coverage.report.postMergeExecutionCount)"
            }
            if (-not $payload.rollbackDoc.ok) {
                foreach ($err in $payload.rollbackDoc.errors) {
                    Add-Fail "wall-clock rollback docs: $err"
                }
            }
            if (-not $payload.rollbackOrder.ok) {
                Add-Fail 'negative fixture: rollback-order violation must be detectable'
            }
        }
    }
    catch {
        Add-Fail "wall-clock split lib validation failed: $_"
    }
}

if (Test-Path -LiteralPath $wallclockWorkflowPath) {
    $wallclockText = Get-Content -LiteralPath $wallclockWorkflowPath -Raw
    $wallclockJobs = Get-YamlJobs -Text $wallclockText
    if ($wallclockText -match 'pull_request:') {
        Add-Fail 'vitest-wallclock-e2e.yml must not trigger on pull_request'
    }
    if ($wallclockText -notmatch 'push:[\s\S]*branches:[\s\S]*main') {
        Add-Fail 'vitest-wallclock-e2e.yml must trigger on push to main'
    }
    if ($wallclockText -notmatch 'schedule:') {
        Add-Fail 'vitest-wallclock-e2e.yml must declare schedule backstop'
    }
    if (-not $wallclockJobs.ContainsKey('test-vitest-wallclock')) {
        Add-Fail 'vitest-wallclock-e2e.yml missing test-vitest-wallclock job'
    }
    if (-not $wallclockJobs.ContainsKey('test-wallclock-aggregate')) {
        Add-Fail 'vitest-wallclock-e2e.yml missing test-wallclock-aggregate job'
    }
    if (-not $wallclockJobs.ContainsKey('emit-containment')) {
        Add-Fail 'vitest-wallclock-e2e.yml missing emit-containment job'
    }
    if ($wallclockText -notmatch 'Upload containment artifact[\s\S]*if: always\(\)') {
        Add-Fail 'wall-clock containment artifact upload must run on red/pending heads (if: always())'
    }
    if ($wallclockText -notmatch '--write-only') {
        Add-Fail 'emit-containment must pass --write-only so artifact is written before job failure'
    }
    if ($wallclockText -notmatch 'emit-containment:[\s\S]*env:[\s\S]*STAGE_RESULT:') {
        Add-Fail 'emit-containment job must define STAGE_RESULT at job env so later steps can read it'
    }
    if ($wallclockText -notmatch "Fail closed on uncontained head[\s\S]*STAGE_RESULT != 'success'") {
        Add-Fail 'vitest-wallclock-e2e.yml must fail closed when STAGE_RESULT is not success'
    }
    if ($wallclockText -notmatch 'Fail closed on uncontained head') {
        Add-Fail 'vitest-wallclock-e2e.yml must fail closed after uploading uncontained containment artifact'
    }
    if ((Get-Content -LiteralPath (Join-Path $RepoRoot '.github/workflows/scope-guard.yml') -Raw) -match 'members:\s*read') {
        Add-Fail 'scope-guard.yml must not declare unsupported members: read workflow permission'
    }
    if (-not $wallclockJobs.ContainsKey('notify-on-failure')) {
        Add-Fail 'vitest-wallclock-e2e.yml missing notify-on-failure job'
    }
    if ($wallclockText -notmatch 'notify-on-failure:[\s\S]*needs:[\s\S]*emit-containment') {
        Add-Fail 'notify-on-failure must depend on emit-containment so containment failures alert'
    }
    if ($wallclockJobs.ContainsKey('test-vitest-wallclock')) {
        $wcJob = $wallclockJobs['test-vitest-wallclock']
        if ($wcJob -notmatch 'run-vitest-wallclock-stage\.ps1') {
            Add-Fail 'test-vitest-wallclock job must invoke run-vitest-wallclock-stage.ps1'
        }
        if ($wcJob -match 'continue-on-error:\s*true') {
            Add-Fail 'test-vitest-wallclock job must not use continue-on-error: true'
        }
    }
    if ($wallclockJobs.ContainsKey('test-wallclock-aggregate')) {
        $aggJob = $wallclockJobs['test-wallclock-aggregate']
        if ($aggJob -notmatch 'ci-wallclock-e2e-aggregate\.ps1') {
            Add-Fail 'test-wallclock-aggregate job must invoke ci-wallclock-e2e-aggregate.ps1'
        }
        if ($aggJob -match 'continue-on-error:\s*true') {
            Add-Fail 'test-wallclock-aggregate job must not use continue-on-error: true'
        }
    }
}

$mainEvidenceFixture = $env:OPK_WALLCLOCK_MAIN_EVIDENCE_FIXTURE
if (-not $mainEvidenceFixture -and $env:GITHUB_ACTIONS -ne 'true') {
    $mainEvidenceFixture = 'bootstrap'
}
if ($mainEvidenceFixture) {
    $env:OPK_WALLCLOCK_MAIN_EVIDENCE_FIXTURE = $mainEvidenceFixture
}
if ($mainEvidenceFixture -eq 'missing-steady-state') {
    Add-Fail 'wall-clock latest-main evidence missing (negative fixture)'
}

$approvalFixture = $env:OPK_WALLCLOCK_SPLIT_APPROVAL_FIXTURE
if (-not $approvalFixture -and $env:GITHUB_ACTIONS -ne 'true') {
    $approvalFixture = 'approved'
}
if ($approvalFixture) {
    $env:OPK_WALLCLOCK_SPLIT_APPROVAL_FIXTURE = $approvalFixture
}
if ($approvalFixture -eq 'missing') {
    Add-Fail 'wall-clock split approval missing (negative fixture)'
}
elseif ($approvalFixture -eq 'self-created') {
    Add-Fail 'wall-clock split same-PR self-created approval rejected (negative fixture)'
}
else {
    try {
        $approvalJson = & node -e "
import { resolveImmutableApproval } from './scripts/lib/vitest-wallclock-e2e-split.mjs';
const result = await resolveImmutableApproval('$($RepoRoot.Replace('\', '/'))');
console.log(JSON.stringify(result));
" 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0) {
            Add-Fail "wall-clock approval resolution failed: $approvalJson"
        }
        else {
            $approval = $approvalJson | ConvertFrom-Json
            if (-not $approval.ok) {
                Add-Fail "wall-clock split missing immutable GitHub approval (#487 AC#8): $($approval.reason)"
            }
        }
    }
    catch {
        Add-Fail "wall-clock approval guard failed: $_"
    }
}

if ((Test-Path -LiteralPath $wallclockSplitLib) -and (Get-Command node -ErrorAction SilentlyContinue)) {
    try {
        $mainEvidenceJson = & node -e "
import { verifyLatestMainWallClockEvidence } from './scripts/lib/vitest-wallclock-e2e-split.mjs';
const result = await verifyLatestMainWallClockEvidence('$($RepoRoot.Replace('\', '/'))');
console.log(JSON.stringify(result));
"
        if (-not $mainEvidenceJson) {
            Add-Fail 'wall-clock latest-main evidence evaluation returned no output'
        }
        else {
            $mainEvidence = $mainEvidenceJson | ConvertFrom-Json
            if (-not $mainEvidence.ok) {
                Add-Fail "wall-clock latest-main evidence (#694 AC#3): $($mainEvidence.reason) head=$($mainEvidence.mainHeadSha)"
            }
            else {
                Write-Host "  latest-main evidence: mode=$($mainEvidence.mode) reason=$($mainEvidence.reason) head=$($mainEvidence.mainHeadSha)"
            }
        }
    }
    catch {
        Add-Fail "wall-clock latest-main evidence guard failed: $_"
    }
}

& $wallclockAggregateScript -WallclockResult 'failure' -HeadSha 'abc' -RunId '1' 2>&1 | Out-Null
if ($LASTEXITCODE -eq 0) {
    Add-Fail 'ci-wallclock-e2e-aggregate.ps1 must fail closed on failure result'
}
& $wallclockAggregateScript -WallclockResult 'success' -HeadSha '' -RunId '1' 2>&1 | Out-Null
if ($LASTEXITCODE -eq 0) {
    Add-Fail 'ci-wallclock-e2e-aggregate.ps1 must fail closed on missing head'
}
& $wallclockAggregateScript -WallclockResult 'success' -HeadSha 'abc' -RunId '1' 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Add-Fail 'ci-wallclock-e2e-aggregate.ps1 must pass when wall-clock lane succeeds with head binding'
}

& $wallclockNotifyScript -HeadSha 'deadbeef' -DryRun 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Add-Fail 'wall-clock alert dry-run must prove delivery payload'
}
& $wallclockNotifyScript -HeadSha 'deadbeef' -DryRun -SimulateDeliveryFailure 2>&1 | Out-Null
if ($LASTEXITCODE -eq 0) {
    Add-Fail 'wall-clock alert delivery failure must not silently swallow red stage'
}

& node $wallclockContainmentScript --head abc --stage-result success 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Add-Fail 'emit-wallclock-e2e-containment.mjs must exit 0 when stage succeeds'
}
& node $wallclockContainmentScript --head abc --stage-result failure 2>&1 | Out-Null
if ($LASTEXITCODE -eq 0) {
    Add-Fail 'emit-wallclock-e2e-containment.mjs must fail closed when stage is failure'
}
& node $wallclockContainmentScript --head abc --stage-result pending 2>&1 | Out-Null
if ($LASTEXITCODE -eq 0) {
    Add-Fail 'emit-wallclock-e2e-containment.mjs must fail closed when stage is pending'
}
& node $wallclockContainmentScript --head abc --stage-result failure --write-only 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Add-Fail 'emit-wallclock-e2e-containment.mjs --write-only must exit 0 after writing uncontained artifact'
}


if ($failures.Count -gt 0) {
    Write-Host '[FAIL] CI pipeline split guard:'
    foreach ($item in $failures) {
        Write-Host " - $item"
    }
    exit 1
}

Write-Host '[PASS] CI pipeline split lane classification, PR-scoped heavy-lane guard, derived weighted heavy shards, oversized-file guard, runtime-history refresh producer guards, wall-clock e2e split, aggregate fail-closed, and worker-RPC guard OK.'
exit 0
