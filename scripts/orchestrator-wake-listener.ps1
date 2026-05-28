#requires -Version 5.1
<#
.SYNOPSIS
  Local loopback HTTP listener: AO webhook POST -> ao send orchestrator wake nudge.

.DESCRIPTION
  Accepts POSTs from AO's built-in webhook notifier (urgent/action routed events),
  filters to wake-relevant kinds, deduplicates within a short window, and runs
  `ao send <orchestrator-session-id> <message>` unless -DryRun is set.

  Defaults: port 17487, path /ao-wake, dedup window 30s.
  See docs/orchestrator-wake-runbook.md.
#>
[CmdletBinding()]
param(
    [int]$Port = 0,
    [string]$OrchestratorSessionId = '',
    [string]$Path = '/ao-wake',
    [int]$DedupWindowSeconds = 30,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$Script:DefaultPort = 17487
$Script:RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Script:FilterCli = Join-Path $Script:RepoRoot 'docs/orchestrator-wake-filter.mjs'

function Get-ListenerPort {
    if ($Port -gt 0) { return $Port }
    $envPort = $env:AO_WAKE_LISTENER_PORT
    if ($envPort -and [int]::TryParse($envPort, [ref]$null)) {
        return [int]$envPort
    }
    return $Script:DefaultPort
}

function Get-OrchestratorSessionId {
    param([string]$CliValue)
    if ($CliValue) { return $CliValue.Trim() }
    $fromEnv = $env:AO_ORCHESTRATOR_SESSION_ID
    if ($fromEnv) { return $fromEnv.Trim() }
    throw 'Orchestrator session id required: -OrchestratorSessionId or AO_ORCHESTRATOR_SESSION_ID'
}

function Write-ListenerLog {
    param([string]$Message)
    $ts = (Get-Date).ToString('o')
    Write-Host "[$ts] $Message"
}

function Invoke-WakeFilter {
    param([string]$BodyJson)

    Push-Location $Script:RepoRoot
    try {
        $output = $BodyJson | node $Script:FilterCli evaluate 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "wake filter exited $LASTEXITCODE: $output"
        }
        return ($output | Out-String).Trim() | ConvertFrom-Json
    }
    finally {
        Pop-Location
    }
}

function Test-LoopbackRemoteEndPoint {
    param($Request)

    $remote = $Request.RemoteEndPoint
    if (-not $remote) { return $false }
    $addr = $remote.Address
    if ($addr.IsIPv4MappedToIPv6) {
        $addr = $addr.MapToIPv4()
    }
    if ([System.Net.IPAddress]::IsLoopback($addr)) { return $true }
    if ($addr.ToString() -eq '127.0.0.1') { return $true }
    return $false
}

function Send-WakeMessage {
    param(
        [string]$OrchestratorId,
        [string]$Message
    )

    if ($DryRun) {
        Write-ListenerLog "dry-run: ao send $OrchestratorId $Message"
        return
    }

    & ao send $OrchestratorId $Message
    if ($LASTEXITCODE -ne 0) {
        throw "ao send failed with exit code $LASTEXITCODE"
    }
    Write-ListenerLog "forwarded: ao send $OrchestratorId"
}

$listenerPort = Get-ListenerPort
$orchestratorId = Get-OrchestratorSessionId -CliValue $OrchestratorSessionId
$normalizedPath = if ($Path.StartsWith('/')) { $Path } else { "/$Path" }
$prefix = "http://127.0.0.1:${listenerPort}/"
$dedupWindowMs = [Math]::Max(1, $DedupWindowSeconds) * 1000
$recentWakes = @{}
$lastAcceptedAt = $null
$quietCheckSeconds = 300

Write-ListenerLog "orchestrator-wake-listener starting on $prefix (path $normalizedPath, orchestrator=$orchestratorId, dedup=${DedupWindowSeconds}s, dryRun=$DryRun)"

