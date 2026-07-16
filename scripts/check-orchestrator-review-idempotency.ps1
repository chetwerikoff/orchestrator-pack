#requires -Version 5.1
<#
.SYNOPSIS
  Regression guard: orchestratorRules require pack-owned review-run idempotency (Issue #98, #189, #625, #839).
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$example = Join-Path $Root 'agent-orchestrator.yaml.example'
$text = Get-Content -LiteralPath $example -Raw

$required = @(
    'REVIEW RUN IDEMPOTENCY',
    'current PR head sha',
    'do not spawn a new run',
    'covered terminal',
    'up_to_date',
    'changes_requested',
    'PRE-RUN COVERAGE RE-CHECK',
    'pack review runner',
    'pack-side run/status store',
    'Get-AoReviewRuns pack-store view'
)

$missing = @($required | Where-Object { $text -notlike "*$_*" })
if ($text -like '*ao-review list*' -or $text -like '*Get-AoReviewRuns fan-out*') {
    $missing += 'retired daemon review-list wording still present'
}
if ($missing.Count -gt 0) {
    Write-Host ("agent-orchestrator.yaml.example missing pack-owned idempotency phrases: {0}" -f ($missing -join ', '))
    exit 1
}

Write-Host '[PASS] orchestratorRules documents pack-store review idempotency before pack review runner start'
exit 0
