#requires -Version 5.1
<#
.SYNOPSIS
  Pack-derived worker-status decision reader (Issue #720).
#>

function New-WorkerStatusDecisionUnknownRows {
    param(
        [object[]]$Sessions,
        [string]$Reason
    )

    return @($Sessions | ForEach-Object {
            $row = [ordered]@{}
            foreach ($prop in $_.PSObject.Properties) {
                $row[$prop.Name] = $prop.Value
            }
            $row['status'] = 'unknown'
            $row['workerStatus'] = 'unknown'
            $row['workerStatusDerived'] = 'unknown'
            $row['workerStatusSource'] = $Script:PackWorkerStatusStoreSurface
            $row['workerStatusWinningSource'] = 'degraded'
            $row['workerStatusStale'] = $true
            $row['workerStatusDegradedReason'] = $Reason
            $row['degradedReason'] = $Reason
            $row['workerStatusDiagnostics'] = @($Reason)
            if (-not $row['reports']) { $row['reports'] = @() }
            [pscustomobject]$row
        })
}

function Get-WorkerStatusDecisionSessionsCore {
    param(
        [string]$Project = '',
        [string]$RepoSlug = '',
        $WorkerListPayload = $null,
        $OrchestratorListPayload = $null,
        $ReportFullPayload = $null,
        [string]$AoCommand = 'ao',
        [switch]$IncludeTerminated,
        [long]$RepoTickGeneration = 0
    )

    if ($ReportFullPayload) {
        $sessions = if ($IncludeTerminated) {
            @(Get-AoStatusSessionsWithReportsIncludingTerminated -ReportFullPayload $ReportFullPayload)
        }
        else {
            @(Get-AoStatusSessionsWithReports -ReportFullPayload $ReportFullPayload)
        }
        if (Test-WorkerStatusKillSwitchActive) {
            return @(New-WorkerStatusDecisionUnknownRows -Sessions $sessions -Reason 'kill_switch_active')
        }
        $readiness = Test-WorkerStatusSiblingReadiness
        if (-not $readiness.ok) {
            return @(New-WorkerStatusDecisionUnknownRows -Sessions $sessions -Reason 'sibling_not_ready')
        }
        return @(Merge-AoSessionRowsWithWorkerStatusStore -Sessions $sessions `
                -RepoTickGeneration $RepoTickGeneration)
    }

    $sessions = if ($IncludeTerminated) {
        @(Get-AoStatusSessionsIncludingTerminated -Project $Project `
                -WorkerListPayload $WorkerListPayload -OrchestratorListPayload $OrchestratorListPayload `
                -AoCommand $AoCommand)
    }
    else {
        @(Get-AoStatusSessions -Project $Project `
                -WorkerListPayload $WorkerListPayload -OrchestratorListPayload $OrchestratorListPayload `
                -AoCommand $AoCommand)
    }
    $resolvedRepoSlug = Resolve-WorkerReportStoreRepoSlug -RepoSlug $RepoSlug
    $sessions = @(Merge-AoSessionRowsWithWorkerReportStore -Sessions $sessions -RepoSlug $resolvedRepoSlug)

    if (Test-WorkerStatusKillSwitchActive) {
        return @(New-WorkerStatusDecisionUnknownRows -Sessions $sessions -Reason 'kill_switch_active')
    }
    $readiness = Test-WorkerStatusSiblingReadiness
    if (-not $readiness.ok) {
        return @(New-WorkerStatusDecisionUnknownRows -Sessions $sessions -Reason 'sibling_not_ready')
    }

    $githubSnapshot = $null
    try {
        $githubSnapshot = Get-WorkerStatusRecomputeGithubSnapshot -Project $Project -Sessions $sessions
    }
    catch {
        $githubSnapshot = New-WorkerStatusEmptyGithubSnapshot
    }

    . (Join-Path $PSScriptRoot 'Get-WorkerOsLiveness.ps1')
    $osLivenessMap = Get-WorkerOsLivenessMap -Sessions $sessions

    foreach ($session in $sessions) {
        $sessionId = [string]$(
            if ($session.id) { $session.id }
            elseif ($session.name) { $session.name }
            else { $session.sessionId }
        )
        if (-not $sessionId) { continue }
        try {
            Write-WorkerStatusRow -Input @{
                session                = $session
                reports                = @($session.reports)
                repoSlug               = $resolvedRepoSlug
                githubSnapshot         = $githubSnapshot
                osLiveness             = if ($osLivenessMap.ContainsKey($sessionId)) { $osLivenessMap[$sessionId] } else { $null }
                writerGenerationVector = @{
                    writerSessionId        = $sessionId
                    reportStoreGeneration  = 0
                    repoTickGeneration     = $RepoTickGeneration
                    journalCursor          = 0
                    bindingCacheGeneration = 0
                }
            } | Out-Null
        }
        catch {
            continue
        }
    }

    try {
        Invoke-WorkerStatusStoreEviction -Sessions $sessions | Out-Null
    }
    catch {
        # eviction is best-effort; decision reads must still proceed
    }

    return @(Merge-AoSessionRowsWithWorkerStatusStore -Sessions $sessions -RepoTickGeneration $RepoTickGeneration)
}

function Get-WorkerStatusDecisionSessions {
    param(
        [string]$Project = '',
        [string]$RepoSlug = '',
        $WorkerListPayload = $null,
        $OrchestratorListPayload = $null,
        $ReportFullPayload = $null,
        [string]$AoCommand = 'ao',
        [long]$RepoTickGeneration = 0
    )

    return @(Get-WorkerStatusDecisionSessionsCore -Project $Project -RepoSlug $RepoSlug `
            -WorkerListPayload $WorkerListPayload -OrchestratorListPayload $OrchestratorListPayload `
            -ReportFullPayload $ReportFullPayload -AoCommand $AoCommand `
            -RepoTickGeneration $RepoTickGeneration)
}

function Get-WorkerStatusDecisionSessionsIncludingTerminated {
    param(
        [string]$Project = '',
        [string]$RepoSlug = '',
        $WorkerListPayload = $null,
        $OrchestratorListPayload = $null,
        $ReportFullPayload = $null,
        [string]$AoCommand = 'ao',
        [long]$RepoTickGeneration = 0
    )

    return @(Get-WorkerStatusDecisionSessionsCore -Project $Project -RepoSlug $RepoSlug `
            -WorkerListPayload $WorkerListPayload -OrchestratorListPayload $OrchestratorListPayload `
            -ReportFullPayload $ReportFullPayload -AoCommand $AoCommand -IncludeTerminated `
            -RepoTickGeneration $RepoTickGeneration)
}

function Assert-WorkerStatusDecisionReadAllowed {
    param(
        [string]$ScriptPath,
        [string]$RawText = ''
    )

    $text = $RawText
    if (-not $text -and $ScriptPath -and (Test-Path -LiteralPath $ScriptPath -PathType Leaf)) {
        $text = Get-Content -LiteralPath $ScriptPath -Raw
    }
    if ($text -match 'Get-AoStatusSessionsWithReports') {
        throw 'worker status decision reads must use Get-WorkerStatusDecisionSessions* instead of Get-AoStatusSessionsWithReports*'
    }
    return $true
}
