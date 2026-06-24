#requires -Version 5.1
<#
.SYNOPSIS
  Gated worker nudge entry point for the LLM orchestrator turn (Issue #384, #430).

.DESCRIPTION
  Classifies intent, acquires the shared worker-nudge claim, sends via
  journaled-worker-send with a single-use token, and finalizes the claim lifecycle.
  task-continuation uses issue-keyed tuples; all other intent classes remain PR-keyed.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$SessionId,
    [int]$PrNumber = 0,
    [int]$IssueNumber = 0,
    [string]$HeadSha = '',
    [string]$IntentClass = '',
    [string]$Source = 'orchestrator-turn',
    [string]$Surface = 'orchestrator-turn',
    [string]$ReviewRunId = '',
    [string]$TransitionId = '',
    [string]$EpisodeKey = '',
    [string]$TargetId = '',
    [string]$TargetGeneration = '',
    [string]$ProjectId = 'orchestrator-pack',
    [string]$RepoRoot = '',
    [string]$YamlPath = '',
    [switch]$DryRun,
    [switch]$Probe
)

$ErrorActionPreference = 'Stop'
$PackRoot = Split-Path -Parent $PSScriptRoot
if (-not $RepoRoot) { $RepoRoot = $PackRoot }

. (Join-Path $PSScriptRoot 'lib/Worker-AutonomousNudgeGate.ps1')
. (Join-Path $PSScriptRoot 'lib/Worker-NudgeClaim.ps1')
. (Join-Path $PSScriptRoot 'lib/Worker-NudgeAudit.ps1')
. (Join-Path $PSScriptRoot 'lib/MechanicalReconcileNode.ps1')
. (Join-Path $PSScriptRoot 'lib/Invoke-AoCliJson.ps1')

$payloadText = [Console]::In.ReadToEnd()
if ($null -eq $payloadText) { $payloadText = '' }

if ($Probe) {
    $payloadText = 'AO_WORKER_MESSAGE_ADOPTION_PROBE_V1 branch=probe'
    $PrNumber = 999999
    $SessionId = 'probe-session'
    $DryRun = $true
}

$preflight = Test-WorkerNudgeGatePreflight -FixtureMode:$Probe
if (-not $preflight.ok) {
    $auditRoot = Get-WorkerNudgeGateAuditRoot -ProjectId $ProjectId
    Write-WorkerNudgeGatePreflightRefusal -AuditRoot $auditRoot -Reason $preflight.reason -MarkerState ([string]$preflight.markerState) | Out-Null
    throw "worker nudge gate preflight failed: $($preflight.reason)"
}

$classifyPayload = @{
    source      = $Source
    surface     = $Surface
    message     = $payloadText
    intentClass = $IntentClass
    prNumber    = $PrNumber
    issueNumber = $IssueNumber
    headSha     = $HeadSha
    sessionId   = $SessionId
    reviewRunId = $ReviewRunId
    transitionId = $TransitionId
    episodeKey  = $EpisodeKey
    targetId    = $TargetId
    targetGeneration = $TargetGeneration
    projectId   = $ProjectId
}
$classified = Invoke-WorkerNudgeFilterCli -Subcommand 'classifyIntent' -Payload $classifyPayload
$resolvedIntent = [string]$classified.intentClass
$issueKeyed = $resolvedIntent -eq 'task-continuation'

if ($issueKeyed -and $IssueNumber -le 0) {
    throw 'task-continuation requires -IssueNumber (issue-keyed tuple)'
}
if (-not $issueKeyed -and $PrNumber -le 0) {
    throw 'PR-keyed worker nudge requires -PrNumber'
}

if ($Probe -and -not $HeadSha) {
    $HeadSha = ('f' * 40)
}

