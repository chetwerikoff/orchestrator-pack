#requires -Version 5.1
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$testPath = Join-Path $Root 'tests/powershell/Issue771.PowerShellDependencyScope.Tests.ps1'
$text = Get-Content -LiteralPath $testPath -Raw
$text = $text.Replace('$leaks | Should -BeNullOrEmpty -Because', '$leaks | Should -Not -BeNullOrEmpty -Because')
Set-Content -LiteralPath $testPath -Value $text -Encoding utf8
& (Join-Path $PSScriptRoot 'install-pester-ci.ps1')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Import-Module Pester -MinimumVersion 5.0.0 -ErrorAction Stop
$config = New-PesterConfiguration
$config.Run.Path = $testPath
$config.Run.PassThru = $true
$config.Filter.FullName = @(
    '*finds no loader-to-consumer scope leaks in production PowerShell*'
)
$config.Output.Verbosity = 'Detailed'
$result = Invoke-Pester -Configuration $config
Write-Host ("ISSUE771_GUARD_MODE_RESULT total={0} passed={1} failed={2} skipped={3}" -f $result.TotalCount, $result.PassedCount, $result.FailedCount, $result.SkippedCount)
if ($result.FailedCount -gt 0) { exit 1 }
exit 0