$httpListener = New-Object System.Net.HttpListener
$httpListener.Prefixes.Add($prefix)

try {
    $httpListener.Start()
}
catch {
    throw "Failed to bind $prefix : $_"
}

Write-ListenerLog "listening (loopback only via 127.0.0.1 prefix)"

$cancelled = $false
$onCancel = [ConsoleCancelEventHandler]{
    param($sender, $eventArgs)
    $script:cancelled = $true
    $eventArgs.Cancel = $true
}
[Console]::add_CancelKeyPress($onCancel)

try {
    while (-not $cancelled) {
        if ($httpListener.IsListening) {
            $async = $httpListener.BeginGetContext($null, $null)
            while (-not $async.IsCompleted) {
                if ($cancelled) { break }
                Start-Sleep -Milliseconds 100
                if ($lastAcceptedAt -and ((Get-Date) - $lastAcceptedAt).TotalSeconds -ge $quietCheckSeconds) {
                    Write-ListenerLog "quiet-period: no accepted wake events in ${quietCheckSeconds}s (AO may not be POSTing)"
                    $lastAcceptedAt = Get-Date
                }
            }
            if ($cancelled) { break }

            $context = $httpListener.EndGetContext($async)
            $request = $context.Request
            $response = $context.Response

            try {
                if (-not (Test-LoopbackRemoteEndPoint -Request $request)) {
                    Write-ListenerLog "rejected non-loopback connection from $($request.RemoteEndPoint)"
                    $response.StatusCode = 403
                    $response.Close()
                    continue
                }

                $reqPath = $request.Url.AbsolutePath
                if ($request.HttpMethod -ne 'POST' -or $reqPath -ne $normalizedPath) {
                    $response.StatusCode = 404
                    $response.Close()
                    continue
                }

                $reader = New-Object System.IO.StreamReader($request.InputStream, $request.ContentEncoding)
                $body = $reader.ReadToEnd()
                $reader.Close()

                $filterResult = Invoke-WakeFilter -BodyJson $body

                if (-not $filterResult.ok) {
                    $reason = $filterResult.reason
                    $detail = $filterResult.detail
                    if ($reason -eq 'missing_session_id') {
                        Write-ListenerLog 'rejected: missing session id in payload'
                    }
                    elseif ($reason -eq 'malformed_payload') {
                        Write-ListenerLog "rejected: malformed payload ($detail)"
                    }
                    else {
                        Write-ListenerLog "dropped: $reason$(if ($detail) { " ($detail)" })"
                    }
                    $response.StatusCode = 204
                    $response.Close()
                    continue
                }

                $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
                $cutoff = $now - $dedupWindowMs
                $pruneKeys = @($recentWakes.Keys | Where-Object { $recentWakes[$_] -lt $cutoff })
                foreach ($key in $pruneKeys) {
                    $recentWakes.Remove($key) | Out-Null
                }

                if ($recentWakes.ContainsKey($filterResult.dedupeKey)) {
                    Write-ListenerLog "deduped: $($filterResult.wakeKind) $($filterResult.sessionId)"
                    $response.StatusCode = 204
                    $response.Close()
                    continue
                }

                $recentWakes[$filterResult.dedupeKey] = $now
                Send-WakeMessage -OrchestratorId $orchestratorId -Message $filterResult.wakeMessage
                $lastAcceptedAt = Get-Date
                Write-ListenerLog "accepted: $($filterResult.wakeKind) worker=$($filterResult.sessionId)"
                $response.StatusCode = 204
                $response.Close()
            }
            catch {
                Write-ListenerLog "error handling request: $_"
                try {
                    $response.StatusCode = 500
                    $response.Close()
                }
                catch {
                    # ignore close failures
                }
            }
        }
    }
}
finally {
    [Console]::remove_CancelKeyPress($onCancel)
    if ($httpListener.IsListening) {
        $httpListener.Stop()
    }
    $httpListener.Close()
    Write-ListenerLog 'stopped'
}
