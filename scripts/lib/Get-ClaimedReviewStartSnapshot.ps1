#requires -Version 5.1
<#
  Shared live snapshot reader for claimed review-start gates.
#>

. (Join-Path $PSScriptRoot 'Gh-PrChecks.ps1')

function Get-ClaimedReviewStartSnapshot {
    param(
        [int]$PrNumber,
        [string]$Project,
        [string]$RepoRoot,
        [hashtable]$FixtureSnapshot,
        [hashtable]$ClaimResult,
        [scriptblock]$ResolveChecksBundle
    )

    if ($FixtureSnapshot) {
        return $FixtureSnapshot
    }

    $openPrs = @()
    if ($ClaimResult -and $ClaimResult.acquired) {
        . (Join-Path $PSScriptRoot 'Review-StartPreflightShield.ps1')
        $preflight = Invoke-ReviewStartPreflightGhPrView -RepoRoot $RepoRoot -PrNumber $PrNumber -ClaimResult $ClaimResult
        if ($preflight.transportFailure) {
            return @{
                transportFailure            = $preflight.transportFailure
                openPrs                     = @()
                reviewRuns                  = @()
                sessions                    = @()
                ciChecksByPr                = @{}
                requiredCheckNamesByPr      = @{}
                requiredCheckLookupFailedByPr = @{}
            }
        }
        $openPrs = @($preflight.openPrs)
    }
    else {
        $scoped = Invoke-ReviewStartScopedGhPrView -RepoRoot $RepoRoot -PrNumber $PrNumber
        $openPrs = @($scoped.openPrs)
        if ($scoped.transportFailure) {
            # Transport denial must short-circuit before live AO reads — same as acquired-claim path.
            return @{
                transportFailure            = $scoped.transportFailure
                openPrs                     = @()
                reviewRuns                  = @()
                sessions                    = @()
                ciChecksByPr                = @{}
                requiredCheckNamesByPr      = @{}
                requiredCheckLookupFailedByPr = @{}
            }
        }
    }
    $reviewRuns = @(
        . (Join-Path $PSScriptRoot 'Review-PostRunRetry.ps1')
        . (Join-Path $PSScriptRoot 'Review-StartClaim.ps1')
        $namespace = if ($ClaimResult -and [string]$ClaimResult.namespace) {
            [string]$ClaimResult.namespace
        }
        else {
            Resolve-ReviewStartClaimNamespace -ProjectId $Project
        }
        Get-EnrichedAoReviewRuns -Project $Project -RepoRoot $RepoRoot -Namespace $namespace
    )
    $sessions = @(Get-AoStatusSessions)
    $checksBundle = & $ResolveChecksBundle $openPrs $PrNumber $RepoRoot
    return @{
        openPrs                       = @($openPrs)
        reviewRuns                    = @($reviewRuns)
        sessions                      = @($sessions)
        ciChecksByPr                  = $checksBundle.ciChecksByPr
        requiredCheckNamesByPr        = $checksBundle.requiredCheckNamesByPr
        requiredCheckLookupFailedByPr = $checksBundle.requiredCheckLookupFailedByPr
        transportFailure              = $null
    }
}

function Get-ClaimedReviewStartReevalFreshSnapshot {
    param(
        [object]$Planned,
        [hashtable]$ClaimResult,
        [string]$Project,
        [string]$RepoRoot
    )

    # Pre-claim callers pass no acquired claim; scoped target-PR lookup uses PrNumber directly.
    . (Join-Path $PSScriptRoot 'Get-ReconcileChecksByPr.ps1')
    $base = Get-ClaimedReviewStartSnapshot -PrNumber ([int]$Planned.prNumber) -Project $Project -RepoRoot $RepoRoot `
        -ClaimResult $ClaimResult -ResolveChecksBundle {
        param($openPrs, $prNumber, $repoRoot)
        Get-ReconcileChecksByPr -RepoRoot $repoRoot -OpenPrs @(
            @($openPrs | Where-Object { [int]$_.number -eq $prNumber })
        )
    }
    return $base
}
