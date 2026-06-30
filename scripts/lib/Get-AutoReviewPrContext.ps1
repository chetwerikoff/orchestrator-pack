#requires -Version 5.1
<#
.SYNOPSIS
  Resolve PR number and linked GitHub issue from the reviewed repo (gh + git).
#>

function Get-IssueNumberFromDeclarationFilename {
    param([string]$RelativePath)

    if ($RelativePath -match '(?:^|[\\/])docs[\\/]declarations[\\/](\d+)\.[^\\/]+\.json$') {
        $n = [int]$Matches[1]
        if ($n -gt 0) {
            return $n
        }
    }

    return $null
}

function Get-IssueNumberFromBranchDeclarationDiff {
    param([string]$RepoRoot)

    $issueNumbers = [System.Collections.Generic.HashSet[int]]::new()
    Push-Location -LiteralPath $RepoRoot
    try {
        $diffRanges = @(
            'origin/main...HEAD',
            'main...HEAD'
        )

        $mergeBase = (git merge-base HEAD origin/main 2>$null)
        if ($mergeBase) {
            $diffRanges += "$mergeBase..HEAD"
        }

        $mergeBaseMain = (git merge-base HEAD main 2>$null)
        if ($mergeBaseMain) {
            $diffRanges += "$mergeBaseMain..HEAD"
        }

        foreach ($range in $diffRanges) {
            $files = @(git diff --name-only $range -- 'docs/declarations/*.json' 2>$null)
            foreach ($file in $files) {
                if ([string]::IsNullOrWhiteSpace($file)) {
                    continue
                }

                $n = Get-IssueNumberFromDeclarationFilename -RelativePath ($file.Replace('\', '/'))
                if ($n) {
                    [void]$issueNumbers.Add($n)
                }
            }
        }

        if ($issueNumbers.Count -eq 1) {
            return @($issueNumbers)[0]
        }

        return $null
    }
    finally {
        Pop-Location
    }
}

function Get-IssueNumberFromDeclarationSnapshots {
    param(
        [string]$RepoRoot,
        [string]$SessionId
    )

    $fromBranch = Get-IssueNumberFromBranchDeclarationDiff -RepoRoot $RepoRoot
    if ($fromBranch) {
        return $fromBranch
    }

    $declDir = Join-Path $RepoRoot 'docs/declarations'
    if (-not (Test-Path -LiteralPath $declDir -PathType Container)) {
        return $null
    }

    if (-not [string]::IsNullOrWhiteSpace($SessionId)) {
        $sessionFiles = @(Get-ChildItem -LiteralPath $declDir -Filter "*.$SessionId.json" -File -ErrorAction SilentlyContinue)
        if ($sessionFiles.Count -gt 0) {
            try {
                $json = Get-Content -LiteralPath $sessionFiles[0].FullName -Raw | ConvertFrom-Json
                $n = [int]$json.issue_number
                if ($n -gt 0) {
                    return $n
                }
            }
            catch {
                return $null
            }
        }
    }

    # Do not scan the entire declarations directory: review worktrees and long-lived
    # branches accumulate many issue snapshots and yield ambiguous issue numbers.
    # Branch-diff and session-specific files are the only authoritative fallbacks.
    return $null
}

function Get-IssueNumberFromPrDiff {
    param(
        [string]$RepoRoot,
        [int]$PrNumber
    )

    if ($PrNumber -le 0 -or -not (Get-Command gh -ErrorAction SilentlyContinue)) {
        return $null
    }

    $issueNumbers = [System.Collections.Generic.HashSet[int]]::new()
    Push-Location -LiteralPath $RepoRoot
    try {
        $files = @(gh pr diff $PrNumber --name-only 2>$null)
        foreach ($file in $files) {
            if ([string]::IsNullOrWhiteSpace($file)) {
                continue
            }

            $n = Get-IssueNumberFromDeclarationFilename -RelativePath ($file.Replace('\', '/'))
            if ($n) {
                [void]$issueNumbers.Add($n)
            }
        }

        if ($issueNumbers.Count -eq 1) {
            return @($issueNumbers)[0]
        }

        return $null
    }
    finally {
        Pop-Location
    }
}

function Get-GhPrContextFromView {
    param(
        [string]$RepoRoot,
        [Parameter(Mandatory)]
        [int]$PrNumber
    )

    if ($PrNumber -le 0 -or -not (Get-Command gh -ErrorAction SilentlyContinue)) {
        return $null
    }

    Push-Location -LiteralPath $RepoRoot
    try {
        $raw = (gh pr view ([string]$PrNumber) --json 'number,body' --jq '{number: .number, body: .body}' 2>$null)
        if (-not $raw) {
            return $null
        }

        return ($raw | ConvertFrom-Json)
    }
    finally {
        Pop-Location
    }
}

function Set-AutoReviewResultFromPrView {
    param(
        [pscustomobject]$Result,
        $PrView
    )

    if (-not $PrView -or -not $PrView.number) {
        return
    }

    $Result.PrNumber = [int]$PrView.number
    $body = [string]$PrView.body
    if (-not $body -or $Result.IssueNumber) {
        return
    }

    $matches = [regex]::Matches(
        $body,
        '(?i)\b(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\s+#(\d+)\b'
    )
    if ($matches.Count -eq 0) {
        return
    }

    $issueNumber = [int]$matches[$matches.Count - 1].Groups[1].Value
    if ($issueNumber -gt 0) {
        $Result.IssueNumber = $issueNumber
    }
}

function Get-GhPrNumberForBranch {
    param(
        [string]$RepoRoot,
        [string]$BranchName
    )

    if ([string]::IsNullOrWhiteSpace($BranchName) -or $BranchName -eq 'HEAD') {
        return $null
    }
    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
        return $null
    }

    Push-Location -LiteralPath $RepoRoot
    try {
        $prRaw = (gh pr list --head $BranchName --json number --jq '.[0].number' 2>$null)
        if ($prRaw) {
            $prNumber = [int]$prRaw
            if ($prNumber -gt 0) {
                return $prNumber
            }
        }

        return $null
    }
    finally {
        Pop-Location
    }
}

function Get-GhPrNumberForHeadSha {
    param(
        [string]$RepoRoot,
        [string]$HeadSha
    )

    if ([string]::IsNullOrWhiteSpace($HeadSha) -or -not (Get-Command gh -ErrorAction SilentlyContinue)) {
        return $null
    }

    Push-Location -LiteralPath $RepoRoot
    try {
        # Detached HEAD: branch-based gh pr list/--head fails; match open PRs by headRefOid.
        # Parse JSON in PowerShell — inline --jq with embedded SHA breaks on Windows (gh/gojq).
        $json = gh pr list --state open --json number,headRefOid --limit 200 2>$null
        if (-not $json) {
            return $null
        }

        $prs = @($json | ConvertFrom-Json)
        foreach ($pr in $prs) {
            if ([string]$pr.headRefOid -eq $HeadSha) {
                $prNumber = [int]$pr.number
                if ($prNumber -gt 0) {
                    return $prNumber
                }
            }
        }

        return $null
    }
    finally {
        Pop-Location
    }
}

function Get-AutoReviewPrContext {
    param([string]$RepoRoot)

    $result = [pscustomobject]@{
        PrNumber    = $null
        IssueNumber = $null
    }

    $sessionId = $null
    if ($env:AO_SESSION_ID) {
        $sessionId = $env:AO_SESSION_ID.Trim()
    }

    $fromEnvIssue = 0
    if ($env:AO_ISSUE_NUMBER) {
        $fromEnvIssue = [int]$env:AO_ISSUE_NUMBER
    }
    elseif ($env:AO_ISSUE_ID) {
        $fromEnvIssue = [int]$env:AO_ISSUE_ID
    }
    if ($fromEnvIssue -gt 0) {
        $result.IssueNumber = $fromEnvIssue
    }

    $branch = $null
    $headSha = $null
    Push-Location -LiteralPath $RepoRoot
    try {
        $branch = (git rev-parse --abbrev-ref HEAD 2>$null)
        $headSha = (git rev-parse HEAD 2>$null)
    }
    finally {
        Pop-Location
    }

    $prFromEnv = 0
    if ($env:AO_PR_NUMBER) {
        $prFromEnv = [int]$env:AO_PR_NUMBER
    }
    elseif ($env:GITHUB_PULL_REQUEST_NUMBER) {
        $prFromEnv = [int]$env:GITHUB_PULL_REQUEST_NUMBER
    }
    elseif ($env:GITHUB_PR_NUMBER) {
        $prFromEnv = [int]$env:GITHUB_PR_NUMBER
    }

    if (Get-Command gh -ErrorAction SilentlyContinue) {
        # Never call bare `gh pr view` — AO review workspaces use detached HEAD.
        if ($prFromEnv -gt 0) {
            $prView = Get-GhPrContextFromView -RepoRoot $RepoRoot -PrNumber $prFromEnv
            Set-AutoReviewResultFromPrView -Result $result -PrView $prView
        }

        if (-not $result.PrNumber) {
            $prNumber = $null
            if ($headSha) {
                $prNumber = Get-GhPrNumberForHeadSha -RepoRoot $RepoRoot -HeadSha $headSha
            }
            if (-not $prNumber -and $branch) {
                $prNumber = Get-GhPrNumberForBranch -RepoRoot $RepoRoot -BranchName $branch
            }

            if ($prNumber) {
                $prView = Get-GhPrContextFromView -RepoRoot $RepoRoot -PrNumber $prNumber
                Set-AutoReviewResultFromPrView -Result $result -PrView $prView
            }
        }
    }

    if (-not $result.IssueNumber -and $result.PrNumber) {
        $fromPrDiff = Get-IssueNumberFromPrDiff -RepoRoot $RepoRoot -PrNumber $result.PrNumber
        if ($fromPrDiff) {
            $result.IssueNumber = $fromPrDiff
        }
    }

    if (-not $result.IssueNumber) {
        $fromDeclarations = Get-IssueNumberFromDeclarationSnapshots -RepoRoot $RepoRoot -SessionId $sessionId
        if ($fromDeclarations) {
            $result.IssueNumber = $fromDeclarations
        }
    }

    return $result
}

function Add-PackReviewAutoForwardArgs {
    param(
        [System.Collections.Generic.List[string]]$ForwardArgs,
        [string]$RepoRoot
    )

    $autoCtx = Get-AutoReviewPrContext -RepoRoot $RepoRoot
    if ($autoCtx.PrNumber -and $ForwardArgs -notcontains '--pr-number') {
        $ForwardArgs.Add('--pr-number') | Out-Null
        $ForwardArgs.Add([string]$autoCtx.PrNumber) | Out-Null
    }
    if ($autoCtx.IssueNumber -and $ForwardArgs -notcontains '--issue') {
        $ForwardArgs.Add('--issue') | Out-Null
        $ForwardArgs.Add([string]$autoCtx.IssueNumber) | Out-Null
        if (-not $env:AO_ISSUE_NUMBER) {
            $env:AO_ISSUE_NUMBER = [string]$autoCtx.IssueNumber
        }
    }

  # Trusted local AO review: pass explicit --source codex-local (fail-closed sandbox
  # in the wrapper rejects env-derived defaults). CI callers must pass their own source.
    if ($ForwardArgs -notcontains '--source' -and $env:GITHUB_ACTIONS -ne 'true') {
        $ForwardArgs.Add('--source') | Out-Null
        $ForwardArgs.Add('codex-local') | Out-Null
    }

    return $autoCtx
}
