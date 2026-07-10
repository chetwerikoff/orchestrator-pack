#requires -Version 5.1
<#
.SYNOPSIS
  Guard: AGENTS.md mandates pack-worker-report and skip-silently rule (Issue #717).
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$agents = Join-Path $Root 'AGENTS.md'
if (-not (Test-Path -LiteralPath $agents -PathType Leaf)) {
    Write-Host 'Missing AGENTS.md'
    exit 1
}

$raw = Get-Content -LiteralPath $agents -Raw
if ($raw -cmatch '(?<![A-Za-z0-9_-])ao report(?![A-Za-z0-9_-])') {
    Write-Host 'AGENTS.md still references removed ao report command'
    exit 1
}
if ($raw -notmatch 'pack-worker-report') {
    Write-Host 'AGENTS.md must reference pack-worker-report command'
    exit 1
}
if ($raw -notmatch 'skip silently') {
    Write-Host 'AGENTS.md must include skip silently rule for unavailable report command'
    exit 1
}

Write-Host 'check-agents-report-contract: PASS'
exit 0
