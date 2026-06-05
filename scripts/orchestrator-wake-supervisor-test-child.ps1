#requires -Version 5.1
<#
  Test-only stub child for orchestrator-wake-supervisor (Issue #168 fixtures).
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet('listener', 'heartbeat', 'review-send-reconcile')]
    [string]$Role,

    [string]$OrchestratorSessionId = '',
    [string]$MarkerDir = ''
)

$ErrorActionPreference = 'Stop'

$sessionId = if ($OrchestratorSessionId) {
    $OrchestratorSessionId.Trim()
}
elseif ($env:AO_ORCHESTRATOR_SESSION_ID) {
    $env:AO_ORCHESTRATOR_SESSION_ID.Trim()
}
else {
    'unknown'
}

$dir = if ($MarkerDir) {
    $MarkerDir
}
elseif ($env:AO_WAKE_SUPERVISOR_TEST_MARKER_DIR) {
    $env:AO_WAKE_SUPERVISOR_TEST_MARKER_DIR
}
else {
    throw 'MarkerDir or AO_WAKE_SUPERVISOR_TEST_MARKER_DIR required for test child'
}

if (-not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
}

$markerPath = Join-Path $dir "$Role.marker.json"
$markerTemp = "${markerPath}.tmp"
@{
    role                  = $Role
    pid                   = $PID
    orchestratorSessionId = $sessionId
    startedAt             = (Get-Date).ToString('o')
} | ConvertTo-Json -Compress | Set-Content -LiteralPath $markerTemp -Encoding utf8 -NoNewline
Move-Item -LiteralPath $markerTemp -Destination $markerPath -Force

while ($true) {
  Start-Sleep -Seconds 1
}
