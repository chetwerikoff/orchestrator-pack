#requires -Version 5.1
<#
.SYNOPSIS
  Static guard for Issue #488 verify runtime refactor: structural verify.ps1 default,
  optional batched smoke helper, full-lane slow-test budget, and Pester cache wiring.
#>
[CmdletBinding()]
param(
    [string]$RepoRoot = ''
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/ci-workflow-yaml.ps1')

if (-not $RepoRoot) {
    $RepoRoot = Split-Path -Parent $PSScriptRoot
}
$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
$GuardIssueNumber = 488

$failures = [System.Collections.Generic.List[string]]::new()

function Add-Fail {
    param([string]$Message)
    $failures.Add($Message) | Out-Null
}

Write-Host '== verify runtime refactor guard (Issue #488) =='

$verifyPath = Join-Path $RepoRoot 'scripts/verify.ps1'
$smokePath = Join-Path $RepoRoot 'scripts/invoke-verify-test-backed-smoke.ps1'
$budgetConfig = Join-Path $RepoRoot 'scripts/test-runtime-budget.config.json'
$budgetEnforcer = Join-Path $RepoRoot 'scripts/enforce-vitest-runtime-budget.mjs'
$testAllPath = Join-Path $RepoRoot 'scripts/test-all.ps1'
$scopeGuardPath = Join-Path $RepoRoot '.github/workflows/scope-guard.yml'
$mappingDoc = Join-Path $RepoRoot 'docs/verify-runtime-refactor.md'
$pesterInstaller = Join-Path $RepoRoot 'scripts/install-pester-ci.ps1'

foreach ($required in @($verifyPath, $smokePath, $budgetConfig, $budgetEnforcer, $testAllPath, $mappingDoc, $pesterInstaller)) {
    if (-not (Test-Path -LiteralPath $required)) {
        Add-Fail "missing required artifact: $(Split-Path -Leaf $required)"
    }
}

if (Test-Path -LiteralPath $verifyPath) {
    $verifyText = Get-Content -LiteralPath $verifyPath -Raw
    if ($verifyText -notmatch '\[switch\]\$TestBackedSmoke') {
        Add-Fail 'verify.ps1 must declare -TestBackedSmoke for optional batched smoke path'
    }
    if ($verifyText -match '(?m)\bnpm ci\b') {
        Add-Fail 'verify.ps1 default body must not run npm ci; use invoke-verify-test-backed-smoke.ps1'
    }
    if ($verifyText -match '(?m)\bnpx vitest run\b') {
        Add-Fail 'verify.ps1 default body must not invoke npx vitest run; full lane owns regression'
    }
    if ($verifyText -notmatch 'invoke-verify-test-backed-smoke\.ps1') {
        Add-Fail 'verify.ps1 must delegate -TestBackedSmoke to invoke-verify-test-backed-smoke.ps1'
    }
}

if (Test-Path -LiteralPath $testAllPath) {
    $testAllText = Get-Content -LiteralPath $testAllPath -Raw
    if ($testAllText -notmatch 'enforce-vitest-runtime-budget\.mjs') {
        Add-Fail 'test-all.ps1 must invoke enforce-vitest-runtime-budget.mjs after Vitest'
    }
    if ($testAllText -notmatch 'test-runtime-budget\.config\.json|\.vitest-runtime-report\.json') {
        Add-Fail 'test-all.ps1 must emit/consume Vitest JSON output for runtime budget enforcement'
    }
}

if (Test-Path -LiteralPath $scopeGuardPath) {
    $scopeText = Get-Content -LiteralPath $scopeGuardPath -Raw
    $jobs = Get-YamlJobs -Text $scopeText

    if ($jobs.ContainsKey('verify-pack')) {
        $verifyJob = $jobs['verify-pack']
        $verifyStepIndex = [regex]::Match($verifyJob, '(?ms)(- name: Run read-only pack verifier.*?run: \./scripts/verify\.ps1)').Index
        $nodeStepIndex = [regex]::Match($verifyJob, '(?ms)- name: Setup Node\.js').Index
        if ($verifyStepIndex -ge 0 -and $nodeStepIndex -ge 0 -and $nodeStepIndex -lt $verifyStepIndex) {
            Add-Fail 'verify-pack must run verify.ps1 before Node setup (default path is npm-free)'
        }
        if ($verifyJob -notmatch 'check-verify-runtime\.ps1') {
            Add-Fail 'verify-pack must invoke scripts/check-verify-runtime.ps1'
        }
    }
    else {
        Add-Fail 'scope-guard.yml missing verify-pack job'
    }

    if ($jobs.ContainsKey('test-pester')) {
        $pesterJob = $jobs['test-pester']
        if ($pesterJob -notmatch 'install-pester-ci\.ps1') {
            Add-Fail 'test-pester job must use scripts/install-pester-ci.ps1 instead of inline Install-Module every run'
        }
        if ($pesterJob -notmatch 'actions/cache@v\d+') {
            Add-Fail 'test-pester job must cache the Pester module path'
        }
    }
}

if ($failures.Count -gt 0) {
    Write-Host '[FAIL] verify runtime refactor guard:'
    foreach ($item in $failures) {
        Write-Host " - $item"
    }
    exit 1
}

Write-Host '[PASS] verify.ps1 structural default, smoke helper, runtime budget, and Pester cache wiring OK.'
exit 0
