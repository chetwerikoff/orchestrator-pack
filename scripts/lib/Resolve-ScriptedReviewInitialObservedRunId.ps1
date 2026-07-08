#requires -Version 5.1
<#
.SYNOPSIS
  Bind initialObservedRunId from a session reviews payload for post-submit gates (#669/#683).
#>
function Resolve-ScriptedReviewInitialObservedRunId {
    param(
        [string]$CurrentInitialObservedRunId = '',
        [array]$Reviews = @(),
        [int]$PrNumber = 0
    )

    if ($CurrentInitialObservedRunId) {
        return [string]$CurrentInitialObservedRunId
    }
    foreach ($entry in @($Reviews)) {
        if ($PrNumber -gt 0 -and [int]$entry.prNumber -ne $PrNumber) { continue }
        $lr = $entry.latestRun
        if ($lr -and [string]$lr.id) {
            return [string]$lr.id
        }
    }
    return ''
}
