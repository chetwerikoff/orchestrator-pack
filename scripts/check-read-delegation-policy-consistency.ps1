#requires -Version 5.1
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$target = Join-Path ([IO.Path]::GetTempPath()) ('opk-771-probe-' + [guid]::NewGuid().ToString('N'))
$resultPath = Join-Path $Root 'scripts/issue-771-structural-result.log'

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
    $config.Filter.FullName = @('*finds no loader-to-consumer scope leaks in production PowerShell*')
    $config.Output.Verbosity = 'Detailed'
    $output = @(Invoke-Pester -Configuration $config 2>&1)
    $output | Out-File -LiteralPath $resultPath -Encoding utf8
    $summary = @($output | Where-Object { $_.PSObject.Properties.Name -contains 'FailedCount' })[-1]
    if ($summary) {
        "SUMMARY total=$($summary.TotalCount) passed=$($summary.PassedCount) failed=$($summary.FailedCount)" | Add-Content -LiteralPath $resultPath
    }
    exit 0
}
finally {
    Push-Location $Root
    try { & git worktree remove --force $target 2>$null | Out-Null }
    finally { Pop-Location }
    Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction SilentlyContinue
}
