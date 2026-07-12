#requires -Version 5.1
<#
.SYNOPSIS
  Run the CI pipeline-split guard with a bounded same-run topology overlay.

.DESCRIPTION
  The committed runtime-history artifact remains untouched. A Node wrapper measures
  stale changed Vitest files, materializes an ephemeral overlay, invokes the original
  guard core, and restores the artifact byte-for-byte in finally.
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
$wrapper = Join-Path $PSScriptRoot 'lib/ci-pipeline-split-pre-topology-wrapper.mjs'
$core = Join-Path $PSScriptRoot 'check-ci-pipeline-split-core.ps1'

if (-not (Test-Path -LiteralPath $wrapper -PathType Leaf)) {
    throw "missing CI pipeline split pre-topology wrapper: $wrapper"
}
if (-not (Test-Path -LiteralPath $core -PathType Leaf)) {
    throw "missing CI pipeline split guard core: $core"
}

$argsList = @(
    $wrapper,
    '--repo-root', $RepoRoot,
    '--core', $core
)
if ($SkipLiveCoverage) {
    $argsList += '--skip-live-coverage'
}

& node @argsList
exit $LASTEXITCODE
