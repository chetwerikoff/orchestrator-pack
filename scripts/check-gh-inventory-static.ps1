#requires -Version 5.1
<#
.SYNOPSIS
  Static guard: gh read forms in pack scripts and agent-facing rule surfaces are REST-covered (Issues #431, #501).
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$GuardScript = Join-Path $Root 'scripts/lib/gh-inventory-static-guard.mjs'

function Invoke-GhInventoryGuard {
    param(
        [string]$FilePath,
        [ValidateSet('reconcile', 'rules')]
        [string]$Mode
    )

    if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) {
        return @()
    }

    $output = & node $GuardScript $FilePath --mode $Mode 2>&1
    if ($LASTEXITCODE -eq 0) {
        return @()
    }

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
    (Join-Path $Root 'scripts/lib/Get-AutoReviewPrContext.ps1')
)

$ruleSurfaceRoots = @(
    (Join-Path $Root 'prompts/agent_rules.md'),
    (Join-Path $Root 'agent-orchestrator.yaml.example')
)

$violations = @()
foreach ($file in $reconcileRoots) {
    $violations += Invoke-GhInventoryGuard -FilePath $file -Mode 'reconcile'
}
foreach ($file in $ruleSurfaceRoots) {
    $violations += Invoke-GhInventoryGuard -FilePath $file -Mode 'rules'
}

if ($violations.Count -gt 0) {
    Write-Host '[FAIL] gh read forms not REST-covered by inventory classifier:'
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

Write-Host '[PASS] gh inventory static guard (classifier-derived; Issues #431, #501)'
exit 0
