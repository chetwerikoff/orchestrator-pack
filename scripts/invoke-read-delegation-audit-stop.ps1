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

$ErrorActionPreference = 'Stop'
try {
    . (Join-Path $PSScriptRoot 'lib/Invoke-TypeScriptCli.ps1')
    $cli = Join-Path $PSScriptRoot 'json-producers/read-delegation-audit-stop.ts'
    $nodeArgs = Get-OpkTypeScriptNodeArguments -ScriptPath $cli
    if ($ArtifactPath) { $nodeArgs += @('--artifact-path', $ArtifactPath) }
    if ($RepoRoot) { $nodeArgs += @('--repo-root', $RepoRoot) }
    $stdin = [Console]::In.ReadToEnd()
    $stdin | & node @nodeArgs
}
catch {
    Write-Warning "read-delegation audit wrapper failed open: $($_.Exception.Message)"
}

# Fail-open by contract: deliberately ignore preparation, launch, and child failures.
exit 0
