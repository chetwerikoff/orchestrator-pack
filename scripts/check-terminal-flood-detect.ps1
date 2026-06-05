#requires -Version 5.1
<#
.SYNOPSIS
  Regression guard: Issue #173 terminal flood detection defaults and runbook.
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$scriptPath = Join-Path $Root 'scripts/terminal-flood-detect.ps1'
$mjsPath = Join-Path $Root 'docs/terminal-flood-detect.mjs'
$runbook = Join-Path $Root 'docs/orchestrator-recovery-runbook.md'

if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
    Write-Host 'Missing scripts/terminal-flood-detect.ps1'
    exit 1
}

if (-not (Test-Path -LiteralPath $mjsPath -PathType Leaf)) {
    Write-Host 'Missing docs/terminal-flood-detect.mjs'
    exit 1
}

$mjs = Get-Content -LiteralPath $mjsPath -Raw
if ($mjs -notmatch 'DEFAULT_WINDOW_MS = 60_000') {
    Write-Host 'docs/terminal-flood-detect.mjs must default to 60-second window'
    exit 1
}

if ($mjs -notmatch 'DEFAULT_MIN_PAIRED_CYCLES = 6') {
    Write-Host 'docs/terminal-flood-detect.mjs must default to 6 paired mux cycles'
    exit 1
}

if ($mjs -notmatch 'ui\.terminal_connected' -or $mjs -notmatch 'ui\.terminal_disconnected') {
    Write-Host 'docs/terminal-flood-detect.mjs must use ui.terminal_connected/disconnected kinds'
    exit 1
}

$ps1 = Get-Content -LiteralPath $scriptPath -Raw
if ($ps1 -notmatch 'DefaultWindowSeconds = 60' -or $ps1 -notmatch 'DefaultMinPairedCycles = 6') {
    Write-Host 'scripts/terminal-flood-detect.ps1 must document safe defaults (60s window, 6 pairs)'
    exit 1
}

$runbookText = Get-Content -LiteralPath $runbook -Raw
$runbookRequired = @(
    'Terminal Device-Attributes flood',
    'active-blocked-upstream',
    'ComposioHQ/agent-orchestrator#2094',
    'terminal-flood-detect.ps1',
    'AO_TERMINAL_FLOOD_WINDOW_SECONDS',
    'AO_TERMINAL_FLOOD_MIN_PAIRED_CYCLES',
    'terminal_mux_paired_flap',
    'Post-stop verification',
    'recycle the session',
    'verified quiet'
)

$missingRunbook = @($runbookRequired | Where-Object { $runbookText -notlike "*$_*" })
if ($missingRunbook.Count -gt 0) {
    Write-Host ("orchestrator-recovery-runbook.md missing terminal-flood phrases: {0}" -f ($missingRunbook -join ', '))
    exit 1
}

$symptomsPos = $runbookText.IndexOf('## Terminal Device-Attributes flood')
$stopPos = $runbookText.IndexOf('### Stop the reconnect loop', $symptomsPos)
$verifyPos = $runbookText.IndexOf('### Post-stop verification', $stopPos)
$redeliverPos = $runbookText.IndexOf('### Re-deliver after verified quiet', $verifyPos)
if ($symptomsPos -lt 0 -or $stopPos -lt $symptomsPos -or $verifyPos -lt $stopPos -or $redeliverPos -lt $verifyPos) {
    Write-Host 'orchestrator-recovery-runbook.md must document symptoms → stop → post-stop verification → re-deliver in order'
    exit 1
}

Write-Host '[PASS] terminal flood detection entrypoint and runbook (Issue #173)'
exit 0
