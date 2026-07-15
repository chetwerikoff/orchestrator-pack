#requires -Version 5.1
<#
.SYNOPSIS
  Regression guard: priority-tag content-shape enforcement across pack review compatibility paths.
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
    'tests/fixtures/harness-post-submit-pn/pretrigger-reviewers-unset-boundary.json',
    'scripts/lib/Invoke-AoReviewApi.ps1',
    'scripts/pack-review-runner.ts',
    'scripts/lib/pack-review-run-store.ts'
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
    Write-Host 'confirmed-delivery gate must import the priority-tag content-shape stage'
    exit 1
}
if ($gateMjs -notmatch 'GATE_ACTION_REJECT_RETRIGGER') {
    Write-Host 'confirmed-delivery gate must define reject_retrigger terminal action'
    exit 1
}
if ($gateMjs -notmatch 'evaluateHarnessContentShapeStage' -or $gateMjs -notmatch 'shouldRunHarnessContentShapeStage') {
    Write-Host 'confirmed-delivery gate must run content-shape evaluation on the existing poll snapshot'
    exit 1
}

$gatePs1 = Get-Content -LiteralPath (Join-Path $Root 'scripts/scripted-review-confirmed-delivery-gate.ps1') -Raw
if ($gatePs1 -notmatch 'harnessContentShape\s*=\s*\$true') {
    Write-Host 'confirmed-delivery gate must enable content-shape evaluation on poll-step payloads'
    exit 1
}
if ($gatePs1 -notmatch 'Resolve-HarnessPnRetriggerCount') {
    Write-Host 'confirmed-delivery gate must restore persisted retrigger count'
    exit 1
}
if ($gatePs1 -notmatch 'harness-post-submit-pn-reconcile\.ps1') {
    Write-Host 'confirmed-delivery gate must delegate reject_retrigger to the compatibility reconcile path'
    exit 1
}

$reconcile = Get-Content -LiteralPath (Join-Path $Root 'scripts/harness-post-submit-pn-reconcile.ps1') -Raw
if ($reconcile -notmatch 'Get-AoSessionReviewsJson' -or $reconcile -notmatch 'Invoke-AoReviewTriggerForWorker') {
    Write-Host 'content-shape reconcile must use the stable pack-store read and pack-runner trigger adapters'
    exit 1
}
$adapter = Get-Content -LiteralPath (Join-Path $Root 'scripts/lib/Invoke-AoReviewApi.ps1') -Raw
if ($adapter -notmatch 'Invoke-PackReviewRunnerCli' -or $adapter -notmatch 'Get-OpkTypeScriptNodeArguments') {
    Write-Host 'stable review adapters must resolve to the pack runner with the shared TypeScript launcher'
    exit 1
}
if ($adapter -match '/reviews/trigger') {
    Write-Host 'stable review adapters must not retain the daemon trigger endpoint'
    exit 1
}
if ($reconcile -notmatch 'Set-HarnessPnRetriggerCount') {
    Write-Host 'content-shape reconcile must persist retrigger count across reruns'
    exit 1
}
if ($reconcile -notmatch 'Resolve-HarnessPnRetriggerCount') {
    Write-Host 'content-shape reconcile must restore persisted retrigger count'
    exit 1
}
if ($reconcile -notmatch "action -eq 'send'" -or $reconcile -match "suppress'\s+-or\s+\`$action\s+-eq\s+'send'") {
    Write-Host 'content-shape reconcile must dispatch explicit delivery on the send terminal'
    exit 1
}
if ($reconcile -notmatch 'Invoke-HarnessPnReconcileExplicitSend' -or $reconcile -notmatch 'Complete-HarnessPnReconcileAfterExplicitSend') {
    Write-Host 'content-shape reconcile must complete explicit send after valid content reconciliation'
    exit 1
}
if ($gatePs1 -notmatch '-DeliveryMessage') {
    Write-Host 'confirmed-delivery gate must forward the delivery message to the reconcile child'
    exit 1
}

$shapeMjs = Get-Content -LiteralPath (Join-Path $Root 'docs/harness-post-submit-pn-content-shape.mjs') -Raw
if ($shapeMjs -notmatch 'isHarnessLatestRun\(attribution\?\.latestRun\)') {
    Write-Host 'content-shape stage must run only for attributed harness latestRun rows'
    exit 1
}
if ($reconcile -match '(?:Read-|Open-|sqlite3|SELECT\s+).{0,20}ao\.db') {
    Write-Host 'content-shape reconcile must not read the AO database directly'
    exit 1
}

$liveSmoke = Get-Content -LiteralPath (Join-Path $Root 'scripts/check-harness-post-submit-pn-live-smoke.ps1') -Raw
if ($liveSmoke -notmatch 'Get-AoDaemonHealthJson' -or $liveSmoke -notmatch 'exit 1') {
    Write-Host 'live compatibility smoke must require a real AO daemon and fail closed'
    exit 1
}
if ($liveSmoke -match '\[SKIP\] live harness \[Pn\] smoke not operator-enabled' -or $liveSmoke -match 'Test-HarnessPnLiveSmokeRequired') {
    Write-Host 'live compatibility smoke must fail closed instead of silently skipping when explicitly armed'
    exit 1
}
$workflow = Get-Content -LiteralPath (Join-Path $Root '.github/workflows/harness-pn-live-smoke.yml') -Raw
if ($workflow -match '(?m)^\s*if:\s*.*PACK_HARNESS_PN_SMOKE_ENABLED') {
    Write-Host 'live compatibility smoke workflow must not use the obsolete enabled-only job condition'
    exit 1
}
if ($workflow -notmatch 'PACK_HARNESS_PN_SMOKE_ENABLED' -or $workflow -notmatch 'PACK_HARNESS_PN_SMOKE_SESSION') {
    Write-Host 'live compatibility smoke workflow must pass its operator controls to the script'
    exit 1
}
if ($workflow -notmatch 'check-harness-post-submit-pn-live-smoke\.ps1' -or $workflow -notmatch 'pull_request:') {
    Write-Host 'live compatibility smoke workflow must retain its PR invocation path'
    exit 1
}
if ($workflow -notmatch 'if:\s*\$\{\{\s*vars\.PACK_HARNESS_PN_SMOKE_SESSION') {
    Write-Host 'live compatibility smoke workflow must gate execution on the configured smoke session'
    exit 1
}

$adoption = Get-Content -LiteralPath (Join-Path $Root 'docs/ao-0-10-review-harness-adoption.md') -Raw
if ($adoption -notmatch 'Pack-owned review runner adoption' -or
    $adoption -notmatch 'GitHub PR review is the authoritative verdict record' -or
    $adoption -notmatch 'Do not use daemon review endpoints') {
    Write-Host 'review-runner adoption guide is missing the pack-owned verdict or no-daemon contract'
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

Write-Host '[PASS] priority-tag content-shape enforcement across pack review compatibility paths'
exit 0
