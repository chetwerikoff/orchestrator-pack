#requires -Version 5.1
<#
.SYNOPSIS
  Registry children[].id must appear in the wake-supervisor fleet operator reference (Issue #702).
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$RegistryPath = Join-Path $Root 'scripts/orchestrator-side-process-registry.json'
$DocPath = Join-Path $Root 'docs/wake-supervisor-fleet-operator-reference.md'

if (-not (Test-Path -LiteralPath $RegistryPath -PathType Leaf)) {
    Write-Host "[FAIL] missing registry: $RegistryPath"
    exit 1
}
if (-not (Test-Path -LiteralPath $DocPath -PathType Leaf)) {
    Write-Host "[FAIL] missing fleet operator doc: $DocPath"
    exit 1
}

$registry = Get-Content -LiteralPath $RegistryPath -Raw | ConvertFrom-Json
$doc = Get-Content -LiteralPath $DocPath -Raw
$errors = @()

foreach ($child in @($registry.children)) {
    $id = [string]$child.id
    if (-not $id) { continue }
    if ($doc -notmatch [regex]::Escape($id)) {
        $errors += "missing registry child id in doc: $id"
    }
    $heading = "### $id"
    if ($doc -notmatch [regex]::Escape($heading)) {
        $errors += "missing section heading: $heading"
    }
}

foreach ($fleetId in @('F1', 'F1b', 'F2')) {
    if ($doc -notmatch [regex]::Escape("### $fleetId")) {
        $errors += "missing fleet scenario section: ### $fleetId"
    }
}

$updateSection = 'When to update this document'
if ($doc -notmatch [regex]::Escape($updateSection)) {
    $errors += "missing update-trigger section: $updateSection"
}

if ($errors.Count -gt 0) {
    Write-Host '[FAIL] wake-supervisor fleet doc coverage'
    $errors | ForEach-Object { Write-Host "  - $_" }
    exit 1
}

Write-Host "[PASS] wake-supervisor fleet doc covers $($registry.children.Count) registry children + F1/F1b/F2"
exit 0
