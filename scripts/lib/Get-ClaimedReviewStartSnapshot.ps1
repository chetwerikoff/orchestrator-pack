#requires -Version 5.1
<#
  Shared live snapshot reader for claimed review-start gates.
#>

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

    if ($ClaimResult -and $ClaimResult.acquired) {
        . (Join-Path $PSScriptRoot 'Review-StartSupervisedGh.ps1')
        $transport = Invoke-ReviewStartSupervisedGh -ClaimResult $ClaimResult -RepoRoot $RepoRoot -GhArguments @(
            'pr', 'list', '--state', 'open', '--json', 'number,headRefOid,baseRefName', '--limit', '200'
        )
        if (-not $transport.ok) {
            return @{
                transportFailure            = $transport
                openPrs                     = @()
                reviewRuns                  = @(Get-AoReviewRuns -Project $Project)
                sessions                    = @(Get-AoStatusSessions)
                ciChecksByPr                = @{}
                requiredCheckNamesByPr      = @{}
                requiredCheckLookupFailedByPr = @{}
            }
        }
        $openPrs = @($transport.stdout | ConvertFrom-Json)
        foreach ($pr in $openPrs) {
            Add-GhPrHeadCommittedAtFromFleetMemo -RepoRoot $RepoRoot -Pr $pr
        }
    }
    else {
        $openPrs = Invoke-GhOpenPrList -RepoRoot $RepoRoot
    }
    $reviewRuns = @(Get-AoReviewRuns -Project $Project)
    $sessions = @(Get-AoStatusSessions)
    $checksBundle = & $ResolveChecksBundle $openPrs $PrNumber $RepoRoot
    return @{
        openPrs                       = @($openPrs)
        reviewRuns                    = @($reviewRuns)
        sessions                      = @($sessions)
        ciChecksByPr                  = $checksBundle.ciChecksByPr
        requiredCheckNamesByPr        = $checksBundle.requiredCheckNamesByPr
        requiredCheckLookupFailedByPr = $checksBundle.requiredCheckLookupFailedByPr
    }
}

function Get-ClaimedReviewStartReevalFreshSnapshot {
    param(
        [object]$Planned,
        [hashtable]$ClaimResult,
        [string]$Project,
        [string]$RepoRoot
    )

    # Pre-claim callers (e.g. Invoke-ReviewTriggerReevalPlannedRun claimRuns) pass no acquired claim;
    # Get-ClaimedReviewStartSnapshot falls back to unsupervised open-PR list until claim is held.
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

