#requires -Version 5.1
<#
  Test-only stub child for orchestrator side-process supervisor (Issues #168, #205 fixtures).
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$Role,

    [string]$OrchestratorSessionId = '',
    [string]$ProjectId = '',
    [string]$MarkerDir = '',
    [ValidateSet('normal', 'hang', 'slow-side-effect', 'tick-error')]
    [string]$Mode = 'normal'
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'lib/Orchestrator-SideProcessProgress.ps1')
. (Join-Path $PSScriptRoot 'lib/Orchestrator-SideEffectFence.ps1')

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

$projectId = if ($ProjectId) {
    $ProjectId.Trim()
}
elseif ($env:AO_WAKE_SUPERVISOR_PROJECT_ID) {
    $env:AO_WAKE_SUPERVISOR_PROJECT_ID.Trim()
}
else {
    ''
}

$markerPath = Join-Path $dir "$Role.marker.json"
$markerTemp = "${markerPath}.tmp"
$marker = @{
    role                  = $Role
    pid                   = $PID
    orchestratorSessionId = $sessionId
    mode                  = $Mode
    startedAt             = (Get-Date).ToString('o')
}
if ($projectId) {
    $marker.projectId = $projectId
}
$marker | ConvertTo-Json -Compress | Set-Content -LiteralPath $markerTemp -Encoding utf8 -NoNewline
Move-Item -LiteralPath $markerTemp -Destination $markerPath -Force

Write-OrchestratorSideProcessProgress -ChildId $Role -Phase 'started'

while ($true) {
    if ($Mode -eq 'hang') {
        Start-Sleep -Seconds 1
        continue
    }

    if ($Mode -eq 'slow-side-effect') {
        $lockPath = Get-OrchestratorSideEffectLockPath -LockFileName 'test-side-effect.lock'
        Write-OrchestratorSideProcessProgress -ChildId $Role -Phase 'side_effect'
        Invoke-OrchestratorSideEffectFenced -LockPath $lockPath -Action {
            Start-Sleep -Seconds 8
        } | Out-Null
    }

    if ($Mode -eq 'tick-error') {
        Write-OrchestratorSideProcessTickError -ChildId $Role -ErrorMessage 'synthetic sustained tick failure'
        Start-Sleep -Seconds 1
        continue
    }

    Write-OrchestratorSideProcessProgress -ChildId $Role -Phase 'idle'
    Start-Sleep -Seconds 1
}
