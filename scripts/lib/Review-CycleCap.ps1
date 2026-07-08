#requires -Version 5.1
<#
  Pack-owned per-tier PR review-cycle cap state (Issue #646).
  Consumes pre-fetched review run rows from Get-AoReviewRuns (#611 read model).
#>

. (Join-Path $PSScriptRoot 'MechanicalReconcileNode.ps1')

$Script:ReviewCycleCapFilterCli = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'docs/review-cycle-cap.mjs'

function Get-ReviewCycleCapStateRoot {
    if ($env:ORCHESTRATOR_PACK_REVIEW_CYCLE_CAP_STATE) {
        return $env:ORCHESTRATOR_PACK_REVIEW_CYCLE_CAP_STATE
    }
    return Join-Path $HOME '.local/state/orchestrator-pack-review-cycle-cap'
}

function Get-ReviewCycleCapStatePath {
    param([string]$ProjectId = 'orchestrator-pack')

    $project = [string]$ProjectId
    if (-not $project) { $project = 'orchestrator-pack' }
    return Join-Path (Get-ReviewCycleCapStateRoot) "$project.json"
}

function Get-ReviewCycleCapState {
    param([string]$Path = '')

    $resolved = if ($Path) { $Path } else { Get-ReviewCycleCapStatePath }
    if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
        return @{}
    }
    return Get-Content -LiteralPath $resolved -Raw | ConvertFrom-Json -AsHashtable
}

function Set-ReviewCycleCapState {
    param(
        [string]$Path = '',
        [object]$State
    )

    $resolved = if ($Path) { $Path } else { Get-ReviewCycleCapStatePath }
    $normalized = if ($State -is [System.Collections.IDictionary]) {
        Copy-MechanicalJsonMap -Map $State
    }
    else {
        Copy-MechanicalJsonMap -Map ($State | ConvertTo-Json -Depth 30 -Compress | ConvertFrom-Json)
    }
    $dir = Split-Path -Parent $resolved
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    ($normalized | ConvertTo-Json -Depth 30 -Compress) | Set-Content -LiteralPath $resolved -Encoding utf8NoBOM
}

function Invoke-ReviewCycleCapFilterCli {
    param(
        [string]$Subcommand,
        [hashtable]$Payload
    )

    return Invoke-MechanicalNodeFilterCli -FilterCliPath $Script:ReviewCycleCapFilterCli `
        -Subcommand $Subcommand -Payload $Payload -Label 'review-cycle-cap' -JsonDepth 30
}

function Evaluate-ReviewCycleCapGate {
    param([hashtable]$Payload)

    return Invoke-ReviewCycleCapFilterCli -Subcommand 'evaluateGate' -Payload $Payload
}

function Get-ReviewCycleCapIssueBody {
    param(
        [Parameter(Mandatory)]
        [int]$PrNumber,
        [string]$RepoRoot,
        [string]$HeadSha = '',
        [string]$ProjectId = 'orchestrator-pack',
        [hashtable]$FixtureSnapshot
    )

    if ($FixtureSnapshot -and $FixtureSnapshot['issueBodiesByPr']) {
        $prKey = [string]$PrNumber
        if ($FixtureSnapshot['issueBodiesByPr'].ContainsKey($prKey) -and $FixtureSnapshot['issueBodiesByPr'][$prKey]) {
            return [string]$FixtureSnapshot['issueBodiesByPr'][$prKey]
        }
    }
    if ($FixtureSnapshot -and $FixtureSnapshot['issueBody']) {
        return [string]$FixtureSnapshot['issueBody']
    }

    # Per-PR declaration diff first — reconcile/reeval iterate many open PRs; AO_ISSUE_NUMBER
    # is the active worker session and must not override other PRs' tier budgets.
    $issueNumber = 0
    if ($RepoRoot -and $PrNumber -gt 0) {
        . (Join-Path $PSScriptRoot 'Get-AutoReviewPrContext.ps1')
        $fromDiff = Get-IssueNumberFromPrDiff -RepoRoot $RepoRoot -PrNumber $PrNumber
        if ($fromDiff) {
            $issueNumber = [int]$fromDiff
        }
    }
    if ($issueNumber -le 0 -and $env:AO_ISSUE_NUMBER) {
        [void][int]::TryParse([string]$env:AO_ISSUE_NUMBER, [ref]$issueNumber)
    }

    $normalizedHead = ([string]$HeadSha).Trim().ToLowerInvariant()
    if ($issueNumber -gt 0 -and $normalizedHead) {
        $resolver = Join-Path (Split-Path -Parent $PSScriptRoot) 'resolve-bound-issue-snapshot.ps1'
        if (Test-Path -LiteralPath $resolver -PathType Leaf) {
            try {
                $snapshotPath = & pwsh -NoProfile -File $resolver -ProjectId $ProjectId `
                    -PrNumber $PrNumber -PrHeadSha $normalizedHead -IssueNumber $issueNumber 2>$null
                if ($snapshotPath -and (Test-Path -LiteralPath $snapshotPath -PathType Leaf)) {
                    return Get-Content -LiteralPath $snapshotPath -Raw
                }
            }
            catch {
                # fall through to live issue body
            }
        }
    }

    if ($issueNumber -gt 0 -and (Get-Command gh -ErrorAction SilentlyContinue) -and $RepoRoot) {
        Push-Location -LiteralPath $RepoRoot
        try {
            $raw = gh issue view $issueNumber --json body 2>$null
            if ($raw) {
                return [string](($raw | ConvertFrom-Json).body)
            }
        }
        finally {
            Pop-Location
        }
    }

    return $null
}

function Get-ReviewCycleCapIssueBodiesByPr {
    param(
        [array]$OpenPrs,
        [string]$RepoRoot,
        [string]$ProjectId = 'orchestrator-pack',
        [hashtable]$FixtureSnapshot
    )

    $byPr = @{}
    foreach ($pr in @($OpenPrs)) {
        $prNumber = [int]$pr.number
        if ($prNumber -le 0) { continue }
        $headSha = if ($pr.headRefOid) { [string]$pr.headRefOid } else { '' }
        $body = Get-ReviewCycleCapIssueBody -PrNumber $prNumber -RepoRoot $RepoRoot -HeadSha $headSha `
            -ProjectId $ProjectId -FixtureSnapshot $FixtureSnapshot
        if ($body) {
            $byPr[[string]$prNumber] = $body
        }
    }
    return $byPr
}
