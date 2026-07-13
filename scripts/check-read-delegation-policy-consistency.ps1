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
    $testPath = Join-Path $target 'tests/powershell/Issue771.PowerShellDependencyScope.Tests.ps1'
    $text = Get-Content -LiteralPath $testPath -Raw
    $old = '$leaks = @(Get-Issue771DependencyScopeLeaks -RepositoryRoot $RepoRoot -ScanRoot (Join-Path $RepoRoot ''scripts''))'
    $new = '$leaks = @(Get-Issue771DependencyScopeLeaks -RepositoryRoot $RepoRoot -ScanRoot (Join-Path $RepoRoot ''scripts'') | Where-Object { $_.LoaderFunction -match ''^(?i)Get-Review'' })'
    if (-not $text.Contains($old)) { throw 'production scan probe anchor not found' }
    $text = $text.Replace($old, $new)
    $text = $text.Replace('$leaks | Should -BeNullOrEmpty -Because', '$leaks | Should -Not -BeNullOrEmpty -Because')
    Set-Content -LiteralPath $testPath -Value $text -Encoding utf8

    & (Join-Path $target 'scripts/install-pester-ci.ps1')
    Import-Module Pester -MinimumVersion 5.0.0 -ErrorAction Stop
    $config = New-PesterConfiguration
    $config.Run.Path = $testPath
    $config.Run.PassThru = $true
    $config.Filter.FullName = @('*finds no loader-to-consumer scope leaks in production PowerShell*')
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
