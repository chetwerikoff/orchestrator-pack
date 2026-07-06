#requires -Version 5.1
<#
.SYNOPSIS
  Helpers for AO 0.10 stuck review-run reaper (Issue #624).
#>

. (Join-Path $PSScriptRoot 'Invoke-AoReviewApi.ps1')
. (Join-Path $PSScriptRoot 'MechanicalReconcileNode.ps1')

$Script:ReviewStuckRunReaperCli = Join-Path (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..' '..')).Path 'docs/review-stuck-run-reaper.mjs'

function Invoke-ReviewStuckRunReaperCli {
    param(
        [Parameter(Mandatory = $true)][string]$Subcommand,
        [hashtable]$Payload
    )
    return Invoke-MechanicalNodeFilterCli -FilterCliPath $Script:ReviewStuckRunReaperCli `
        -Subcommand $Subcommand -Payload $Payload -Label 'review-stuck-run-reaper' -JsonDepth 30
}

function Test-TmuxSessionExistsForReviewer {
    param([Parameter(Mandatory = $true)][string]$HandleId)

    if (-not (Get-Command tmux -ErrorAction SilentlyContinue)) {
        return 'unavailable'
    }
    try {
        & tmux has-session -t $HandleId 2>$null
        if ($LASTEXITCODE -eq 0) { return 'exists' }
        return 'missing'
    }
    catch {
        return 'unavailable'
    }
}

function Get-ReviewerPaneLivenessMap {
    param(
        [hashtable]$ListPayloads,
        [array]$Sessions = @()
    )

    $map = @{}
    foreach ($payload in @($ListPayloads.Values)) {
        $handle = [string]$payload.reviewerHandleId
        if (-not $handle -or $map.ContainsKey($handle)) { continue }
        $tmux = Test-TmuxSessionExistsForReviewer -HandleId $handle
        $probePayload = @{
            reviewerHandleId = $handle
            sessions         = @($Sessions)
        }
        if ($tmux) { $probePayload.tmuxExists = $tmux }
        $result = Invoke-ReviewStuckRunReaperCli -Subcommand 'probe' -Payload $probePayload
        $map[$handle] = [string]$result.paneLiveness
        if (-not $map[$handle]) { $map[$handle] = 'unknown' }
    }
    return $map
}

function Test-AoReviewFailStaleSurfaceAvailable {
    if ($env:AO_REVIEW_FAIL_STALE_SURFACE -eq 'available') { return $true }
    if ($env:AO_REVIEW_FAIL_STALE_SURFACE -eq 'absent') { return $false }
    return $false
}

function Invoke-ReviewStuckRunReaperTick {
    param(
        [string]$ProjectId = 'orchestrator-pack',
        [switch]$DryRun,
        [string]$BaseUrl = '',
        [hashtable]$HealthPayload = $null,
        [hashtable]$FixtureListPayloads = $null
    )

    $sessions = @(Get-AoStatusSessions -Project $ProjectId)
    $workerSessions = @($sessions | Where-Object {
            $role = [string]$_.role
            if ($role -and $role -ne 'worker') { return $false }
            if ($_.isTerminated -eq $true) { return $false }
            return $true
        })

    $listPayloads = @{}
    foreach ($worker in $workerSessions) {
        $sessionId = [string]$worker.id
        if (-not $sessionId) { $sessionId = [string]$worker.name }
        if (-not $sessionId) { continue }
        if ($FixtureListPayloads -and $FixtureListPayloads.ContainsKey($sessionId)) {
            $listPayloads[$sessionId] = $FixtureListPayloads[$sessionId]
            continue
        }
        try {
            $listPayloads[$sessionId] = Get-AoSessionReviewsJson -SessionId $sessionId -BaseUrl $BaseUrl -HealthPayload $HealthPayload
        }
        catch {
            continue
        }
    }

    $paneByHandle = Get-ReviewerPaneLivenessMap -ListPayloads $listPayloads -Sessions $sessions
    $failSurface = Test-AoReviewFailStaleSurfaceAvailable
    $base = $BaseUrl
    if (-not $base) {
        try { $base = Get-AoDaemonApiBaseUrl -HealthPayload $HealthPayload } catch { $base = '' }
    }

    return Invoke-ReviewStuckRunReaperCli -Subcommand 'tick' -Payload @{
        workerSessions            = @($workerSessions)
        listPayloads              = $listPayloads
        sessions                  = @($sessions)
        paneByHandle              = $paneByHandle
        config                    = @{
            ageFloorSeconds = $(if ($env:AO_REVIEW_STUCK_AGE_FLOOR_SECONDS) { [int]$env:AO_REVIEW_STUCK_AGE_FLOOR_SECONDS } else { 600 })
        }
        failStaleSurfaceAvailable = [bool]$failSurface
        dryRun                    = [bool]$DryRun
        baseUrl                   = $base
    }
}
