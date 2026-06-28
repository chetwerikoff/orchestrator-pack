#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Watches for worker tmux sessions and sets up lossless pipe-pane logging
  for each one. Each worker gets its own log: /tmp/ci-pane-<session>.log
#>

param(
  [string]$LogDir = '/tmp',
  [int]$PollSeconds = 10
)

$ErrorActionPreference = 'Stop'

$scriptName = 'diag-worker-pipe-watcher'

function Write-WatcherLog {
  param([string]$Message)
  $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss.fff')
  Write-Host "[$stamp] ${scriptName}: $Message"
}

Write-WatcherLog "started (poll=${PollSeconds}s, logDir=${LogDir})"
Write-WatcherLog ""

do {
  # 1. Get all tracked sessions from AO status (worker + orchestrator)
  try {
    # Redirect stderr to null to avoid ErrorRecord mixing with JSON stdout
    $jsonText = ao status --json 2>($null) | Out-String
    if (-not $jsonText -or $jsonText.Trim().Length -eq 0) { throw 'Empty ao status output' }
    $statusObj = $jsonText | ConvertFrom-Json
    $allSessions = @($statusObj.data | Where-Object { ($_.name) -ne '' })
  }
  catch {
    Write-WatcherLog "WARN ao status failed: $_"
    Start-Sleep -Seconds $PollSeconds
    continue
  }

  foreach ($session in $allSessions) {
    $sessionId = $session.name
    $logFile = Join-Path $LogDir "ci-pane-$sessionId.log"

    # 2. Check if tmux session exists for this worker
    tmux has-session -t $sessionId 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
      Write-WatcherLog "tmux session $sessionId not found (respawn or stale AO entry)"
      continue
    }

    # 3. Check current pipe status (pane_pipe: 0=none, 1=active)
    $panePipe = ''
    try {
      $panePipe = tmux list-panes -t $sessionId -F '#{pane_pipe}' 2>&1 | Select-Object -First 1
    }
    catch {
      Write-WatcherLog "WARN tmux list-panes failed for ${sessionId}: $_"
      continue
    }

    if ($panePipe -eq '') {
      continue
    }

    # 4. If no pipe active, start one
    if ($panePipe -eq '0') {
      # Ensure log file exists
      if (-not (Test-Path -LiteralPath $logFile -PathType Leaf)) {
        $null = New-Item -Path $logFile -ItemType File -Force
      }

      try {
        tmux pipe-pane -t $sessionId "stdbuf -oL cat >> $logFile" 2>&1 | Out-Null
        Write-WatcherLog "pipe-pane started for $sessionId -> $logFile"
      }
      catch {
        Write-WatcherLog "WARN pipe-pane failed for ${sessionId}: $_"
      }
    }
  }

  Start-Sleep -Seconds $PollSeconds
} while ($true)
