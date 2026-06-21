#requires -Version 5.1
<#
.SYNOPSIS
  Regression guard: Issue #207 event-driven review wake trigger wiring.
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$listenerScript = Join-Path $Root 'scripts/orchestrator-wake-listener.ps1'
$triggerMjs = Join-Path $Root 'docs/review-wake-trigger.mjs'
$triggerLib = Join-Path $Root 'scripts/lib/Invoke-ReviewWakeTrigger.ps1'
$supervisorLib = Join-Path $Root 'scripts/lib/Orchestrator-SideProcessSupervisor.ps1'
$registryPath = Join-Path $Root 'scripts/orchestrator-side-process-registry.json'
$agentRules = Join-Path $Root 'prompts/agent_rules.md'
$wakeRunbook = Join-Path $Root 'docs/orchestrator-wake-runbook.md'

foreach ($path in @($listenerScript, $triggerMjs, $triggerLib)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        Write-Host "Missing required file: $path"
        exit 1
    }
}

$listener = Get-Content -LiteralPath $listenerScript -Raw
if ($listener -notmatch 'Invoke-ReviewWakeTriggerOnCompletionWake') {
    Write-Host 'orchestrator-wake-listener.ps1 must invoke review wake trigger on completion wakes'
    exit 1
}
if ($listener -notmatch 'ready_for_review') {
    Write-Host 'orchestrator-wake-listener.ps1 must handle ready_for_review hand-off wakes'
    exit 1
}
if ($listener -notmatch 'merge\.ready') {
    Write-Host 'orchestrator-wake-listener.ps1 must handle merge.ready completion wakes'
    exit 1
}
$triggerIdx = $listener.IndexOf('Invoke-ReviewWakeTriggerOnCompletionWake')
$dedupIdx = $listener.IndexOf('$dedupDecision = Test-AndRecordWakeDedup')
if ($triggerIdx -lt 0 -or $dedupIdx -lt 0 -or $triggerIdx -gt $dedupIdx) {
    Write-Host 'orchestrator-wake-listener.ps1 must invoke review wake trigger before wake dedup'
    exit 1
}
if ($listener -notmatch 'review_trigger_failed') {
    Write-Host 'orchestrator-wake-listener.ps1 must forward merge.ready wakes when review trigger fails'
    exit 1
}
if ($listener -notmatch 'Invoke-ReviewHandoffWakeAdmissionRecovery') {
    Write-Host 'orchestrator-wake-listener.ps1 must replay durable handoff admissions on startup'
    exit 1
}
if ($listener -notmatch 'Write-OrchestratorSideProcessProgress -ChildId ''listener''') {
    Write-Host 'orchestrator-wake-listener.ps1 must emit supervised progress heartbeats for the listener child'
    exit 1
}
if ((Get-Content -LiteralPath $triggerLib -Raw) -notmatch 'Invoke-ReviewerWorkspacePreflight\.ps1') {
    Write-Host 'Invoke-ReviewWakeTrigger.ps1 must compose Invoke-ReviewerWorkspacePreflight.ps1'
    exit 1
}
if ((Get-Content -LiteralPath $triggerLib -Raw) -notmatch 'Invoke-ReviewerWorkspacePreflight -RepoRoot') {
    Write-Host 'Invoke-ReviewWakeTrigger.ps1 must run reviewer-workspace-preflight before ao review run'
    exit 1
}
if ((Get-Content -LiteralPath $triggerLib -Raw) -notmatch 'Test-ReviewWakeTriggerForbiddenCommand') {
    Write-Host 'Invoke-ReviewWakeTrigger.ps1 must block merge commands in the wake trigger guard'
    exit 1
}

$mjs = Get-Content -LiteralPath $triggerMjs -Raw
if ($mjs -notmatch 'MECHANICAL_FORBIDDEN_REVIEW_WAKE') {
    Write-Host 'docs/review-wake-trigger.mjs must forbid merge commands in the wake trigger guard'
    exit 1
}
if ($mjs -notmatch 'WAKE_TO_RUN_DECISION_MAX_MS = 5_000') {
    Write-Host 'docs/review-wake-trigger.mjs must define 5-second wake-to-run decision bound'
    exit 1
}
if ($mjs -notmatch "from '\./review-head-ready\.mjs'") {
    Write-Host 'docs/review-wake-trigger.mjs must compose review-head-ready.mjs (Issue #195)'
    exit 1
}

if (-not (Test-Path -LiteralPath $registryPath)) {
    Write-Host "Missing registry: $registryPath"
    exit 1
}
$registry = Get-Content -LiteralPath $registryPath -Raw | ConvertFrom-Json
$listener = $registry.children | Where-Object { $_.id -eq 'listener' } | Select-Object -First 1
if (-not $listener -or -not $listener.sideEffecting) {
    Write-Host 'orchestrator-side-process-registry.json must classify listener as side-effecting'
    exit 1
}
if ($listener.sideEffectLockFile -ne 'listener-side-effect.lock') {
    Write-Host 'listener sideEffectLockFile must be listener-side-effect.lock'
    exit 1
}
$supervisor = Get-Content -LiteralPath $supervisorLib -Raw
if ($supervisor -notmatch 'Get-OrchestratorWakeSupervisorChildRegistry') {
    Write-Host 'Orchestrator-SideProcessSupervisor.ps1 must load child registry'
    exit 1
}

if ((Get-Content -LiteralPath $agentRules -Raw) -notlike '*event-driven review trigger*') {
    Write-Host 'prompts/agent_rules.md missing event-driven review trigger section'
    exit 1
}

if ((Get-Content -LiteralPath $wakeRunbook -Raw) -notlike '*review-wake-trigger*') {
    Write-Host 'docs/orchestrator-wake-runbook.md missing review-wake-trigger documentation'
    exit 1
}

Write-Host '[PASS] event-driven review wake trigger entrypoint and wiring (Issue #207)'
exit 0
