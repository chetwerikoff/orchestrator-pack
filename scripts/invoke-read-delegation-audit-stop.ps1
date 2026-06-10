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
  $payload = $stdin | ConvertFrom-Json
}
catch {
  $payload = [pscustomobject]@{ parseError = $_.Exception.Message }
}

if ($ArtifactPath) {
  $payload | Add-Member -NotePropertyName artifactPath -NotePropertyValue $ArtifactPath -Force
}
elseif (-not $payload.PSObject.Properties.Match('artifactPath').Count) {
  $homeDir = if ($env:HOME) { $env:HOME } else { $env:USERPROFILE }
  $payload | Add-Member -NotePropertyName artifactPath -NotePropertyValue (Join-Path $homeDir '.orchestrator-pack/read-delegation-audit.jsonl') -Force
}

if (-not $payload.PSObject.Properties.Match('surface').Count) {
  $hookEventName = $null
  if ($payload.PSObject.Properties.Match('hookEventName').Count) {
    $hookEventName = $payload.hookEventName
  }
  elseif ($payload.PSObject.Properties.Match('hook_event_name').Count) {
    $hookEventName = $payload.hook_event_name
  }

  if ($hookEventName -ceq 'Stop') {
    $payload | Add-Member -NotePropertyName surface -NotePropertyValue 'claude' -Force
  }
  else {
    $payload | Add-Member -NotePropertyName surface -NotePropertyValue 'cursor' -Force
  }
}

if (-not $payload.PSObject.Properties.Match('env').Count) {
  $payload | Add-Member -NotePropertyName env -NotePropertyValue ([ordered]@{
      PACK_REVIEWER   = $env:PACK_REVIEWER
      REVIEW_COMMAND  = $env:REVIEW_COMMAND
    }) -Force
}

$jsonIn = $payload | ConvertTo-Json -Depth 30 -Compress
try {
  $jsonOut = $jsonIn | node $auditModule stop 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "audit module exited ${LASTEXITCODE}: $jsonOut"
  }
}
catch {
  $artifact = $payload.artifactPath
  $surface = if ($payload.PSObject.Properties.Match('surface').Count) { $payload.surface } else { 'unknown' }
  $health = @{
    kind        = 'audit_error'
    surface     = $surface
    eventId     = "hook-error:$(Get-Date -Format 'yyyyMMddHHmmss')"
    emittedAtMs = [int64](([DateTimeOffset]::UtcNow).UtcDateTime - [datetime]'1970-01-01Z').TotalMilliseconds
    message     = $_.Exception.Message
  } | ConvertTo-Json -Compress
  try {
    Add-Content -LiteralPath $artifact -Value $health -Encoding utf8
  }
  catch {
    Write-Warning "failed to record audit health error: $($_.Exception.Message)"
  }
}

exit 0
