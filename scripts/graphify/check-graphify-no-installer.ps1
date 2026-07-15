#requires -Version 7.0
<#
.SYNOPSIS
  Confirm the graphify wrapper scripts never invoke `graphify install` or any
  `graphify <platform> install` variant (Issue #833, AC#1 / AC#7).
.DESCRIPTION
  scripts/graphify/lib/Resolve-GraphifyEnv.ps1 is the single point that shells out to the real
  `graphify` executable (via Invoke-GraphifyCommand). This guard checks two things:
    1. Every leaf entrypoint (build-graph.ps1, refresh-graph.ps1, query-graph.ps1,
       query-graph.mjs) never invokes the graphify executable directly (must go through
       Invoke-GraphifyCommand) and never contains the word "install" outside a comment.
    2. The single enforcement point still restricts the allowed subcommand set to exactly
       {extract, update} (ValidateSet) and still rejects any argument that looks like an
       install-family subcommand at runtime.
.PARAMETER RepoRoot
  Override the repo root to scan (used by the negative-regression test fixture). Defaults to the
  real repo root two levels above this script.
#>
param(
    [string]$RepoRoot = ''
)
$ErrorActionPreference = 'Stop'
$Root = if ($RepoRoot) { $RepoRoot } else { Split-Path -Parent (Split-Path -Parent $PSScriptRoot) }

$LeafRelativePaths = @(
    'scripts/graphify/build-graph.ps1',
    'scripts/graphify/refresh-graph.ps1',
    'scripts/graphify/query-graph.ps1',
    'scripts/graphify/query-graph.mjs'
)
$EnforcementRelativePath = 'scripts/graphify/lib/Resolve-GraphifyEnv.ps1'

$violations = New-Object System.Collections.Generic.List[string]

function Get-NonCommentLines {
    param([string]$Path)
    $lines = Get-Content -LiteralPath $Path
    $inBlockComment = $false
    $result = New-Object System.Collections.Generic.List[psobject]
    for ($i = 0; $i -lt $lines.Count; $i++) {
        $line = $lines[$i]
        if ($inBlockComment) {
            if ($line -match '#>') { $inBlockComment = $false }
            continue
        }
        if ($line -match '<#') {
            if ($line -notmatch '#>') { $inBlockComment = $true }
            continue
        }
        if ($line -match '^\s*#') { continue }
        if ($line -match '^\s*//') { continue }
        $result.Add([pscustomobject]@{ LineNumber = $i + 1; Text = $line })
    }
    return $result
}

foreach ($rel in $LeafRelativePaths) {
    $path = Join-Path $Root $rel
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        $violations.Add("$rel :: missing in-scope file")
        continue
    }
    foreach ($entry in (Get-NonCommentLines -Path $path)) {
        if ($entry.Text -match '&\s*\$exe\b') {
            $violations.Add("$rel`:$($entry.LineNumber): invokes the graphify executable directly, bypassing Invoke-GraphifyCommand: $($entry.Text.Trim())")
        }
        if ($entry.Text -match '(?i)\binstall\b') {
            $violations.Add("$rel`:$($entry.LineNumber): contains the word 'install' outside a comment: $($entry.Text.Trim())")
        }
    }
}

$enforcementPath = Join-Path $Root $EnforcementRelativePath
if (-not (Test-Path -LiteralPath $enforcementPath -PathType Leaf)) {
    $violations.Add("$EnforcementRelativePath :: missing enforcement file")
} else {
    $enforcementText = Get-Content -LiteralPath $enforcementPath -Raw
    if ($enforcementText -notmatch "ValidateSet\('extract',\s*'update'\)") {
        $violations.Add("$EnforcementRelativePath :: allowed-subcommand ValidateSet must be exactly ('extract', 'update')")
    }
    if ($enforcementText -notmatch '\binstall\b') {
        $violations.Add("$EnforcementRelativePath :: runtime guard must reject arguments matching an install-family pattern")
    }
}

if ($violations.Count -gt 0) {
    Write-Host '[FAIL] graphify no-installer scan (Issue #833 AC#1/AC#7):'
    foreach ($v in $violations) { Write-Host "  - $v" }
    exit 1
}

Write-Host '[PASS] graphify wrapper scripts never invoke graphify install / <platform> install (Issue #833 AC#1/AC#7)'
exit 0
