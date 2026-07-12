#requires -Version 5.1
<#
.SYNOPSIS
  Pack-derived worker-status refresh and decision reader (Issues #720, #748).
#>

$Script:WorkerStatusRefreshDetailLimit = 8
$Script:WorkerStatusRefreshWriteMaxAttempts = 40
$Script:WorkerStatusRefreshWriteRetryDelayMs = 25
$Script:WorkerStatusRefreshReasonAllowlist = @(
    'binding_miss',
    'eviction_exception',
    'kill_switch_active',
    'missing_input',
    'missing_session_id',
    'monotonic_refused',
    'no_live_sessions',
    'session_pr_binding_resolver_missing',
    'sibling_not_ready',
    'stale_generation',
    'worker_report_store_missing',
    'write_exception',
    'write_rejected'
)

function ConvertTo-WorkerStatusRefreshSafeToken {
    param(
        [string]$Value,
        [string]$Fallback = 'unknown'
    )

    $token = [string]$Value
    if ([string]::IsNullOrWhiteSpace($token)) {
        $token = $Fallback
    }
    $token = $token.Trim() -replace '[^A-Za-z0-9_.:-]', '_'
    if ($token.Length -gt 96) {
        $token = $token.Substring(0, 96)
    }
    return $token
}

function Resolve-WorkerStatusRefreshReasonCode {
    param(
        [string]$Reason,
        [string]$Fallback = 'write_rejected'
    )

    $candidate = ConvertTo-WorkerStatusRefreshSafeToken -Value $Reason -Fallback $Fallback
    if ($Script:WorkerStatusRefreshReasonAllowlist -contains $candidate) {
        return $candidate
    }
    return $Fallback
}

function Get-WorkerStatusRefreshSourceSessions {
    param(
        [string]$Project = '',
        [string]$RepoSlug = '',
        $WorkerListPayload = $null,
        $OrchestratorListPayload = $null,
        $ReportFullPayload = $null,
        [string]$AoCommand = 'ao',
        [switch]$IncludeTerminated
    )

    if ($ReportFullPayload) {
        if ($IncludeTerminated) {
            return @(Get-AoStatusSessionsWithReportsIncludingTerminated -ReportFullPayload $ReportFullPayload)
        }
        return @(Get-AoStatusSessionsWithReports -ReportFullPayload $ReportFullPayload)
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
    return @(Merge-AoSessionRowsWithWorkerReportStore -Sessions $sessions -RepoSlug $resolvedRepoSlug)
}

function New-WorkerStatusRefreshDiagnostic {
    param(
        [string]$Owner,
        [int]$SessionCount,
        [long]$NowMs
    )

    return @{
        schemaVersion       = 'worker-status-refresh-diagnostic/v1'
        owner               = ConvertTo-WorkerStatusRefreshSafeToken -Value $Owner -Fallback 'unspecified'
        observedAtMs        = $NowMs
        outcome             = 'pending'
        reasonCode          = ''
        sessionCount        = $SessionCount
        writeAttemptCount   = 0
        writeRetryCount     = 0
        successCount        = 0
        gateClosedCount     = 0
        skippedCount        = 0
        exceptionCount      = 0
        failureCount        = 0
        evictionRemoved     = 0
        evictionFailed      = $false
        githubDegraded      = $false
        details             = @()
    }
}

function Add-WorkerStatusRefreshDiagnosticDetail {
    param(
        [System.Collections.IDictionary]$Diagnostic,
        [string]$SessionId,
        [string]$ReasonCode
    )

    if (@($Diagnostic.details).Count -ge $Script:WorkerStatusRefreshDetailLimit) {
        return
    }
    $Diagnostic.details = @($Diagnostic.details) + @(
        @{
            sessionId  = ConvertTo-WorkerStatusRefreshSafeToken -Value $SessionId -Fallback 'unknown_session'
            reasonCode = Resolve-WorkerStatusRefreshReasonCode -Reason $ReasonCode
        }
    )
}

function Format-WorkerStatusRefreshDiagnostic {
    param($Diagnostic)

    if (-not $Diagnostic) {
        return 'worker-status-refresh: outcome=missing_diagnostic'
    }
    $details = @($Diagnostic.details | ForEach-Object {
            '{0}:{1}' -f `
                (ConvertTo-WorkerStatusRefreshSafeToken -Value ([string]$_.sessionId) -Fallback 'unknown_session'), `
                (Resolve-WorkerStatusRefreshReasonCode -Reason ([string]$_.reasonCode))
        })
    $detailText = if ($details.Count -gt 0) { $details -join ',' } else { 'none' }
    $reasonToken = ConvertTo-WorkerStatusRefreshSafeToken -Value ([string]$Diagnostic.reasonCode) -Fallback 'none'
    return ('worker-status-refresh: owner={0} outcome={1} reason={2} sessions={3} attempted={4} retries={5} success={6} gateClosed={7} skipped={8} exceptions={9} failures={10} evictionRemoved={11} evictionFailed={12} githubDegraded={13} details={14}' -f `
            (ConvertTo-WorkerStatusRefreshSafeToken -Value ([string]$Diagnostic.owner) -Fallback 'unspecified'), `
            (ConvertTo-WorkerStatusRefreshSafeToken -Value ([string]$Diagnostic.outcome) -Fallback 'unknown'), `
            $reasonToken, `
            [int]$Diagnostic.sessionCount, [int]$Diagnostic.writeAttemptCount, [int]$Diagnostic.writeRetryCount, `
            [int]$Diagnostic.successCount, [int]$Diagnostic.gateClosedCount, [int]$Diagnostic.skippedCount, `
            [int]$Diagnostic.exceptionCount, [int]$Diagnostic.failureCount, [int]$Diagnostic.evictionRemoved, `
            [bool]$Diagnostic.evictionFailed, [bool]$Diagnostic.githubDegraded, $detailText)
}

function Get-WorkerStatusRefreshSessionId {
    param($Session)

    if ($Session.id) { return [string]$Session.id }
    if ($Session.name) { return [string]$Session.name }
    return [string]$Session.sessionId
}

function Get-WorkerStatusRefreshOsLiveness {
    param(
        $OsLivenessMap,
        [string]$SessionId
    )

    if ($OsLivenessMap -is [System.Collections.IDictionary]) {
        if ($OsLivenessMap.Contains($SessionId)) {
            return $OsLivenessMap[$SessionId]
        }
        return $null
    }
    if ($OsLivenessMap) {
        $property = $OsLivenessMap.PSObject.Properties[$SessionId]
        if ($property) { return $property.Value }
    }
    return $null
}

function Invoke-WorkerStatusRefreshRowWrite {
    param(
        [hashtable]$WriteInput,
        [string]$StorePath,
        [long]$NowMs
    )

    $retryCount = 0
    for ($attempt = 1; $attempt -le $Script:WorkerStatusRefreshWriteMaxAttempts; $attempt++) {
        try {
            $result = Write-WorkerStatusRow -WriteInput $WriteInput -StorePath $StorePath -NowMs $NowMs
        }
        catch {
            return @{
                result     = $null
                retryCount = $retryCount
                exception  = $true
            }
        }
        if ($result) {
            return @{
                result     = $result
                retryCount = $retryCount
                exception  = $false
            }
        }
        if ($attempt -lt $Script:WorkerStatusRefreshWriteMaxAttempts) {
            $retryCount++
            Start-Sleep -Milliseconds $Script:WorkerStatusRefreshWriteRetryDelayMs
        }
    }
    return @{
        result     = $null
        retryCount = $retryCount
        exception  = $false
    }
}

function Invoke-WorkerStatusRefresh {
    param(
        [string]$Project = '',
        [string]$RepoSlug = '',
        $WorkerListPayload = $null,
        $OrchestratorListPayload = $null,
        $ReportFullPayload = $null,
        [string]$AoCommand = 'ao',
        [switch]$IncludeTerminated,
        [object[]]$Sessions = $null,
        $GithubSnapshot = $null,
        [long]$RepoTickGeneration = 0,
        [string]$StorePath = '',
        [long]$NowMs = 0,
        [string]$Owner = 'unspecified'
    )

    if (-not $NowMs) {
        $NowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }
    $sourceSessions = if ($null -ne $Sessions) {
        @($Sessions)
    }
    else {
        @(Get-WorkerStatusRefreshSourceSessions -Project $Project -RepoSlug $RepoSlug `
                -WorkerListPayload $WorkerListPayload -OrchestratorListPayload $OrchestratorListPayload `
                -ReportFullPayload $ReportFullPayload -AoCommand $AoCommand -IncludeTerminated:$IncludeTerminated)
    }
    $diagnostic = New-WorkerStatusRefreshDiagnostic -Owner $Owner -SessionCount (@($sourceSessions).Count) -NowMs $NowMs

    if (Test-WorkerStatusKillSwitchActive) {
        $diagnostic.outcome = 'gate_closed'
        $diagnostic.reasonCode = 'kill_switch_active'
        $diagnostic.gateClosedCount = @($sourceSessions).Count
        foreach ($session in @($sourceSessions)) {
            Add-WorkerStatusRefreshDiagnosticDetail -Diagnostic $diagnostic `
                -SessionId (Get-WorkerStatusRefreshSessionId -Session $session) -ReasonCode 'kill_switch_active'
        }
        $Script:LastWorkerStatusRefreshDiagnostic = $diagnostic
        return $diagnostic
    }

    $readiness = Test-WorkerStatusSiblingReadiness
    if (-not $readiness.ok) {
        $reasonCode = 'sibling_not_ready'
        if ($null -ne $readiness.workerReportStorePresent -and -not [bool]$readiness.workerReportStorePresent) {
            $reasonCode = 'worker_report_store_missing'
        }
        elseif ($null -ne $readiness.sessionPrBindingResolverPresent -and -not [bool]$readiness.sessionPrBindingResolverPresent) {
            $reasonCode = 'session_pr_binding_resolver_missing'
        }
        $diagnostic.outcome = 'gate_closed'
        $diagnostic.reasonCode = $reasonCode
        $diagnostic.gateClosedCount = @($sourceSessions).Count
        foreach ($session in @($sourceSessions)) {
            Add-WorkerStatusRefreshDiagnosticDetail -Diagnostic $diagnostic `
                -SessionId (Get-WorkerStatusRefreshSessionId -Session $session) -ReasonCode $reasonCode
        }
        $Script:LastWorkerStatusRefreshDiagnostic = $diagnostic
        return $diagnostic
    }

    $resolvedRepoSlug = Resolve-WorkerReportStoreRepoSlug -RepoSlug $RepoSlug
    $resolvedGithubSnapshot = $GithubSnapshot
    if (-not $resolvedGithubSnapshot) {
        $resolvedGithubSnapshot = Get-WorkerStatusRecomputeGithubSnapshot -Project $Project -Sessions $sourceSessions
    }
    if (-not $resolvedGithubSnapshot) {
        $resolvedGithubSnapshot = New-WorkerStatusEmptyGithubSnapshot
    }
    $diagnostic.githubDegraded = [bool]$resolvedGithubSnapshot.degraded

    if (-not (Get-Command Get-WorkerOsLivenessMap -ErrorAction SilentlyContinue)) {
        . (Join-Path $PSScriptRoot 'Get-WorkerOsLiveness.ps1')
    }
    $osLivenessMap = Get-WorkerOsLivenessMap -Sessions $sourceSessions

    foreach ($session in @($sourceSessions)) {
        $sessionId = Get-WorkerStatusRefreshSessionId -Session $session
        if (-not $sessionId) {
            $diagnostic.skippedCount++
            $diagnostic.failureCount++
            Add-WorkerStatusRefreshDiagnosticDetail -Diagnostic $diagnostic `
                -SessionId 'unknown_session' -ReasonCode 'missing_session_id'
            continue
        }

        $diagnostic.writeAttemptCount++
        $writeInput = @{
            session                = $session
            reports                = @($session.reports)
            repoSlug               = $resolvedRepoSlug
            githubSnapshot         = $resolvedGithubSnapshot
            osLiveness             = Get-WorkerStatusRefreshOsLiveness -OsLivenessMap $osLivenessMap -SessionId $sessionId
            writerGenerationVector = Get-WorkerStatusWriterGenerationVector -SessionId $sessionId `
                    -RepoTickGeneration $RepoTickGeneration -GithubSnapshot $resolvedGithubSnapshot
        }
        $writeOutcome = Invoke-WorkerStatusRefreshRowWrite -WriteInput $writeInput -StorePath $StorePath -NowMs $NowMs
        $diagnostic.writeRetryCount += [int]$writeOutcome.retryCount
        if ($writeOutcome.exception) {
            $diagnostic.exceptionCount++
            $diagnostic.failureCount++
            Add-WorkerStatusRefreshDiagnosticDetail -Diagnostic $diagnostic `
                -SessionId $sessionId -ReasonCode 'write_exception'
            continue
        }

        $result = $writeOutcome.result
        if (-not $result -or $null -eq $result.ok -or -not [bool]$result.ok) {
            $rawReason = if ($result -and $result.reason) { [string]$result.reason } else { 'write_rejected' }
            $reasonCode = Resolve-WorkerStatusRefreshReasonCode -Reason $rawReason
            $diagnostic.skippedCount++
            $diagnostic.failureCount++
            Add-WorkerStatusRefreshDiagnosticDetail -Diagnostic $diagnostic `
                -SessionId $sessionId -ReasonCode $reasonCode
            continue
        }
        $diagnostic.successCount++
    }

    try {
        $eviction = Invoke-WorkerStatusStoreEviction -Sessions $sourceSessions -StorePath $StorePath -NowMs $NowMs
        if ($eviction) {
            $diagnostic.evictionRemoved = [int]$eviction.removed
        }
    }
    catch {
        $diagnostic.evictionFailed = $true
        $diagnostic.failureCount++
        Add-WorkerStatusRefreshDiagnosticDetail -Diagnostic $diagnostic `
            -SessionId 'store' -ReasonCode 'eviction_exception'
    }

    if (@($sourceSessions).Count -eq 0) {
        $diagnostic.outcome = 'empty_fleet'
        $diagnostic.reasonCode = 'no_live_sessions'
    }
    elseif ($diagnostic.exceptionCount -gt 0 -or $diagnostic.failureCount -gt 0) {
        $diagnostic.outcome = 'partial_failure'
        $diagnostic.reasonCode = if ($diagnostic.exceptionCount -gt 0) { 'write_exception' } else { 'write_rejected' }
    }
    else {
        $diagnostic.outcome = 'success'
        $diagnostic.reasonCode = ''
    }
    $Script:LastWorkerStatusRefreshDiagnostic = $diagnostic
    return $diagnostic
}

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

    $sessions = @(Get-WorkerStatusRefreshSourceSessions -Project $Project -RepoSlug $RepoSlug `
            -WorkerListPayload $WorkerListPayload -OrchestratorListPayload $OrchestratorListPayload `
            -ReportFullPayload $ReportFullPayload -AoCommand $AoCommand -IncludeTerminated:$IncludeTerminated)

    if (Test-WorkerStatusKillSwitchActive) {
        return @(New-WorkerStatusDecisionUnknownRows -Sessions $sessions -Reason 'kill_switch_active')
    }
    $readiness = Test-WorkerStatusSiblingReadiness
    if (-not $readiness.ok) {
        return @(New-WorkerStatusDecisionUnknownRows -Sessions $sessions -Reason 'sibling_not_ready')
    }

    return @(Merge-AoSessionRowsWithWorkerStatusStore -Sessions $sessions -RepoTickGeneration $RepoTickGeneration)
}

function Get-WorkerStatusReadOnlyProjection {
    param(
        [string]$Project = 'orchestrator-pack',
        [string]$RepoSlug = '',
        [string]$AoCommand = 'ao',
        [long]$RepoTickGeneration = 0
    )

    $sessions = @(Get-AoStatusSessions -Project $Project -AoCommand $AoCommand)
    if (Test-WorkerStatusKillSwitchActive) {
        return @(New-WorkerStatusDecisionUnknownRows -Sessions $sessions -Reason 'kill_switch_active')
    }
    $readiness = Test-WorkerStatusSiblingReadiness
    if (-not $readiness.ok) {
        return @(New-WorkerStatusDecisionUnknownRows -Sessions $sessions -Reason 'sibling_not_ready')
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
