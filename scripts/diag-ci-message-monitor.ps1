#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Diagnostic monitor: log all CI-failure messages arriving at worker.

  Watches:
    1. AO reaction events for ci-failed send-to-agent
    2. Worker tmux pane for incoming CI-related messages
    3. Orchestrator ao send output (from wrapper log)

  All output goes to /tmp/ci-message-diag-{date}.log
#>

param(
  [string]$WorkerSessionId = 'opk-53',
  [string]$OrchestratorSessionId = 'opk-orchestrator',
  [string]$LogDir = '/tmp',
  [int]$PollSeconds = 5,
  [switch]$Once
)

$ErrorActionPreference = 'Stop'
$logFile = Join-Path $LogDir "ci-message-diag-$(Get-Date -Format 'yyyy-MM-dd-HHmmss').log"

function Write-DiagLog {
  param([string]$Message)
  $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss.fff')
  $line = "[$stamp] $Message"
  Add-Content -Path $logFile -Value $line
  Write-Host $line
}

Write-DiagLog "=== CI message diagnostic monitor started ==="
Write-DiagLog "Worker session: $WorkerSessionId"
Write-DiagLog "Orchestrator session: $OrchestratorSessionId"
Write-DiagLog "Log file: $logFile"
Write-DiagLog "Poll interval: ${PollSeconds}s"
Write-DiagLog ""

$lastEventId = 0
$lastWorkerPaneLines = @()
$seenOrchCommands = [System.Collections.Generic.HashSet[string]]::new()
$seenWrapperLines = 0

do {
  # 1. Check AO events for ci-failed reaction
  try {
    $eventsJson = ao events list --json --kind reaction.action_succeeded --session $WorkerSessionId 2>&1 | ConvertFrom-Json
    if ($eventsJson -and $eventsJson.events) {
      foreach ($evt in $eventsJson.events) {
        $eid = [int]$evt.id
        if ($eid -le $lastEventId) { continue }
        $lastEventId = $eid
        if ($evt.data.reactionKey -eq 'ci-failed' -and $evt.data.action -eq 'send-to-agent') {
          Write-DiagLog "EVENT reaction.action_succeeded ci-failed send-to-agent (id=$eid ts=$($evt.ts))"
        }
      }
    }
  }
  catch {
    Write-DiagLog "WARN ao events failed: $_"
  }

  # 2. Log ALL new text in worker tmux pane (diff-based dedup)
  try {
    $paneContent = tmux capture-pane -t $WorkerSessionId -p -S -50 2>&1
    $lines = $paneContent -split "`n"
    # Find new lines: compare from bottom up
    $newStart = $lines.Count
    for ($i = $lines.Count - 1; $i -ge 0; $i--) {
      $line = $lines[$i].Trim()
      if ($line.Length -eq 0) { continue }
      $idx = [Math]::Max(0, $lastWorkerPaneLines.Count - ($lines.Count - $i))
      if ($idx -lt $lastWorkerPaneLines.Count -and $lastWorkerPaneLines[$idx].Trim() -eq $line) {
        break
      }
      $newStart = $i
    }
    for ($i = $newStart; $i -lt $lines.Count; $i++) {
      Write-DiagLog "WORKER PANE: $($lines[$i])"
    }
    $lastWorkerPaneLines = $lines
  }
  catch {
    Write-DiagLog "WARN tmux capture worker failed: $_"
  }

  # 3. Check orchestrator pane for ao send commands (deduplicated)
  try {
    $orchContent = tmux capture-pane -t $OrchestratorSessionId -p -S -30 2>&1
    $orchLines = $orchContent -split "`n"
    foreach ($line in $orchLines) {
      $line = $line.Trim()
      if ($line -match '(?i)\bao send\b.*opk-53') {
        $digest = [System.Convert]::ToBase64String(
          [System.Text.Encoding]::UTF8.GetBytes($line)
        )
        if (-not $seenOrchCommands.Contains($digest)) {
          Write-DiagLog "ORCH PANE (ao send to worker): $line"
          $null = $seenOrchCommands.Add($digest)
        }
      }
    }
  }
  catch {
    Write-DiagLog "WARN tmux capture orchestrator failed: $_"
  }

  # 4. Check ao send wrapper log for new entries
  $wrapperLog = '/tmp/ao-send-diag.log'
  if (Test-Path $wrapperLog) {
    try {
      $currentLines = (Get-Content -Path $wrapperLog -ErrorAction SilentlyContinue).Count
      if ($currentLines -gt $seenWrapperLines) {
        $newLines = Get-Content -Path $wrapperLog -Skip $seenWrapperLines -ErrorAction SilentlyContinue
        foreach ($nl in $newLines) {
          Write-DiagLog "WRAPPER: $nl"
        }
        $seenWrapperLines = $currentLines
      }
    }
    catch {}
  }

  if ($Once) { break }
  Start-Sleep -Seconds $PollSeconds
} while ($true)
