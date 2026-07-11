#requires -Version 5.1
<#
.SYNOPSIS
  Retired heartbeat entrypoint.

.DESCRIPTION
  Issue #721 retires the wake/heartbeat FYI channel. The wake supervisor no longer
  registers this child and orchestrator-facing liveness is escalation-router only.
#>
[CmdletBinding()]
param(
    [string]$OrchestratorSessionId = '',
    [int]$IntervalMinutes = 0,
    [int]$DedupWindowSeconds = 30,
    [int]$PollSeconds = 60,
    [switch]$DryRun,
    [switch]$Once
)

$ErrorActionPreference = 'Stop'
$message = 'orchestrator-wake-heartbeat is retired by Issue #721; use orchestrator-escalation-router for orchestrator liveness and escalation delivery.'
Write-Host $message
exit 1
