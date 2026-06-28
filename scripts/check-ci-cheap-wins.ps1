#requires -Version 5.1
<#
.SYNOPSIS
  Static guard for Issue #486 CI cheap wins: PR cancellation scope, npm cache coverage,
  and read-delegation audit fixture ownership.
#>
[CmdletBinding()]
param(
    [string]$RepoRoot = ''
)

# Issue #486 — PR cancellation scope and npm-cache contract
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot "lib/ci-workflow-yaml.ps1")
if (-not $RepoRoot) {
    $RepoRoot = Split-Path -Parent $PSScriptRoot
}
$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
$GuardIssueNumber = 486

$failures = [System.Collections.Generic.List[string]]::new()

function Add-Fail {
    param([string]$Message)
    $failures.Add($Message) | Out-Null
}

function Get-WorkflowFiles {
    $dir = Join-Path $RepoRoot '.github/workflows'
    if (-not (Test-Path -LiteralPath $dir)) {
        return @()
    }
    return @(
        Get-ChildItem -LiteralPath $dir -File |
            Where-Object { $_.Extension -in '.yml', '.yaml' } |
            Sort-Object Name
    )
}

function Test-WorkflowTriggersPushMain {
    param([string]$Text)
    if ($Text -match '(?ms)^on:\s*.*?^\s*push:\s*$.*?^\s*branches:\s*$.*?^\s*-\s*main\s*$') {
        return $true
    }
    if ($Text -match '(?ms)push:\s*[\r\n]+\s*branches:\s*\[[^\]]*\bmain\b') {
        return $true
    }
    if ($Text -match '(?ms)push:\s*[\r\n]+\s*branches:\s*\r?\n\s*-\s*main\b') {
        return $true
    }
    if ($Text -match '(?ms)push:\s*branches:\s*\[[^\]]*\bmain\b') {
        return $true
    }
    return $false
}

function Test-WorkflowTriggersPullRequest {
    param([string]$Text)
    if ($Text -match '(?m)^on:\s*pull_request(_target)?\s*$') {
        return $true
    }
    if ($Text -match '(?m)^on:\s*\[[^\]]*\bpull_request(_target)?\b[^\]]*\]') {
        return $true
    }
    if ($Text -match '(?m)^\s*pull_request(_target)?:\s*') {
        return $true
    }
    if ($Text -match '(?m)^\s*-\s*pull_request(_target)?\s*$') {
        return $true
    }
    return $false
}

function Test-WorkflowIsReusable {
    param([string]$Text)
    if ($Text -match '(?m)^on:\s*workflow_call\s*$') {
        return $true
    }
    if ($Text -match '(?m)^on:\s*\[[^\]]*\bworkflow_call\b[^\]]*\]') {
        return $true
    }
    if ($Text -match '(?m)^on:\s*$' -and $Text -match '(?m)^\s*workflow_call:\s*') {
        return $true
    }
    return $false
}

function Get-WorkflowConcurrencyBlock {
    param([string]$Text)
    $lines = $Text -split '\r?\n'
    for ($i = 0; $i -lt $lines.Count; $i++) {
        $line = $lines[$i]
        if ($line -match '^concurrency:\s*$') {
            $block = [System.Collections.Generic.List[string]]::new()
            for ($j = $i + 1; $j -lt $lines.Count; $j++) {
                if ($lines[$j] -match '^\S') {
                    break
                }
                $block.Add($lines[$j]) | Out-Null
            }
            return ($block -join "`n")
        }
        if ($line -match '^concurrency:\s*(.+)$') {
            return $Matches[1].Trim()
        }
    }
    return ''
}

Write-Host '== CI cheap wins static guard (Issue #486) =='

$workflowFiles = Get-WorkflowFiles
if ($workflowFiles.Count -eq 0) {
    Add-Fail 'no workflow files found under .github/workflows'
}

$scopeGuardPath = Join-Path $RepoRoot '.github/workflows/scope-guard.yml'
$auditWorkflowPath = Join-Path $RepoRoot '.github/workflows/read-delegation-audit.yml'

$governedWorkflowExempt = '.github/workflows/contract-evidence-legacy-list-guard.yml'

