#requires -Version 5.1
<#
.SYNOPSIS
  Stop-hook entry for coworker read-delegation audit (Issue #255).
.DESCRIPTION
  Compatibility wrapper. The TypeScript producer owns normalization and JSON serialization.
  Fail-open: always exits 0 so completion is never wedged.
#>
param(
    [string]$ArtifactPath,
    [string]$RepoRoot
)

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'lib/Invoke-TypeScriptCli.ps1')
$cli = Join-Path $PSScriptRoot 'json-producers/read-delegation-audit-stop.ts'
$nodeArgs = Get-OpkTypeScriptNodeArguments -ScriptPath $cli
if ($ArtifactPath) { $nodeArgs += @('--artifact-path', $ArtifactPath) }
if ($RepoRoot) { $nodeArgs += @('--repo-root', $RepoRoot) }
$stdin = [Console]::In.ReadToEnd()
$stdin | & node @nodeArgs
# Fail-open by contract: deliberately ignore the child exit status.
