#requires -Version 5.1
<#
.SYNOPSIS
  Static guard: GitHub read forms in pack scripts and agent-facing rule surfaces
  are covered by the tracked REST inventory, and bounded production surfaces do
  not select ambient gh as their executable.
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$GuardScript = Join-Path $Root 'scripts/lib/gh-inventory-static-guard.mjs'
$InventoryScript = Join-Path $Root 'scripts/lib/graphql-quota-github-read-inventory.mjs'

function Invoke-GhInventoryGuard {
    param(
        [string]$FilePath,
        [ValidateSet('reconcile', 'rules', 'transport')]
        [string]$Mode
    )

    if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) { return @() }

    $output = & node $GuardScript $FilePath --mode $Mode 2>&1
    if ($LASTEXITCODE -eq 0) { return @() }

    try {
        return @($output | ConvertFrom-Json)
    }
    catch {
        throw "gh inventory guard failed for ${FilePath}: $output"
    }
}

$reconcileRoots = @(
    (Join-Path $Root 'scripts/lib/Gh-PrChecks.ps1'),
    (Join-Path $Root 'scripts/pr-scope-check.ps1'),
    (Join-Path $Root 'scripts/lib/Get-AutoReviewPrContext.ps1'),
    (Join-Path $Root 'scripts/worker-smoke-run.ts')
)

$ruleSurfaceRoots = @(
    (Join-Path $Root 'AGENTS.md'),
    (Join-Path $Root 'CLAUDE.md'),
    (Join-Path $Root 'prompts/investigate_root_cause.md'),
    (Join-Path $Root 'docs/pack-review-waiver-merge-runbook.md')
)

$transportRoots = @(
    (Join-Path $Root 'scripts/lib/pack-gpt-reviewer.ts'),
    (Join-Path $Root 'scripts/pack-review-runner.ts'),
    (Join-Path $Root 'scripts/lib/pack-gpt-source-comment.ts'),
    (Join-Path $Root 'scripts/lib/github-review-reconciliation.ts'),
    (Join-Path $Root 'scripts/lib/pack-review-delivery.ts'),
    (Join-Path $Root 'scripts/worker-smoke-run.ts'),
    (Join-Path $Root 'scripts/lib/worker-smoke-core-base.ts'),
    (Join-Path $Root 'scripts/invoke-reviewer-contract-mapping.ts'),
    (Join-Path $Root 'plugins/codex-pr-reviewer/lib/scope_context.ts')
)

$violations = @()
foreach ($file in $reconcileRoots) {
    $violations += Invoke-GhInventoryGuard -FilePath $file -Mode 'reconcile'
}
foreach ($file in $ruleSurfaceRoots) {
    $violations += Invoke-GhInventoryGuard -FilePath $file -Mode 'rules'
}
foreach ($file in $transportRoots) {
    $violations += Invoke-GhInventoryGuard -FilePath $file -Mode 'transport'
}

if ($violations.Count -gt 0) {
    Write-Host '[FAIL] GitHub read inventory / tracked transport guard:'
    foreach ($item in $violations) {
        if ($item.line) {
            Write-Host "$($item.file): $($item.command) :: $($item.line)"
        }
        else {
            Write-Host "$($item.file): $($item.command)"
        }
    }
    exit 1
}

$inventoryOutput = & node $InventoryScript validate $Root 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host '[FAIL] GitHub read inventory completeness:'
    Write-Host $inventoryOutput
    exit 1
}

Write-Host '[PASS] GitHub read inventory static guard'
exit 0
