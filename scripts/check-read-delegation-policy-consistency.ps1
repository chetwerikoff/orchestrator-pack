#requires -Version 5.1
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
& (Join-Path $PSScriptRoot 'install-pester-ci.ps1')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Import-Module Pester -MinimumVersion 5.0.0 -ErrorAction Stop
$config = New-PesterConfiguration
$config.Run.Path = Join-Path $Root 'tests/powershell/Issue771.PowerShellDependencyScope.Tests.ps1'
$config.Run.PassThru = $true
$config.Filter.FullName = @(
    '*fails for an unrelated synthetic cross-file loader and consumer*'
)
$config.Output.Verbosity = 'Detailed'
$result = Invoke-Pester -Configuration $config
Write-Host ("ISSUE771_SYNTHETIC_GUARD_RESULT total={0} passed={1} failed={2} skipped={3}" -f $result.TotalCount, $result.PassedCount, $result.FailedCount, $result.SkippedCount)
if ($result.FailedCount -gt 0) { exit 1 }
exit 0
