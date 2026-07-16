#requires -Version 7.0
<#
.SYNOPSIS
  Repo-side pre-upgrade gates for AO 0.10.x operator adoption (Issue #590).

.DESCRIPTION
  Runs pack-owned checks that do not require installing the target AO binary.
  Live install, restart, and target-version CLI probes belong to the operator
  post-merge checklist in docs/ao-0-10-operator-upgrade-runbook.md.
#>
[CmdletBinding()]
param(
    [string]$RepoRoot,
    [string]$FactsFile
)

$ErrorActionPreference = 'Stop'
$Root = if ($RepoRoot) { (Resolve-Path $RepoRoot).Path } else { Split-Path -Parent $PSScriptRoot }
$FactsPath = if ($FactsFile) {
    (Resolve-Path $FactsFile).Path
} else {
    Join-Path $Root 'scripts/fixtures/ao-operator-upgrade/v0.10.2-release-facts.json'
}

function Write-Step {
    param([string]$Name, [string]$Status, [string]$Detail = '')
    $suffix = if ($Detail) { " — $Detail" } else { '' }
    Write-Host "[$Status] $Name$suffix"
}

$failures = @()

if (-not (Test-Path -LiteralPath $FactsPath -PathType Leaf)) {
    Write-Step 'release-facts.json' 'FAIL' "missing $FactsPath"
    exit 1
}

try {
    $facts = Get-Content -LiteralPath $FactsPath -Raw | ConvertFrom-Json
} catch {
    Write-Step 'release-facts.json' 'FAIL' $_.Exception.Message
    exit 1
}

if (-not $facts.selectedRelease.tag) {
    $failures += 'release-facts.json missing selectedRelease.tag'
}
if (-not $facts.npmInstallability) {
    $failures += 'release-facts.json missing npmInstallability'
}
if ($facts.npmInstallability.targetVersionAvailable -eq $true) {
    $failures += 'release-facts.json still claims npm can install the target version'
}

$ghCommand = Get-Command gh -ErrorAction SilentlyContinue
if (-not $ghCommand) {
    $failures += 'gh not found on PATH'
} else {
    $ghPath = $ghCommand.Source
    $expectedGh = Join-Path $Root 'scripts/gh'
    if ($ghPath -ne $expectedGh) {
        $failures += "which gh resolves to $ghPath (expected pack wrapper $expectedGh)"
    } else {
        Write-Step 'pack gh wrapper' 'PASS' $ghPath
    }
}

$spawnShape = Join-Path $Root 'scripts/check-ao-spawn-shape.ps1'
if (-not (Test-Path -LiteralPath $spawnShape -PathType Leaf)) {
    $failures += 'missing scripts/check-ao-spawn-shape.ps1'
} else {
  Push-Location $Root
  try {
    & pwsh -NoProfile -File $spawnShape
    if ($LASTEXITCODE -ne 0) {
      $failures += 'check-ao-spawn-shape.ps1 failed (Issue #589 prerequisite)'
    } else {
      Write-Step 'spawn-name prerequisite (#589)' 'PASS'
    }
  } finally {
    Pop-Location
  }
}

$gateRunner = Join-Path $Root 'scripts/gate-runner/runner.ts'
if (-not (Test-Path -LiteralPath $gateRunner -PathType Leaf)) {
    $failures += 'missing scripts/gate-runner/runner.ts'
} else {
  Push-Location $Root
  try {
    & node --experimental-strip-types $gateRunner --repo-root $Root --gate external-output-shape-guard
    if ($LASTEXITCODE -ne 0) {
      $failures += 'external-output-shape-guard runner entrypoint failed (Issue #223 baseline)'
    } else {
      Write-Step 'external-output shape guard (#223)' 'PASS' 'current corpus'
    }
  } finally {
    Pop-Location
  }
}

$reviewerStatus = Join-Path $Root 'scripts/show-pack-reviewer-status.ps1'
if (Test-Path -LiteralPath $reviewerStatus -PathType Leaf) {
    & pwsh -NoProfile -File $reviewerStatus | Out-Host
    Write-Step 'PACK_REVIEWER status' 'INFO' 'confirm effective reviewer before live upgrade'
} else {
    $failures += 'missing scripts/show-pack-reviewer-status.ps1'
}

Write-Host ''
Write-Host "Selected target: $($facts.selectedRelease.tag) ($($facts.selectedRelease.publishedAt))"
Write-Host "npm install path: $($facts.npmInstallability.installPath)"
Write-Host ''
Write-Host 'Operator-only gates (not run here):'
Write-Host '  - ao --version through pack-resolved command path'
Write-Host '  - ao spawn --help confirms --project and --name'
Write-Host '  - output-shape sweep against target AO binary (see runbook)'
Write-Host '  - stale-session smoke (upstream PR #2320 / #2350 class)'
Write-Host ''
Write-Host "Runbook: docs/ao-0-10-operator-upgrade-runbook.md"

if ($failures.Count -gt 0) {
    Write-Host ''
    Write-Host 'Failures:'
    foreach ($item in $failures) {
        Write-Host "  - $item"
    }
    exit 1
}

Write-Step 'repo-side pre-upgrade preflight' 'PASS'
exit 0
