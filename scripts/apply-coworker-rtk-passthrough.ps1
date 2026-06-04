#requires -Version 7.0
<#
.SYNOPSIS
  Apply orchestrator-pack additive coworker RTK passthrough patterns (pack manifest only).

.DESCRIPTION
  Idempotent wrapper around `coworker rtk passthrough add|list|remove`.
  Never adds upstream default entries — operator coworker version owns those.

  Static (CI): use -WhatIf merge preview; no coworker binary required.
  Effective (operator): run without -WhatIf after `coworker rtk install`, before `coworker rtk enable`.

.PARAMETER WhatIf
  Print patterns that would be added; do not invoke coworker.

.PARAMETER CompareUpstream
  After listing effective passthrough, compare upstream-default manifest vs live list (informational).

.EXAMPLE
  pwsh -NoProfile -File scripts/apply-coworker-rtk-passthrough.ps1 -WhatIf
.EXAMPLE
  pwsh -NoProfile -File scripts/apply-coworker-rtk-passthrough.ps1
#>
[CmdletBinding()]
param(
    [switch]$WhatIf,

    [switch]$CompareUpstream
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/Get-RtkPassthroughManifest.ps1')

$pack = Get-RtkPassthroughManifest -Kind 'pack' -ScriptsRoot $PSScriptRoot
$patterns = @($pack.Patterns)

Write-Host "Pack passthrough manifest: $($pack.Path)"
Write-Host ('Patterns ({0}): {1}' -f $patterns.Count, ($patterns -join ', '))

if ($WhatIf) {
    foreach ($pattern in $patterns) {
        Write-Host "[WhatIf] coworker rtk passthrough add '$pattern'"
    }
    Write-Host '[WhatIf] merge preview complete (pack families only; upstream defaults not applied).'
    exit 0
}

$coworker = Get-Command coworker -ErrorAction SilentlyContinue
if (-not $coworker) {
    Write-Error 'coworker not on PATH. Install per upstream docs, run `coworker rtk install`, then re-run this script (or use -WhatIf for CI merge preview).'
}

$existingRaw = @(coworker rtk passthrough list 2>&1)
if ($LASTEXITCODE -ne 0) {
    Write-Error "coworker rtk passthrough list failed: $($existingRaw -join ' ')"
}

$existing = @($existingRaw | ForEach-Object { $_.Trim() } | Where-Object { $_ })

$added = 0
foreach ($pattern in $patterns) {
    if ($existing -contains $pattern) {
        Write-Host "[skip] already present: $pattern"
        continue
    }
    $out = @(coworker rtk passthrough add $pattern 2>&1)
    if ($LASTEXITCODE -ne 0) {
        Write-Error "coworker rtk passthrough add failed for '$pattern': $($out -join ' ')"
    }
    Write-Host "[add] $pattern"
    $added++
    $existing += $pattern
}

Write-Host ("Applied {0} new pack pattern(s); {1} total in manifest." -f $added, $patterns.Count)

if ($CompareUpstream) {
    $upstream = Get-RtkPassthroughManifest -Kind 'upstream' -ScriptsRoot $PSScriptRoot
    $upstreamPatterns = @($upstream.Patterns)
    $missingUpstream = @($upstreamPatterns | Where-Object { $existing -notcontains $_ })
    $extraUpstream = @($existing | Where-Object { $upstreamPatterns -contains $_ -and $patterns -notcontains $_ })

    if ($missingUpstream.Count -gt 0) {
        Write-Host '[drift] upstream defaults missing from effective list (informational):'
        $missingUpstream | ForEach-Object { Write-Host "  - $_" }
    }
    if ($extraUpstream.Count -gt 0) {
        Write-Host '[drift] upstream snapshot entries present (informational):'
        $extraUpstream | ForEach-Object { Write-Host "  - $_" }
    }
    if ($missingUpstream.Count -eq 0 -and $extraUpstream.Count -eq 0) {
        Write-Host '[drift] upstream-default manifest matches effective upstream entries (informational).'
    }
}

$missingPack = @(Test-RtkPackFamilyCoverage -ManifestPatterns $patterns)
if ($missingPack.Count -gt 0) {
    Write-Error ("Pack manifest fails family checklist: {0}" -f ($missingPack -join '; '))
}

$liveList = @(coworker rtk passthrough list 2>&1)
foreach ($pattern in $patterns) {
    if ($liveList -notcontains $pattern) {
        Write-Error "Effective list missing pack pattern after apply: $pattern"
    }
}

Write-Host '[PASS] All pack passthrough patterns present in effective list.'
exit 0
