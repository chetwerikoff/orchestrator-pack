#requires -Version 5.1
<#
.SYNOPSIS
  Poll AO worktrees and auto-trust new Cursor workspaces (no manual [a] prompt).

.DESCRIPTION
  Run alongside orchestrator-wake-listener.ps1. Scans
  ~/.agent-orchestrator/projects/<project>/worktrees/* every few seconds and
  invokes scripts/trust-ao-worktree.ps1 for paths not yet recorded in local state.

  See docs/orchestrator-autoloop-go-live.md.

  Stop the process by closing the terminal or ending the PowerShell job (no Ctrl+C
  handler — avoids duplicating wake-listener shutdown logic).
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

$PackRoot = Split-Path -Parent $PSScriptRoot
$CursorAgentTuiShimModule = Join-Path $PSScriptRoot 'lib/Cursor-Agent-TuiShim.ps1'
$CursorAgentTuiShimModuleLoaded = $false

$userHome = if (-not [string]::IsNullOrWhiteSpace($env:HOME)) { $env:HOME } else { [Environment]::GetFolderPath('UserProfile') }
$stateBase = if (-not [string]::IsNullOrWhiteSpace($env:XDG_STATE_HOME)) {
    $env:XDG_STATE_HOME
}
elseif (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    $env:LOCALAPPDATA
}
else {
    Join-Path $userHome '.local' 'state'
}
$WorktreesRoots = @(
    (Join-Path $userHome '.ao' 'data' 'worktrees' $ProjectId),
    (Join-Path $userHome '.agent-orchestrator' 'projects' $ProjectId 'worktrees')
)
$StateFile = Join-Path $stateBase 'orchestrator-pack-trusted-worktrees.txt'
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

function Invoke-CursorAgentTuiShimWatcherSelfHeal {
    if (-not $CursorAgentTuiShimModuleLoaded) {
        if (-not (Test-Path -LiteralPath $CursorAgentTuiShimModule -PathType Leaf)) {
            return
        }
        . $CursorAgentTuiShimModule
        $script:CursorAgentTuiShimModuleLoaded = $true
    }
    try {
        $heal = Invoke-CursorAgentTuiShimSelfHeal -PackRoot $PackRoot -Source 'worktree-trust-watcher' -Quiet
        if ($heal.Alerted) {
            Write-WatcherLog "cursor-agent shim: $($heal.Message)"
        }
    }
    catch {
        Write-WatcherLog "cursor-agent shim self-heal error: $_"
    }
}

function Register-TrustedPath {
    param([string]$Path)
    if ($known[$Path]) { return }
    # Write .workspace-trusted before the worker PTY reads the path (race with AO spawn).
    & $TrustScript -WorkspacePath $Path -Quiet
    $known[$Path] = $true
    Add-Content -LiteralPath $StateFile -Value $Path
    Write-WatcherLog "trusted: $Path"
}

# Parent worktrees dir — reduces trust churn for every new op-* session.
try {
    & $TrustScript -TrustWorktreesRoot -ProjectId $ProjectId -Quiet
    Write-WatcherLog 'trusted worktrees root (once per watcher start)'
}
catch {
    Write-WatcherLog "worktrees root trust skipped: $_"
}

Write-WatcherLog "starting (project=$ProjectId, poll=${PollSeconds}s, roots=$($WorktreesRoots -join ';'))"

while ($true) {
    foreach ($worktreesRoot in $WorktreesRoots) {
        if (Test-Path -LiteralPath $worktreesRoot -PathType Container) {
            Get-ChildItem -LiteralPath $worktreesRoot -Directory -ErrorAction SilentlyContinue |
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
    }
    Invoke-CursorAgentTuiShimWatcherSelfHeal
    Start-Sleep -Seconds ([Math]::Max(3, $PollSeconds))
}
