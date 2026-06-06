#requires -Version 5.1
<#
.SYNOPSIS
  Submit-only adapter: send Enter to an idle worker's tmux pane (Issue #216).

.DESCRIPTION
  Never composes or edits finding text — only submits the draft AO already pasted.
  Fail-closed when tmux is unavailable, session addressing is stale, or the target
  pane is missing. Does not invoke ao send, spawn, claim-pr, or session kill.
#>

$PackRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$SubmitCli = Join-Path $PackRoot 'docs/worker-input-draft-submit.mjs'

function Test-TmuxAvailable {
    try {
        $null = & tmux list-sessions -F '#{session_name}' 2>$null
        return $LASTEXITCODE -eq 0
    }
    catch {
        return $false
    }
}

function Test-TmuxSessionExists {
    param([string]$Target)

    if (-not $Target) { return $false }
    try {
        & tmux has-session -t $Target 2>$null
        return $LASTEXITCODE -eq 0
    }
    catch {
        return $false
    }
}

function Resolve-WorkerTmuxTarget {
    param([string]$SessionId)

    $needle = $SessionId.Trim()
    if (-not $needle) { return $null }
    if (Test-TmuxSessionExists -Target $needle) {
        return $needle
    }
    return $null
}

function Invoke-SubmitAdapterGateCli {
    param([hashtable]$Payload)

    $json = $Payload | ConvertTo-Json -Depth 10 -Compress
    $output = $json | & node $SubmitCli gate 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "worker-input-draft-submit.mjs gate exited ${LASTEXITCODE}: $output"
    }
    $text = ($output | ForEach-Object { $_.ToString() }) -join "`n"
    return $text | ConvertFrom-Json
}

function Invoke-TmuxSubmitEnter {
    param(
        [string]$TmuxTarget,
        [int]$MaxAttempts = 3
    )

    $attempts = [Math]::Max(1, $MaxAttempts)
    for ($i = 1; $i -le $attempts; $i++) {
        & tmux send-keys -t $TmuxTarget Enter 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) {
            return @{ ok = $true; attempts = $i }
        }
        Start-Sleep -Milliseconds 200
    }
    return @{ ok = $false; attempts = $attempts }
}

function Invoke-WorkerInputDraftSubmit {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SessionId,
        [Parameter(Mandatory = $true)]
        [string]$ExpectedSessionId,
        [string]$RunId = '',
        [int]$PrNumber = 0,
        [string]$HeadSha = '',
        [switch]$DryRun,
        [int]$EnterRetries = 3,
        [int]$TimeoutMs = 5000
    )

    $tmuxAvailable = Test-TmuxAvailable
    $tmuxTarget = Resolve-WorkerTmuxTarget -SessionId $SessionId
    $tmuxExists = [bool]$tmuxTarget

    $gate = Invoke-SubmitAdapterGateCli -Payload @{
        sessionId           = $SessionId
        expectedSessionId   = $ExpectedSessionId
        tmuxAvailable       = $tmuxAvailable
        tmuxSessionExists   = $tmuxExists
        tmuxTarget          = $tmuxTarget
    }

    if (-not $gate.ok) {
        return @{
            submitted = $false
            reason    = [string]$gate.reason
            enter     = $false
        }
    }

    if ($DryRun) {
        return @{
            submitted  = $true
            reason     = 'dry_run'
            enter      = $false
            tmuxTarget = [string]$gate.tmuxTarget
        }
    }

    $deadline = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + [Math]::Max(1000, $TimeoutMs)
    $send = Invoke-TmuxSubmitEnter -TmuxTarget $gate.tmuxTarget -MaxAttempts $EnterRetries
    if (-not $send.ok) {
        return @{
            submitted  = $false
            reason     = 'tmux_enter_failed'
            enter      = $true
            tmuxTarget = [string]$gate.tmuxTarget
        }
    }

    while ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt $deadline) {
        # Submit-only: no pane scraping for verification; Enter dispatch is best-effort.
        return @{
            submitted  = $true
            reason     = 'enter_sent'
            enter      = $true
            tmuxTarget = [string]$gate.tmuxTarget
            attempts   = [int]$send.attempts
        }
    }

    return @{
        submitted  = $false
        reason     = 'submit_timeout'
        enter      = $true
        tmuxTarget = [string]$gate.tmuxTarget
    }
}
