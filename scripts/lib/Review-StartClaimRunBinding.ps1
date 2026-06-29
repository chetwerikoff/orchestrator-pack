#requires -Version 5.1
<#
  Review-start claim ↔ AO review run lifecycle binding (Issue #521).
#>

. (Join-Path $PSScriptRoot 'MechanicalReconcileNode.ps1')

$Script:ReviewStartClaimRunBindingCli = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'docs/review-start-claim-run-binding.mjs'

function Invoke-ReviewStartClaimRunBindingCli {
    param(
        [string]$Subcommand,
        [hashtable]$Payload
    )
    return Invoke-MechanicalNodeFilterCli -FilterCliPath $Script:ReviewStartClaimRunBindingCli `
        -Subcommand $Subcommand -Payload $Payload -Label 'review-start-claim-run-binding' -JsonDepth 30
}

function Test-ReviewStartClaimRunBindingLaunchGate {
    param(
        [hashtable]$ClaimResult,
        [int]$PrNumber,
        [string]$HeadSha,
        [string]$ProjectId = 'orchestrator-pack',
        [string]$Surface = ''
    )

    $claim = if ($ClaimResult -and $ClaimResult.acquired) { $ClaimResult.claim } else { $null }
    return Invoke-ReviewStartClaimRunBindingCli -Subcommand 'evaluateLaunchGate' -Payload @{
        claim     = $claim
        prNumber  = $PrNumber
        headSha   = $HeadSha
        projectId = $ProjectId
        surface   = $Surface
    }
}

function Get-MissingClaimForReviewRunDiagnostic {
    param(
        [object]$Run,
        [array]$Claims = @(),
        [string]$ProjectId = 'orchestrator-pack',
        [object]$ReviewerEvidence = $null,
        [string]$DetectionPoint = 'lifecycle_reconciler',
        [string]$Surface = ''
    )

    return Invoke-ReviewStartClaimRunBindingCli -Subcommand 'diagnoseMissingClaim' -Payload @{
        run              = $Run
        claims           = @($Claims)
        projectId        = $ProjectId
        reviewerEvidence = $ReviewerEvidence
        detectionPoint   = $DetectionPoint
        surface          = $Surface
    }
}

function Confirm-ReviewStartClaimRunBindingLaunch {
    param(
        [hashtable]$ClaimResult,
        [int]$PrNumber,
        [string]$HeadSha,
        [string]$ProjectId = 'orchestrator-pack',
        [string]$Surface = '',
        [scriptblock]$LogWriter = $null
    )

    $gate = Test-ReviewStartClaimRunBindingLaunchGate -ClaimResult $ClaimResult -PrNumber $PrNumber `
        -HeadSha $HeadSha -ProjectId $ProjectId -Surface $Surface
    if ($gate.allowed) {
        return @{ ok = $true; gate = $gate }
    }
    if ($LogWriter) {
        & $LogWriter "review-start-claim-run-binding: launch denied PR #$PrNumber head=$HeadSha reason=$($gate.reason) surface=$Surface"
    }
    return @{ ok = $false; reason = [string]$gate.reason; gate = $gate }
}

function Write-MissingClaimForReviewRunDiagnosticAudit {
    param(
        [string]$AuditRoot,
        [object]$Diagnostic
    )

    if (-not $Diagnostic -or -not $Diagnostic.diagnostic) { return $null }
    if (-not $AuditRoot) { return $null }
    if (-not (Test-Path -LiteralPath $AuditRoot)) {
        New-Item -ItemType Directory -Path $AuditRoot -Force | Out-Null
    }
    $path = Join-Path $AuditRoot ("missing-claim-{0}.json" -f ([guid]::NewGuid().ToString('n')))
    ($Diagnostic | ConvertTo-Json -Compress -Depth 20) | Set-Content -LiteralPath $path -Encoding UTF8
    return $path
}