if ($issueKeyed) {
    $resolveParams = @{
        IssueNumber = $IssueNumber
        SessionId   = $SessionId
        ProjectId   = $ProjectId
    }
    if ($Probe) {
        $resolveParams.Sessions = @(@{
            name    = $SessionId
            role    = 'worker'
            issue   = [string]$IssueNumber
            project = $ProjectId
            status  = 'working'
        })
    }
    $targetResolution = Resolve-WorkerNudgeTargetFromIssueClaim @resolveParams
}
else {
    $resolveParams = @{
        PrNumber  = $PrNumber
        SessionId = $SessionId
        HeadSha   = $HeadSha
        ProjectId = $ProjectId
    }
    if ($Probe) {
        $resolveParams.Sessions = @(@{
            name         = $SessionId
            role         = 'worker'
            prNumber     = $PrNumber
            ownedHeadSha = $HeadSha
            runtime      = 'alive'
        })
    }
    $targetResolution = Resolve-WorkerNudgeTargetFromPrClaim @resolveParams
}

if (-not $targetResolution.ok) {
    $detail = if ($issueKeyed) { 'issue-claim' } else { 'PR-claim' }
    @{
        sent       = $false
        reason     = [string]$targetResolution.reason
        suppressed = $true
    } | ConvertTo-Json -Compress -Depth 6
    exit 0
}
if (-not $TargetId) { $TargetId = [string]$targetResolution.targetId }
if (-not $TargetGeneration) { $TargetGeneration = [string]$targetResolution.targetGeneration }
$workerTarget = [string]$targetResolution.workerTarget
if (-not $workerTarget) { $workerTarget = "$TargetId`:$TargetGeneration" }
$targetResolutionSource = [string]$targetResolution.targetResolutionSource
$ownerSessionId = [string]$targetResolution.ownerSessionId
$sendSessionId = if ($ownerSessionId) { $ownerSessionId } else { $SessionId }

$cyclePayload = @{
    prNumber         = $PrNumber
    issueNumber      = $IssueNumber
    projectId        = $ProjectId
    headSha          = $HeadSha
    sessionId        = $SessionId
    reviewRunId      = $ReviewRunId
    runId            = $ReviewRunId
    transitionId     = $TransitionId
    episodeKey       = $EpisodeKey
    targetId         = $TargetId
    targetGeneration = $TargetGeneration
    intentClass      = $resolvedIntent
}
$cycle = Invoke-WorkerNudgeFilterCli -Subcommand 'deriveCycleKey' -Payload $cyclePayload
$cycleKey = [string]$cycle.cycleKey
if (-not $cycleKey) {
    throw 'worker nudge gate could not derive cycle key (fail-closed)'
}

if ($issueKeyed) {
    $tupleKey = "$ProjectId|$IssueNumber|$cycleKey|$resolvedIntent|$workerTarget"
}
else {
    $tupleKey = "$PrNumber|$cycleKey|$resolvedIntent|$workerTarget"
}
$namespace = Resolve-WorkerNudgeClaimNamespace -ProjectId $ProjectId
$storePath = $namespace

$gatePayload = @{
    prNumber               = $PrNumber
    issueNumber            = $IssueNumber
    projectId              = $ProjectId
    headSha                = $HeadSha
    sessionId              = $SessionId
    sendTarget             = $sendSessionId
    intentClass            = $resolvedIntent
    cycleKey               = $cycleKey
    targetId               = $TargetId
    targetGeneration       = $TargetGeneration
    source                 = $Source
    surface                = $Surface
    message                = $payloadText
    storePath              = $storePath
    targetResolutionSource = $(if ($targetResolutionSource) { $targetResolutionSource } else { 'orchestrator-turn' })
    claims                 = @(Get-WorkerNudgeClaimRecordsForGate -Namespace $namespace)
}
$gate = Invoke-WorkerNudgeFilterCli -Subcommand 'evaluateNudgeGate' -Payload $gatePayload
if (-not $gate.allow) {
    Write-WorkerNudgeGateAudit -Record $gate.audit | Out-Null
    @{
        sent       = $false
        reason     = [string]$gate.reason
        suppressed = $true
        escalate   = [bool]$gate.escalate
        diagnosis  = [string]$gate.diagnosis
        audit      = $gate.audit
    } | ConvertTo-Json -Compress -Depth 8
    exit 0
}

