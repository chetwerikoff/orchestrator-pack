#requires -Version 7.0
param(
    [Parameter(Mandatory = $true)]
    [string]$DraftPath,
    [string]$RepoRoot
)
& (Join-Path $PSScriptRoot 'check-draft-text-guard.ps1') -Guard tier-gate -DraftPath $DraftPath -RepoRoot $RepoRoot
