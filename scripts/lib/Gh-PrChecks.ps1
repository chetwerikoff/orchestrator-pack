#requires -Version 5.1
<#
.SYNOPSIS
  Shared gh pr list / checks / branch-protection helpers for mechanical reconcile scripts.
#>

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

function Invoke-GhOpenPrList {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot
    )

    Push-Location -LiteralPath $RepoRoot
    try {
        # Keep the list query cheap. Requesting the `commits` connection here
        # pulls every commit (and its `authors` connection) for up to --limit
        # PRs, whose static GraphQL cost exceeds GitHub's 500k node limit and
        # fails the whole query. The head commit's committed date is resolved
        # per-PR below via a single-commit REST lookup instead.
        $raw = gh pr list --state open --json number,headRefOid,baseRefName --limit 200 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "gh pr list failed (exit $LASTEXITCODE): $raw"
        }

        $prs = @($raw | ConvertFrom-Json)
        foreach ($pr in $prs) {
            $headSha = [string]$pr.headRefOid
            if (-not $headSha) { continue }
            $committedDate = gh api "repos/{owner}/{repo}/commits/$headSha" --jq '.commit.committer.date' 2>$null
            if ($LASTEXITCODE -eq 0 -and $committedDate) {
                $pr | Add-Member -NotePropertyName headCommittedAt -NotePropertyValue ([string]$committedDate).Trim() -Force
            }
        }
        return $prs
    }
    finally {
        Pop-Location
    }
}


function Invoke-GhOpenPrListForNumbers {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [int[]]$PrNumbers
    )

    $unique = @($PrNumbers | Where-Object { $_ -gt 0 } | Sort-Object -Unique)
    if ($unique.Count -eq 0) {
        return @()
    }

    Push-Location -LiteralPath $RepoRoot
    try {
        $prs = @()
        foreach ($n in $unique) {
            $raw = gh pr view $n --json number,headRefOid,baseRefName 2>&1
            if ($LASTEXITCODE -ne 0) {
                continue
            }
            $pr = $raw | ConvertFrom-Json
            $headSha = [string]$pr.headRefOid
            if (-not $headSha) {
                continue
            }
            $committedDate = gh api "repos/{owner}/{repo}/commits/$headSha" --jq '.commit.committer.date' 2>$null
            if ($LASTEXITCODE -eq 0 -and $committedDate) {
                $pr | Add-Member -NotePropertyName headCommittedAt -NotePropertyValue ([string]$committedDate).Trim() -Force
            }
            $prs += $pr
        }
        return $prs
    }
    finally {
        Pop-Location
    }
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
        [string]$EmptyChecksWarning = ''
    )

    Push-Location -LiteralPath $RepoRoot
    try {
        $raw = gh pr checks $PrNumber --json name,state,bucket,link,startedAt,completedAt,workflow,description 2>&1
        $exitCode = $LASTEXITCODE
        $checks = ConvertFrom-GhJsonArrayOutput -RawOutput $raw
        if ($exitCode -ne 0 -and $checks.Count -eq 0 -and $EmptyChecksWarning) {
            Write-GhPrChecksLog $EmptyChecksWarning
        }
        return @($checks)
    }
    finally {
        Pop-Location
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
        [string]$ProtectionLookupWarning = ''
    )

    Push-Location -LiteralPath $RepoRoot
    try {
        $baseRef = gh pr view $PrNumber --json baseRefName -q .baseRefName 2>&1
        if ($LASTEXITCODE -ne 0 -or -not $baseRef) {
            return @{ names = $null; lookupFailed = $true }
        }

        $repoSlug = gh repo view --json nameWithOwner -q .nameWithOwner 2>&1
        if ($LASTEXITCODE -ne 0 -or -not $repoSlug) {
            return @{ names = $null; lookupFailed = $true }
        }

        $encodedBaseRef = Get-GhEncodedBranchRef -BranchRef $baseRef
        $protectionRaw = gh api "repos/$repoSlug/branches/$encodedBaseRef/protection" 2>&1
        $protectionExit = $LASTEXITCODE
        if ($protectionExit -ne 0) {
            $protectionText = ($protectionRaw | ForEach-Object { $_.ToString() }) -join "`n"
            if ($protectionText -match 'Branch not protected|404') {
                return @{ names = $null; lookupFailed = $false }
            }
            if ($ProtectionLookupWarning) {
                Write-GhPrChecksLog ($ProtectionLookupWarning -f $PrNumber, $protectionExit)
            }
            return @{ names = $null; lookupFailed = $true }
        }

        $protection = $protectionRaw | ConvertFrom-Json
        $rsc = $protection.required_status_checks
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
    finally {
        Pop-Location
    }
}

function Get-GhChecksBundleByPr {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [array]$OpenPrs,
        [Parameter(Mandatory = $true)]
        [scriptblock]$MergeRequiredNames,
        [string]$EmptyChecksWarningTemplate = 'warn: gh pr checks PR #{0} exit {1} with no parseable JSON',
        [string]$ChecksFetchFailedWarningTemplate = 'warn: checks fetch failed PR #{0} : {1}',
        [string]$ProtectionLookupWarningTemplate = 'warn: branch protection lookup failed PR #{0} (exit {1}); treating required CI as unresolved'
    )

    $ciChecksByPr = @{}
    $requiredCheckNamesByPr = @{}
    $requiredCheckLookupFailedByPr = @{}
    if (-not @($OpenPrs).Count) {
        return @{
            ciChecksByPr                  = $ciChecksByPr
            requiredCheckNamesByPr        = $requiredCheckNamesByPr
            requiredCheckLookupFailedByPr = $requiredCheckLookupFailedByPr
        }
    }
    foreach ($pr in @($OpenPrs)) {
        $n = [int]$pr.number
        if (-not $n) {
            continue
        }

        try {
            $ciChecksByPr[[string]$n] = @(Invoke-GhPrChecks -RepoRoot $RepoRoot -PrNumber $n)
        }
        catch {
            Write-GhPrChecksLog ($ChecksFetchFailedWarningTemplate -f $n, $_)
            $ciChecksByPr[[string]$n] = @()
        }

        $requiredLookup = Get-GhRequiredCheckNamesForPr -RepoRoot $RepoRoot -PrNumber $n `
            -MergeRequiredNames $MergeRequiredNames `
            -ProtectionLookupWarning $ProtectionLookupWarningTemplate
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
