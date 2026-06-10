#requires -Version 5.1
<#
.SYNOPSIS
  Drift guard for coworker delegation T1 volume floor (Issue #255).
#>
param(
    [string]$RepoRoot
)

$ErrorActionPreference = 'Stop'
if (-not $RepoRoot) {
    $RepoRoot = Split-Path -Parent $PSScriptRoot
}

$canonical = Join-Path $RepoRoot 'prompts/agent_rules.md'
if (-not (Test-Path -LiteralPath $canonical)) {
    Write-Host "[FAIL] missing canonical policy: prompts/agent_rules.md"
    exit 1
}

$canonicalText = Get-Content -LiteralPath $canonical -Raw
if ($canonicalText -notmatch 'more than 400 lines') {
    Write-Host '[FAIL] prompts/agent_rules.md must state T1 volume floor of 400 lines'
    exit 1
}

$staleVolumePatterns = @(
    'more than 600 lines',
    'total \*\*more than 600',
    'together total \*\*more than 600'
)

$trackedPolicyGlobs = @(
    'prompts/agent_rules.md',
    'AGENTS.md',
    'CLAUDE.md',
    '.cursor/rules/coworker-delegation.mdc',
    '.cursor/rules/coworker-rtk-read-exploration.mdc'
)

$failures = [System.Collections.Generic.List[string]]::new()
foreach ($rel in $trackedPolicyGlobs) {
    $path = Join-Path $RepoRoot $rel
    if (-not (Test-Path -LiteralPath $path)) {
        continue
    }
    $text = Get-Content -LiteralPath $path -Raw
    foreach ($pattern in $staleVolumePatterns) {
        if ($text -match [regex]::Escape($pattern)) {
            $failures.Add("$rel still contains stale volume-floor literal: $pattern")
        }
    }
}

if ($failures.Count -gt 0) {
    Write-Host '[FAIL] coworker delegation threshold drift:'
    foreach ($item in $failures) {
        Write-Host " - $item"
    }
    exit 1
}

Write-Host '[PASS] coworker delegation T1 floor is 400 with no stale 600 volume-floor literals in tracked policy files.'
exit 0
