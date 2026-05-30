#requires -Version 5.1
# Worker entrypoint (Issue #63) — forwards to check-launch-failure.ps1
param(
    [Parameter(Mandatory = $true)][string]$FixturePath,
    [switch]$ExpectMatch,
    [switch]$ExpectNoMatch
)
& (Join-Path $PSScriptRoot 'check-launch-failure.ps1') @PSBoundParameters -RoleLabel 'Launch'
exit $LASTEXITCODE
