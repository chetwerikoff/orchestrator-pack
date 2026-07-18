#requires -Version 5.1
<#
.SYNOPSIS
  Run the surviving CI pipeline-split guard.

.DESCRIPTION
  Issue #906 retires the merge-blind parity/audit wrappers together with their
  removed legacy subjects. The static/live pipeline-split core remains
  load-bearing because the protected scope-guard workflow invokes this entrypoint.
#>
[CmdletBinding()]
param(
    [string]$RepoRoot = '',
    [switch]$SkipLiveCoverage
)

$ErrorActionPreference = 'Stop'
if (-not $RepoRoot) {
    $RepoRoot = Split-Path -Parent $PSScriptRoot
}
$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
$core = Join-Path $PSScriptRoot 'check-ci-pipeline-split-core.ps1'

if (-not (Test-Path -LiteralPath $core -PathType Leaf)) {
    throw "missing CI pipeline split prerequisite: $core"
}

$argsList = @('-RepoRoot', $RepoRoot)
if ($SkipLiveCoverage) {
    $argsList += '-SkipLiveCoverage'
}

& $core @argsList
exit $LASTEXITCODE
