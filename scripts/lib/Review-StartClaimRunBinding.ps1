#requires -Version 5.1
<#
  Review-start claim and claimed review-start lifecycle binding (Issue #521).
#>

. (Join-Path $PSScriptRoot 'MechanicalReconcileNode.ps1')

$Script:ReviewStartClaimRunBindingCli = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'docs/review-start-claim-run-binding.mjs'

function Invoke-ReviewStartClaimRunBindingCli {
    param(
        [Parameter(Mandatory = $true)][string]$Subcommand,
        [hashtable]$Payload = @{}
    )

    return Invoke-MechanicalNodeFilterCli -FilterCliPath $Script:ReviewStartClaimRunBindingCli `
        -Subcommand $Subcommand -Payload $Payload -Label 'review-start-claim-run-binding' -JsonDepth 30
}

function Resolve-ReviewStartClaimBindingProjectId {
    param(
        [hashtable]$ClaimResult,
        [string]$ProjectId = ''
    )

    if ([string]$ProjectId) { return [string]$ProjectId }
    if ($ClaimResult -and [string]$ClaimResult.projectId) { return [string]$ClaimResult.projectId }
    if ($ClaimResult -and [string]$ClaimResult.claim.projectId) { return [string]$ClaimResult.claim.projectId }
    return 'orchestrator-pack'
}

function Resolve-ReviewStartClaimProjectIdFromNamespace {
    param([string]$Namespace)

    $normalized = ([string]$Namespace).Replace('\', '/').TrimEnd('/')
    if ($normalized -match '/projects/([^/]+)/review-start-claims$') {
        return $Matches[1]
    }
    return 'orchestrator-pack'
}

function Test-AutomatedReviewLaunchClaimGate {
    param(
        [hashtable]$ClaimResult,
        [array]$Claims = @(),
        [int]$PrNumber,
        [string]$HeadSha,
        [string]$ProjectId = 'orchestrator-pack'
    )

    $ProjectId = Resolve-ReviewStartClaimBindingProjectId -ClaimResult $ClaimResult -ProjectId $ProjectId

    if ($ClaimResult -and $ClaimResult.acquired -and [string]$ClaimResult.claim.state -eq 'active') {
        $claimPr = [int]$ClaimResult.claim.prNumber
        $claimHead = [string]$ClaimResult.claim.headSha
        $claimProject = if ([string]$ClaimResult.projectId) { [string]$ClaimResult.projectId } else { 'orchestrator-pack' }
        if ($claimPr -eq $PrNumber -and $claimHead -eq $HeadSha -and $claimProject -eq $ProjectId) {
            return @{ ok = $true; reason = 'live_claim_present'; fastPath = $true }
        }
    }

    $payload = @{
        prNumber         = $PrNumber
        headSha          = $HeadSha
        projectNamespace = $ProjectId
        claims           = @($Claims)
    }
    if ($ClaimResult -and $ClaimResult.acquired) {
        $claimProject = if ([string]$ClaimResult.projectId) { [string]$ClaimResult.projectId } else { 'orchestrator-pack' }
        $claimPr = [int]$ClaimResult.claim.prNumber
        $claimHead = [string]$ClaimResult.claim.headSha
        if ($claimPr -eq $PrNumber -and $claimHead -eq $HeadSha -and $claimProject -eq $ProjectId) {
            $payload.claim = $ClaimResult.claim
        }
    }
    $gate = Invoke-ReviewStartClaimRunBindingCli -Subcommand 'launch-gate' -Payload $payload
    if ($gate.launch) {
        return @{ ok = $true; reason = [string]$gate.reason; gate = $gate }
    }
    return @{ ok = $false; reason = [string]$gate.reason; gate = $gate }
}

function Get-MissingClaimForReviewRunDiagnostic {
    param(
        [object]$Run,
        [array]$Claims = @(),
        [string]$ProjectId = 'orchestrator-pack',
        [string]$DetectionPoint = 'lifecycle_reconciler',
        [string]$Surface = '',
        [string]$Provenance = ''
    )

    $runHt = ConvertTo-MechanicalJsonStateHashtable -Value $Run

    return Invoke-ReviewStartClaimRunBindingCli -Subcommand 'diagnose-missing-claim' -Payload @{
        run              = $runHt
        claims           = @($Claims)
        projectNamespace = $ProjectId
        detectionPoint   = $DetectionPoint
        surface          = $Surface
        provenance       = $Provenance
    }
}

function Resolve-ReviewStartClaimRunBindingDecision {
    param(
        [hashtable]$Claim,
        [array]$ReviewRuns = @(),
        [array]$ReviewerEvidence = @(),
        [int64]$NowMs = 0,
        [string]$ProjectId = ''
    )

    if ($NowMs -le 0) {
        $NowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }
    $payload = @{
        claim             = $Claim
        reviewRuns        = @($ReviewRuns)
        reviewerEvidence  = @($ReviewerEvidence)
        nowMs             = $NowMs
    }
    if ([string]$ProjectId) {
        $payload.projectNamespace = [string]$ProjectId
    }
    return Invoke-ReviewStartClaimRunBindingCli -Subcommand 'launch-pending-budget' -Payload $payload
}

function Complete-ReviewStartClaimFromRunBinding {
    param(
        [hashtable]$ClaimResult,
        [hashtable]$BindingDecision,
        [array]$ReviewRuns = @(),
        [scriptblock]$LogWriter = $null
    )

    if (-not $ClaimResult -or -not $ClaimResult.acquired) {
        return @{ ok = $false; reason = 'no_claim' }
    }
    $outcome = [string]$BindingDecision.outcome
    if (-not $outcome) {
        return @{ ok = $false; reason = 'missing_outcome' }
    }
    $extra = @{
        reason = [string]$BindingDecision.reason
    }
    if ($BindingDecision.runId) { $extra.boundRunId = [string]$BindingDecision.runId }
    if ($BindingDecision.binding) { $extra.binding = $BindingDecision.binding }
    $complete = Complete-ReviewStartClaim -ClaimResult $ClaimResult -Outcome $outcome -ReviewRuns @($ReviewRuns) -Extra $extra
    if ($LogWriter) {
        & $LogWriter "review-start-claim-run-binding: reconciled key=$($ClaimResult.key) outcome=$outcome reason=$($BindingDecision.reason)"
    }
    return @{ ok = $true; outcome = $outcome; complete = $complete }
}
