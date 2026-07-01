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
        $parse = Invoke-CommandRuntimeParseStructuredOutput -Stdout $transport.stdout -Stderr $transport.stderr
        if (-not $parse.ok) {
            $reason = [string]$parse.reason
            if (-not $reason) { $reason = 'structured_output_polluted' }
            return @{
                transportFailure            = @{
                    ok           = $false
                    reason       = $reason
                    exitCode     = [int]$transport.exitCode
                    stderr       = [string]$transport.stderr
                    stdout       = [string]$transport.stdout
                    failureClass = 'infra_transport'
                }
                openPrs                     = @()
                reviewRuns                  = @()
                sessions                    = @()
                ciChecksByPr                = @{}
                requiredCheckNamesByPr      = @{}
                requiredCheckLookupFailedByPr = @{}
            }
        }
        $pr = $parse.value
        if ($pr -and [string]$pr.state -eq 'OPEN') {
            Add-GhPrHeadCommittedAtFromFleetMemo -RepoRoot $RepoRoot -Pr $pr
            $openPrs = @($pr)
        }
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
