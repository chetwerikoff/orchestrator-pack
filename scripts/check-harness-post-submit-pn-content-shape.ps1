#requires -Version 5.1
<#
.SYNOPSIS
  Regression guard: post-submit harness [Pn] content-shape enforcement (Issue #683).
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot

$required = @(
    'docs/harness-post-submit-pn-content-shape.mjs',
    'docs/scripted-review-confirmed-delivery-gate.mjs',
    'scripts/harness-post-submit-pn-reconcile.ps1',
    'scripts/lib/Harness-PnRetriggerState.ps1',
    'scripts/lib/Invoke-ScriptedReviewDeliveryExplicitSend.ps1',
    'scripts/check-harness-post-submit-pn-live-smoke.ps1',
    'scripts/harness-post-submit-pn-content-shape.test.ts',
    '.github/workflows/harness-pn-live-smoke.yml',
    'tests/fixtures/harness-post-submit-pn/matrix.json',
    'tests/fixtures/harness-post-submit-pn/pretrigger-reviewers-unset-boundary.json'
)
foreach ($rel in $required) {
    $path = Join-Path $Root $rel
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        Write-Host "Missing required file: $rel"
        exit 1
    }
}

$gateMjs = Get-Content -LiteralPath (Join-Path $Root 'docs/scripted-review-confirmed-delivery-gate.mjs') -Raw
if ($gateMjs -notmatch 'harness-post-submit-pn-content-shape\.mjs') {
    Write-Host 'confirmed-delivery gate must import harness post-submit content-shape stage'
    exit 1
}
if ($gateMjs -notmatch 'GATE_ACTION_REJECT_RETRIGGER') {
    Write-Host 'confirmed-delivery gate must define reject_retrigger terminal action'
    exit 1
}
if ($gateMjs -notmatch 'evaluateHarnessContentShapeStage' -or $gateMjs -notmatch 'shouldRunHarnessContentShapeStage') {
    Write-Host 'confirmed-delivery gate must run content-shape on the existing poll snapshot'
    exit 1
}

$gatePs1 = Get-Content -LiteralPath (Join-Path $Root 'scripts/scripted-review-confirmed-delivery-gate.ps1') -Raw
if ($gatePs1 -notmatch 'harnessContentShape\s*=\s*\$true') {
    Write-Host 'confirmed-delivery gate must enable harnessContentShape on poll-step payloads'
    exit 1
}
if ($gatePs1 -notmatch 'Resolve-HarnessPnRetriggerCount') {
    Write-Host 'confirmed-delivery gate must restore persisted harness retrigger count'
    exit 1
}
if ($gatePs1 -notmatch 'harness-post-submit-pn-reconcile\.ps1') {
    Write-Host 'confirmed-delivery gate must delegate reject_retrigger to harness-post-submit-pn-reconcile.ps1'
    exit 1
}

$reconcile = Get-Content -LiteralPath (Join-Path $Root 'scripts/harness-post-submit-pn-reconcile.ps1') -Raw
if ($reconcile -notmatch 'Get-AoSessionReviewsJson' -or $reconcile -notmatch 'Invoke-AoReviewTriggerForWorker') {
    Write-Host 'harness post-submit reconcile must use AO HTTP review list/trigger helpers'
    exit 1
}
if ($reconcile -notmatch 'Set-HarnessPnRetriggerCount') {
    Write-Host 'harness post-submit reconcile must persist retrigger count across reruns'
    exit 1
}
if ($reconcile -notmatch 'Resolve-HarnessPnRetriggerCount') {
    Write-Host 'harness post-submit reconcile must restore persisted retrigger count'
    exit 1
}
if ($reconcile -notmatch "action -eq 'send'" -or $reconcile -match "suppress'\s+-or\s+\`$action\s+-eq\s+'send'") {
    Write-Host 'harness post-submit reconcile must dispatch explicit delivery on send terminal'
    exit 1
}
if ($reconcile -notmatch 'Invoke-HarnessPnReconcileExplicitSend' -or $reconcile -notmatch 'Complete-HarnessPnReconcileAfterExplicitSend') {
    Write-Host 'harness post-submit reconcile must complete explicit send after content-valid reconcile'
    exit 1
}
if ($gatePs1 -notmatch '-DeliveryMessage') {
    Write-Host 'confirmed-delivery gate must forward delivery message to harness reconcile child'
    exit 1
}

