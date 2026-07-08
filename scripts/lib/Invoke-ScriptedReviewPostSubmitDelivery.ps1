#requires -Version 5.1
<#
.SYNOPSIS
  Wire confirmed-delivery gate into invoke-pack-review after ao review submit (Issue #669).
#>

function Invoke-ScriptedReviewPostSubmitDeliveryCli {
    param(
        [Parameter(Mandatory = $true)][string]$Subcommand,
        [hashtable]$Payload = @{}
    )
    $packRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    $cli = Join-Path $packRoot 'docs/scripted-review-post-submit-delivery.mjs'
    . (Join-Path $PSScriptRoot 'MechanicalReconcileNode.ps1')
    return Invoke-MechanicalNodeFilterCli -FilterCliPath $cli -Subcommand $Subcommand `
        -Payload $Payload -Label 'scripted-review-post-submit-delivery' -JsonDepth 20
}

function Invoke-ScriptedReviewDeliveryGateCli {
    param(
        [Parameter(Mandatory = $true)][string]$Subcommand,
        [hashtable]$Payload = @{}
    )
    $packRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    $cli = Join-Path $packRoot 'docs/scripted-review-confirmed-delivery-gate.mjs'
    . (Join-Path $PSScriptRoot 'MechanicalReconcileNode.ps1')
    return Invoke-MechanicalNodeFilterCli -FilterCliPath $cli -Subcommand $Subcommand `
        -Payload $Payload -Label 'scripted-review-confirmed-delivery-gate' -JsonDepth 20
}

function Get-PackReviewHeadSha {
    param([string]$RepoRoot)
    Push-Location -LiteralPath $RepoRoot
    try {
        return (git rev-parse HEAD 2>$null)
    }
    finally {
        Pop-Location
    }
}

function Invoke-ScriptedReviewPostSubmitDeliveryEscalation {
    param(
        [Parameter(Mandatory = $true)][string]$Reason,
        [string]$Detail = '',
        [string]$RunId = '',
        [string]$SessionId = '',
        [int]$PrNumber = 0
    )

    . (Join-Path $PSScriptRoot 'Invoke-OrchestratorEscalationEmit.ps1')
    $builtResult = Invoke-ScriptedReviewDeliveryGateCli -Subcommand 'build-escalation' -Payload @{
        runId     = $RunId
        sessionId = $SessionId
        prNumber  = $PrNumber
        reason    = $Reason
    }
    $built = [string]$builtResult.message
    if ($Detail) {
        $built = "$built Detail: $Detail"
    }
    [Console]::Error.WriteLine($built)

    $corr = if ($RunId) { "corr:scripted-review-delivery:$RunId" } else { 'corr:scripted-review-delivery:unattributed' }
    $dedupe = if ($RunId) {
        "dedupe:scripted-review-delivery:$RunId`:$Reason"
    }
    else {
        "dedupe:scripted-review-delivery:unattributed:$Reason"
    }
    Invoke-OrchestratorEscalationEmit -EscalationClassId 'escalation-pipeline-failure' `
        -SourceProcess 'scripted-review-post-submit-delivery' -CorrelationKey $corr -DedupeKey $dedupe `
        -Diagnosis @{
            runId     = $RunId
            sessionId = $SessionId
            prNumber  = $PrNumber
            reason    = $Reason
            detail    = $Detail
        } | Out-Null

    return @{
        ok        = $false
        escalated = $true
        reason    = $Reason
        detail    = $Detail
    }
}

function Wait-ScriptedReviewSubmittedRun {
    param(
        [int]$PrNumber,
        [string]$TargetSha,
        [string]$ProjectId = 'orchestrator-pack',
        [long]$SubmitObservedAfterMs = 0,
        [hashtable]$VisibilityConfig = $null
    )

    . (Join-Path $PSScriptRoot 'Invoke-AoReviewApi.ps1')
    $config = if ($VisibilityConfig) { $VisibilityConfig } else {
        Invoke-ScriptedReviewPostSubmitDeliveryCli -Subcommand 'resolve-submit-visibility-config' -Payload @{ env = @{} }
    }
    $deadline = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + [int]$config.visibilityMs
    $intervalMs = [Math]::Max(200, [int]$config.intervalMs)

    while ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt $deadline) {
        $runs = @(Get-AoReviewRunsFromWorkerSessions -Project $ProjectId)
        $found = Invoke-ScriptedReviewPostSubmitDeliveryCli -Subcommand 'find-submitted-run' -Payload @{
            reviewRuns            = @($runs)
            prNumber              = $PrNumber
            targetSha             = $TargetSha
            submitObservedAfterMs = $SubmitObservedAfterMs
        }
        if ($found.ok) {
            return $found
        }
        Start-Sleep -Milliseconds $intervalMs
    }

    return @{ ok = $false; reason = 'submit_visibility_timeout' }
}

