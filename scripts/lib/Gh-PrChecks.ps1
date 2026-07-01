#requires -Version 5.1
<#
.SYNOPSIS
  Shared gh pr list / checks / branch-protection helpers for mechanical reconcile scripts.
#>

. (Join-Path $PSScriptRoot 'Gh-FleetInventoryCache.ps1')

function Write-GhPrChecksLog {
    param([string]$Message)

    if ($null -ne $Script:GhPrChecksLogWriter) {
        & $Script:GhPrChecksLogWriter $Message
    }
}

function ConvertFrom-GhJsonArrayOutput {
    param([object]$RawOutput)

    $text = ($RawOutput | ForEach-Object {
            if ($_ -is [string]) { $_ }
            elseif ($null -ne $_) { $_.ToString() }
        }) -join "`n"
    $start = $text.IndexOf('[')
    if ($start -lt 0) {
        return @()
    }

    return @($text.Substring($start) | ConvertFrom-Json)
}

function ConvertTo-GhOpenPrArray {
    param($OpenPrs)

    if ($null -eq $OpenPrs) {
        return ,@()
    }
    $normalized = @($OpenPrs | Where-Object { $null -ne $_ })
    if ($normalized.Count -eq 0) {
        return ,@()
    }
    return ,$normalized
}

function Invoke-GhOpenPrList {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,
        [string]$Consumer = ''
    )

    # List query stays cheap (no commits connection). Head commit dates use the
    # fleet SHA memo; open-PR rows use the shared short-TTL snapshot (#453).
    $prs = @(Invoke-GhFleetCachedOpenPrListRaw -RepoRoot $RepoRoot)
    foreach ($pr in $prs) {
        Add-GhPrHeadCommittedAtFromFleetMemo -RepoRoot $RepoRoot -Pr $pr
    }
    return $prs
}

function Invoke-GhOpenPrListForNumbers {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [int[]]$PrNumbers,
        [scriptblock]$ProgressWriter = $null,
        [string]$Consumer = ''
    )

    $unique = @($PrNumbers | Where-Object { $_ -gt 0 } | Sort-Object -Unique)
    if ($unique.Count -eq 0) {
        return @()
    }

    $prs = @()
    $ordinal = 0
    foreach ($n in $unique) {
        $ordinal += 1
        if ($ProgressWriter) {
            & $ProgressWriter 'open_pr_view' $ordinal
        }
        $pr = Invoke-GhFleetCachedPrView -RepoRoot $RepoRoot -PrNumber $n -Consumer $Consumer
        if (-not $pr) {
            continue
        }
        if ([string]$pr.state -ne 'OPEN') {
            continue
        }
        Add-GhPrHeadCommittedAtFromFleetMemo -RepoRoot $RepoRoot -Pr $pr
        $prs += $pr
    }
    return $prs
}

function Get-GhEncodedBranchRef {
    param(
        [Parameter(Mandatory = $true)]
        [string]$BranchRef
    )

    return [uri]::EscapeDataString([string]$BranchRef)
}

function Invoke-GhPrChecks {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,
        [Parameter(Mandatory = $true)]
        [int]$PrNumber,
        [string]$HeadSha = '',
        [string]$EmptyChecksWarning = '',
        [string]$Consumer = ''
    )

    if (-not $HeadSha) {
        $view = Invoke-GhFleetCachedPrView -RepoRoot $RepoRoot -PrNumber $PrNumber -Consumer $Consumer
        $HeadSha = [string]$view.headRefOid
    }
    if (-not $HeadSha) {
        if ($EmptyChecksWarning) {
            Write-GhPrChecksLog $EmptyChecksWarning
        }
        return @()
    }

    try {
        return @(Invoke-GhFleetCachedChecksByHeadSha -RepoRoot $RepoRoot -PrNumber $PrNumber -HeadSha $HeadSha -Consumer $Consumer)
    }
    catch {
        if ($_.Exception.Message -match 'snapshot_populate_failed|child_checks_bypass') {
            throw
        }
        if ($EmptyChecksWarning) {
            Write-GhPrChecksLog $EmptyChecksWarning
        }
        return @()
    }
}

