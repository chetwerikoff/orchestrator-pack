#requires -Version 5.1
<#
.SYNOPSIS
  Fail-closed live-reference guard: no normative prompts/agent_rules.md or bare
  agent_rules.md references (Issue #678).
#>
param(
    [string]$RepoRoot
)

. (Join-Path $PSScriptRoot 'lib/Initialize-PackGateCheck.ps1')
$gate = Initialize-PackGateCheck -RepoRoot $RepoRoot -CallerScriptRoot $PSScriptRoot
$RepoRoot = $gate.RepoRoot

$excludePrefixes = @(
    'docs/declarations/',
    'docs/issues_drafts/',
    '.ao/'
)

$patterns = @(
    'prompts/agent_rules\.md',
    'prompts\\agent_rules\.md',
    '(?<![\w/\\])agent_rules\.md'
)

$failures = [System.Collections.Generic.List[string]]::new()
Get-ChildItem -LiteralPath $RepoRoot -Recurse -File |
    Where-Object {
        $rel = $_.FullName.Substring($RepoRoot.Length).TrimStart('/', '\') -replace '\\', '/'
        foreach ($prefix in $excludePrefixes) {
            if ($rel.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
                return $false
            }
        }
        return $true
    } |
    ForEach-Object {
        $rel = $_.FullName.Substring($RepoRoot.Length).TrimStart('/', '\') -replace '\\', '/'
        if ($rel -eq 'scripts/check-agent-rules-grep-inventory.ps1') {
            return
        }
        if ($rel.StartsWith('tests/fixtures/', [StringComparison]::OrdinalIgnoreCase)) {
            return
        }
        if ($rel -eq 'tests/agents-md-relocation.test.ts') {
            return
        }
        $text = Get-Content -LiteralPath $_.FullName -Raw -ErrorAction SilentlyContinue
        if ([string]::IsNullOrEmpty($text)) {
            return
        }
        foreach ($pattern in $patterns) {
            if ($text -match $pattern) {
                $failures.Add("$rel references retired agent_rules.md")
                break
            }
        }
    }

if ($failures.Count -gt 0) {
    Write-Host '[FAIL] live references to retired agent_rules.md:'
    foreach ($item in $failures) {
        Write-Host " - $item"
    }
    exit 1
}

Write-Host '[PASS] no live normative references to agent_rules.md'
exit 0
