#requires -Version 5.1
<#
.SYNOPSIS
  Run the CI pipeline-split guard with merge-context parity checks and a bounded same-run topology overlay.

.DESCRIPTION
  Issue #823's audit and run-twice fixture execute before the topology wrapper so a
  PR-only leniency branch or self-referential push base cannot silently reappear.
  The committed runtime-history artifact remains untouched. The topology wrapper
  measures stale changed Vitest files, materializes an ephemeral overlay, invokes
  the original guard core, and restores the artifact byte-for-byte in finally.
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
$audit = Join-Path $PSScriptRoot 'check-merge-blind-ci-gates.mjs'
$parityFixture = Join-Path $PSScriptRoot 'fixtures/merge-blind-ci-gates/parity.mjs'

foreach ($required in @($wrapper, $core, $audit, $parityFixture)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "missing CI pipeline split prerequisite: $required"
    }
}

& node $audit $RepoRoot
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

& node --experimental-strip-types $parityFixture $RepoRoot
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

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