$claimParams = @{
    CycleKey         = $cycleKey
    IntentClass      = $resolvedIntent
    WorkerTarget     = $workerTarget
    SessionId        = $sendSessionId
    TargetId         = $TargetId
    TargetGeneration = $TargetGeneration
    TupleKey         = $tupleKey
    Surface          = $Surface
    ProjectId        = $ProjectId
    Message          = $payloadText
}
if ($issueKeyed) {
    $claimParams.IssueNumber = $IssueNumber
    $claimParams.PrNumber = 0
}
else {
    $claimParams.PrNumber = $PrNumber
}
$claim = Acquire-WorkerNudgeClaim @claimParams
if (-not $claim.acquired) {
    $claimReason = [string]$claim.reason
    if ($claimReason -in @('storage_failure', 'ambiguous_claim')) {
        $failure = Invoke-WorkerNudgeClaimStoreFailure -Namespace $namespace -FailureReason $claimReason `
            -PrNumber $PrNumber -CycleKey $cycleKey -Surface $Surface
        @{
            sent            = $false
            reason          = [string]$failure.reason
            claimSkip       = $true
            claimStoreFault = $true
            escalate        = [bool]$failure.escalate
            unresolvedCount = [int]$failure.unresolvedCount
            tupleKey        = $tupleKey
        } | ConvertTo-Json -Compress -Depth 6
        exit 0
    }
    Write-WorkerNudgeGateAudit -Record @{
        decision = 'SUPPRESS'
        reason   = $claimReason
        tupleKey = $tupleKey
        surface  = $Surface
    } | Out-Null
    @{
        sent       = $false
        reason     = $claimReason
        claimSkip  = $true
        tupleKey   = $tupleKey
        escalate   = [bool]$claim.escalate
        diagnosis  = [string]$claim.diagnosis
    } | ConvertTo-Json -Compress -Depth 6
    exit 0
}

$token = New-WorkerNudgeClaimToken -ClaimResult $claim
if ($DryRun) {
    Release-WorkerNudgeActiveClaim -ClaimResult $claim | Out-Null
    @{
        sent     = $false
        reason   = 'dry_run'
        tupleKey = $tupleKey
        token    = 'redacted'
    } | ConvertTo-Json -Compress -Depth 6
    exit 0
}

$messageHashResult = Invoke-WorkerNudgeFilterCli -Subcommand 'hashMessageContent' -Payload @{ message = $payloadText }
$messageContentHash = [string]$messageHashResult.messageContentHash
$hashPersist = Set-WorkerNudgeClaimMessageContentHash -ClaimResult $claim -MessageContentHash $messageContentHash
if (-not $hashPersist.ok) {
    Release-WorkerNudgeActiveClaim -ClaimResult $claim | Out-Null
    @{ sent = $false; reason = 'message_hash_persist_failed'; detail = [string]$hashPersist.reason; tupleKey = $tupleKey } | ConvertTo-Json -Compress
    exit 0
}

$journaledScript = Join-Path $PSScriptRoot 'journaled-worker-send.ps1'
$payloadText | pwsh -NoProfile -File $journaledScript $sendSessionId -Source $Source -SourceKey $tupleKey -ClaimToken $token -GatedNudge -NoWait
$exitCode = $LASTEXITCODE

if ($exitCode -eq 0) {
    Write-WorkerNudgeGateAudit -Record $gate.audit | Out-Null
    @{ sent = $true; reason = 'sent'; tupleKey = $tupleKey } | ConvertTo-Json -Compress
    exit 0
}
if ($exitCode -eq 43) {
    @{ sent = $false; reason = 'journal_register_failed'; tupleKey = $tupleKey } | ConvertTo-Json -Compress
    exit $exitCode
}
if ($exitCode -eq 44 -or $exitCode -eq 47) {
    $uncertainReason = if ($exitCode -eq 47) { 'journal_update_unknown' } else { 'dispatch_unknown' }
    Finalize-WorkerNudgeClaim -ClaimResult $claim -Outcome 'UNCERTAIN' | Out-Null
    @{ sent = $false; reason = $uncertainReason; tupleKey = $tupleKey } | ConvertTo-Json -Compress
    exit $exitCode
}

Finalize-WorkerNudgeClaim -ClaimResult $claim -Outcome 'FAILED_DEFINITIVE' -Extra @{ exitCode = $exitCode } | Out-Null
@{ sent = $false; reason = 'send_failed'; exitCode = $exitCode; tupleKey = $tupleKey } | ConvertTo-Json -Compress
exit $exitCode
