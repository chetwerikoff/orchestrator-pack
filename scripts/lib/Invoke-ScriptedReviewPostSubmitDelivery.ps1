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

function Wait-ScriptedReviewSubmittedRun {
    param(
        [int]$PrNumber,
        [string]$TargetSha,
        [string]$ProjectId = 'orchestrator-pack',
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
            reviewRuns = @($runs)
            prNumber   = $PrNumber
            targetSha  = $TargetSha
        }
        if ($found.ok) {
            return $found
        }
        Start-Sleep -Milliseconds $intervalMs
    }

    return @{ ok = $false; reason = 'submit_visibility_timeout' }
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
        return @{ ok = $false; skipped = $true; reason = 'pr_unresolved' }
    }

    $targetSha = Get-PackReviewHeadSha -RepoRoot $RepoRoot
    if (-not $targetSha) {
        return @{ ok = $false; skipped = $true; reason = 'head_unresolved' }
    }

    try {
        $submitted = Wait-ScriptedReviewSubmittedRun -PrNumber $prNumber -TargetSha $targetSha -ProjectId $ProjectId
    }
    catch {
        return @{ ok = $false; skipped = $true; reason = 'review_runs_unavailable'; detail = $_.Exception.Message }
    }

    if (-not $submitted.ok) {
        return @{ ok = $false; skipped = $true; reason = [string]$submitted.reason }
    }

    $message = Invoke-ScriptedReviewPostSubmitDeliveryCli -Subcommand 'build-delivery-message' -Payload @{
        prNumber    = $prNumber
        runId       = [string]$submitted.runId
        gateVerdict = [string]$parsed.gateVerdict
    }
    if (-not $message.ok) {
        return @{ ok = $false; skipped = $true; reason = [string]$message.reason }
    }

    $seamScript = Join-Path (Split-Path -Parent $PSScriptRoot) 'invoke-scripted-review-post-submit-delivery.ps1'
    if (-not (Test-Path -LiteralPath $seamScript -PathType Leaf)) {
        return @{ ok = $false; skipped = $true; reason = 'missing_seam_script' }
    }

    $gateArgs = @(
        '-SessionId', [string]$submitted.sessionId,
        '-RunId', [string]$submitted.runId,
        '-PrNumber', $prNumber,
        '-TargetSha', $targetSha,
        '-Verdict', [string]$parsed.gateVerdict,
        '-ProjectId', $ProjectId,
        '-RepoRoot', $RepoRoot
    )
    if ($submitted.batchId) {
        $gateArgs += @('-BatchId', [string]$submitted.batchId)
    }
    if ($DryRun) {
        $gateArgs += '-DryRun'
    }

    [string]$message.message | pwsh -NoProfile -File $seamScript @gateArgs
    $gateExit = $LASTEXITCODE
    return @{
        ok       = ($gateExit -eq 0)
        skipped  = $false
        gateExit = $gateExit
        runId    = [string]$submitted.runId
        sessionId = [string]$submitted.sessionId
        verdict  = [string]$parsed.gateVerdict
    }
}
