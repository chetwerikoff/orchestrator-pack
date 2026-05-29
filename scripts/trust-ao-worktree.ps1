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

function Get-AoWorktreesRoot {
    param([string]$Id)
    Join-Path $env:USERPROFILE ".agent-orchestrator\projects\$Id\worktrees"
}

function Get-CursorProjectsDir {
    Join-Path $env:USERPROFILE '.cursor\projects'
}

function Get-CursorProjectSlugFromWorkspace {
    param([string]$FullPath)
    $full = [System.IO.Path]::GetFullPath($FullPath)
    if ($full -match '^([A-Za-z]):\\(.*)$') {
        # cursor-agent keeps leading dots in segments (e.g. .agent-orchestrator);
        # stripping them writes the marker where the interactive worker never looks.
        $segments = $Matches[2] -split '\\' |
            ForEach-Object { $_.Trim() } |
            Where-Object { $_ }
        return ('{0}-{1}' -f $Matches[1], ($segments -join '-'))
    }
    return ($full -replace '\\', '-')
}

function Resolve-AoWorkspacePath {
    param(
        [string]$Path,
        [string]$Id,
        [string]$Session
    )

    if ($Session) {
        $candidate = Join-Path (Get-AoWorktreesRoot -Id $Id) $Session
        if (-not (Test-Path -LiteralPath $candidate -PathType Container)) {
            throw "Worktree not found for session ${Session}: $candidate"
        }
        return (Resolve-Path -LiteralPath $candidate).Path
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

    $slug = Get-CursorProjectSlugFromWorkspace -FullPath $Root
    $projectDir = Join-Path (Get-CursorProjectsDir) $slug
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
    $root = Get-AoWorktreesRoot -Id $ProjectId
    if (Test-Path -LiteralPath $root -PathType Container) {
        $targets.Add((Resolve-Path -LiteralPath $root).Path)
    }
    elseif (-not $WorkspacePath -and -not $SessionId) {
        if (-not $Quiet) {
            Write-Host "[trust-ao-worktree] worktrees root does not exist yet ($root)"
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
