#requires -Version 5.1
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$target = Join-Path ([IO.Path]::GetTempPath()) ('opk-771-probe-' + [guid]::NewGuid().ToString('N'))

Push-Location $Root
try {
    & git fetch --no-tags origin agent/issue-771-powershell-scope
    if ($LASTEXITCODE -ne 0) { throw "git fetch failed: $LASTEXITCODE" }
    & git worktree add --detach $target FETCH_HEAD
    if ($LASTEXITCODE -ne 0) { throw "git worktree add failed: $LASTEXITCODE" }
}
finally { Pop-Location }

try {
    & (Join-Path $target 'scripts/install-pester-ci.ps1')
    Import-Module Pester -MinimumVersion 5.0.0 -ErrorAction Stop
    $config = New-PesterConfiguration
    $config.Run.Path = Join-Path $target 'tests/powershell/Issue771.PowerShellDependencyScope.Tests.ps1'
    $config.Run.PassThru = $true
    $config.Filter.FullName = @(
        '*keeps worker-status GitHub commands visible after lazy import returns*',
        '*never latches an incomplete load as success or replays partial top-level effects*',
        '*uses the GitHub boundary, computes a snapshot, and writes a store record*'
    )
    $config.Output.Verbosity = 'None'
    $result = Invoke-Pester -Configuration $config
    if ($result.FailedCount -gt 0) { exit 1 }
    exit 0
}
finally {
    Push-Location $Root
    try { & git worktree remove --force $target 2>$null | Out-Null }
    finally { Pop-Location }
    Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction SilentlyContinue
}