foreach ($file in $workflowFiles) {
    $rel = '.github/workflows/' + $file.Name
    if ($rel -eq $governedWorkflowExempt) {
        continue
    }
    $text = Get-Content -LiteralPath $file.FullName -Raw

    $hasPr = Test-WorkflowTriggersPullRequest -Text $text
    $hasPushMain = Test-WorkflowTriggersPushMain -Text $text
    $isReusable = Test-WorkflowIsReusable -Text $text

    if ($hasPr -or $hasPushMain -or $isReusable) {
        if ($text -notmatch '(?m)^concurrency:\s*') {
            Add-Fail "$rel missing top-level concurrency block"
        }
        else {
            $concurrency = Get-WorkflowConcurrencyBlock -Text $text
            if ($hasPushMain) {
                if ($concurrency -match '(?m)^\s*cancel-in-progress:\s*true\s*$') {
                    Add-Fail "$rel uses unconditional cancel-in-progress: true while also triggering push to main"
                }
                if ($concurrency -notmatch 'cancel-in-progress:\s*\$\{\{') {
                    Add-Fail "$rel must gate cancel-in-progress with a pull_request expression when push-to-main is enabled"
                }
            }

            if ($hasPr) {
                if ($concurrency -match 'github\.head_ref' -and $concurrency -notmatch 'pull_request\.number') {
                    Add-Fail "$rel concurrency group uses head_ref without pull_request.number (fork PR isolation)"
                }
                if ($concurrency -notmatch 'pull_request\.number') {
                    Add-Fail "$rel concurrency group must key on pull_request.number for PR-scoped cancellation"
                }
            }
        }
    }

    $jobs = Get-YamlJobs -Text $text
    foreach ($jobName in $jobs.Keys) {
        $jobText = $jobs[$jobName]
        if ($jobText -notmatch 'npm ci') {
            continue
        }
        if ($jobText -match 'ci-cheap-wins:\s*npm-cache-unavailable') {
            continue
        }
        if ($jobText -notmatch 'actions/setup-node@v\d+' -or $jobText -notmatch 'cache:\s*npm') {
            Add-Fail "$rel job '$jobName' runs npm ci without actions/setup-node cache: npm (or documented npm-cache-unavailable carve-out)"
        }
    }
}

if (Test-Path -LiteralPath $auditWorkflowPath) {
    $auditText = Get-Content -LiteralPath $auditWorkflowPath -Raw
    if ($auditText -match '(?m)(run:\s*npm test -- scripts/read-delegation-audit\.test\.ts|vitest run.*read-delegation-audit\.test\.ts)') {
        Add-Fail 'read-delegation-audit.yml must not run the fixture suite (owned by scope-guard tests via test-all.ps1)'
    }
    $auditJobs = Get-YamlJobs -Text $auditText
    foreach ($jobName in $auditJobs.Keys) {
        $jobText = $auditJobs[$jobName]
        if ($jobText -match 'check-read-delegation-audit-ci-gate\.ps1') {
            if ($jobText -notmatch 'actions/setup-node@v\d+' -or $jobText -notmatch 'cache:\s*npm') {
                Add-Fail "read-delegation-audit.yml job '$jobName' invokes npm-ci meta-check without actions/setup-node cache: npm"
            }
        }
    }
}
else {
    Add-Fail 'missing .github/workflows/read-delegation-audit.yml'
}

if (Test-Path -LiteralPath $scopeGuardPath) {
    $scopeText = Get-Content -LiteralPath $scopeGuardPath -Raw
    $hasMonolithicTests = $scopeText -match '(?m)^\s*tests:\s*$' -and $scopeText -match 'test-all\.ps1'
    $hasShardedPipeline = $scopeText -match 'test-vitest' -and $scopeText -match 'run-vitest-shard\.ps1' -and $scopeText -match 'ci-test-aggregate\.ps1'
    if (-not $hasMonolithicTests -and -not $hasShardedPipeline) {
        Add-Fail 'scope-guard.yml must run scripts/test-all.ps1 or the sharded vitest/pester pipeline (Issue #487)'
    }
    if ($hasShardedPipeline -and $scopeText -notmatch 'test-all\.ps1.*-SkipNpm|-SkipNpm.*test-all\.ps1') {
        Add-Fail 'sharded pipeline must keep scripts/test-all.ps1 -SkipNpm for Pester/read-delegation ownership'
    }
    if ($scopeText -notmatch 'check-ci-cheap-wins\.ps1') {
        Add-Fail 'scope-guard.yml must invoke scripts/check-ci-cheap-wins.ps1'
    }
    if ($scopeText -notmatch 'check-verify-runtime\.ps1') {
        Add-Fail 'scope-guard.yml must invoke scripts/check-verify-runtime.ps1 (Issue #488)'
    }
    if ($hasShardedPipeline -and $scopeText -notmatch 'check-ci-pipeline-split\.ps1') {
        Add-Fail 'scope-guard.yml must invoke scripts/check-ci-pipeline-split.ps1 when using sharded test pipeline'
    }
}
else {
    Add-Fail 'missing .github/workflows/scope-guard.yml'
}

if ($failures.Count -gt 0) {
    Write-Host '[FAIL] CI cheap wins static guard:'
    foreach ($item in $failures) {
        Write-Host " - $item"
    }
    exit 1
}

Write-Host '[PASS] PR cancellation scope, npm cache coverage, and read-delegation audit ownership OK.'
exit 0
