#requires -Version 7.0
<#
  Shared helpers for CI-failure notification reaction and reconcile scripts (Issue #342).
#>

$Script:CiFailureNotificationPackRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$Script:CiFailureNotificationWrapper = Join-Path $Script:CiFailureNotificationPackRoot 'scripts/ci-failure-notification.ps1'

function Write-CiFailureNotificationLog {
    param(
        [string]$Prefix,
        [string]$Message
    )

    $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    Write-Host "[$stamp] ${Prefix}: $Message"
}

function Get-CiFailureNotificationStoreDir {
    param(
        [string]$ProjectIdOverride = ''
    )

    if ($StateDir) { return Join-Path $StateDir 'ci-failure-notification' }
    if ($env:AO_CI_FAILURE_NOTIFICATION_STORE) { return $env:AO_CI_FAILURE_NOTIFICATION_STORE.Trim() }

    $resolvedProjectId = if ($ProjectIdOverride) {
        $ProjectIdOverride
    }
    elseif ($ProjectId) {
        [string]$ProjectId
    }
    else {
        'orchestrator-pack'
    }
    $safeProject = ($resolvedProjectId -replace '[^\w\-.]', '_').Trim('_')
    if (-not $safeProject) { $safeProject = 'orchestrator-pack' }
    return Join-Path (Join-Path ([System.IO.Path]::GetTempPath()) 'orchestrator-ci-failure-notification') $safeProject
}

function Invoke-CiFailureHelper {
    param(
        [string]$Mode,
        [hashtable]$Payload
    )

    $json = $Payload | ConvertTo-Json -Compress -Depth 30
    $output = $json | pwsh -NoProfile -ExecutionPolicy Bypass -File $Script:CiFailureNotificationWrapper -Mode $Mode 2>&1
    if ($LASTEXITCODE -ne 0) { throw "ci-failure-notification.ps1 -Mode $Mode exited $LASTEXITCODE`: $output" }
    return ($output | Out-String).Trim() | ConvertFrom-Json
}