$shapeMjs = Get-Content -LiteralPath (Join-Path $Root 'docs/harness-post-submit-pn-content-shape.mjs') -Raw
if ($shapeMjs -notmatch 'isHarnessLatestRun\(attribution\?\.latestRun\)') {
    Write-Host 'content-shape stage must run only for harness latestRun rows'
    exit 1
}
if ($reconcile -match '(?:Read-|Open-|sqlite3|SELECT\s+).{0,20}ao\.db') {
    Write-Host 'harness post-submit reconcile must not read ao.db directly'
    exit 1
}

$liveSmoke = Get-Content -LiteralPath (Join-Path $Root 'scripts/check-harness-post-submit-pn-live-smoke.ps1') -Raw
if ($liveSmoke -notmatch 'Get-AoDaemonHealthJson' -or $liveSmoke -notmatch 'exit 1') {
    Write-Host 'live harness [Pn] smoke must require a real AO daemon and fail closed'
    exit 1
}
if ($liveSmoke -match '\[SKIP\] live harness \[Pn\] smoke not operator-enabled' -or $liveSmoke -match 'Test-HarnessPnLiveSmokeRequired') {
    Write-Host 'live harness [Pn] smoke must fail closed instead of skipping when operator env is unset'
    exit 1
}
$workflow = Get-Content -LiteralPath (Join-Path $Root '.github/workflows/harness-pn-live-smoke.yml') -Raw
if ($workflow -match '(?m)^\s*if:\s*.*PACK_HARNESS_PN_SMOKE_ENABLED') {
    Write-Host 'live harness [Pn] smoke workflow must not skip the job via operator-only if guard'
    exit 1
}
if ($workflow -notmatch 'PACK_HARNESS_PN_SMOKE_ENABLED') {
    Write-Host 'live harness [Pn] smoke workflow must pass PACK_HARNESS_PN_SMOKE_ENABLED to the script'
    exit 1
}
if ($workflow -notmatch 'check-harness-post-submit-pn-live-smoke.ps1') {
    Write-Host 'live harness [Pn] smoke workflow must run the live smoke script'
    exit 1
}
if ($workflow -notmatch 'pull_request:') {
    Write-Host 'live harness [Pn] smoke workflow must run on pull_request for merge-blocking PR checks'
    exit 1
}
if ($workflow -notmatch 'if:\s*\$\{\{\s*vars\.PACK_HARNESS_PN_SMOKE_SESSION') {
    Write-Host 'live harness [Pn] smoke workflow must gate the job on PACK_HARNESS_PN_SMOKE_SESSION'
    exit 1
}
if ($workflow -notmatch 'PACK_HARNESS_PN_SMOKE_SESSION') {
    Write-Host 'live harness [Pn] smoke workflow must pass PACK_HARNESS_PN_SMOKE_SESSION to the script'
    exit 1
}

$harnessAdoption = Get-Content -LiteralPath (Join-Path $Root 'docs/ao-0-10-review-harness-adoption.md') -Raw
if ($harnessAdoption -match 'must run the pack JSONL bridge before') {
    Write-Host 'ao-0-10-review-harness-adoption.md must not require pre-submit bridge as enforcement'
    exit 1
}
if ($harnessAdoption -notmatch 'post-submit') {
    Write-Host 'ao-0-10-review-harness-adoption.md must document post-submit [Pn] enforcement (#683)'
    exit 1
}

$fixtureText = Get-Content -LiteralPath (Join-Path $Root 'tests/fixtures/harness-post-submit-pn/matrix.json') -Raw
foreach ($name in @(
        'prose-complete-reject-retrigger',
        'delivered-prose-supersede-converge',
        'mapper-accept',
        'clean-accept',
        'empty-lgtm-reject',
        'failed-never-accept',
        'running-wait-624',
        'contradictory-fail-closed',
        'ambiguous-escalate',
        'bound-exhaustion-escalate'
    )) {
    if ($fixtureText -notmatch [regex]::Escape($name)) {
        Write-Host "missing matrix cell: $name"
        exit 1
    }
}
if ($fixtureText -match 'soft instruction|best effort|warn-only|may accept') {
    Write-Host 'content-shape fixtures must not encode soft instruction escape hatches'
    exit 1
}

Write-Host '[PASS] harness post-submit [Pn] content-shape enforcement (Issue #683)'
exit 0
