#requires -Version 5.1
<#
.SYNOPSIS
  Idempotent install/re-apply for the pack-owned cursor-agent TUI shim (Issue #725).

.DESCRIPTION
  Converges machine state: copies tracked shim source to ~/.local/share/orchestrator-pack/
  and symlinks ~/.local/bin/cursor-agent at the pack shim. Never touches ~/.local/bin/agent.
#>
[CmdletBinding()]
param(
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
$PackRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'lib/Cursor-Agent-TuiShim.ps1')

$null = Install-CursorAgentTuiShim -PackRoot $PackRoot -Quiet:$Quiet
$topology = Get-CursorAgentTuiShimTopology
if (-not $topology.Pass) {
    Write-Error "Install completed but topology check failed: $($topology.Reason)"
}
exit 0
