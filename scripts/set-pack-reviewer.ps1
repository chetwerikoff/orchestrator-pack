#requires -Version 5.1
<#
.SYNOPSIS
  Set operator-global PACK_REVIEWER (User scope) and clear session override (Process).
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

if ($env:OS -notmatch 'Windows') {
    Write-Error 'Persistent User scope is applied via Windows registry. On non-Windows, set PACK_REVIEWER in the shell profile or service unit and clear process scope manually.'
}

[Environment]::SetEnvironmentVariable('PACK_REVIEWER', $Reviewer, 'User')
Remove-Item Env:PACK_REVIEWER -ErrorAction SilentlyContinue

Write-Host "Set User PACK_REVIEWER=$Reviewer and cleared Process override in this session."

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
        Start-Process -FilePath 'pwsh' -ArgumentList @(
            '-NoProfile',
            '-Command',
            "Remove-Item Env:PACK_REVIEWER -ErrorAction SilentlyContinue; Set-Location '$escapedRoot'; ao start orchestrator-pack"
        ) -WorkingDirectory $repoRoot | Out-Null
        Write-Host 'AO start launched in background via clean shell (dashboard may take a few seconds).'
    }
}

function Invoke-PackReviewerStatusCheck {
    param([string]$ExpectedReviewer)

    Remove-Item Env:PACK_REVIEWER -ErrorAction SilentlyContinue
    $statusScript = Join-Path $PSScriptRoot 'show-pack-reviewer-status.ps1'
    $quotedScript = $statusScript.Replace("'", "''")
    $quotedExpected = $ExpectedReviewer.Replace("'", "''")
    & pwsh -NoProfile -Command "& { Remove-Item Env:PACK_REVIEWER -ErrorAction SilentlyContinue; & '$quotedScript' -Expected '$quotedExpected' }"
    return $LASTEXITCODE
}

exit (Invoke-PackReviewerStatusCheck -ExpectedReviewer $Reviewer)
