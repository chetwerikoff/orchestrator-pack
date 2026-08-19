#requires -Version 5.1
<#
.SYNOPSIS
  Transitional compatibility wrapper for the native Node 22/TypeScript heavy-lane authority.

.SUNSET
  Remove after all external callers use scripts/vitest-ci-runner.ts directly.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [int]$Shard
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Runner = Join-Path $Root 'scripts/vitest-ci-runner.ts'

& node --experimental-strip-types $Runner heavy --shard $Shard
exit $LASTEXITCODE
