#requires -Version 5.1
<#
.SYNOPSIS
  Remove stale AO reviewer workspace directories before ao review run (Issue #98).

.DESCRIPTION
  AO creates code-reviews/workspaces/op-rev-* via git worktree add. A failed run can
  leave the directory on disk so the next worktree add fails with already exists.
  This script removes a targeted path or orphan workspace dirs not registered in
  git worktree list. Run from the pack repo root before ao review run — not from
  inside an active reviewer workspace.
#>
param(
    [Parameter(Mandatory = $true)]
    [string]$RepoRoot,

    [string]$WorkspacePath,

    [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'

function Get-ProjectRootFromRepoRoot {
    param([string]$Root)

    $resolved = (Resolve-Path -LiteralPath $Root).Path
    if ($resolved -match '[\\/]worktrees[\\/][^\\/]+$') {
        return (Split-Path (Split-Path $resolved -Parent) -Parent)
    }

    return $resolved
}

function Get-ReviewerWorkspacesRoot {
    param([string]$ProjectRoot)

    $candidates = @(
        (Join-Path $ProjectRoot 'code-reviews\workspaces'),
        (Join-Path $ProjectRoot 'code-reviews/workspaces')
    )

    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Container) {
            return $candidate
        }
    }

    return $null
}

function Get-GitWorktreeMainRepo {
    param([string]$RepoRoot)

    Push-Location -LiteralPath $RepoRoot
    try {
        $toplevel = (git rev-parse --show-toplevel 2>$null)
        if (-not $toplevel) {
            return $null
        }

        $listed = @(git worktree list --porcelain 2>$null)
        foreach ($line in $listed) {
            if ($line -match '^worktree (.+)$') {
                $path = $Matches[1]
                if ($path -notmatch 'code-reviews[\\/]workspaces') {
                    return $path
                }
            }
        }

        return $toplevel
    }
    finally {
        Pop-Location
    }
}

function Get-RegisteredWorktreePaths {
    param([string]$GitMainRepo)

    $paths = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    Push-Location -LiteralPath $GitMainRepo
    try {
        $listed = @(git worktree list --porcelain 2>$null)
        $i = 0
        while ($i -lt $listed.Count) {
            if ($listed[$i] -match '^worktree (.+)$') {
                [void]$paths.Add($Matches[1])
            }
            $i++
        }
    }
    finally {
        Pop-Location
    }

    return $paths
}

function Clear-ReviewerWorkspacePath {
    param(
        [string]$Path,
        [string]$GitMainRepo,
        [switch]$WhatIf
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        return $false
    }

    $registered = Get-RegisteredWorktreePaths -GitMainRepo $GitMainRepo
    $isRegistered = $registered.Contains($Path)

    if ($WhatIf) {
        if ($isRegistered) {
            Write-Host "[WhatIf] git worktree remove --force `"$Path`""
        }
        else {
            Write-Host "[WhatIf] Remove-Item -Recurse -Force `"$Path`""
        }
        return $true
    }

    if ($isRegistered) {
        Push-Location -LiteralPath $GitMainRepo
        try {
            & git worktree remove --force $Path
            if ($LASTEXITCODE -ne 0) {
                throw "git worktree remove --force failed for $Path (exit $LASTEXITCODE)"
            }
        }
        finally {
            Pop-Location
        }
    }
    else {
        Remove-Item -LiteralPath $Path -Recurse -Force
    }

    Write-Host "[OK] Cleared stale reviewer workspace: $Path"
    return $true
}

$resolvedRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
$projectRoot = Get-ProjectRootFromRepoRoot -Root $resolvedRoot
$gitMain = Get-GitWorktreeMainRepo -RepoRoot $resolvedRoot

$cleared = 0

if ($WorkspacePath) {
    $target = (Resolve-Path -LiteralPath $WorkspacePath -ErrorAction Stop).Path
    if (-not $gitMain) {
        if ($WhatIf) {
            Write-Host "[WhatIf] Remove-Item -Recurse -Force `"$target`""
        }
        elseif (Test-Path -LiteralPath $target) {
            Remove-Item -LiteralPath $target -Recurse -Force
            Write-Host "[OK] Cleared stale reviewer workspace: $target"
        }
        exit 0
    }

    if (Clear-ReviewerWorkspacePath -Path $target -GitMainRepo $gitMain -WhatIf:$WhatIf) {
        $cleared = 1
    }
    exit 0
}

if (-not $gitMain) {
    Write-Error "Could not resolve git main repo from $resolvedRoot"
}

$workspacesRoot = Get-ReviewerWorkspacesRoot -ProjectRoot $projectRoot
if (-not $workspacesRoot) {
    Write-Host '[OK] No code-reviews/workspaces directory; nothing to clean.'
    exit 0
}

$registered = Get-RegisteredWorktreePaths -GitMainRepo $gitMain
foreach ($dir in Get-ChildItem -LiteralPath $workspacesRoot -Directory -ErrorAction SilentlyContinue) {
    $fullPath = $dir.FullName
    if ($registered.Contains($fullPath)) {
        continue
    }

    if (Clear-ReviewerWorkspacePath -Path $fullPath -GitMainRepo $gitMain -WhatIf:$WhatIf) {
        $cleared++
    }
}

if ($cleared -eq 0) {
    Write-Host '[OK] No orphan reviewer workspace directories found.'
}
else {
    Write-Host ("[OK] Cleared {0} orphan reviewer workspace(s)." -f $cleared)
}

exit 0
