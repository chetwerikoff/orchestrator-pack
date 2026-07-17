#requires -Version 5.1
<#
.SYNOPSIS
  Wire stdout-first delivery into invoke-pack-review (Issues #669/#718).
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

    . (Join-Path $PSScriptRoot 'Invoke-ScriptedReviewDeliveryEscalation.ps1')
    $packRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    $gateCli = Join-Path $packRoot 'docs/scripted-review-confirmed-delivery-gate.mjs'
    return Invoke-ScriptedReviewDeliveryEscalationEmit -Reason $Reason -Detail $Detail `
        -RunId $RunId -SessionId $SessionId -PrNumber $PrNumber `
        -SourceProcess 'scripted-review-post-submit-delivery' -GateFilterCli $gateCli `
        -WriteLog { param($Message) [Console]::Error.WriteLine($Message) }
}

function Get-ScriptedReviewPostSubmitDeliveryField {
    param(
        [Parameter(Mandatory = $true)]$Delivery,
        [Parameter(Mandatory = $true)][string]$Name
    )

    if ($Delivery -is [System.Collections.IDictionary]) {
        if ($Delivery.Contains($Name)) {
            return [pscustomobject]@{ found = $true; value = $Delivery[$Name] }
        }
        return [pscustomobject]@{ found = $false; value = $null }
    }

    $property = $Delivery.PSObject.Properties[$Name]
    if ($null -eq $property) {
        return [pscustomobject]@{ found = $false; value = $null }
    }
    return [pscustomobject]@{ found = $true; value = $property.Value }
}

function Get-ScriptedReviewPostSubmitDeliveryReason {
    param([Parameter(Mandatory = $true)]$Delivery)

    $reasonField = Get-ScriptedReviewPostSubmitDeliveryField -Delivery $Delivery -Name 'reason'
    if (-not $reasonField.found -or $reasonField.value -isnot [string]) {
        throw 'scripted review post-submit delivery outcome is missing a string reason'
    }
    $reason = [string]$reasonField.value
    if ([string]::IsNullOrWhiteSpace($reason)) {
        throw 'scripted review post-submit delivery outcome is missing a string reason'
    }
    return $reason
}

function ConvertTo-ScriptedReviewPostSubmitDeliveryOutcome {
    param([Parameter(Mandatory = $true)]$Delivery)

    $skippedField = Get-ScriptedReviewPostSubmitDeliveryField -Delivery $Delivery -Name 'skipped'
    return @{
        ok          = [bool]$Delivery.ok
        skipped     = if ($skippedField.found) { [bool]$skippedField.value } else { $false }
        escalated   = [bool]$Delivery.escalated
        reason      = Get-ScriptedReviewPostSubmitDeliveryReason -Delivery $Delivery
        deliveryKey = [string]$Delivery.deliveryKey
        sessionId   = [string]$Delivery.sessionId
        verdict     = [string]$Delivery.verdict
    }
}

function Record-PackReviewDeliveryOutcome {
    param(
        [Parameter(Mandatory = $true)]$Delivery,
        [Parameter(Mandatory = $true)][string]$ReviewTargetRoot
    )

    $runId = [string]$env:PACK_REVIEW_RUN_ID
    if ([string]::IsNullOrWhiteSpace($runId)) { return }

    $storeRoot = [string]$env:PACK_REVIEW_RUN_STORE_ROOT
    if ([string]::IsNullOrWhiteSpace($storeRoot)) {
        $worktreesRoot = Split-Path -Parent $ReviewTargetRoot
        if ((Split-Path -Leaf $ReviewTargetRoot) -eq $runId -and
            (Split-Path -Leaf $worktreesRoot) -eq 'worktrees') {
            $storeRoot = Split-Path -Parent $worktreesRoot
        }
    }
    if ([string]::IsNullOrWhiteSpace($storeRoot)) {
        throw "Could not resolve pack review run store root for $runId"
    }

    $projectId = [string]$env:PACK_REVIEW_PROJECT_ID
    if ([string]::IsNullOrWhiteSpace($projectId)) { $projectId = 'orchestrator-pack' }
    $recorderPath = Join-Path $PSScriptRoot 'pack-review-delivery-outcome.ts'
    if (-not (Test-Path -LiteralPath $recorderPath -PathType Leaf)) {
        throw "Missing pack review delivery-outcome recorder at $recorderPath"
    }

    $fields = @{}
    foreach ($name in @('ok', 'skipped', 'escalated', 'reason')) {
        $field = Get-ScriptedReviewPostSubmitDeliveryField -Delivery $Delivery -Name $name
        if (-not $field.found) {
            throw "pack review delivery outcome is missing required property '$name'"
        }
        $fields[$name] = $field.value
    }
    foreach ($name in @('ok', 'skipped', 'escalated')) {
        if ($fields[$name] -isnot [bool]) {
            throw "pack review delivery outcome property '$name' must be a boolean"
        }
    }
    if ($fields['reason'] -isnot [string]) {
        throw 'pack review delivery outcome reason must be a string'
    }

    $reason = [string]$fields['reason']
    if ([string]::IsNullOrWhiteSpace($reason)) {
        throw 'pack review delivery outcome reason must be a non-empty string'
    }
    $reasonBytes = [System.Text.Encoding]::UTF8.GetBytes($reason)
    $reasonBase64 = [Convert]::ToBase64String($reasonBytes)
    $recorderArgs = @(
        "--run-id=$runId",
        "--project-id=$projectId",
        "--store-root=$storeRoot",
        "--ok=$(([bool]$fields['ok']).ToString().ToLowerInvariant())",
        "--skipped=$(([bool]$fields['skipped']).ToString().ToLowerInvariant())",
        "--escalated=$(([bool]$fields['escalated']).ToString().ToLowerInvariant())",
        "--reason-base64=$reasonBase64"
    )
    . (Join-Path $PSScriptRoot 'Invoke-TypeScriptCli.ps1')
    $nodeArgs = @(Get-OpkTypeScriptNodeArguments -ScriptPath $recorderPath)
    $recorderOutput = @(& node @nodeArgs @recorderArgs 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw "pack review delivery-outcome recorder failed: $($recorderOutput -join [Environment]::NewLine)"
    }
}

function Invoke-ScriptedReviewPostSubmitDeliveryFromPackReview {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [Parameter(Mandatory = $true)][string]$WrapperStdout,
        [Parameter(Mandatory = $true)][int]$WrapperExitCode,
        [string]$ProjectId = 'orchestrator-pack',
        [string]$LifecycleStorePath = '',
        [object[]]$Sessions = $null,
        [object[]]$OpenPrs = $null,
        [switch]$DryRun,
        [switch]$SkipTelemetry,
        [switch]$SimulateCrashAfterVerdictBeforeSend
    )

    if ($WrapperExitCode -ne 0) {
        return @{ ok = $true; skipped = $true; escalated = $false; reason = 'wrapper_failed' }
    }
    if ($env:AO_SCRIPTED_REVIEW_SKIP_POST_SUBMIT_DELIVERY -eq '1') {
        return @{ ok = $true; skipped = $true; escalated = $false; reason = 'env_skip' }
    }

    $parsed = Invoke-ScriptedReviewPostSubmitDeliveryCli -Subcommand 'parse-terminal-stdout' -Payload @{
        stdout = $WrapperStdout
    }
    if (-not $parsed.ok) {
        return @{ ok = $true; skipped = $true; escalated = $false; reason = [string]$parsed.reason }
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

    if (-not (Get-Command Invoke-ScriptedReviewStdoutDelivery -CommandType Function -ErrorAction SilentlyContinue)) {
        . (Join-Path $PSScriptRoot 'Invoke-ScriptedReviewStdoutDelivery.ps1')
    }
    $delivery = Invoke-ScriptedReviewStdoutDelivery -RepoRoot $RepoRoot -WrapperStdout $WrapperStdout `
        -ParsedStdout $parsed -PrNumber $prNumber -TargetSha $targetSha -ProjectId $ProjectId `
        -LifecycleStorePath $LifecycleStorePath -Sessions $Sessions -OpenPrs $OpenPrs `
        -DryRun:$DryRun -SkipTelemetry:$SkipTelemetry `
        -SimulateCrashAfterVerdictBeforeSend:$SimulateCrashAfterVerdictBeforeSend

    return ConvertTo-ScriptedReviewPostSubmitDeliveryOutcome -Delivery $delivery
}
