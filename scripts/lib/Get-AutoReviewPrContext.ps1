#requires -Version 5.1
<#
.SYNOPSIS
  Resolve PR number and linked GitHub issue from the reviewed repo (gh + git).
#>

function Get-IssueNumberFromDeclarationSnapshots {
    param(
        [string]$RepoRoot,
        [string]$SessionId
    )

    $declDir = Join-Path $RepoRoot 'docs\declarations'
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
                # fall through to unique-issue scan
            }
        }
    }

    $issueNumbers = [System.Collections.Generic.HashSet[int]]::new()
    foreach ($file in Get-ChildItem -LiteralPath $declDir -Filter '*.json' -File) {
        try {
            $json = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json
            $n = [int]$json.issue_number
            if ($n -gt 0) {
                [void]$issueNumbers.Add($n)
            }
        }
        catch {
            continue
        }
    }

    if ($issueNumbers.Count -eq 1) {
        return @($issueNumbers)[0]
    }

    return $null
}

function Get-GhPrNumberForHead {
    param(
        [string]$RepoRoot,
        [string]$HeadRef
    )

    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
        return $null
    }

    Push-Location -LiteralPath $RepoRoot
    try {
        foreach ($head in @($HeadRef)) {
            if ([string]::IsNullOrWhiteSpace($head)) {
                continue
            }

            $prRaw = (gh pr list --head $head --json number --jq '.[0].number' 2>$null)
            if ($prRaw) {
                $prNumber = [int]$prRaw
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

    if (Get-Command gh -ErrorAction SilentlyContinue) {
        $prNumber = Get-GhPrNumberForHead -RepoRoot $RepoRoot -HeadRef $branch
        if (-not $prNumber -and $headSha) {
            $prNumber = Get-GhPrNumberForHead -RepoRoot $RepoRoot -HeadRef $headSha
        }

        if ($prNumber) {
            $result.PrNumber = $prNumber

            Push-Location -LiteralPath $RepoRoot
            try {
                $body = (gh pr view $prNumber --json body --jq '.body' 2>$null)
                if ($body) {
                    $matches = [regex]::Matches(
                        $body,
                        '(?i)\b(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\s+#(\d+)\b'
                    )
                    if ($matches.Count -gt 0) {
                        $issueNumber = [int]$matches[$matches.Count - 1].Groups[1].Value
                        if ($issueNumber -gt 0) {
                            $result.IssueNumber = $issueNumber
                        }
                    }
                }
            }
            finally {
                Pop-Location
            }
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

    return $autoCtx
}
