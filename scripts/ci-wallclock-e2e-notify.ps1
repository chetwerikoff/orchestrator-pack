#requires -Version 5.1
<#
.SYNOPSIS
  Operator-visible red-signal for post-merge wall-clock stage failures (Issue #694).
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$HeadSha,
    [string]$RunId = $env:GITHUB_RUN_ID,
    [string]$WorkflowUrl = $env:GITHUB_SERVER_URL + '/' + $env:GITHUB_REPOSITORY + '/actions/runs/' + $env:GITHUB_RUN_ID,
    [switch]$DryRun,
    [switch]$SimulateDeliveryFailure
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'lib/Ci-Failure-Notification-Common.ps1')

$manifestPath = Join-Path $Root 'scripts/vitest-wallclock-e2e-split.manifest.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$episodeKey = $manifest.redSignal.episodeKey -replace '\{sha\}', $HeadSha
$dedupeKey = $manifest.redSignal.dedupeKey -replace '\{sha\}', $HeadSha

$payload = @{
    schema          = 'wallclock-e2e-failure.v1'
    issue           = 694
    headSha         = $HeadSha
    runId           = $RunId
    episodeKey      = $episodeKey
    dedupeKey       = $dedupeKey
    owner           = $manifest.redSignal.owner
    deliveryTarget  = $manifest.redSignal.deliveryTarget
    workflowUrl     = $WorkflowUrl
    enumeratedMove  = $manifest.preMoveEnumeratedFiles
    triageHint      = 'Inspect vitest-wallclock-e2e workflow run for failing postMergeWallclock file; do not treat PR aggregate as wall-clock pass.'
}

if ($DryRun) {
    $payload.dryRun = $true
    Write-Host ($payload | ConvertTo-Json -Compress)
    if ($SimulateDeliveryFailure) {
        Write-Host '[FAIL] wall-clock alert delivery simulated failure (fail-closed)'
        exit 1
    }
    Write-Host '[PASS] wall-clock alert dry-run delivery payload emitted'
    exit 0
}

if ($SimulateDeliveryFailure) {
    Write-Host '[FAIL] wall-clock alert delivery failed (fail-closed; stage remains red)'
    exit 1
}

$stateDir = Get-CiFailureNotificationStateDir
$recordPath = Join-Path $stateDir "wallclock-e2e-$HeadSha.json"
$payload | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $recordPath -Encoding UTF8
Write-Host "[PASS] wall-clock failure alert recorded episode=$episodeKey path=$recordPath"
exit 0
