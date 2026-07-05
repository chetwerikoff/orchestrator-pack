#requires -Version 5.1
<#
  Durable audit records for orchestrator claimed review-start gate (Issue #318).
#>

$Script:OrchestratorReviewStartAuditSurface = 'orchestrator-turn'

function Get-OrchestratorReviewStartAuditRoot {
    param([string]$ProjectId = 'orchestrator-pack')

    $project = ([string]$ProjectId).Trim()
    if (-not $project) { $project = 'orchestrator-pack' }
    $base = if ($env:AO_BASE_DIR) { $env:AO_BASE_DIR.Trim() } else { Join-Path $HOME '.agent-orchestrator' }
    return (Join-Path (Join-Path (Join-Path $base 'projects') $project) 'orchestrator-review-start-audit')
}

function Get-OrchestratorReviewStartDenialDir {
    param([string]$AuditRoot)
    return (Join-Path $AuditRoot 'denials')
}

function Get-OrchestratorReviewStartPreflightDir {
    param([string]$AuditRoot)
    return (Join-Path $AuditRoot 'preflight')
}

function Get-ReviewStartPreflightShieldAuditDir {
    param([string]$AuditRoot)
    return (Join-Path $AuditRoot 'preflight-shield')
}

function Initialize-OrchestratorReviewStartAuditRoot {
    param([string]$AuditRoot)
    foreach ($dir in @(
        $AuditRoot,
        (Get-OrchestratorReviewStartDenialDir -AuditRoot $AuditRoot),
        (Get-OrchestratorReviewStartPreflightDir -AuditRoot $AuditRoot),
        (Get-ReviewStartPreflightShieldAuditDir -AuditRoot $AuditRoot)
    )) {
        if (-not (Test-Path -LiteralPath $dir)) {
            New-Item -ItemType Directory -Path $dir -Force | Out-Null
        }
    }
}

function New-OrchestratorReviewStartAuditKey {
    param(
        [string]$Repo = 'orchestrator-pack',
        [int]$PrNumber = 0,
        [string]$HeadSha = '',
        [string]$Provenance = $Script:OrchestratorReviewStartAuditSurface,
        [string]$Reason = ''
    )
    $head = ([string]$HeadSha).Trim().ToLowerInvariant()
    return ("{0}|{1}|{2}|{3}|{4}" -f $Repo, $PrNumber, $head, $Provenance, $Reason)
}

function Write-OrchestratorReviewStartDenialAudit {
    param(
        [string]$AuditRoot,
        [int]$PrNumber,
        [string]$HeadSha,
        [string]$Reason,
        [string]$ClaimOutcome,
        [string]$Provenance = $Script:OrchestratorReviewStartAuditSurface
    )

    Initialize-OrchestratorReviewStartAuditRoot -AuditRoot $AuditRoot
    $key = New-OrchestratorReviewStartAuditKey -PrNumber $PrNumber -HeadSha $HeadSha -Provenance $Provenance -Reason $Reason
    $path = Join-Path (Get-OrchestratorReviewStartDenialDir -AuditRoot $AuditRoot) ("$([guid]::NewGuid().ToString('n')).json")
    $coalescePath = Join-Path (Get-OrchestratorReviewStartDenialDir -AuditRoot $AuditRoot) ("coalesced-$($key -replace '[^a-zA-Z0-9._-]', '_').json")
    $now = (Get-Date).ToUniversalTime().ToString('o')
    $incoming = @{
        kind         = 'per_start_denial'
        prNumber     = $PrNumber
        headSha      = ([string]$HeadSha).Trim().ToLowerInvariant()
        provenance   = $Provenance
        reason       = $Reason
        claimOutcome = $ClaimOutcome
        atUtc        = $now
    }
    if (Test-Path -LiteralPath $coalescePath) {
        $existing = Get-Content -LiteralPath $coalescePath -Raw | ConvertFrom-Json
        $merged = @{
            kind         = 'per_start_denial'
            prNumber     = $PrNumber
            headSha      = $incoming.headSha
            provenance   = $Provenance
            reason       = $Reason
            claimOutcome = $ClaimOutcome
            count        = [int]$existing.count + 1
            firstAtUtc   = [string]$existing.firstAtUtc
            lastAtUtc    = $now
        }
        ($merged | ConvertTo-Json -Compress) | Set-Content -LiteralPath $coalescePath -Encoding UTF8
    }
    else {
        $merged = @{
            kind         = 'per_start_denial'
            prNumber     = $PrNumber
            headSha      = $incoming.headSha
            provenance   = $Provenance
            reason       = $Reason
            claimOutcome = $ClaimOutcome
            count        = 1
            firstAtUtc   = $now
            lastAtUtc    = $now
        }
        ($merged | ConvertTo-Json -Compress) | Set-Content -LiteralPath $coalescePath -Encoding UTF8
    }
    ($incoming | ConvertTo-Json -Compress) | Set-Content -LiteralPath $path -Encoding UTF8
    return @{ path = $path; coalescePath = $coalescePath; record = $merged }
}

function Write-OrchestratorReviewStartPreflightRefusal {
    param(
        [string]$AuditRoot,
        [string]$Reason,
        [string]$MarkerState,
        [int]$PrNumber = 0,
        [string]$HeadSha = ''
    )

    Initialize-OrchestratorReviewStartAuditRoot -AuditRoot $AuditRoot
    $path = Join-Path (Get-OrchestratorReviewStartPreflightDir -AuditRoot $AuditRoot) ("$([guid]::NewGuid().ToString('n')).json")
    $record = @{
        kind        = 'preflight_refusal'
        prNumber    = $PrNumber
        headSha     = ([string]$HeadSha).Trim().ToLowerInvariant()
        reason      = $Reason
        markerState = $MarkerState
        atUtc       = (Get-Date).ToUniversalTime().ToString('o')
    }
    ($record | ConvertTo-Json -Compress) | Set-Content -LiteralPath $path -Encoding UTF8
    return @{ path = $path; record = $record }
}

function Write-ReviewStartPreflightShieldAudit {
    param(
        [string]$AuditRoot,
        [int]$PrNumber,
        [string]$HeadSha,
        [int]$Attempt,
        [string]$Disposition,
        [string]$Reason,
        [int]$BackoffMs = 0,
        [bool]$HeaderDegraded = $false,
        [string]$TransientClass = ''
    )

    Initialize-OrchestratorReviewStartAuditRoot -AuditRoot $AuditRoot
    $path = Join-Path (Get-ReviewStartPreflightShieldAuditDir -AuditRoot $AuditRoot) ("$([guid]::NewGuid().ToString('n')).json")
    $record = @{
        kind            = 'preflight_shield'
        producer        = 'review-start-preflight-shield'
        prNumber        = $PrNumber
        headSha         = ([string]$HeadSha).Trim().ToLowerInvariant()
        attempt         = $Attempt
        disposition     = $Disposition
        reason          = $Reason
        backoffMs       = $BackoffMs
        headerDegraded  = [bool]$HeaderDegraded
        transientClass  = $TransientClass
        atUtc           = (Get-Date).ToUniversalTime().ToString('o')
    }
    ($record | ConvertTo-Json -Compress) | Set-Content -LiteralPath $path -Encoding UTF8
    return @{ path = $path; record = $record }
}
