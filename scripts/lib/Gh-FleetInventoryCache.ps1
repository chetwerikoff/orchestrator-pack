#requires -Version 5.1
<#
.SYNOPSIS
  Runtime-neutral GitHub inventory service used by mechanical reconcile callers.

.DESCRIPTION
  Issue #1248 removes the AO-era supervisor runtime and its PowerShell
  side-effect fence. GitHub inventory is non-runtime service work retained for
  #1250, so this module preserves the existing service surface without importing
  or emulating any retired runtime owner. Requests are delegated to the existing
  pack-owned GitHub signal transport. The shared cache implementation is deferred
  with the rest of the service layer; correctness does not depend on cache state.
#>

. (Join-Path $PSScriptRoot 'Get-SupervisedRepoSlug.ps1')
. (Join-Path $PSScriptRoot 'Gh-SignalDispatch.ps1')

$Script:GhFleetOpenPrListTtlSeconds = 15
$Script:GhFleetPrViewTtlSeconds = 15
$Script:GhFleetCiChecksTtlSeconds = 15
$Script:GhFleetBranchProtectionTtlSeconds = 300
$Script:GhFleetNegativeLookupTtlSeconds = 30
$Script:GhFleetReviewFreshnessTtlSeconds = 30
$Script:GhFleetRepoSlugByRoot = @{}

function Set-GhGovernorCallerContext {
    param([string]$Consumer = '', [string]$Lane = '')
    $saved = @{ Lane = $env:GH_GOVERNOR_LANE; Consumer = $env:GH_GOVERNOR_CONSUMER }
    if ($Consumer) { $env:GH_GOVERNOR_CONSUMER = $Consumer }
    if ($Lane) { $env:GH_GOVERNOR_LANE = $Lane }
    return $saved
}

function Restore-GhGovernorCallerContext {
    param([hashtable]$Saved)
    if (-not $Saved) { return }
    if ($Saved.Lane) { $env:GH_GOVERNOR_LANE = [string]$Saved.Lane }
    else { Remove-Item Env:GH_GOVERNOR_LANE -ErrorAction SilentlyContinue }
    if ($Saved.Consumer) { $env:GH_GOVERNOR_CONSUMER = [string]$Saved.Consumer }
    else { Remove-Item Env:GH_GOVERNOR_CONSUMER -ErrorAction SilentlyContinue }
}

function Get-GhFleetInventoryCacheRoot { return '' }

function Get-GhFleetInventoryCacheTtlSeconds {
    param([string]$Name)
    switch ($Name) {
        'openPrList' { return $Script:GhFleetOpenPrListTtlSeconds }
        'prView' { return $Script:GhFleetPrViewTtlSeconds }
        'ciChecks' { return $Script:GhFleetCiChecksTtlSeconds }
        'branchProtection' { return $Script:GhFleetBranchProtectionTtlSeconds }
        'negativeLookup' { return $Script:GhFleetNegativeLookupTtlSeconds }
        'reviewFreshness' { return $Script:GhFleetReviewFreshnessTtlSeconds }
        default { return 0 }
    }
}

function Resolve-GhFleetRepoSlug {
    param([Parameter(Mandatory = $true)][string]$RepoRoot)
    if ($Script:GhFleetRepoSlugByRoot.ContainsKey($RepoRoot)) {
        return [string]$Script:GhFleetRepoSlugByRoot[$RepoRoot]
    }
    $slug = Get-SupervisedRepoSlug -RepoRoot $RepoRoot
    if (-not $slug) { $slug = (Resolve-Path -LiteralPath $RepoRoot).Path }
    $Script:GhFleetRepoSlugByRoot[$RepoRoot] = [string]$slug
    return [string]$slug
}

function Invoke-GhFleetJson {
    param(
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][ValidateSet('array','object','number')][string]$ExpectedRoot,
        [int[]]$AllowedExitCodes = @(0),
        [string]$Consumer = ''
    )
    $saved = Set-GhGovernorCallerContext -Consumer $Consumer -Lane 'background'
    try {
        $result = Invoke-GhSignalJsonCommand -Arguments $Arguments -ExpectedRoot $ExpectedRoot `
            -AllowedExitCodes $AllowedExitCodes -WorkingDirectory $RepoRoot
        if (-not $result.ok) {
            throw "gh inventory request failed: $(Format-GhSignalFailureDetail -Result $result)"
        }
        return $result.value
    }
    finally { Restore-GhGovernorCallerContext -Saved $saved }
}

function Invoke-GhFleetCachedOpenPrListRaw {
    param([Parameter(Mandatory = $true)][string]$RepoRoot, [string]$Consumer = '', [switch]$BoundedListOnly)
    return @(Invoke-GhFleetJson -RepoRoot $RepoRoot -Consumer $Consumer -ExpectedRoot 'array' `
        -Arguments @('pr','list','--state','open','--json','number,headRefOid,baseRefName,headRefName','--limit','200'))
}

