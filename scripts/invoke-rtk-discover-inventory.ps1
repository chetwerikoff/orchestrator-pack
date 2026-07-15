#requires -Version 7.0
<#
.SYNOPSIS
  Regenerate the RTK missed-savings inventory from local rtk discover output (Issue #199).
#>
[CmdletBinding()]
param(
    [int]$SinceDays = 30,
    [switch]$AllProjects,
    [int]$Limit = 50,
    [string]$OutputJson,
    [string]$DiscoverFixture = '',
    [long]$NowMs = 0
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/Invoke-TypeScriptCli.ps1')
$cli = Join-Path $PSScriptRoot 'json-producers/rtk-discover-inventory.ts'
$nodeArgs = Get-OpkTypeScriptNodeArguments -ScriptPath $cli
$nodeArgs += @('--since-days', [string]$SinceDays, '--limit', [string]$Limit)
if ($AllProjects) { $nodeArgs += '--all-projects' }
if ($OutputJson) { $nodeArgs += @('--output-json', $OutputJson) }
if ($DiscoverFixture) { $nodeArgs += @('--discover-fixture', $DiscoverFixture) }
if ($NowMs -gt 0) { $nodeArgs += @('--now-ms', [string]$NowMs) }
& node @nodeArgs
if ($LASTEXITCODE -ne 0) { throw "rtk-discover-inventory.ts exited $LASTEXITCODE" }