function Get-GhRequiredCheckNamesForPr {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,
        [Parameter(Mandatory = $true)]
        [int]$PrNumber,
        [Parameter(Mandatory = $true)]
        [scriptblock]$MergeRequiredNames,
        [string]$ProtectionLookupWarning = '',
        [string]$Consumer = ''
    )

    $prView = Invoke-GhFleetCachedPrView -RepoRoot $RepoRoot -PrNumber $PrNumber -Consumer $Consumer
    if (-not $prView -or -not $prView.baseRefName) {
        return @{ names = $null; lookupFailed = $true }
    }

    $baseRef = [string]$prView.baseRefName
    try {
        $protectionLookup = Invoke-GhFleetCachedBranchProtection -RepoRoot $RepoRoot -BaseBranch $baseRef -Consumer $Consumer
    }
    catch {
        if ($ProtectionLookupWarning) {
            Write-GhPrChecksLog ($ProtectionLookupWarning -f $PrNumber, 1)
        }
        return @{ names = $null; lookupFailed = $true }
    }

    if ($protectionLookup.lookupFailed) {
        return @{ names = $null; lookupFailed = $true }
    }
    if ($protectionLookup.unprotected -or -not $protectionLookup.protection) {
        return @{ names = $null; lookupFailed = $false }
    }

    $rsc = $protectionLookup.protection.required_status_checks
    if (-not $rsc) {
        return @{ names = $null; lookupFailed = $false }
    }

    $merged = & $MergeRequiredNames @{
        contexts = @($rsc.contexts)
        checks   = @($rsc.checks)
    }
    if (-not $merged -or @($merged).Count -eq 0) {
        return @{ names = $null; lookupFailed = $false }
    }

    return @{ names = @($merged); lookupFailed = $false }
}

function Get-GhChecksBundleByPr {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,
        [Parameter(Mandatory = $false)]
        [AllowEmptyCollection()]
        [AllowNull()]
        [array]$OpenPrs,
        [Parameter(Mandatory = $true)]
        [scriptblock]$MergeRequiredNames,
        [string]$EmptyChecksWarningTemplate = 'warn: gh pr checks PR #{0} exit {1} with no parseable JSON',
        [string]$ChecksFetchFailedWarningTemplate = 'warn: checks fetch failed PR #{0} : {1}',
        [string]$ProtectionLookupWarningTemplate = 'warn: branch protection lookup failed PR #{0} (exit {1}); treating required CI as unresolved',
        [scriptblock]$ProgressWriter = $null,
        [string]$Consumer = ''
    )

    $ciChecksByPr = @{}
    $requiredCheckNamesByPr = @{}
    $requiredCheckLookupFailedByPr = @{}
    $OpenPrs = ConvertTo-GhOpenPrArray -OpenPrs $OpenPrs
    if (-not $OpenPrs.Count) {
        return @{
            ciChecksByPr                  = $ciChecksByPr
            requiredCheckNamesByPr        = $requiredCheckNamesByPr
            requiredCheckLookupFailedByPr = $requiredCheckLookupFailedByPr
        }
    }
    $ordinal = 0
    foreach ($pr in @($OpenPrs)) {
        $ordinal += 1
        $n = [int]$pr.number
        if (-not $n) {
            continue
        }

        $expectedHead = [string]$pr.headRefOid
        $headGate = Test-GhFleetPrHeadCurrent -RepoRoot $RepoRoot -PrNumber $n -ExpectedHeadSha $expectedHead -Consumer $Consumer
        if (-not $headGate.current) {
            Write-GhPrChecksLog ("stale head fence PR #{0}: {1}" -f $n, $headGate.reason)
            continue
        }

        try {
            if ($ProgressWriter) {
                & $ProgressWriter 'checks' $ordinal
            }
            $checks = @(Invoke-GhPrChecks -RepoRoot $RepoRoot -PrNumber $n -HeadSha $expectedHead -Consumer $Consumer)
            $ciChecksByPr[[string]$n] = $checks
            $null = Test-GhFleetCiDeltaUnchanged -RepoRoot $RepoRoot -HeadSha $expectedHead -Checks $checks -Consumer $Consumer
        }
        catch {
            Write-GhPrChecksLog ($ChecksFetchFailedWarningTemplate -f $n, $_)
            $ciChecksByPr[[string]$n] = @()
        }

        if ($ProgressWriter) {
            & $ProgressWriter 'required_checks' $ordinal
        }
        $requiredLookup = Get-GhRequiredCheckNamesForPr -RepoRoot $RepoRoot -PrNumber $n `
            -MergeRequiredNames $MergeRequiredNames `
            -ProtectionLookupWarning $ProtectionLookupWarningTemplate `
            -Consumer $Consumer
        if ($requiredLookup.lookupFailed) {
            $requiredCheckLookupFailedByPr[[string]$n] = $true
        }
        elseif ($requiredLookup.names) {
            $requiredCheckNamesByPr[[string]$n] = @($requiredLookup.names)
        }
    }

    return @{
        ciChecksByPr                  = $ciChecksByPr
        requiredCheckNamesByPr        = $requiredCheckNamesByPr
        requiredCheckLookupFailedByPr = $requiredCheckLookupFailedByPr
    }
}
