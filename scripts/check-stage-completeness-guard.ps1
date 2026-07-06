#requires -Version 7.0
param(
    [Parameter(Mandatory = $true)]
    [string]$DraftPath,
    [string]$RepoRoot
)
& (Join-Path $PSScriptRoot 'check-draft-text-guard.ps1') -Guard stage-completeness -DraftPath $DraftPath -RepoRoot $RepoRoot
exit $LASTEXITCODE
