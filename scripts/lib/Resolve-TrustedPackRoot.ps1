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
            if ($lines[$i] -ne 'worktree') {
                continue
            }
            $worktreePath = $lines[$i + 1].Replace('worktree ', '').Trim()
            $branchLine = $lines[$i + 2]
            if ($branchLine -match 'branch refs/heads/main$') {
                return $worktreePath
            }
        }
    }
    finally {
        Pop-Location
    }

    return $null
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
        return (Resolve-Path -LiteralPath $TrustedBaseRoot).Path
    }

    if ($env:AO_TRUSTED_PACK_ROOT) {
        return (Resolve-Path -LiteralPath $env:AO_TRUSTED_PACK_ROOT).Path
    }

    $resolvedReviewTarget = (Resolve-Path -LiteralPath $ReviewTargetRoot).Path
    $mainWorktree = Get-MainPackWorktreePath -ReviewTargetRoot $resolvedReviewTarget
    if ($mainWorktree) {
        $checker = Join-Path $mainWorktree $BootstrapCheckerRelativePath
        if (Test-Path -LiteralPath $checker) {
            return (Resolve-Path -LiteralPath $mainWorktree).Path
        }
    }

    $archiveRoot = New-TrustedPackArchiveCheckout -ReviewTargetRoot $resolvedReviewTarget -BaseRef $BaseRef
    if ($archiveRoot) {
        $checker = Join-Path $archiveRoot $BootstrapCheckerRelativePath
        if (Test-Path -LiteralPath $checker) {
            return $archiveRoot
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

    $trustedRoot = Resolve-TrustedPackRoot -ReviewTargetRoot $ReviewTargetRoot -TrustedBaseRoot $TrustedBaseRoot
    $runner = Join-Path $trustedRoot $RunnerRelativePath
    if (-not (Test-Path -LiteralPath $runner)) {
        throw "missing trusted runner at $runner"
    }
    return @{
        TrustedBaseRoot = $trustedRoot
        RunnerPath      = $runner
    }
}
