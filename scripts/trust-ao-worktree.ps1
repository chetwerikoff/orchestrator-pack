#requires -Version 5.1
<#
.SYNOPSIS
  Pre-trust an AO Cursor worktree so workers skip "Workspace Trust Required".

.DESCRIPTION
  Cursor Agent stores trust under ~/.cursor/projects/<slug>/.workspace-trusted.
  Headless `agent -p --trust` alone does not always unblock AO's interactive PTY;
  writing .workspace-trusted before the worker starts does.

  See docs/orchestrator-autoloop-go-live.md and orchestrator-worktree-trust-watcher.ps1.
#>
[CmdletBinding()]
param(
    [string]$WorkspacePath = '',
    [string]$ProjectId = 'orchestrator-pack',
    [string]$SessionId = '',
    [switch]$TrustWorktreesRoot,
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

function Get-PackUserHome {
    if (-not [string]::IsNullOrWhiteSpace($env:HOME)) {
        return $env:HOME
    }
    return [Environment]::GetFolderPath('UserProfile')
}

function Get-AoWorktreesRoot {
    param([string]$Id)
    Join-Path (Get-PackUserHome) '.agent-orchestrator' 'projects' $Id 'worktrees'
}

function Get-AoDataWorktreesRoot {
    param([string]$Id)
    Join-Path (Get-PackUserHome) '.ao' 'data' 'worktrees' $Id
}

function Get-AoWorktreesRoots {
    param([string]$Id)
    @(
        (Get-AoDataWorktreesRoot -Id $Id),
        (Get-AoWorktreesRoot -Id $Id)
    )
}

function Get-CursorProjectsDir {
    Join-Path (Get-PackUserHome) '.cursor' 'projects'
}

function Get-CursorPathSegments {
    param([string[]]$RawSegments)
    $RawSegments |
        ForEach-Object { $_.Trim() } |
        Where-Object { $_ } |
        ForEach-Object { $_.TrimStart('.') } |
        Where-Object { $_ }
}

function Get-CursorProjectSlugFromWorkspace {
    param([string]$FullPath)
    $full = [System.IO.Path]::GetFullPath($FullPath)
    if ($full -match '^([A-Za-z]):[\\/]+(.*)$') {
        $segments = Get-CursorPathSegments -RawSegments ($Matches[2] -split '[\\/]')
        return ('{0}-{1}' -f $Matches[1].ToLower(), ($segments -join '-'))
    }
    $trimmed = $full.TrimStart([char[]]@('/', '\'))
    $segments = Get-CursorPathSegments -RawSegments ($trimmed -split '[\\/]')
    return ($segments -join '-')
}

function Get-CursorProjectDirFromWorkspace {
    param([string]$FullPath)
    # Match cursor-config $(): join(~/.cursor/projects, slugifyPath); hash-truncate when > 92 chars.
    $projectsDir = Get-CursorProjectsDir
    $slug = Get-CursorProjectSlugFromWorkspace -FullPath $FullPath
    $candidate = Join-Path $projectsDir $slug
    if ($candidate.Length -le 92) {
        return $candidate
    }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($candidate))
    }
    finally {
        $sha.Dispose()
    }
    $hex = -join ($bytes | ForEach-Object { '{0:x2}' -f $_ })
    $hash = $hex.Substring(0, 7)
    $prefixLen = [Math]::Min(84, $candidate.Length)
    return '{0}-{1}' -f $candidate.Substring(0, $prefixLen), $hash
}

function Resolve-AoWorkspacePath {
    param(
        [string]$Path,
        [string]$Id,
        [string]$Session
    )

    if ($Session) {
        $candidates = Get-AoWorktreesRoots -Id $Id | ForEach-Object { Join-Path $_ $Session }
        foreach ($candidate in $candidates) {
            if (Test-Path -LiteralPath $candidate -PathType Container) {
                return (Resolve-Path -LiteralPath $candidate).Path
            }
        }
        throw "Worktree not found for session ${Session}: $($candidates -join ', ')"
    }

    if (-not $Path) {
        throw 'Specify -WorkspacePath, -SessionId, or -TrustWorktreesRoot'
    }
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        throw "Workspace path does not exist: $Path"
    }
    return (Resolve-Path -LiteralPath $Path).Path
}

function Write-CursorWorkspaceTrustedFile {
    param(
        [string]$Root,
        [string]$Method = 'orchestrator-pack-script'
    )

    $projectDir = Get-CursorProjectDirFromWorkspace -FullPath $Root
    New-Item -ItemType Directory -Force -Path $projectDir | Out-Null

    $trustFile = Join-Path $projectDir '.workspace-trusted'
    $payload = [ordered]@{
        trustedAt     = (Get-Date).ToUniversalTime().ToString('o')
        workspacePath = $Root
        trustMethod   = $Method
    }
    [System.IO.File]::WriteAllText($trustFile, (($payload | ConvertTo-Json -Compress) + "`n"), [System.Text.UTF8Encoding]::new($false))
    return $trustFile
}

function Invoke-AoWorktreeTrust {
    param(
        [string]$Root,
        [switch]$Silent
    )

    $trustFile = Write-CursorWorkspaceTrustedFile -Root $Root

    # Best-effort only: the .workspace-trusted marker above is the mechanism that
    # unblocks the worker. A failed bootstrap (rate limit, transient) must not undo
    # that success, or the watcher retries this headless session every poll.
    if (Get-Command agent -ErrorAction SilentlyContinue) {
        $null = & agent -p --trust --force --sandbox disabled --approve-mcps `
            --workspace $Root `
            'workspace-trust-bootstrap: reply OK only.' 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "agent trust bootstrap failed for $Root (exit $LASTEXITCODE); marker already written"
        }
    }

    if (-not $Silent) {
        Write-Host "[trust-ao-worktree] trusted $Root ($trustFile)"
    }
}

$targets = [System.Collections.Generic.List[string]]::new()

if ($TrustWorktreesRoot) {
    foreach ($root in (Get-AoWorktreesRoots -Id $ProjectId)) {
        if (Test-Path -LiteralPath $root -PathType Container) {
            $targets.Add((Resolve-Path -LiteralPath $root).Path)
        }
    }
    if ($targets.Count -eq 0 -and -not $WorkspacePath -and -not $SessionId) {
        if (-not $Quiet) {
            Write-Host "[trust-ao-worktree] worktrees roots do not exist yet"
        }
        return
    }
}

if ($WorkspacePath -or $SessionId) {
    $targets.Add((Resolve-AoWorkspacePath -Path $WorkspacePath -Id $ProjectId -Session $SessionId))
}

if ($targets.Count -eq 0) {
    throw 'No trust targets resolved'
}

foreach ($resolved in $targets) {
    Invoke-AoWorktreeTrust -Root $resolved -Silent:$Quiet
}
