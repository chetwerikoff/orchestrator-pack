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

function Get-WorkflowFiles {
    $dir = Join-Path $RepoRoot '.github/workflows'
    if (-not (Test-Path -LiteralPath $dir)) {
        return @()
    }
    return @(
        Get-ChildItem -LiteralPath $dir -Include '*.yml', '*.yaml' -File |
            Sort-Object Name
    )
}

function Test-WorkflowTriggersPushMain {
    param([string]$Text)
    return $Text -match '(?ms)^on:\s*.*?^\s*push:\s*$.*?^\s*branches:\s*$.*?^\s*-\s*main\s*$'
}

function Test-WorkflowTriggersPullRequest {
    param([string]$Text)
    return $Text -match '(?m)^\s*pull_request(_target)?:\s*$' -or $Text -match '(?m)^\s*-\s*pull_request(_target)?\s*$'
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
  $isReusable = $text -match '(?m)^on:\s*$' -and $text -match '(?m)^\s*workflow_call:\s*$'

    if ($hasPr -or $hasPushMain -or $isReusable) {
        if ($text -notmatch '(?m)^concurrency:\s*$') {
            Add-Fail "$rel missing top-level concurrency block"
        }
        else {
            if ($hasPushMain) {
                if ($text -match '(?m)^\s*cancel-in-progress:\s*true\s*$') {
                    Add-Fail "$rel uses unconditional cancel-in-progress: true while also triggering push to main"
                }
                if ($text -notmatch 'cancel-in-progress:\s*\$\{\{') {
                    Add-Fail "$rel must gate cancel-in-progress with a pull_request expression when push-to-main is enabled"
                }
            }

            if ($hasPr) {
                if ($text -match 'github\.head_ref' -and $text -notmatch 'pull_request\.number') {
                    Add-Fail "$rel concurrency group uses head_ref without pull_request.number (fork PR isolation)"
                }
                if ($text -notmatch 'pull_request\.number') {
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
  if ($scopeText -notmatch 'test-all\.ps1') {
        Add-Fail 'scope-guard.yml tests job must run scripts/test-all.ps1 (vitest owner for read-delegation audit fixtures)'
    }
    if ($scopeText -notmatch 'check-ci-cheap-wins\.ps1') {
        Add-Fail 'scope-guard.yml must invoke scripts/check-ci-cheap-wins.ps1'
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