function Invoke-GhFleetFetchCommitDateUpstream {
    param([Parameter(Mandatory = $true)][string]$RepoRoot, [Parameter(Mandatory = $true)][string]$HeadSha)
    if (-not $HeadSha) { return $null }
    try {
        $result = Invoke-GhFleetJson -RepoRoot $RepoRoot -ExpectedRoot 'object' `
            -Arguments @('api',"repos/{owner}/{repo}/commits/$HeadSha")
        if ($result.commit -and $result.commit.committer -and $result.commit.committer.date) {
            return [string]$result.commit.committer.date
        }
    }
    catch { return $null }
    return $null
}

function Invoke-GhFleetResolveCommitDate {
    param([Parameter(Mandatory = $true)][string]$RepoRoot, [Parameter(Mandatory = $true)][string]$HeadSha)
    return Invoke-GhFleetFetchCommitDateUpstream -RepoRoot $RepoRoot -HeadSha $HeadSha
}

function Add-GhPrHeadCommittedAtFromFleetMemo {
    param([Parameter(Mandatory = $true)][string]$RepoRoot, [Parameter(Mandatory = $true)][object]$Pr)
    $headSha = [string]$Pr.headRefOid
    if (-not $headSha) { return }
    $date = Invoke-GhFleetResolveCommitDate -RepoRoot $RepoRoot -HeadSha $headSha
    if ($date) { $Pr | Add-Member -NotePropertyName headCommittedAt -NotePropertyValue $date -Force }
}

function Invoke-GhFleetCachedPrView {
    param([Parameter(Mandatory = $true)][string]$RepoRoot, [Parameter(Mandatory = $true)][int]$PrNumber, [string]$Consumer = '')
    if ($PrNumber -le 0) { return $null }
    return Invoke-GhFleetJson -RepoRoot $RepoRoot -Consumer $Consumer -ExpectedRoot 'object' `
        -Arguments @('pr','view',[string]$PrNumber,'--json','number,headRefOid,baseRefName,state,isDraft,mergeable,headRefName')
}

function Invoke-GhFleetCachedChecksByHeadSha {
    param(
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [Parameter(Mandatory = $true)][int]$PrNumber,
        [Parameter(Mandatory = $true)][string]$HeadSha,
        [string]$Consumer = ''
    )
    if ($PrNumber -le 0 -or -not $HeadSha) { return @() }
    return @(Invoke-GhFleetJson -RepoRoot $RepoRoot -Consumer $Consumer -ExpectedRoot 'array' `
        -AllowedExitCodes @(0,1,8) -Arguments @('pr','checks',[string]$PrNumber,'--json','name,state,bucket,link,startedAt,completedAt,workflow,description'))
}

function Invoke-GhFleetCachedBranchProtection {
    param([Parameter(Mandatory = $true)][string]$RepoRoot, [Parameter(Mandatory = $true)][string]$BaseBranch, [string]$Consumer = '')
    if (-not $BaseBranch) { return @{ lookupFailed = $true; unprotected = $false; protection = $null } }
    $slug = Resolve-GhFleetRepoSlug -RepoRoot $RepoRoot
    $encoded = [uri]::EscapeDataString($BaseBranch)
    try {
        $protection = Invoke-GhFleetJson -RepoRoot $RepoRoot -Consumer $Consumer -ExpectedRoot 'object' `
            -Arguments @('api',"repos/$slug/branches/$encoded/protection")
        return @{ lookupFailed = $false; unprotected = $false; protection = $protection }
    }
    catch {
        if ($_.Exception.Message -match 'Branch not protected|404') {
            return @{ lookupFailed = $false; unprotected = $true; protection = $null }
        }
        throw
    }
}

function Invoke-GhFleetCachedNegativeLookup {
    param(
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [Parameter(Mandatory = $true)][string]$NegativeKind,
        [Parameter(Mandatory = $true)][string]$IdentityKey,
        [Parameter(Mandatory = $true)][scriptblock]$PopulateWhenMiss,
        [string]$Consumer = ''
    )
    $saved = Set-GhGovernorCallerContext -Consumer $Consumer -Lane 'background'
    try { return & $PopulateWhenMiss }
    finally { Restore-GhGovernorCallerContext -Saved $saved }
}

function Invoke-GhFleetCachedPrNumberByHeadBranch {
    param([Parameter(Mandatory = $true)][string]$RepoRoot, [Parameter(Mandatory = $true)][string]$HeadBranch, [string]$Consumer = '')
    $rows = @(Invoke-GhFleetJson -RepoRoot $RepoRoot -Consumer $Consumer -ExpectedRoot 'array' `
        -Arguments @('pr','list','--head',$HeadBranch,'--json','number,url','--limit','1'))
    if ($rows.Count -eq 0) { return $null }
    $number = [int]$rows[0].number
    if ($number -le 0) { return $null }
    return $number
}

function Invoke-GhFleetCachedReviewFreshness {
    param(
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [Parameter(Mandatory = $true)][int]$PrNumber,
        [Parameter(Mandatory = $true)][string]$HeadSha,
        [Parameter(Mandatory = $true)][bool]$ReviewActive,
        [string]$Consumer = ''
    )
    if (-not $ReviewActive) {
        return @{ active = $false; fresh = $true; etag = $null; upstreamCalls = 0; negative = $true }
    }
    $slug = Resolve-GhFleetRepoSlug -RepoRoot $RepoRoot
    $count = Invoke-GhFleetJson -RepoRoot $RepoRoot -Consumer $Consumer -ExpectedRoot 'number' `
        -Arguments @('api',"repos/$slug/pulls/$PrNumber/reviews",'--jq','length')
    return @{ active = $true; fresh = $true; etag = [string][DateTimeOffset]::UtcNow.Ticks; reviewCount = [int]$count }
}

function Test-GhFleetPrHeadCurrent {
    param(
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [Parameter(Mandatory = $true)][int]$PrNumber,
        [Parameter(Mandatory = $true)][string]$ExpectedHeadSha,
        [string]$Consumer = ''
    )
    try { $view = Invoke-GhFleetCachedPrView -RepoRoot $RepoRoot -PrNumber $PrNumber -Consumer $Consumer }
    catch { return @{ current = $false; reason = 'pr_view_failed' } }
    if (-not $view) { return @{ current = $false; reason = 'no_pr_view' } }
    $head = [string]$view.headRefOid
    if ($head -ne $ExpectedHeadSha) {
        return @{ current = $false; reason = 'stale_head'; cachedHead = $head; expectedHead = $ExpectedHeadSha }
    }
    return @{ current = $true; view = $view; cachedHead = $head }
}

function Get-GhFleetOpenPrIndexes {
    param([Parameter(Mandatory = $true)][string]$RepoRoot)
    $prs = @(Invoke-GhFleetCachedOpenPrListRaw -RepoRoot $RepoRoot)
    $byNumber = @{}; $byHeadRefName = @{}; $byHeadSha = @{}
    foreach ($pr in $prs) {
        if ($pr.number) { $byNumber[[string]$pr.number] = $pr }
        if ($pr.headRefName) { $byHeadRefName[[string]$pr.headRefName] = $pr }
        if ($pr.headRefOid) { $byHeadSha[[string]$pr.headRefOid] = $pr }
    }
    return @{ prs = $prs; byNumber = $byNumber; byHeadRefName = $byHeadRefName; byHeadSha = $byHeadSha }
}

function Test-GhFleetCiDeltaUnchanged {
    param([string]$RepoRoot, [string]$HeadSha, [object[]]$Checks, [string]$Consumer = '')
    return $false
}

function Test-GhFleetHeadAlreadyCovered {
    param([string]$RepoRoot, [string]$HeadSha, [string]$Consumer = '')
    return $false
}

function Get-GhFleetInventoryCacheTtlContract {
    return [ordered]@{
        prView = $Script:GhFleetPrViewTtlSeconds
        ciChecks = $Script:GhFleetCiChecksTtlSeconds
        branchProtection = $Script:GhFleetBranchProtectionTtlSeconds
        negativeLookup = $Script:GhFleetNegativeLookupTtlSeconds
        reviewFreshness = $Script:GhFleetReviewFreshnessTtlSeconds
        openPrList = $Script:GhFleetOpenPrListTtlSeconds
    }
}
