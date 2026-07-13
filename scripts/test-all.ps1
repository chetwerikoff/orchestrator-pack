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
$result = Invoke-Pester -Path (Join-Path $Root 'tests/powershell/Issue771.PowerShellDependencyScope.Tests.ps1') -Output Detailed -PassThru
Write-Host ("ISSUE771_RESULT total={0} passed={1} failed={2} skipped={3}" -f $result.TotalCount, $result.PassedCount, $result.FailedCount, $result.SkippedCount)
if ($result.FailedCount -gt 0) { exit 1 }
exit 0
