#requires -Version 5.1
<#
.SYNOPSIS
  Set PACK_REVIEWER for pack-owned review (User scope on Win32NT; Process scope elsewhere).
.PARAMETER Reviewer
  codex | claude
.PARAMETER RestartSupervisor
  Restart scripts/orchestrator-wake-supervisor.ps1 so supported Linux/WSL child
  processes inherit the changed process-scoped selector.
.PARAMETER RestartAo
  Deprecated compatibility alias. It restarts the pack supervisor, not AO.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet('codex', 'claude')]
    [string]$Reviewer,

    [switch]$RestartSupervisor,

    [switch]$RestartAo
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/Resolve-PackReviewer.ps1')

if (Test-PackReviewerPersistentLayersAvailable) {
    [Environment]::SetEnvironmentVariable('PACK_REVIEWER', $Reviewer, 'User')
    Remove-Item Env:PACK_REVIEWER -ErrorAction SilentlyContinue
    Write-Host "Set User PACK_REVIEWER=$Reviewer and cleared Process override in this session."
}
else {
    $env:PACK_REVIEWER = $Reviewer
    Write-Host "Set Process PACK_REVIEWER=$Reviewer for this session (non-Win32NT: process-only)."
    Write-Host 'For persistence across shells, export PACK_REVIEWER in the shell/service environment that starts the pack supervisor.'
}

$restartRequested = [bool]($RestartSupervisor -or $RestartAo)
if ($RestartAo) {
    Write-Warning '-RestartAo is deprecated. Pack review is not daemon-spawned; restarting the pack side-process supervisor instead.'
}

if ($restartRequested) {
    $supervisorScript = Join-Path $PSScriptRoot 'orchestrator-wake-supervisor.ps1'
    if (-not (Test-Path -LiteralPath $supervisorScript -PathType Leaf)) {
        Write-Warning "Pack supervisor script not found at $supervisorScript — selector was set, but no process was restarted."
    }
    else {
        Write-Host 'Restarting orchestrator-pack side-process supervisor...'
        & pwsh -NoProfile -File $supervisorScript -Action Stop
        if ($LASTEXITCODE -ne 0) {
            throw "orchestrator-wake-supervisor Stop failed (exit $LASTEXITCODE)"
        }
        & pwsh -NoProfile -File $supervisorScript -Action Start
        if ($LASTEXITCODE -ne 0) {
            throw "orchestrator-wake-supervisor Start failed (exit $LASTEXITCODE)"
        }
        Write-Host 'Pack side-process supervisor restarted with the selected reviewer environment.'
    }
}

function Invoke-PackReviewerStatusCheck {
    param([string]$ExpectedReviewer)

    $statusScript = Join-Path $PSScriptRoot 'show-pack-reviewer-status.ps1'
    if (Test-PackReviewerPersistentLayersAvailable) {
        $quotedScript = $statusScript.Replace("'", "''")
        $quotedExpected = $ExpectedReviewer.Replace("'", "''")
        & pwsh -NoProfile -Command "& { Remove-Item Env:PACK_REVIEWER -ErrorAction SilentlyContinue; & '$quotedScript' -Expected '$quotedExpected' }"
    }
    else {
        & $statusScript -Expected $ExpectedReviewer
    }
    return $LASTEXITCODE
}

exit (Invoke-PackReviewerStatusCheck -ExpectedReviewer $Reviewer)
