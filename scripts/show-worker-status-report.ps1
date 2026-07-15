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
$cli = Join-Path $PSScriptRoot 'json-producers/worker-status-report.ts'
$args = @('--experimental-strip-types', $cli, '--project', $Project)
if ($RepoSlug) { $args += @('--repo-slug', $RepoSlug) }
if ($Json) { $args += '--json' }
if ($SessionListsFixture) { $args += @('--session-lists-fixture', $SessionListsFixture) }
if ($StorePath) { $args += @('--store-path', $StorePath) }
if ($NowMs -gt 0) { $args += @('--now-ms', [string]$NowMs) }
& node @args
if ($LASTEXITCODE -ne 0) { throw "worker-status-report.ts exited $LASTEXITCODE" }
