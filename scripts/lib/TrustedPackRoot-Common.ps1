#requires -Version 5.1
<#
.SYNOPSIS
  Shared trusted-pack root helpers for checkpoint-2 reverify (Issue #376).
#>
function Test-PathInsideReviewTarget {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$CandidatePath,
        [Parameter(Mandatory)]
        [string]$ReviewTargetRoot
    )

    $candidate = [IO.Path]::GetFullPath($CandidatePath).TrimEnd(
        [IO.Path]::DirectorySeparatorChar,
        [IO.Path]::AltDirectorySeparatorChar
    )
    $reviewTarget = [IO.Path]::GetFullPath($ReviewTargetRoot).TrimEnd(
        [IO.Path]::DirectorySeparatorChar,
        [IO.Path]::AltDirectorySeparatorChar
    )

    if ($candidate.Equals($reviewTarget, [StringComparison]::OrdinalIgnoreCase)) {
        return $true
    }

    $reviewPrefix = $reviewTarget + [IO.Path]::DirectorySeparatorChar
    return $candidate.StartsWith($reviewPrefix, [StringComparison]::OrdinalIgnoreCase)
}

function Assert-TrustedRootOverrideEligible {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$TrustedRoot,
        [Parameter(Mandatory)]
        [string]$ReviewTargetRoot,
        [string]$BaseRef = 'origin/main'
    )

    if (Test-PathInsideReviewTarget -CandidatePath $TrustedRoot -ReviewTargetRoot $ReviewTargetRoot) {
        throw 'refusing trusted-root override: trusted base equals or lies inside review target'
    }

    if ($env:OPK_REVERIFY_E2E_REQUIRED -eq '1') {
        return
    }

    Push-Location $ReviewTargetRoot
    try {
        $baseSha = (git rev-parse $BaseRef 2>$null).Trim()
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($baseSha)) {
            throw "refusing trusted-root override: could not resolve ${BaseRef} from review target"
        }
    }
    finally {
        Pop-Location
    }

    Push-Location $TrustedRoot
    try {
        $gitDir = Join-Path (Get-Location) '.git'
        if (-not (Test-Path -LiteralPath $gitDir)) {
            throw 'refusing trusted-root override: path is not a clean git checkout at BaseRef'
        }

        $status = @(git status --porcelain 2>$null)
        if ($status.Count -gt 0) {
            throw 'refusing trusted-root override: trusted checkout has uncommitted changes'
        }

        $trustedHead = (git rev-parse HEAD 2>$null).Trim()
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($trustedHead)) {
            throw 'refusing trusted-root override: could not resolve trusted checkout HEAD'
        }

        if ($trustedHead -ne $baseSha) {
            throw "refusing trusted-root override: trusted checkout HEAD does not match ${BaseRef}"
        }
    }
    finally {
        Pop-Location
    }
}

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

function Copy-ImplementingPrScriptsBootstrap {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$ReviewTargetRoot,
        [Parameter(Mandatory)]
        [string]$DestinationRoot
    )

    $resolvedSource = (Resolve-Path -LiteralPath $ReviewTargetRoot).Path
    $scriptsRoot = Join-Path $resolvedSource 'scripts'
    if (-not (Test-Path -LiteralPath $scriptsRoot)) {
        return $false
    }

    if (Test-Path -LiteralPath $DestinationRoot) {
        Remove-Item -LiteralPath $DestinationRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
    New-Item -ItemType Directory -Path $DestinationRoot -Force | Out-Null

    Copy-Item -LiteralPath $scriptsRoot -Destination (Join-Path $DestinationRoot 'scripts') -Recurse -Force
    foreach ($pluginRel in @('plugins/_shared', 'plugins/ao-scope-guard')) {
        $pluginRoot = Join-Path $resolvedSource $pluginRel
        if (Test-Path -LiteralPath $pluginRoot) {
            $pluginDest = Join-Path $DestinationRoot $pluginRel
            New-Item -ItemType Directory -Path (Split-Path -Parent $pluginDest) -Force | Out-Null
            Copy-Item -LiteralPath $pluginRoot -Destination $pluginDest -Recurse -Force
        }
    }
    foreach ($fixtureRel in @('tests/fixtures/contract-evidence-reverify')) {
        $fixtureRoot = Join-Path $resolvedSource $fixtureRel
        if (Test-Path -LiteralPath $fixtureRoot) {
            $fixtureDest = Join-Path $DestinationRoot $fixtureRel
            New-Item -ItemType Directory -Path (Split-Path -Parent (Split-Path -Parent $fixtureDest)) -Force | Out-Null
            New-Item -ItemType Directory -Path (Split-Path -Parent $fixtureDest) -Force | Out-Null
            Copy-Item -LiteralPath $fixtureRoot -Destination $fixtureDest -Recurse -Force
        }
    }
    foreach ($rootFile in @('package.json', 'package-lock.json', 'tsconfig.base.json')) {
        $sourceFile = Join-Path $resolvedSource $rootFile
        if (Test-Path -LiteralPath $sourceFile) {
            Copy-Item -LiteralPath $sourceFile -Destination (Join-Path $DestinationRoot $rootFile) -Force
        }
    }

    return Test-Path -LiteralPath (Join-Path $DestinationRoot 'scripts/launch-contract-evidence-reverify.ps1')
}

function Remove-ImplementingPrScriptsBootstrap {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DestinationRoot
    )

    if (Test-Path -LiteralPath (Join-Path $DestinationRoot '.git')) {
        Push-Location $DestinationRoot
        try {
            git worktree remove --force $DestinationRoot 2>$null
        }
        catch {
            Remove-Item -LiteralPath $DestinationRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
        finally {
            Pop-Location
        }
        return
    }

    Remove-Item -LiteralPath $DestinationRoot -Recurse -Force -ErrorAction SilentlyContinue
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
