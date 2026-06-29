#requires -Version 5.1
<#
  Guard: automated review-start surfaces route mandatory preflight gh through supervised gateway (Issue #516).
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $Root 'scripts/review-start-envelope-ledger-starter-surfaces.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    Write-Host "[FAIL] missing starter-surface manifest: $manifestPath"
    exit 1
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$markers = @($manifest.mandatoryPreflightMarkers)
$violations = @()

foreach ($surface in @($manifest.surfaces)) {
    $rel = ([string]$surface.path).Replace('\', '/')
    $full = Join-Path $Root $rel
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
        $violations += "missing starter surface file: $rel"
        continue
    }
    $text = Get-Content -LiteralPath $full -Raw
    $matched = $false
    foreach ($marker in $markers) {
        if ($text -match [regex]::Escape([string]$marker)) {
            $matched = $true
            break
        }
    }
    if (-not $matched) {
        $violations += "$rel ($($surface.id)) missing supervised preflight marker: $($markers -join ' | ')"
    }
}

if ($violations.Count -gt 0) {
    Write-Host '[FAIL] review-start envelope ledger starter-surface guard:'
    $violations | ForEach-Object { Write-Host " - $_" }
    exit 1
}

Write-Host '[PASS] review-start envelope ledger starter-surface guard'
exit 0
