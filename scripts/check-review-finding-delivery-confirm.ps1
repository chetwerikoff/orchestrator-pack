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

$dmtPath = Join-Path $Root 'docs/review-finding-delivery-confirm.d.mts'
if (-not (Test-Path -LiteralPath $dmtPath -PathType Leaf)) {
    Write-Host 'Missing docs/review-finding-delivery-confirm.d.mts'
    exit 1
}
$dmt = Get-Content -LiteralPath $dmtPath -Raw
if ($dmt -match "type: 'submit'|maxSubmits") {
    Write-Host 'docs/review-finding-delivery-confirm.d.mts must not advertise submit rung (Issue #232 owns submit)'
    exit 1
}

$submitMjs = Join-Path $Root 'docs/worker-input-draft-submit.mjs'
if (-not (Test-Path -LiteralPath $submitMjs -PathType Leaf)) {
    Write-Host 'Missing docs/worker-input-draft-submit.mjs (Issue #216)'
    exit 1
}

$submitMjsText = Get-Content -LiteralPath $submitMjs -Raw
if ($submitMjsText -notmatch 'DEFAULT_MAX_SUBMITS = 1') {
    Write-Host 'docs/worker-input-draft-submit.mjs must default to 1 max submit per run/head'
    exit 1
}

if ($mjs -notmatch "PENDING_SENT_DELIVERY_STATUSES[\s\S]*'changes_requested'") {
    Write-Host 'docs/review-finding-delivery-confirm.mjs must treat changes_requested as pending sent delivery'
    exit 1
}

if ($mjs -notmatch 'export \{ sessionOwnsRunHead \}' -or $mjs -notmatch 'sessionOwnsRunHead\(session, prNumber') {
    Write-Host 'docs/review-finding-delivery-confirm.mjs must verify linked session owns run targetSha'
    exit 1
}

$submitReconcile = Join-Path $Root 'scripts/worker-message-submit-reconcile.ps1'
if (-not (Test-Path -LiteralPath $submitReconcile -PathType Leaf)) {
    Write-Host 'Missing scripts/worker-message-submit-reconcile.ps1 (Issue #232 unified submit owner)'
    exit 1
}

$ps1 = Get-Content -LiteralPath $scriptPath -Raw
if ($ps1 -match 'Invoke-WorkerInputDraftSubmit') {
    Write-Host 'scripts/review-finding-delivery-confirm.ps1 must not invoke submit adapter — Issue #232 owns submit'
    exit 1
}

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
    'worker-message-submit-reconcile',
    'ESCALATION: unconfirmed delivery',
    'Operator remedy'
)

$missingRunbook = @($runbookRequired | Where-Object { $runbookText -notlike "*$_*" })
if ($missingRunbook.Count -gt 0) {
    Write-Host ("orchestrator-recovery-runbook.md missing delivery-confirm phrases: {0}" -f ($missingRunbook -join ', '))
    exit 1
}

Write-Host '[PASS] review-finding delivery confirmation entrypoint and runbook (Issues #171; submit owned by #232)'
exit 0
