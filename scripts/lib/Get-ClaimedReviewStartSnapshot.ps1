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
        [scriptblock]$ResolveChecksBundle
    )

    if ($FixtureSnapshot) {
        return $FixtureSnapshot
    }

    $openPrs = Invoke-GhOpenPrList -RepoRoot $RepoRoot
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
