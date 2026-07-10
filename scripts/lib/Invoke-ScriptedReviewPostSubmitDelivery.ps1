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

    . (Join-Path $PSScriptRoot 'Invoke-ScriptedReviewStdoutDelivery.ps1')
    $delivery = Invoke-ScriptedReviewStdoutDelivery -RepoRoot $RepoRoot -WrapperStdout $WrapperStdout `
        -ParsedStdout $parsed -PrNumber $prNumber -TargetSha $targetSha -ProjectId $ProjectId -DryRun:$DryRun

    if ($delivery.escalated) {
        return @{
            ok        = $false
            skipped   = $false
            escalated = $true
            reason    = [string]$delivery.reason
        }
    }

    return @{
        ok          = [bool]$delivery.ok
        skipped     = [bool]$delivery.skipped
        escalated   = $false
        deliveryKey = [string]$delivery.deliveryKey
        sessionId   = [string]$delivery.sessionId
        verdict     = [string]$delivery.verdict
    }
}
