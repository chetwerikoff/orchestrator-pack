#requires -Version 5.1
<#
.SYNOPSIS
  Shared trusted-pack root helpers for checkpoint-2 reverify (Issue #376).
#>
function Get-MainPackWorktreePath {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$ReviewTargetRoot
    )

    Push-Location $ReviewTargetRoot
    try {
        $lines = @(git worktree list --porcelain 2>$null)
        for ($i = 0; $i -lt $lines.Count; $i += 1) {
            if ($lines[$i] -notmatch '^worktree (.+)$') {
                continue
            }
            $worktreePath = $Matches[1].Trim()
            for ($j = $i + 1; $j -lt $lines.Count; $j += 1) {
                if ($lines[$j] -match '^worktree ') {
                    break
                }
                if ($lines[$j] -match '^branch refs/heads/main$') {
                    return $worktreePath
                }
            }
        }
    }
    finally {
        Pop-Location
    }

    return $null
}

function Test-TrustedMainWorktreeEligible {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$MainWorktreePath,
        [Parameter(Mandatory)]
        [string]$ReviewTargetRoot,
        [string]$BaseRef = 'origin/main'
    )

    Push-Location $MainWorktreePath
    try {
        $status = @(git status --porcelain 2>$null)
        if ($status.Count -gt 0) {
            return $false
        }
        $mainHead = (git rev-parse HEAD 2>$null).Trim()
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($mainHead)) {
            return $false
        }
    }
    finally {
        Pop-Location
    }

    Push-Location $ReviewTargetRoot
    try {
        $baseSha = (git rev-parse $BaseRef 2>$null).Trim()
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($baseSha)) {
            return $false
        }
    }
    finally {
        Pop-Location
    }

    return $mainHead -eq $baseSha
}

function New-TrustedOriginMainArchiveCheckout {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$TempPrefix,
        [Parameter(Mandatory)]
        [string]$ReviewTargetRoot,
        [string]$BaseRef = 'origin/main'
    )

    $temp = Join-Path ([IO.Path]::GetTempPath()) ("{0}-{1}" -f $TempPrefix, ([Guid]::NewGuid().ToString('N')))
    New-Item -ItemType Directory -Path $temp -Force | Out-Null

    Push-Location $ReviewTargetRoot
    try {
        git archive $BaseRef 2>$null | tar -x -C $temp 2>$null
        if ($LASTEXITCODE -ne 0) {
            Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
            return $null
        }
        return $temp
    }
    finally {
        Pop-Location
    }
}
