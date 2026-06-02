#requires -Version 5.1
<#
.SYNOPSIS
  Set PACK_REVIEWER for pack review (User scope on Win32NT; Process scope elsewhere).
.PARAMETER Reviewer
  codex | claude
.PARAMETER RestartAo
  Run ao stop / ao start orchestrator-pack when ao is on PATH.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet('codex', 'claude')]
    [string]$Reviewer,

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
    Write-Host "Set Process PACK_REVIEWER=$Reviewer for this session (non-Win32NT: process-only per architecture section N)."
    Write-Host 'For persistence across shells, export PACK_REVIEWER in your shell profile or service unit (see docs/reviewer-switch-runbook.md).'
}

if ($RestartAo) {
    if (-not (Get-Command ao -ErrorAction SilentlyContinue)) {
        Write-Warning 'ao not on PATH — skipped ao stop/start. Run manually after opening a fresh shell.'
    }
    else {
        Write-Host 'Restarting AO (orchestrator-pack)...'
        & ao stop 2>&1 | ForEach-Object { Write-Host $_ }
        Start-Sleep -Seconds 2
        $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
        $escapedRoot = $repoRoot.Replace("'", "''")
        if (Test-PackReviewerPersistentLayersAvailable) {
            $startCommand = "Remove-Item Env:PACK_REVIEWER -ErrorAction SilentlyContinue; Set-Location '$escapedRoot'; ao start orchestrator-pack"
        }
        else {
            $escapedReviewer = $Reviewer.Replace("'", "''")
            $startCommand = "`$env:PACK_REVIEWER='$escapedReviewer'; Set-Location '$escapedRoot'; ao start orchestrator-pack"
        }
        Start-Process -FilePath 'pwsh' -ArgumentList @(
            '-NoProfile',
            '-Command',
            $startCommand
        ) -WorkingDirectory $repoRoot | Out-Null
        Write-Host 'AO start launched in background via clean shell (dashboard may take a few seconds).'
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
