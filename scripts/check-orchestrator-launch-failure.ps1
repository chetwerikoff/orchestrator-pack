#requires -Version 5.1
# Orchestrator entrypoint (Issue #91) — forwards to check-launch-failure.ps1
param(
    [Parameter(Mandatory = $true)][string]$FixturePath,
    [switch]$ExpectMatch,
    [switch]$ExpectNoMatch
)
& (Join-Path $PSScriptRoot 'check-launch-failure.ps1') @PSBoundParameters -RoleLabel 'Orchestrator launch'
exit $LASTEXITCODE
