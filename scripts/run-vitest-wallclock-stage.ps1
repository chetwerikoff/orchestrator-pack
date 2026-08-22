#requires -Version 5.1
<#
.SYNOPSIS
  Transitional compatibility wrapper for the native Node 22/TypeScript wall-clock authority.

.SUNSET
  Remove after all external callers use scripts/vitest-ci-runner.ts directly.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Runner = Join-Path $Root 'scripts/vitest-ci-runner.ts'

& node --experimental-strip-types $Runner wallclock
exit $LASTEXITCODE
