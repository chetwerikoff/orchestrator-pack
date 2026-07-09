#requires -Version 7.0
<#
.SYNOPSIS
  Bind supervisor heavy-lane RPC artifact metadata to a code commit SHA (Issue #693).

  Run at the code commit (defaults to current HEAD), then commit only
  scripts/fixtures/supervisor-test-waits-heavy-lane-rpc/ in a follow-up commit.
#>
[CmdletBinding()]
param(
    [string]$Root = '',
    [string]$HeadSha = ''
)

$ErrorActionPreference = 'Stop'
if (-not $Root) {
    $Root = Split-Path -Parent $PSScriptRoot
}

$cli = Join-Path $Root 'scripts/lib/bind-supervisor-heavy-lane-rpc-metadata.mjs'
if (-not (Test-Path -LiteralPath $cli)) {
    Write-Host "[FAIL] missing bind cli: $cli"
    exit 1
}

$args = @()
if ($HeadSha) {
    $args += $HeadSha
}

& node $cli @args
exit $LASTEXITCODE
