#requires -Version 7.0
<#
.SYNOPSIS
  Executable ci-failed reaction record hook (Issue #342).

.DESCRIPTION
  Records pending CI-failure episodes when required CI is red for an open worker PR.
  Side-process supervisor runs this script; it is the machine-checkable record callsite
  for reactions.ci-failed enqueue-only delivery (not orchestratorRules prose).
#>
[CmdletBinding()]
param(
    [string]$ProjectId = 'orchestrator-pack',
    [string]$RepoRoot = '',
    [string]$StateDir = '',
    [int]$IntervalMinutes = 1,
    [switch]$Once,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$Script:ReactionLogPrefix = 'ci-failure-notification-reaction'

$PackRoot = Split-Path -Parent $PSScriptRoot
if (-not $RepoRoot) { $RepoRoot = $PackRoot }

. (Join-Path $PSScriptRoot 'lib/Ci-Failure-Notification-Common.ps1')
. (Join-Path $PSScriptRoot 'lib/Invoke-AoCliJson.ps1')
. (Join-Path $PSScriptRoot 'lib/Gh-PrChecks.ps1')
. (Join-Path $PSScriptRoot 'lib/Get-ReconcileChecksByPr.ps1')
. (Join-Path $PSScriptRoot 'lib/Orchestrator-SideProcessProgress.ps1')
function Invoke-CiFailureReactionRecordTick {
    param(
        [string]$StoreDir,
        [string]$EnqueueTickId
    )

    $repo = Get-RepoIdentity
    $openPrs = ConvertTo-GhOpenPrArray -OpenPrs (Invoke-GhOpenPrList -RepoRoot $RepoRoot)
    $sessions = @(Get-AoStatusSessions)
    $sessionDetailsById = Build-AoSessionDetailsById -Sessions $sessions -Project $ProjectId
    $checksBundle = Get-ReconcileChecksByPr -RepoRoot $RepoRoot -OpenPrs $openPrs
    $plan = Invoke-CiFailureHelper -Mode 'reaction-record-plan' -Payload @{
        storeDir                      = $StoreDir
        repo                          = $repo
        openPrs                       = $openPrs
        sessions                      = $sessions
        sessionDetailsById            = $sessionDetailsById
        ciChecksByPr                  = $checksBundle.ciChecksByPr
        requiredCheckNamesByPr        = $checksBundle.requiredCheckNamesByPr
        requiredCheckLookupFailedByPr = $checksBundle.requiredCheckLookupFailedByPr
    }

    foreach ($row in @($plan.records)) {
        $episode = $row.episode
        if (-not $episode) { continue }
        if ($DryRun) {
            Write-CiFailureNotificationLog -Prefix $Script:ReactionLogPrefix -Message "dry-run would record PR #$($episode.prNumber) head=$($episode.headSha)"
            continue
        }
        $result = Invoke-CiFailureHelper -Mode 'record' -Payload @{
            storeDir      = $StoreDir
            episode       = $episode
            enqueueTickId = $EnqueueTickId
            nowMs         = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        }
        if ($result.recorded) {
            Write-CiFailureNotificationLog -Prefix $Script:ReactionLogPrefix -Message "recorded pending episode PR #$($episode.prNumber) digest=$($result.digest)"
        }
    }
}

$storeDir = Get-CiFailureNotificationStoreDir -ProjectIdOverride $ProjectId
if (-not (Test-Path -LiteralPath $storeDir)) {
    New-Item -ItemType Directory -Path $storeDir -Force | Out-Null
}

do {
    try {
        Write-OrchestratorSideProcessProgress -ChildId 'ci-failure-notification-reaction' -Phase 'poll'
        $tickId = "reaction-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
        Invoke-CiFailureReactionRecordTick -StoreDir $storeDir -EnqueueTickId $tickId
        Write-OrchestratorSideProcessTickSuccess -ChildId 'ci-failure-notification-reaction'
    }
    catch {
        Write-OrchestratorSideProcessTickError -ChildId 'ci-failure-notification-reaction' -ErrorMessage "$_"
        if ($Once) { exit 1 }
    }
    if ($Once) { break }
    Start-Sleep -Seconds ([Math]::Max(30, $IntervalMinutes * 60))
} while ($true)