function Write-ScriptedReviewDeliveryGateSupervisorLogsToStderr {
    param([string[]]$LogPaths)

    foreach ($logPath in @($LogPaths)) {
        if (-not $logPath -or -not (Test-Path -LiteralPath $logPath -PathType Leaf)) { continue }
        foreach ($line in (Get-Content -LiteralPath $logPath -ErrorAction SilentlyContinue)) {
            $trimmed = [string]$line
            if ($trimmed) {
                [Console]::Error.WriteLine($trimmed)
            }
        }
    }
}

function Invoke-ScriptedReviewDeliveryGateProcess {
    param(
        [Parameter(Mandatory = $true)][hashtable]$GateParams,
        [string]$MessageText = '',
        [string]$ProjectId = 'orchestrator-pack'
    )

    $childId = 'scripted-review-confirmed-delivery-gate'
    . (Join-Path $PSScriptRoot 'Orchestrator-WakeSupervisor.ps1')
    $stateRoot = Get-OrchestratorWakeSupervisorStateRoot
    if (-not (Test-Path -LiteralPath $stateRoot)) {
        New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null
    }
    $paths = Get-OrchestratorWakeSupervisorPaths -StateRoot $stateRoot
    $logPath = Get-OrchestratorWakeSupervisorChildLogPath -Paths $paths -ChildId $childId

    $extraArgs = @(
        '-SessionId', [string]$GateParams.SessionId,
        '-RunId', [string]$GateParams.RunId,
        '-PrNumber', [int]$GateParams.PrNumber,
        '-TargetSha', [string]$GateParams.TargetSha,
        '-Verdict', [string]$GateParams.Verdict,
        '-RepoRoot', [string]$GateParams.RepoRoot
    )
    if ($GateParams.BatchId) {
        $extraArgs += @('-BatchId', [string]$GateParams.BatchId)
    }
    if ($MessageText) {
        $extraArgs += @('-DeliveryMessage', $MessageText)
    }
    if ($GateParams.DryRun) {
        $extraArgs += '-DryRun'
    }

    $gateConfig = Invoke-ScriptedReviewDeliveryGateCli -Subcommand 'resolve-config' -Payload @{
        config = @{}
    }
    $pollWindowMs = [Math]::Max(45_000, [int]$gateConfig.pollWindowMs)
    $waitSeconds = [Math]::Ceiling(($pollWindowMs / 1000.0) + 60)

    $childPid = Start-OrchestratorWakeSupervisorChild -ChildId $childId -OrchestratorSessionId '' `
        -Paths $paths -ProjectId $ProjectId -ExtraChildArgs $extraArgs
    if ($childPid -le 0) {
        throw 'Failed to start scripted-review confirmed-delivery gate supervisor child'
    }

    $deadline = (Get-Date).AddSeconds($waitSeconds)
    $exitCode = 2
    while ((Get-Date) -lt $deadline) {
        $proc = Get-Process -Id $childPid -ErrorAction SilentlyContinue
        if (-not $proc) {
            break
        }
        if ($proc.HasExited) {
            $exitCode = $proc.ExitCode
            break
        }
        Start-Sleep -Milliseconds 250
    }

    $proc = Get-Process -Id $childPid -ErrorAction SilentlyContinue
    if ($proc -and -not $proc.HasExited) {
        try { $proc.Kill() } catch { }
        $exitCode = 2
    }

    Write-ScriptedReviewDeliveryGateSupervisorLogsToStderr -LogPaths @($logPath, "${logPath}.err")
    return [int]$exitCode
}

function Invoke-ScriptedReviewPostSubmitDeliveryFromPackReview {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [Parameter(Mandatory = $true)][string]$WrapperStdout,
        [Parameter(Mandatory = $true)][int]$WrapperExitCode,
        [string]$ProjectId = 'orchestrator-pack',
        [switch]$DryRun
    )

    if ($WrapperExitCode -ne 0) {
        return @{ ok = $true; skipped = $true; reason = 'wrapper_failed' }
    }
    if ($env:AO_SCRIPTED_REVIEW_SKIP_POST_SUBMIT_DELIVERY -eq '1') {
        return @{ ok = $true; skipped = $true; reason = 'env_skip' }
    }

    $parsed = Invoke-ScriptedReviewPostSubmitDeliveryCli -Subcommand 'parse-terminal-stdout' -Payload @{
        stdout = $WrapperStdout
    }
    if (-not $parsed.ok) {
        return @{ ok = $true; skipped = $true; reason = [string]$parsed.reason }
    }

    . (Join-Path $PSScriptRoot 'Get-AutoReviewPrContext.ps1')
    $ctx = Get-AutoReviewPrContext -RepoRoot $RepoRoot
    $prNumber = [int]$ctx.PrNumber
    if ($prNumber -le 0) {
        return Invoke-ScriptedReviewPostSubmitDeliveryEscalation -Reason 'pr_unresolved' -Detail "repoRoot=$RepoRoot"
    }

    $targetSha = Get-PackReviewHeadSha -RepoRoot $RepoRoot
    if (-not $targetSha) {
        return Invoke-ScriptedReviewPostSubmitDeliveryEscalation -Reason 'head_unresolved' -PrNumber $prNumber `
            -Detail "repoRoot=$RepoRoot"
    }

    try {
        $submitObservedAfterMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        $submitted = Wait-ScriptedReviewSubmittedRun -PrNumber $prNumber -TargetSha $targetSha -ProjectId $ProjectId `
            -SubmitObservedAfterMs $submitObservedAfterMs
    }
    catch {
        return Invoke-ScriptedReviewPostSubmitDeliveryEscalation -Reason 'review_runs_unavailable' -PrNumber $prNumber `
            -Detail $_.Exception.Message
    }

    if (-not $submitted.ok) {
        return Invoke-ScriptedReviewPostSubmitDeliveryEscalation -Reason ([string]$submitted.reason) -PrNumber $prNumber `
            -Detail "targetSha=$targetSha"
    }

    $message = Invoke-ScriptedReviewPostSubmitDeliveryCli -Subcommand 'build-delivery-message' -Payload @{
        prNumber    = $prNumber
        runId       = [string]$submitted.runId
        gateVerdict = [string]$parsed.gateVerdict
    }
    if (-not $message.ok) {
        return Invoke-ScriptedReviewPostSubmitDeliveryEscalation -Reason ([string]$message.reason) `
            -RunId ([string]$submitted.runId) -SessionId ([string]$submitted.sessionId) -PrNumber $prNumber
    }

    $gateParams = @{
        SessionId = [string]$submitted.sessionId
        RunId     = [string]$submitted.runId
        BatchId   = [string]$submitted.batchId
        PrNumber  = $prNumber
        TargetSha = $targetSha
        Verdict   = [string]$parsed.gateVerdict
        RepoRoot  = $RepoRoot
        DryRun    = [bool]$DryRun
    }

    $gateExit = Invoke-ScriptedReviewDeliveryGateProcess -GateParams $gateParams `
        -MessageText ([string]$message.message) -ProjectId $ProjectId
    return @{
        ok        = ($gateExit -eq 0)
        skipped   = $false
        escalated = ($gateExit -ne 0)
        gateExit  = $gateExit
        runId     = [string]$submitted.runId
        sessionId = [string]$submitted.sessionId
        verdict   = [string]$parsed.gateVerdict
    }
}
