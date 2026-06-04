#requires -Version 7.0
<#
.SYNOPSIS
  CI-safe static guard for coworker RTK pack passthrough manifest and merge preview (Issue #145).
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'lib/Get-RtkPassthroughManifest.ps1')

$failures = New-Object System.Collections.Generic.List[string]

function Add-Fail {
    param([string]$Message)
    $failures.Add($Message) | Out-Null
}

Write-Host '== RTK passthrough static guard (Issue #145) =='

try {
    $pack = Get-RtkPassthroughManifest -Kind 'pack' -ScriptsRoot $PSScriptRoot
    $upstream = Get-RtkPassthroughManifest -Kind 'upstream' -ScriptsRoot $PSScriptRoot
}
catch {
    Add-Fail $_.Exception.Message
    $pack = $null
    $upstream = $null
}

if ($pack) {
    if ($pack.Patterns.Count -lt 1) {
        Add-Fail 'Pack manifest has no patterns'
    }

    $dupes = $pack.Patterns | Group-Object | Where-Object { $_.Count -gt 1 }
    if ($dupes) {
        Add-Fail ('Duplicate pack patterns: {0}' -f (($dupes | ForEach-Object { $_.Name }) -join ', '))
    }

    $familyGaps = @(Test-RtkPackFamilyCoverage -ManifestPatterns $pack.Patterns)
    foreach ($gap in $familyGaps) {
        Add-Fail "Canonical family checklist: $gap"
    }

    if ($upstream) {
        foreach ($pattern in $pack.Patterns) {
            if ($upstream.Patterns -contains $pattern) {
                Add-Fail "Pack pattern duplicates upstream snapshot (helper must not apply upstream): $pattern"
            }
        }
        if ($upstream.Patterns.Count -ne 13) {
            Add-Fail ("Upstream-default snapshot must list 13 patterns (found {0})" -f $upstream.Patterns.Count)
        }
    }
}

$applyScript = Join-Path $PSScriptRoot 'apply-coworker-rtk-passthrough.ps1'
if (-not (Test-Path -LiteralPath $applyScript -PathType Leaf)) {
    Add-Fail 'Missing scripts/apply-coworker-rtk-passthrough.ps1'
}
else {
    $previewLines = @(pwsh -NoProfile -File $applyScript -WhatIf 2>&1)
    if ($LASTEXITCODE -ne 0) {
        Add-Fail "Merge preview (-WhatIf) failed: exit=$LASTEXITCODE"
    }
    elseif ($pack) {
        foreach ($pattern in $pack.Patterns) {
            $needle = "passthrough add '$pattern'"
            $hit = $false
            foreach ($line in $previewLines) {
                if ($line -like "*$needle*") {
                    $hit = $true
                    break
                }
            }
            if (-not $hit) {
                Add-Fail "Merge preview missing WhatIf add for pack pattern: $pattern"
            }
        }
    }
}

if ($failures.Count -gt 0) {
    Write-Host '[FAIL] RTK passthrough static guard:'
    foreach ($f in $failures) { Write-Host "  - $f" }
    exit 1
}

Write-Host '[PASS] Pack manifest, five-family checklist, upstream snapshot, and merge preview OK.'
exit 0
