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
$cli = Join-Path $PSScriptRoot 'json-producers/read-delegation-audit-stop.ts'
$args = @('--experimental-strip-types', $cli)
if ($ArtifactPath) { $args += @('--artifact-path', $ArtifactPath) }
if ($RepoRoot) { $args += @('--repo-root', $RepoRoot) }
$stdin = [Console]::In.ReadToEnd()
$stdin | & node @args
# Fail-open by contract: deliberately ignore the child exit status.
