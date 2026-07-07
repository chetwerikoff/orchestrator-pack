#requires -Version 5.1
<#
.SYNOPSIS
  Line-budget ceiling guard for prompts/agent_rules.md (Issue #654).
#>
param(
    [string]$RepoRoot,
    [int]$MaxLines = 450
)

. (Join-Path $PSScriptRoot 'lib/Initialize-PackGateCheck.ps1')
$gate = Initialize-PackGateCheck -RepoRoot $RepoRoot -CallerScriptRoot $PSScriptRoot
$RepoRoot = $gate.RepoRoot

$target = Join-Path $RepoRoot 'prompts/agent_rules.md'
if (-not (Test-Path -LiteralPath $target)) {
    Write-Host '[FAIL] missing prompts/agent_rules.md'
    exit 1
}

$lineCount = (Get-Content -LiteralPath $target).Count
if ($lineCount -gt $MaxLines) {
    Write-Host "[FAIL] prompts/agent_rules.md has $lineCount lines (ceiling $MaxLines)"
    exit 1
}

Write-Host "[PASS] prompts/agent_rules.md line budget ($lineCount <= $MaxLines)"
exit 0
