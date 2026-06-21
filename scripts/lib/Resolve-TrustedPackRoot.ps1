#requires -Version 5.1
<#
.SYNOPSIS
  Resolve the trusted pack root for reviewer checkpoint-2 (Issue #376).
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

function New-TrustedPackArchiveCheckout {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$ReviewTargetRoot,
        [string]$BaseRef = 'origin/main'
    )

    $temp = Join-Path ([IO.Path]::GetTempPath()) ("opk-trusted-{0}" -f ([Guid]::NewGuid().ToString('N')))
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

function Resolve-TrustedPackRoot {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$ReviewTargetRoot,
        [string]$TrustedBaseRoot,
        [string]$BootstrapCheckerRelativePath = 'scripts/invoke-contract-evidence-reverify.ts',
        [string]$BaseRef = 'origin/main'
    )

    if (-not [string]::IsNullOrWhiteSpace($TrustedBaseRoot)) {
        return @{
            Path                  = (Resolve-Path -LiteralPath $TrustedBaseRoot).Path
            DisposableTrustedRoot = $false
        }
    }

    if ($env:AO_TRUSTED_PACK_ROOT) {
        return @{
            Path                  = (Resolve-Path -LiteralPath $env:AO_TRUSTED_PACK_ROOT).Path
            DisposableTrustedRoot = $false
        }
    }

    $resolvedReviewTarget = (Resolve-Path -LiteralPath $ReviewTargetRoot).Path
    $mainWorktree = Get-MainPackWorktreePath -ReviewTargetRoot $resolvedReviewTarget
    if ($mainWorktree) {
        $checker = Join-Path $mainWorktree $BootstrapCheckerRelativePath
        if ((Test-Path -LiteralPath $checker) -and (Test-TrustedMainWorktreeEligible -MainWorktreePath $mainWorktree -ReviewTargetRoot $resolvedReviewTarget -BaseRef $BaseRef)) {
            return @{
                Path                  = (Resolve-Path -LiteralPath $mainWorktree).Path
                DisposableTrustedRoot = $false
            }
        }
    }

    $archiveRoot = New-TrustedPackArchiveCheckout -ReviewTargetRoot $resolvedReviewTarget -BaseRef $BaseRef
    if ($archiveRoot) {
        $checker = Join-Path $archiveRoot $BootstrapCheckerRelativePath
        if (Test-Path -LiteralPath $checker) {
            return @{
                Path                  = $archiveRoot
                DisposableTrustedRoot = $true
            }
        }
        Remove-Item -LiteralPath $archiveRoot -Recurse -Force -ErrorAction SilentlyContinue
    }

    throw "trusted runner unavailable: could not resolve trusted pack root from main worktree or ${BaseRef} archive (refusing PR-head fallback)"
}

function Resolve-TrustedPackRunner {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$ReviewTargetRoot,
        [string]$TrustedBaseRoot,
        [string]$RunnerRelativePath = 'scripts/invoke-contract-evidence-reverify.ts'
    )

    $resolved = Resolve-TrustedPackRoot -ReviewTargetRoot $ReviewTargetRoot -TrustedBaseRoot $TrustedBaseRoot
    $trustedRoot = $resolved.Path
    $runner = Join-Path $trustedRoot $RunnerRelativePath
    if (-not (Test-Path -LiteralPath $runner)) {
        throw "missing trusted runner at $runner"
    }
    return @{
        TrustedBaseRoot         = $trustedRoot
        RunnerPath              = $runner
        DisposableTrustedRoot   = [bool]$resolved.DisposableTrustedRoot
    }
}
