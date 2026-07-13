#requires -Version 5.1
<#
.SYNOPSIS
  Regression guard: Issue #207 review wake-trigger primitives after Issue #745 listener retirement.
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$listenerScript = Join-Path $Root 'scripts/orchestrator-wake-listener.ps1'
$triggerMjs = Join-Path $Root 'docs/review-wake-trigger.mjs'
$triggerLib = Join-Path $Root 'scripts/lib/Invoke-ReviewWakeTrigger.ps1'
$admissionMjs = Join-Path $Root 'docs/review-handoff-wake-admission.mjs'
$admissionLib = Join-Path $Root 'scripts/lib/Record-ReviewHandoffWakeAdmission.ps1'
$supervisorLib = Join-Path $Root 'scripts/lib/Orchestrator-SideProcessSupervisor.ps1'
$registryPath = Join-Path $Root 'scripts/orchestrator-side-process-registry.json'
$scriptOwnedDoc = Join-Path $Root 'docs/script-owned-review-pipeline.md'
$wakeRunbook = Join-Path $Root 'docs/orchestrator-wake-runbook.md'

if (Test-Path -LiteralPath $listenerScript -PathType Leaf) {
    Write-Host 'orchestrator-wake-listener.ps1 must remain retired after the zero-traffic Issue #745 probe'
    exit 1
}

foreach ($path in @($triggerMjs, $triggerLib, $admissionMjs, $admissionLib, $supervisorLib, $registryPath, $scriptOwnedDoc, $wakeRunbook)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        Write-Host "Missing required surviving review-trigger surface: $path"
        exit 1
    }
}

$admissionText = Get-Content -LiteralPath $admissionMjs -Raw
if ($admissionText -notmatch 'isQualifiedReviewPendingInfoHandoffEnvelope') {
    Write-Host 'review-handoff-wake-admission.mjs must preserve review.pending(info) envelope classification'
    exit 1
}
if ($admissionText -notmatch "REVIEW_PENDING_HANDOFF_EVENT_TYPE = 'review\.pending'") {
    Write-Host 'review-handoff-wake-admission.mjs must bind the review.pending event discriminator'
    exit 1
}

$triggerLibText = Get-Content -LiteralPath $triggerLib -Raw
if ($triggerLibText -notmatch 'Invoke-ReviewerWorkspacePreflight\.ps1' -or
    $triggerLibText -notmatch 'Invoke-ReviewerWorkspacePreflight -RepoRoot') {
    Write-Host 'Invoke-ReviewWakeTrigger.ps1 must retain reviewer workspace preflight composition'
    exit 1
}
if ($triggerLibText -notmatch 'handoff receipt bound exceeded before review run') {
    Write-Host 'Invoke-ReviewWakeTrigger.ps1 must retain the handoff receipt bound before review run'
    exit 1
}
$preflightIdx = $triggerLibText.IndexOf('Invoke-ReviewerWorkspacePreflight -RepoRoot')
$receiptIdx = $triggerLibText.IndexOf('handoff receipt bound exceeded before review run')
if ($preflightIdx -lt 0 -or $receiptIdx -lt 0 -or $preflightIdx -gt $receiptIdx) {
    Write-Host 'Invoke-ReviewWakeTrigger.ps1 must recheck the handoff receipt after workspace preflight'
    exit 1
}
if ($triggerLibText -notmatch 'Test-ReviewWakeTriggerForbiddenCommand') {
    Write-Host 'Invoke-ReviewWakeTrigger.ps1 must retain the mechanical forbidden-command guard'
    exit 1
}

$mechanicalLoader = 'Get-Mechanical' + 'JsonStateFile'
if ((Get-Content -LiteralPath $admissionLib -Raw) -notmatch [regex]::Escape($mechanicalLoader)) {
    Write-Host 'Record-ReviewHandoffWakeAdmission.ps1 must retain mechanical JSON state loading'
    exit 1
}

$mjs = Get-Content -LiteralPath $triggerMjs -Raw
if ($mjs -notmatch 'MECHANICAL_FORBIDDEN_REVIEW_WAKE') {
    Write-Host 'docs/review-wake-trigger.mjs must retain forbidden review-wake command classification'
    exit 1
}
if ($mjs -notmatch 'WAKE_TO_RUN_DECISION_MAX_MS = 5_000') {
    Write-Host 'docs/review-wake-trigger.mjs must retain the five-second decision bound'
    exit 1
}
if ($mjs -notmatch "from '\./review-head-ready\.mjs'") {
    Write-Host 'docs/review-wake-trigger.mjs must compose review-head-ready.mjs'
    exit 1
}

$registry = Get-Content -LiteralPath $registryPath -Raw | ConvertFrom-Json
if (@($registry.requiredChildIds) -contains 'listener' -or
    @($registry.children | Where-Object { [string]$_.id -eq 'listener' }).Count -gt 0) {
    Write-Host 'orchestrator-side-process-registry.json must not reintroduce the retired listener'
    exit 1
}
if ((Get-Content -LiteralPath $supervisorLib -Raw) -notmatch 'Get-OrchestratorWakeSupervisorChildRegistry') {
    Write-Host 'Orchestrator-SideProcessSupervisor.ps1 must continue loading the registry-defined fleet'
    exit 1
}

if ((Get-Content -LiteralPath $scriptOwnedDoc -Raw) -notlike '*event-driven review trigger*') {
    Write-Host 'docs/script-owned-review-pipeline.md must preserve the historical trigger ownership section'
    exit 1
}
$runbook = Get-Content -LiteralPath $wakeRunbook -Raw
if ($runbook -notmatch 'review-trigger-reconcile' -or $runbook -notmatch 'listener.*retired|retired.*listener') {
    Write-Host 'docs/orchestrator-wake-runbook.md must document periodic review coverage and listener retirement'
    exit 1
}

Write-Host '[PASS] review wake-trigger primitives retained; listener entrypoint retired (Issues #207 / #745)'
exit 0
