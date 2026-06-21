#requires -Version 5.1
<#
.SYNOPSIS
  Load checkpoint-2 reverify PowerShell helpers from an immutable trusted base.
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

function New-TrustedBootstrapScriptCheckout {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$ReviewTargetRoot,
        [string]$BaseRef = 'origin/main'
    )

    $temp = Join-Path ([IO.Path]::GetTempPath()) ("opk-trusted-bootstrap-{0}" -f ([Guid]::NewGuid().ToString('N')))
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

function Get-TrustedBootstrapScriptRoot {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$ReviewTargetRoot,
        [string]$TrustedBaseRoot,
        [string]$BaseRef = 'origin/main'
    )

    $bootstrapHelperPaths = @(
        'scripts/lib/Resolve-TrustedPackRoot.ps1',
        'scripts/lib/Ensure-ReverifyWorkspaceDeps.ps1'
    )

    if (-not [string]::IsNullOrWhiteSpace($TrustedBaseRoot)) {
        $resolved = (Resolve-Path -LiteralPath $TrustedBaseRoot).Path
        foreach ($relativePath in $bootstrapHelperPaths) {
            $candidate = Join-Path $resolved $relativePath
            if (-not (Test-Path -LiteralPath $candidate)) {
                throw "trusted bootstrap unavailable: missing $relativePath under $resolved"
            }
        }
        return @{
            Path                    = $resolved
            DisposableBootstrapRoot = $false
        }
    }

    if ($env:AO_TRUSTED_PACK_ROOT) {
        $resolved = (Resolve-Path -LiteralPath $env:AO_TRUSTED_PACK_ROOT).Path
        foreach ($relativePath in $bootstrapHelperPaths) {
            $candidate = Join-Path $resolved $relativePath
            if (-not (Test-Path -LiteralPath $candidate)) {
                throw "trusted bootstrap unavailable: missing $relativePath under $resolved"
            }
        }
        return @{
            Path                    = $resolved
            DisposableBootstrapRoot = $false
        }
    }

    $resolvedReviewTarget = (Resolve-Path -LiteralPath $ReviewTargetRoot).Path
    $mainWorktree = Get-MainPackWorktreePath -ReviewTargetRoot $resolvedReviewTarget
    if ($mainWorktree) {
        $eligible = Test-TrustedMainWorktreeEligible -MainWorktreePath $mainWorktree -ReviewTargetRoot $resolvedReviewTarget -BaseRef $BaseRef
        if ($eligible) {
            $resolvedMain = (Resolve-Path -LiteralPath $mainWorktree).Path
            foreach ($relativePath in $bootstrapHelperPaths) {
                $candidate = Join-Path $resolvedMain $relativePath
                if (-not (Test-Path -LiteralPath $candidate)) {
                    throw "trusted bootstrap unavailable: missing $relativePath under main worktree $resolvedMain"
                }
            }
            return @{
                Path                    = $resolvedMain
                DisposableBootstrapRoot = $false
            }
        }
    }

    $archiveRoot = New-TrustedBootstrapScriptCheckout -ReviewTargetRoot $resolvedReviewTarget -BaseRef $BaseRef
    if (-not $archiveRoot) {
        throw "trusted bootstrap unavailable: could not extract bootstrap helpers from ${BaseRef} archive"
    }

    foreach ($relativePath in $bootstrapHelperPaths) {
        $candidate = Join-Path $archiveRoot $relativePath
        if (-not (Test-Path -LiteralPath $candidate)) {
            Remove-Item -LiteralPath $archiveRoot -Recurse -Force -ErrorAction SilentlyContinue
            throw "trusted bootstrap unavailable: archive missing $relativePath"
        }
    }

    return @{
        Path                    = $archiveRoot
        DisposableBootstrapRoot = $true
    }
}

function Import-TrustedReverifyBootstrap {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$ReviewTargetRoot,
        [string]$TrustedBaseRoot
    )

    $resolved = Get-TrustedBootstrapScriptRoot -ReviewTargetRoot $ReviewTargetRoot -TrustedBaseRoot $TrustedBaseRoot
    $bootstrapRoot = $resolved.Path

    . (Join-Path $bootstrapRoot 'scripts/lib/Resolve-TrustedPackRoot.ps1')
    . (Join-Path $bootstrapRoot 'scripts/lib/Ensure-ReverifyWorkspaceDeps.ps1')

    return @{
        BootstrapRoot           = $bootstrapRoot
        DisposableBootstrapRoot = [bool]$resolved.DisposableBootstrapRoot
    }
}
