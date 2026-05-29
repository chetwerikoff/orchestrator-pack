#requires -Version 5.1
<#
.SYNOPSIS
  Resolve PR number and linked GitHub issue from the reviewed repo (gh + git).
#>

function Get-AutoReviewPrContext {
    param([string]$RepoRoot)

    $result = [pscustomobject]@{
        PrNumber    = $null
        IssueNumber = $null
    }

    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
        return $result
    }

    Push-Location -LiteralPath $RepoRoot
    try {
        $head = (git rev-parse HEAD 2>$null)
        if (-not $head) { return $result }

        $prRaw = (gh pr list --head $head --json number --jq '.[0].number' 2>$null)
        if (-not $prRaw) { return $result }

        $prNumber = [int]$prRaw
        if ($prNumber -le 0) { return $result }
        $result.PrNumber = $prNumber

        $body = (gh pr view $prNumber --json body --jq '.body' 2>$null)
        if (-not $body) { return $result }

        $matches = [regex]::Matches(
            $body,
            '(?i)\b(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\s+#(\d+)\b'
        )
        if ($matches.Count -eq 0) { return $result }

        $issueNumber = [int]$matches[$matches.Count - 1].Groups[1].Value
        if ($issueNumber -gt 0) {
            $result.IssueNumber = $issueNumber
        }

        return $result
    }
    catch {
        return $result
    }
    finally {
        Pop-Location
    }
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
    }

    return $autoCtx
}
