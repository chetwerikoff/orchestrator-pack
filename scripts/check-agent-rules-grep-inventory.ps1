#requires -Version 5.1
<#
.SYNOPSIS
  Fail-closed inventory guard for prompts/agent_rules.md grep consumers (Issue #654).
#>
param(
    [string]$RepoRoot
)

$ErrorActionPreference = 'Stop'
if (-not $RepoRoot) {
    $RepoRoot = Split-Path -Parent $PSScriptRoot
}

$inventoryPath = Join-Path $RepoRoot 'scripts/agent-rules-grep-inventory.json'
if (-not (Test-Path -LiteralPath $inventoryPath)) {
    Write-Host '[FAIL] missing scripts/agent-rules-grep-inventory.json'
    exit 1
}

$inventory = Get-Content -LiteralPath $inventoryPath -Raw | ConvertFrom-Json
$allowed = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($row in @($inventory.consumers)) {
    [void]$allowed.Add([string]$row.path)
}

$scriptsRoot = Join-Path $RepoRoot 'scripts'
$patterns = @(
    'agent_rules\.md',
    "Join-Path[^\n]*agent_rules",
    'Get-Content[^\n]*agent_rules',
    'prompts/agent_rules'
)

$discovered = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
Get-ChildItem -LiteralPath $scriptsRoot -Recurse -File |
    Where-Object { $_.Extension -in '.ps1', '.mjs', '.ts', '.js' } |
    ForEach-Object {
        $rel = $_.FullName.Substring($RepoRoot.Length).TrimStart('/', '\') -replace '\\', '/'
        if ($rel -eq 'scripts/agent-rules-grep-inventory.json') {
            return
        }
        $text = Get-Content -LiteralPath $_.FullName -Raw
        foreach ($pattern in $patterns) {
            if ($text -match $pattern) {
                [void]$discovered.Add($rel)
                break
            }
        }
    }

$failures = [System.Collections.Generic.List[string]]::new()
foreach ($consumer in $discovered) {
    if (-not $allowed.Contains($consumer)) {
        $failures.Add("uninventoried agent_rules consumer: $consumer")
    }
}

foreach ($row in @($inventory.consumers)) {
    $path = Join-Path $RepoRoot ([string]$row.path)
    if (-not (Test-Path -LiteralPath $path)) {
        $failures.Add("inventory row missing on disk: $($row.path)")
    }
}

if ($failures.Count -gt 0) {
    Write-Host '[FAIL] agent-rules grep-consumer inventory:'
    foreach ($item in $failures) {
        Write-Host " - $item"
    }
    exit 1
}

Write-Host "[PASS] agent-rules grep-consumer inventory ($($discovered.Count) consumers inventoried)"
exit 0
