#requires -Version 5.1
<#
.SYNOPSIS
  Read-only operator projection of pack worker-status store (Issue #720).
.DESCRIPTION
  Compatibility wrapper for the TypeScript JSON producer. The historical implementation used
  Get-WorkerStatusReadOnlyProjection and computed age from workerStatusLastUpdatedMs as
  [long]$session.workerStatusLastUpdatedMs; those read-only semantics remain the contract.
#>
param(
    [string]$Project = 'orchestrator-pack',
    [string]$RepoSlug = '',
    [switch]$Json,
    [string]$SessionListsFixture = '',
    [string]$StorePath = '',
    [long]$NowMs = 0
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/Invoke-TypeScriptCli.ps1')
$cli = Join-Path $PSScriptRoot 'json-producers/worker-status-report.ts'
$nodeArgs = Get-OpkTypeScriptNodeArguments -ScriptPath $cli
$nodeArgs += @('--project', $Project)
if ($RepoSlug) { $nodeArgs += @('--repo-slug', $RepoSlug) }
if ($Json) { $nodeArgs += '--json' }
if ($SessionListsFixture) { $nodeArgs += @('--session-lists-fixture', $SessionListsFixture) }
if ($StorePath) { $nodeArgs += @('--store-path', $StorePath) }
if ($NowMs -gt 0) { $nodeArgs += @('--now-ms', [string]$NowMs) }
& node @nodeArgs
if ($LASTEXITCODE -ne 0) { throw "worker-status-report.ts exited $LASTEXITCODE" }
