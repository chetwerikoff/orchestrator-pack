#requires -Version 5.1
<#
.SYNOPSIS
  Regression guard: orchestratorRules document the failed+zero-findings trap.
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$example = Join-Path $Root 'agent-orchestrator.yaml.example'
$text = Get-Content -LiteralPath $example -Raw

$required = @(
    'EMPTY REVIEW TRAP',
    'findingCount 0 on failed',
    'terminationReason',
    'orchestrator-diagnose.ps1'
)

$missing = @($required | Where-Object { $text -notlike "*$_*" })
if ($text -notlike '*invoke-pack-review.ps1*' -and $text -notlike '*run-pack-review.ps1*') {
    $missing += 'invoke-pack-review.ps1 or run-pack-review.ps1'
}
if ($missing.Count -gt 0) {
    Write-Host ("agent-orchestrator.yaml.example missing review empty-trap phrases: {0}" -f ($missing -join ', '))
    exit 1
}

Write-Host '[PASS] orchestratorRules documents empty-review trap and diagnose routing'
exit 0
