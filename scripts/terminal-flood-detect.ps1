#requires -Version 5.1
<#
.SYNOPSIS
  Read-only terminal mux flood diagnostic from ao events (Issue #173).

.DESCRIPTION
  Surfaces the pack detection signature (session-local, paired
  ui.terminal_connected + ui.terminal_disconnected sustained over a bounded window)
  from observable AO state. Does not scrape tmux panes. Does not mutate sessions.

  Root fix: ComposioHQ/agent-orchestrator#2094 (upstream). This script is mitigation only.

  See docs/orchestrator-recovery-runbook.md (Terminal Device-Attributes flood).
#>
[CmdletBinding()]
param(
    [string]$SessionId = '',
    [int]$WindowSeconds = 0,
    [int]$MinPairedCycles = 0,
    [int]$SinceMinutes = 5,
    [string]$FixturePath = ''
)

$ErrorActionPreference = 'Stop'

$PackRoot = Split-Path -Parent $PSScriptRoot
$DetectCli = Join-Path $PackRoot 'docs/terminal-flood-detect.mjs'
$Script:DefaultWindowSeconds = 60
$Script:DefaultMinPairedCycles = 6

. (Join-Path $PSScriptRoot 'lib/Invoke-AoCliJson.ps1')

function Get-FloodWindowSeconds {
    if ($WindowSeconds -gt 0) { return $WindowSeconds }
    $envSeconds = $env:AO_TERMINAL_FLOOD_WINDOW_SECONDS
    if ($envSeconds -and [int]::TryParse($envSeconds, [ref]$null)) {
        return [int]$envSeconds
    }
    return $Script:DefaultWindowSeconds
}

function Get-FloodMinPairedCycles {
    if ($MinPairedCycles -gt 0) { return $MinPairedCycles }
    $envCycles = $env:AO_TERMINAL_FLOOD_MIN_PAIRED_CYCLES
    if ($envCycles -and [int]::TryParse($envCycles, [ref]$null)) {
        return [int]$envCycles
    }
    return $Script:DefaultMinPairedCycles
}

function Invoke-FloodDetectCli {
    param([hashtable]$Payload)

    $json = $Payload | ConvertTo-Json -Depth 30 -Compress
    $output = $json | & node $DetectCli detect 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "terminal-flood-detect.mjs detect exited ${LASTEXITCODE}: $output"
    }

    $text = ($output | ForEach-Object { $_.ToString() }) -join "`n"
    return $text | ConvertFrom-Json
}

if ($FixturePath) {
    $fixtureResolved = (Resolve-Path -LiteralPath $FixturePath).Path
    $fixture = Get-Content -LiteralPath $fixtureResolved -Raw | ConvertFrom-Json
    $events = @($fixture.events)
    if (-not $events -and $fixture.aoEvents) {
        $events = @($fixture.aoEvents.events)
    }
    $nowMs = [long]$fixture.nowMs
    if (-not $nowMs) {
        throw 'Fixture must include nowMs'
    }
}
else {
    $since = "${SinceMinutes}m"
    $eventsPayload = Invoke-AoCliJson -AoArgs @(
        'events', 'list', '--since', $since, '--limit', '500', '--json'
    ) -FailureLabel 'ao events list'
    $events = @($eventsPayload.events)
    $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
}

$config = @{
    windowMs           = (Get-FloodWindowSeconds) * 1000
    minPairedCycles    = Get-FloodMinPairedCycles
    minSpanMs          = 30 * 1000
    maxSubscriberCount = 1
}
if ($SessionId) {
    $config.sessionId = $SessionId.Trim()
}

$result = Invoke-FloodDetectCli -Payload @{
    events = $events
    nowMs  = $nowMs
    config = $config
}

$result | ConvertTo-Json -Depth 20

if ($result.flagged) {
    Write-Host ''
    Write-Host '[FLAG] terminal_mux_paired_flap — session-local sustained mux connect/disconnect cycling'
    foreach ($row in @($result.flaggedSessions)) {
        $ev = $row.evidence
        Write-Host (
            "  session={0} pairedCycles={1} connected={2} disconnected={3} spanMs={4}" -f
            $row.sessionId,
            $ev.pairedCycles,
            $ev.connectedCount,
            $ev.disconnectedCount,
            $ev.spanMs
        )
    }
    exit 2
}

if ($result.globalMuxChurn -and $SessionId) {
    Write-Host ''
    Write-Host '[INFO] Global mux churn in window but no session-local signature for requested session.'
    Write-Host '       Correlate worker symptoms (CPU pegged, unsubmitted paste) or close the dashboard terminal view for that worker.'
}

exit 0
