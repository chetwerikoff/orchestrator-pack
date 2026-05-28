#requires -Version 5.1
<#
.SYNOPSIS
  Pre-trust an AO Cursor worktree so interactive workers skip "Workspace Trust Required".

.DESCRIPTION
  Cursor only honors --trust in headless mode (-p). AO worktrees live under
  ~/.agent-orchestrator/projects/<project>/worktrees/<session-id>/ and each new
  path can block the worker until trusted. This script runs a one-line headless
  agent bootstrap per path (idempotent).

  See docs/orchestrator-autoloop-go-live.md (worktree trust watcher).
#>
[CmdletBinding()]
param(
    [string]$WorkspacePath = '',
    [string]$ProjectId = 'orchestrator-pack',
    [string]$SessionId = '',
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

function Get-AoWorktreesRoot {
    param([string]$Id)
    Join-Path $env:USERPROFILE ".agent-orchestrator\projects\$Id\worktrees"
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
        throw 'Specify -WorkspacePath or -SessionId'
    }
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        throw "Workspace path does not exist: $Path"
    }
    return (Resolve-Path -LiteralPath $Path).Path
}

function Invoke-AoWorktreeTrust {
    param(
        [string]$Root,
        [switch]$Silent
    )

    if (-not (Get-Command agent -ErrorAction SilentlyContinue)) {
        throw 'Cursor agent CLI not found on PATH (expected command: agent)'
    }

    $null = & agent -p --trust --force --sandbox disabled --approve-mcps `
        --workspace $Root `
        'workspace-trust-bootstrap: reply OK only.' 2>&1

    if ($LASTEXITCODE -ne 0) {
        throw "agent trust bootstrap failed for $Root (exit $LASTEXITCODE)"
    }

    if (-not $Silent) {
        Write-Host "[trust-ao-worktree] trusted $Root"
    }
}

$resolved = Resolve-AoWorkspacePath -Path $WorkspacePath -Id $ProjectId -Session $SessionId
Invoke-AoWorktreeTrust -Root $resolved -Silent:$Quiet
