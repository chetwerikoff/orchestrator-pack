#requires -Version 5.1
<#
.SYNOPSIS
  Stop-hook entry for coworker read-delegation audit (Issue #255).
.DESCRIPTION
  Fail-open: always exits 0 so completion is never wedged. Errors are recorded in the metric artifact.
#>
param(
    [string]$ArtifactPath,
    [string]$RepoRoot
)

$ErrorActionPreference = 'Stop'

if (-not $RepoRoot) {
    $RepoRoot = Split-Path -Parent $PSScriptRoot
}

$auditModule = Join-Path $RepoRoot 'docs/read-delegation-audit.mjs'
if (-not (Test-Path -LiteralPath $auditModule)) {
  Write-Warning "read-delegation audit module missing: $auditModule"
  exit 0
}

$stdin = [Console]::In.ReadToEnd()
if (-not $stdin.Trim()) {
  $stdin = '{}'
}

try {
  $payload = $stdin | ConvertFrom-Json -AsHashtable
}
catch {
  $payload = @{ parseError = $_.Exception.Message }
}

if ($ArtifactPath) {
  $payload['artifactPath'] = $ArtifactPath
}
elseif (-not $payload['artifactPath']) {
  $home = if ($env:HOME) { $env:HOME } else { $env:USERPROFILE }
  $payload['artifactPath'] = Join-Path $home '.orchestrator-pack/read-delegation-audit.jsonl'
}

if (-not $payload['surface']) {
  if ($payload['hookEventName'] -eq 'Stop') {
    $payload['surface'] = 'claude'
  }
  else {
    $payload['surface'] = 'cursor'
  }
}

if (-not $payload['env']) {
  $payload['env'] = @{
    PACK_REVIEWER = $env:PACK_REVIEWER
    REVIEW_COMMAND = $env:REVIEW_COMMAND
  }
}

$jsonIn = $payload | ConvertTo-Json -Depth 30 -Compress
try {
  $jsonOut = $jsonIn | node $auditModule stop 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "audit module exited $LASTEXITCODE: $jsonOut"
  }
}
catch {
  $health = @{
    kind = 'audit_error'
    surface = $payload['surface']
    eventId = "hook-error:$(Get-Date -Format 'yyyyMMddHHmmss')"
    emittedAtMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    message = $_.Exception.Message
  } | ConvertTo-Json -Compress
  $artifact = $payload['artifactPath']
  try {
    Add-Content -LiteralPath $artifact -Value $health -Encoding utf8
  }
  catch {
    Write-Warning "failed to record audit health error: $($_.Exception.Message)"
  }
}

exit 0
