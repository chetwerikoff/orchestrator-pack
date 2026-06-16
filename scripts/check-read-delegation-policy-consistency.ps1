#requires -Version 5.1
<#
.SYNOPSIS
  Stale-wording and manifest scan for Cursor read-delegation policy pointers (Issue #309).
#>
param(
    [string]$RepoRoot
)

. (Join-Path $PSScriptRoot 'lib/Read-DelegationCheck-Common.ps1')
$ErrorActionPreference = 'Stop'
$RepoRoot = Resolve-ReadDelegationCheckRepoRoot -RepoRoot $RepoRoot -ScriptRoot $PSScriptRoot

$manifestPath = Join-Path $RepoRoot '.cursor/rules/read-delegation-policy-manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath)) {
    Write-Host '[FAIL] missing committed Cursor read-delegation policy manifest'
    exit 1
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$failures = [System.Collections.Generic.List[string]]::new()

$stalePatterns = @($manifest.stalePatterns)
$manifestedRules = @($manifest.policyBearingCursorRules)

foreach ($rel in $manifestedRules) {
    $path = Join-Path $RepoRoot $rel
    if (-not (Test-Path -LiteralPath $path)) {
        $failures.Add("manifested Cursor rule missing: $rel")
        continue
    }
    $text = Get-Content -LiteralPath $path -Raw
    foreach ($pattern in $stalePatterns) {
        if ($text -match [regex]::Escape($pattern)) {
            $failures.Add("$rel contains stale read-delegation wording: $pattern")
        }
    }
}

$rulesDir = Join-Path $RepoRoot '.cursor/rules'
$policyMarkers = @(
    'Coworker CLI delegation',
    'coworker ask',
    'delegate I/O, keep reasoning'
)

Get-ChildItem -LiteralPath $rulesDir -Filter '*.mdc' -File | ForEach-Object {
    $rel = '.cursor/rules/' + $_.Name
    if ($manifestedRules -contains $rel) {
        return
    }
    $text = Get-Content -LiteralPath $_.FullName -Raw
    foreach ($marker in $policyMarkers) {
        if ($text -match [regex]::Escape($marker)) {
            $failures.Add("unmanifested policy-bearing Cursor rule: $rel (marker: $marker)")
            break
        }
    }
}

$canonical = Join-Path $RepoRoot 'prompts/agent_rules.md'
$canonicalText = Get-Content -LiteralPath $canonical -Raw
if ($canonicalText -notmatch 'index-coverage carve-out') {
    $failures.Add('prompts/agent_rules.md missing index-coverage carve-out prose')
}

if ($failures.Count -gt 0) {
    Write-Host '[FAIL] read-delegation policy consistency:'
    foreach ($item in $failures) {
        Write-Host " - $item"
    }
    exit 1
}

Write-Host '[PASS] read-delegation Cursor policy pointers and manifest are consistent.'
exit 0
