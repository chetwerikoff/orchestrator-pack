#requires -Version 5.1
<#
.SYNOPSIS
  Refresh committed Vitest runtime-history from heavy-shard JSON reports (Issue #691).
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ReportsDir,

    [Parameter(Mandatory = $true)]
    [string]$CommitSha,

    [string]$RepoRoot = '',
    [string]$HistoryPath = '',
    [switch]$DryRun,
    [switch]$CommitBack
)

$ErrorActionPreference = 'Stop'
if (-not $RepoRoot) {
    $RepoRoot = Split-Path -Parent $PSScriptRoot
}
$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path

$refreshScript = Join-Path $PSScriptRoot 'refresh-vitest-runtime-history.mjs'
$args = @(
    $refreshScript,
    '--reports-dir', $ReportsDir,
    '--commit-sha', $CommitSha,
    '--repo-root', $RepoRoot
)
if ($HistoryPath) {
    $args += @('--history-path', $HistoryPath)
}
if ($DryRun) {
    $args += '--dry-run'
}

& node @args
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

if (-not $CommitBack -or $DryRun) {
    exit 0
}

$historyFile = if ($HistoryPath) { $HistoryPath } else { Join-Path $RepoRoot 'scripts/vitest-runtime-history.json' }
if (-not (Test-Path -LiteralPath $historyFile)) {
    Write-Host "[FAIL] expected history file missing after refresh: $historyFile"
    exit 1
}

git -C $RepoRoot add -- 'scripts/vitest-runtime-history.json'
$status = git -C $RepoRoot status --porcelain -- 'scripts/vitest-runtime-history.json'
if ([string]::IsNullOrWhiteSpace($status)) {
    Write-Host '[PASS] runtime-history commit-back skipped (idempotent no-op)'
    exit 0
}

git -C $RepoRoot -c user.name='github-actions[bot]' -c user.email='41898282+github-actions[bot]@users.noreply.github.com' `
    commit -m "chore(ci): refresh vitest runtime-history from measured heavy-shard reports"
if ($LASTEXITCODE -ne 0) {
    Write-Host '[FAIL] runtime-history commit-back failed'
    exit 1
}

$maxAttempts = 3
for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
  git -C $RepoRoot pull --rebase origin main
  if ($LASTEXITCODE -ne 0) {
    if ($attempt -eq $maxAttempts) {
      Write-Host '[FAIL] runtime-history push failed after stale-base rebase retries'
      exit 1
    }
    continue
  }
  git -C $RepoRoot push origin HEAD:main
  if ($LASTEXITCODE -eq 0) {
    Write-Host '[PASS] runtime-history commit-back pushed to main'
    exit 0
  }
}

Write-Host '[FAIL] runtime-history push failed'
exit 1
