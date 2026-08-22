#requires -Version 5.1
<#
.SYNOPSIS
  Transitional compatibility wrapper for the native Node 22/TypeScript light-lane authority.

.SUNSET
  Remove after all external callers use scripts/vitest-ci-runner.ts directly.
#>
[CmdletBinding()]
param(
    [int]$Shard = 0
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Runner = Join-Path $Root 'scripts/vitest-ci-runner.ts'
$args = @('--experimental-strip-types', $Runner, 'light')
if ($Shard -gt 0) { $args += @('--shard', [string]$Shard) }

& node @args
exit $LASTEXITCODE
