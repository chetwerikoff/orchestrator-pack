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

    $transportFailure = $null
    $openPrs = @()
    if ($ClaimResult -and $ClaimResult.acquired) {
        . (Join-Path $PSScriptRoot 'Review-StartSupervisedGh.ps1')
        $transport = Invoke-ReviewStartSupervisedGh -ClaimResult $ClaimResult -RepoRoot $RepoRoot -GhArguments @(
            'pr', 'view', [string]$PrNumber, '--json', 'number,headRefOid,baseRefName,state'
        )
        if (-not $transport.ok) {
            # Transport denial must short-circuit before live AO reads — Get-AoReviewRuns /
            # Get-AoStatusSessions can fail in clean checkouts without agent-orchestrator.yaml
            # and would mask supervised gh infra failures needed for ledger counting (#516).
            return @{
                transportFailure            = $transport
                openPrs                     = @()
                reviewRuns                  = @()
                sessions                    = @()
                ciChecksByPr                = @{}
                requiredCheckNamesByPr      = @{}
                requiredCheckLookupFailedByPr = @{}
            }
        }
        $pr = $transport.stdout | ConvertFrom-Json
        if ($pr -and [string]$pr.state -eq 'OPEN') {
            Add-GhPrHeadCommittedAtFromFleetMemo -RepoRoot $RepoRoot -Pr $pr
            $openPrs = @($pr)
        }
    }
    else {
        $openPrs = @(Invoke-GhOpenPrListForNumbers -RepoRoot $RepoRoot -PrNumbers @($PrNumber))
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
        transportFailure              = $transportFailure
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
