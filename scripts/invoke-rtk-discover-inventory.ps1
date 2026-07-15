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
$cli = Join-Path $PSScriptRoot 'json-producers/rtk-discover-inventory.ts'
$args = @('--experimental-strip-types', $cli, '--since-days', [string]$SinceDays, '--limit', [string]$Limit)
if ($AllProjects) { $args += '--all-projects' }
if ($OutputJson) { $args += @('--output-json', $OutputJson) }
if ($DiscoverFixture) { $args += @('--discover-fixture', $DiscoverFixture) }
if ($NowMs -gt 0) { $args += @('--now-ms', [string]$NowMs) }
& node @args
if ($LASTEXITCODE -ne 0) { throw "rtk-discover-inventory.ts exited $LASTEXITCODE" }
