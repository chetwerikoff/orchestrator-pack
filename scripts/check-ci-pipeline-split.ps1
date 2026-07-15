#requires -Version 5.1
<#
.SYNOPSIS
  Run the CI pipeline-split guard with merge-context parity checks and a bounded same-run topology overlay.

.DESCRIPTION
  Issue #823's fail-closed audit and run-twice fixture execute before the topology
  wrapper so PR-only leniency or self-referential push bases cannot reappear. The
  committed runtime-history artifact remains untouched.
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
$parityFixture = Join-Path $PSScriptRoot 'fixtures/merge-blind-ci-gates/parity.ps1'

foreach ($required in @($wrapper, $core, $audit, $parityFixture)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "missing CI pipeline split prerequisite: $required"
    }
}

$trackedFilesPath = Join-Path ([IO.Path]::GetTempPath()) ("opk-823-tracked-{0}.json" -f [guid]::NewGuid().ToString('N'))
try {
    $trackedFiles = @(& git -C $RepoRoot ls-files)
    if ($LASTEXITCODE -ne 0) { throw 'git ls-files failed while preparing merge-blind audit input' }
    [IO.File]::WriteAllText($trackedFilesPath, ($trackedFiles | ConvertTo-Json -Compress))

    & node $audit --repo-root $RepoRoot --tracked-files $trackedFilesPath
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
finally {
    Remove-Item -LiteralPath $trackedFilesPath -Force -ErrorAction SilentlyContinue
}

& pwsh -NoProfile -File $parityFixture -RepoRoot $RepoRoot
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
