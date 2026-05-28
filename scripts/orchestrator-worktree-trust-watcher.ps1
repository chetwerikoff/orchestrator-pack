#requires -Version 5.1
<#
.SYNOPSIS
  Poll AO worktrees and auto-trust new Cursor workspaces (no manual [a] prompt).

.DESCRIPTION
  Run alongside orchestrator-wake-listener.ps1. Scans
  ~/.agent-orchestrator/projects/<project>/worktrees/* every few seconds and
  invokes scripts/trust-ao-worktree.ps1 for paths not yet recorded in local state.

  See docs/orchestrator-autoloop-go-live.md.
#>
[CmdletBinding()]
param(
    [string]$ProjectId = 'orchestrator-pack',
    [int]$PollSeconds = 8
)

$ErrorActionPreference = 'Stop'

$TrustScript = Join-Path $PSScriptRoot 'trust-ao-worktree.ps1'
if (-not (Test-Path -LiteralPath $TrustScript -PathType Leaf)) {
    throw "Missing $TrustScript"
}

$WorktreesRoot = Join-Path $env:USERPROFILE ".agent-orchestrator\projects\$ProjectId\worktrees"
$StateFile = Join-Path $env:LOCALAPPDATA 'orchestrator-pack-trusted-worktrees.txt'
$known = @{}

if (Test-Path -LiteralPath $StateFile -PathType Leaf) {
    Get-Content -LiteralPath $StateFile | ForEach-Object {
        $line = $_.Trim()
        if ($line) { $known[$line] = $true }
    }
}

function Write-WatcherLog {
    param([string]$Message)
    $ts = (Get-Date).ToString('o')
    Write-Host "[$ts] worktree-trust-watcher $Message"
}

function Register-TrustedPath {
    param([string]$Path)
    if ($known[$Path]) { return }
    & $TrustScript -WorkspacePath $Path -Quiet
    $known[$Path] = $true
    Add-Content -LiteralPath $StateFile -Value $Path
    Write-WatcherLog "trusted: $Path"
}

Write-WatcherLog "starting (project=$ProjectId, poll=${PollSeconds}s, root=$WorktreesRoot)"

$cancelled = $false
$onCancel = [ConsoleCancelEventHandler]{
    param($sender, $eventArgs)
    $script:cancelled = $true
    $eventArgs.Cancel = $true
}
[Console]::add_CancelKeyPress($onCancel)

try {
    while (-not $cancelled) {
        if (Test-Path -LiteralPath $WorktreesRoot -PathType Container) {
            Get-ChildItem -LiteralPath $WorktreesRoot -Directory -ErrorAction SilentlyContinue |
                ForEach-Object {
                    $full = $_.FullName
                    if (-not $known[$full]) {
                        try {
                            Register-TrustedPath -Path $full
                        }
                        catch {
                            Write-WatcherLog "failed $full : $_"
                        }
                    }
                }
        }
        Start-Sleep -Seconds ([Math]::Max(3, $PollSeconds))
    }
}
finally {
    [Console]::remove_CancelKeyPress($onCancel)
    Write-WatcherLog 'stopped'
}
