#requires -Version 5.1
<#
.SYNOPSIS
  Regression guard: Issue #171 review-finding delivery confirmation defaults and runbook.
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$scriptPath = Join-Path $Root 'scripts/review-finding-delivery-confirm.ps1'
$mjsPath = Join-Path $Root 'docs/review-finding-delivery-confirm.mjs'
$runbook = Join-Path $Root 'docs/orchestrator-recovery-runbook.md'

if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
    Write-Host 'Missing scripts/review-finding-delivery-confirm.ps1'
    exit 1
}

if (-not (Test-Path -LiteralPath $mjsPath -PathType Leaf)) {
    Write-Host 'Missing docs/review-finding-delivery-confirm.mjs'
    exit 1
}

$mjs = Get-Content -LiteralPath $mjsPath -Raw
if ($mjs -notmatch 'DEFAULT_CONFIRMATION_WINDOW_MS = 5 \* 60 \* 1000') {
    Write-Host 'docs/review-finding-delivery-confirm.mjs must default to 5-minute confirmation window'
    exit 1
}

if ($mjs -notmatch 'DEFAULT_MAX_REDELIVERIES = 2') {
    Write-Host 'docs/review-finding-delivery-confirm.mjs must default to 2 max redeliveries'
    exit 1
}

if ($mjs -notmatch "PENDING_SENT_DELIVERY_STATUSES[\s\S]*'sent_to_agent'") {
    Write-Host 'docs/review-finding-delivery-confirm.mjs must treat sent_to_agent as pending sent delivery'
    exit 1
}

if ($mjs -notmatch 'export \{ sessionOwnsRunHead \}' -or $mjs -notmatch 'sessionOwnsRunHead\(session, prNumber') {
    Write-Host 'docs/review-finding-delivery-confirm.mjs must verify linked session owns run targetSha'
    exit 1
}

$ps1 = Get-Content -LiteralPath $scriptPath -Raw
if ($ps1 -notmatch 'gh pr list failed \(exit') {
    Write-Host 'scripts/review-finding-delivery-confirm.ps1 must fail tick when gh pr list fails'
    exit 1
}

if ($ps1 -notmatch '\$tickFailed = \$true' -or $ps1 -notmatch 'if \(\$Once -and \$tickFailed\)') {
    Write-Host 'scripts/review-finding-delivery-confirm.ps1 must exit 1 on -Once when a live tick fails; loop continues otherwise'
    exit 1
}

if ($ps1 -notmatch 'Save-PartialDeliveryTracking') {
    Write-Host 'scripts/review-finding-delivery-confirm.ps1 must persist tracking after each applied action'
    exit 1
}

$runbookText = Get-Content -LiteralPath $runbook -Raw
$runbookRequired = @(
    'review-finding-delivery-confirm',
    'AO_REVIEW_DELIVERY_CONFIRM_WINDOW_MINUTES',
    'AO_REVIEW_DELIVERY_CONFIRM_MAX_REDELIVERIES',
    'AO_REVIEW_DELIVERY_CONFIRM_INTERVAL_MINUTES',
    'ESCALATION: unconfirmed delivery',
    'Operator remedy'
)

$missingRunbook = @($runbookRequired | Where-Object { $runbookText -notlike "*$_*" })
if ($missingRunbook.Count -gt 0) {
    Write-Host ("orchestrator-recovery-runbook.md missing delivery-confirm phrases: {0}" -f ($missingRunbook -join ', '))
    exit 1
}

Write-Host '[PASS] review-finding delivery confirmation entrypoint and runbook (Issue #171)'
exit 0
