[CmdletBinding()]
param(
    [switch]$SkipNpm,
    [switch]$SkipPester,
    [int]$VitestShard = 0,
    [int]$VitestShardCount = 0
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot

if ($SkipPester) {
    Write-Host 'Issue 771 focused diagnostic skipped by -SkipPester.'
    exit 0
}

Import-Module Pester -MinimumVersion 5.0.0 -ErrorAction Stop
$config = New-PesterConfiguration
$config.Run.Path = Join-Path $Root 'tests/powershell/Issue771.PowerShellDependencyScope.Tests.ps1'
$config.Run.PassThru = $true
$config.Filter.FullName = @(
    '*keeps worker-status GitHub commands visible after lazy import returns*',
    '*never latches an incomplete load as success or replays partial top-level effects*'
)
$config.Output.Verbosity = 'Detailed'
$result = Invoke-Pester -Configuration $config
Write-Host ("ISSUE771_LOADER_RESULT total={0} passed={1} failed={2} skipped={3}" -f $result.TotalCount, $result.PassedCount, $result.FailedCount, $result.SkippedCount)
if ($result.FailedCount -gt 0) { exit 1 }
exit 0
