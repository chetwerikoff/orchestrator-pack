#requires -Version 7.0
<#
  Shared helpers for CI-failure notification reaction and reconcile scripts (Issue #342).
#>

$Script:CiFailureNotificationPackRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$Script:CiFailureNotificationWrapper = Join-Path $Script:CiFailureNotificationPackRoot 'scripts/ci-failure-notification.ps1'

function Get-CiFailureNotificationStoreDir {
    if ($StateDir) { return Join-Path $StateDir 'ci-failure-notification' }
    if ($env:AO_CI_FAILURE_NOTIFICATION_STORE) { return $env:AO_CI_FAILURE_NOTIFICATION_STORE.Trim() }
    return Join-Path ([System.IO.Path]::GetTempPath()) 'orchestrator-ci-failure-notification'
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
