#requires -Version 5.1
<# Worker/session and submit-state evidence helpers for the CI-red watchdog (Issue #755). #>

function ConvertTo-CiRedWatchdogTimestampMs {
    param([object]$Value)
    if ($null -eq $Value -or "$Value" -eq '') { return 0L }
    if ($Value -is [datetime]) { return ([DateTimeOffset]$Value).ToUnixTimeMilliseconds() }
    if ($Value -is [DateTimeOffset]) { return $Value.ToUnixTimeMilliseconds() }
    $numeric = 0L
    if ([long]::TryParse([string]$Value, [ref]$numeric)) { return $numeric }
    $parsed = [DateTimeOffset]::MinValue
    if ([DateTimeOffset]::TryParse([string]$Value, [ref]$parsed)) { return $parsed.ToUnixTimeMilliseconds() }
    return 0L
}

function Get-CiRedWatchdogDecisionSessions {
    param([object[]]$FallbackSessions = @())
    if (Get-Command Get-WorkerStatusDecisionSessions -ErrorAction SilentlyContinue) {
        try {
            $decisionSessions = @(Get-WorkerStatusDecisionSessions)
            if ($decisionSessions.Count -gt 0) { return $decisionSessions }
        }
        catch { }
    }
    if (Get-Command Get-AoStatusSessions -ErrorAction SilentlyContinue) {
        try {
            $liveSessions = @(Get-AoStatusSessions)
            if ($liveSessions.Count -gt 0) { return $liveSessions }
        }
        catch { }
    }
    return @($FallbackSessions)
}

function Resolve-CiRedWatchdogWorker {
    param(
        [object[]]$Sessions,
        [int]$PrNumber,
        [string]$HeadSha,
        [long]$NowMs,
        [string]$ExpectedSessionId = '',
        [string]$ExpectedGeneration = '',
        [object]$SubmitState = $null
    )
    $matches = @()
    foreach ($session in @($Sessions)) {
        $role = [string](Get-CiRedWatchdogProperty -Object $session -Names @('role'))
        if ($role -and $role -ne 'worker') { continue }
        $sessionPr = [int](Get-CiRedWatchdogProperty -Object $session -Names @('prNumber', 'pr', 'issueId', 'issueNumber'))
        $ownedHead = [string](Get-CiRedWatchdogProperty -Object $session -Names @('ownedHeadSha', 'headSha', 'runHeadSha'))
        $candidateSessionId = [string](Get-CiRedWatchdogProperty -Object $session -Names @('name', 'sessionId', 'id'))
        $candidateGeneration = [string](Get-CiRedWatchdogProperty -Object $session -Names @('targetGeneration', 'sessionGeneration', 'generation', 'id', 'name'))
        if ($ExpectedSessionId -and $candidateSessionId -ne $ExpectedSessionId) { continue }
        if ($ExpectedGeneration -and $candidateGeneration -ne $ExpectedGeneration) { continue }
        if ($sessionPr -eq $PrNumber -or ($ownedHead -and $ownedHead -eq $HeadSha) -or ($ExpectedSessionId -and $candidateSessionId -eq $ExpectedSessionId)) { $matches += $session }
    }
    if ($matches.Count -eq 0) { return @{ ok = $false; reason = 'worker_binding_missing' } }
    if ($matches.Count -gt 1) { return @{ ok = $false; reason = 'worker_binding_conflict' } }
    $session = $matches[0]
    $sessionId = [string](Get-CiRedWatchdogProperty -Object $session -Names @('name', 'sessionId', 'id'))
    $generation = [string](Get-CiRedWatchdogProperty -Object $session -Names @('targetGeneration', 'sessionGeneration', 'generation', 'id', 'name'))
    if (-not $sessionId -or -not $generation) { return @{ ok = $false; reason = 'worker_generation_missing' } }

    $status = ([string](Get-CiRedWatchdogProperty -Object $session -Names @('status'))).ToLowerInvariant()
    $explicitAlive = Get-CiRedWatchdogProperty -Object $session -Names @('alive', 'live', 'paneAlive', 'pane_alive')
    if ($null -ne $explicitAlive) {
        $alive = [bool]$explicitAlive
    }
    elseif ($status) {
        $alive = $status -notin @('dead', 'exited', 'terminated', 'stopped', 'missing')
    }
    else {
        $alive = $false
    }

    $quiescentSignals = @()
    $quiescentExplicit = Get-CiRedWatchdogProperty -Object $session -Names @('quiescent', 'idle')
    if ($null -ne $quiescentExplicit) { $quiescentSignals += [bool]$quiescentExplicit }
    if ($status -in @('idle', 'waiting', 'ready', 'blocked', 'awaiting_input', 'awaiting-input')) {
        $quiescentSignals += $true
    }
    elseif ($status -in @('working', 'fixing_ci', 'reviewing', 'running', 'streaming', 'busy')) {
        $quiescentSignals += $false
    }

    $lastActivityAtMs = 0L
    foreach ($field in @('lastActivityAtMs', 'last_activity_at_ms', 'updatedAtMs', 'updatedAt', 'activityChangedAtMs', 'activityChangedAt')) {
        $candidateActivity = ConvertTo-CiRedWatchdogTimestampMs -Value (Get-CiRedWatchdogProperty -Object $session -Names @($field))
        if ($candidateActivity -gt $lastActivityAtMs) { $lastActivityAtMs = $candidateActivity }
    }

    $reports = @((Get-CiRedWatchdogProperty -Object $session -Names @('reports')))
    if ($reports.Count -gt 0) {
        $latest = $reports | Sort-Object {
            ConvertTo-CiRedWatchdogTimestampMs -Value (Get-CiRedWatchdogProperty -Object $_ -Names @('reportedAtMs', 'updatedAtMs', 'reportedAt', 'timestamp'))
        } -Descending | Select-Object -First 1
        $reportedAtMs = ConvertTo-CiRedWatchdogTimestampMs -Value (Get-CiRedWatchdogProperty -Object $latest -Names @('reportedAtMs', 'updatedAtMs', 'reportedAt', 'timestamp'))
        if ($reportedAtMs -gt $lastActivityAtMs) { $lastActivityAtMs = $reportedAtMs }
        $reportState = ([string](Get-CiRedWatchdogProperty -Object $latest -Names @('reportState', 'state'))).ToLowerInvariant()
        if ($reportState -in @('idle', 'waiting', 'ready', 'blocked', 'awaiting_input', 'awaiting-input')) { $quiescentSignals += $true }
        elseif ($reportState -in @('working', 'fixing_ci', 'reviewing', 'running', 'streaming', 'busy')) { $quiescentSignals += $false }
    }

    if ($SubmitState) {
        foreach ($delivery in @(Get-CiRedWatchdogSubmitDeliveriesForSession -SubmitState $SubmitState -SessionId $sessionId)) {
            $deliveryId = [string](Get-CiRedWatchdogProperty -Object $delivery -Names @('deliveryId'))
            if (Test-CiRedWatchdogDeliveryAttemptId -DeliveryId $deliveryId) { continue }
            $terminal = ([string](Get-CiRedWatchdogProperty -Object $delivery -Names @('terminalState'))).ToLowerInvariant()
            if ($terminal -in @('submitted', 'escalated', 'noop')) { continue }
            $quiescentSignals += $false
            foreach ($field in @('lastSubmitAtMs', 'lastProgressAtMs', 'firstObservedAtMs', 'updatedAtMs')) {
                $candidateActivity = ConvertTo-CiRedWatchdogTimestampMs -Value (Get-CiRedWatchdogProperty -Object $delivery -Names @($field))
                if ($candidateActivity -gt $lastActivityAtMs) { $lastActivityAtMs = $candidateActivity }
            }
        }
    }

    $quiescent = $quiescentSignals.Count -gt 0 -and ($quiescentSignals -notcontains $false)
    return @{
        ok                   = $true
        session              = $session
        sessionId            = $sessionId
        sessionGeneration    = $generation
        alive                = $alive
        quiescent            = $quiescent
        lastActivityAtMs     = if ($lastActivityAtMs -gt 0) { $lastActivityAtMs } else { $null }
        activityObservedAtMs = $NowMs
    }
}

function Resolve-CiRedWatchdogWorkerBinding {
    param(
        [object[]]$Sessions,
        [object[]]$OpenPrs,
        [int]$PrNumber,
        [string]$HeadSha,
        [string]$ProjectId,
        [long]$NowMs,
        [object]$SubmitState = $null
    )

    $direct = Resolve-CiRedWatchdogWorker -Sessions $Sessions -PrNumber $PrNumber -HeadSha $HeadSha -NowMs $NowMs -SubmitState $SubmitState
    if ($direct.ok) { return $direct }
    if (-not (Get-Command Resolve-WorkerNudgeTargetFromPrClaim -ErrorAction SilentlyContinue)) { return $direct }

    $resolved = @()
    foreach ($session in @($Sessions)) {
        $sessionId = [string](Get-CiRedWatchdogProperty -Object $session -Names @('name', 'sessionId', 'id'))
        if (-not $sessionId) { continue }
        try {
            $target = Resolve-WorkerNudgeTargetFromPrClaim -PrNumber $PrNumber -SessionId $sessionId `
                -HeadSha $HeadSha -ProjectId $ProjectId -OpenPrs $OpenPrs
        }
        catch { continue }
        if (-not $target.ok) { continue }
        $ownerSessionId = [string]$target.ownerSessionId
        if (-not $ownerSessionId) { $ownerSessionId = $sessionId }
        $generation = [string]$target.targetGeneration
        if (-not $generation) { $generation = [string]$target.targetId }
        $worker = Resolve-CiRedWatchdogWorker -Sessions $Sessions -PrNumber $PrNumber -HeadSha $HeadSha -NowMs $NowMs `
            -ExpectedSessionId $ownerSessionId -SubmitState $SubmitState
        if ($worker.ok) {
            if ($generation) { $worker.sessionGeneration = $generation }
            $resolved += $worker
        }
    }
    $unique = @($resolved | Group-Object { "$($_.sessionId)|$($_.sessionGeneration)" } | ForEach-Object { $_.Group[0] })
    if ($unique.Count -eq 1) { return $unique[0] }
    if ($unique.Count -gt 1) { return @{ ok = $false; reason = 'worker_binding_conflict' } }
    return $direct
}

function Resolve-CiRedWatchdogCurrentAttemptWorker {
    param(
        [object[]]$Sessions,
        [object[]]$OpenPrs,
        [int]$PrNumber,
        [string]$HeadSha,
        [string]$ExpectedSessionId,
        [string]$ExpectedGeneration,
        [string]$ProjectId,
        [long]$NowMs
    )

    $worker = Resolve-CiRedWatchdogWorker -Sessions $Sessions -PrNumber $PrNumber -HeadSha $HeadSha `
        -NowMs $NowMs -ExpectedSessionId $ExpectedSessionId
    if (-not $worker.ok) { return $worker }

    $currentGeneration = [string]$worker.sessionGeneration
    if (Get-Command Resolve-WorkerNudgeTargetFromPrClaim -ErrorAction SilentlyContinue) {
        try {
            $target = Resolve-WorkerNudgeTargetFromPrClaim -PrNumber $PrNumber -SessionId $ExpectedSessionId `
                -HeadSha $HeadSha -ProjectId $ProjectId -OpenPrs $OpenPrs
            if (-not $target.ok) { return @{ ok = $false; reason = [string]$target.reason } }
            $ownerSessionId = [string]$target.ownerSessionId
            if ($ownerSessionId -and $ownerSessionId -ne $ExpectedSessionId) {
                return @{ ok = $false; reason = 'worker_session_changed' }
            }
            $resolvedGeneration = [string]$target.targetGeneration
            if (-not $resolvedGeneration) { $resolvedGeneration = [string]$target.targetId }
            if ($resolvedGeneration) { $currentGeneration = $resolvedGeneration }
        }
        catch { return @{ ok = $false; reason = 'worker_binding_revalidation_failed' } }
    }
    if (-not $currentGeneration -or $currentGeneration -ne $ExpectedGeneration) {
        return @{ ok = $false; reason = 'session_generation_changed' }
    }
    $worker.sessionGeneration = $currentGeneration
    return $worker
}

function Get-CiRedWatchdogSubmitState {
    $path = ''
    if ($env:AO_WORKER_MESSAGE_SUBMIT_STATE) {
        $path = $env:AO_WORKER_MESSAGE_SUBMIT_STATE.Trim()
    }
    elseif ($env:AO_SIDE_PROCESS_STATE_DIR) {
        $anchorPath = Join-Path $env:AO_SIDE_PROCESS_STATE_DIR.Trim() 'worker-message-submit-state-root.anchor.json'
        if (Test-Path -LiteralPath $anchorPath -PathType Leaf) {
            try {
                $anchor = Get-Content -LiteralPath $anchorPath -Raw | ConvertFrom-Json
                $path = [string]$anchor.statePath
            }
            catch { $path = '' }
        }
    }
    if (-not $path -and (Get-Command Get-WorkerMessageDispatchJournalPath -ErrorAction SilentlyContinue)) {
        try {
            $journalPath = Get-WorkerMessageDispatchJournalPath
            $journalDir = Split-Path -Parent $journalPath
            $anchorPath = Join-Path $journalDir 'worker-message-submit-state-root.anchor.json'
            if (Test-Path -LiteralPath $anchorPath -PathType Leaf) {
                $anchor = Get-Content -LiteralPath $anchorPath -Raw | ConvertFrom-Json
                $path = [string]$anchor.statePath
            }
        }
        catch { $path = '' }
    }
    if (-not $path) {
        $path = Join-Path ([System.IO.Path]::GetTempPath()) 'orchestrator-worker-message-submit-state.json'
    }
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return @{} }
    try { return Get-Content -LiteralPath $path -Raw | ConvertFrom-Json }
    catch { return @{} }
}

function Get-CiRedWatchdogMapValues {
    param([object]$Map)
    if ($null -eq $Map) { return @() }
    if ($Map -is [System.Collections.IDictionary]) {
        return @($Map.Keys | ForEach-Object { $Map[$_] })
    }
    return @($Map.PSObject.Properties | ForEach-Object { $_.Value })
}

function Get-CiRedWatchdogSubmitDeliveriesForSession {
    param(
        [object]$SubmitState,
        [string]$SessionId
    )
    if (-not $SubmitState -or -not $SessionId) { return @() }
    $deliveries = Get-CiRedWatchdogProperty -Object $SubmitState -Names @('deliveries')
    return @(Get-CiRedWatchdogMapValues -Map $deliveries | Where-Object {
        [string](Get-CiRedWatchdogProperty -Object $_ -Names @('sessionId')) -eq $SessionId
    })
}

function Test-CiRedWatchdogEpisodeIdentityEqual {
    param([object]$Left, [object]$Right)
    if (-not $Left -or -not $Right) { return $false }
    return (
        [string]$Left.repo -eq [string]$Right.repo -and
        [int]$Left.prNumber -eq [int]$Right.prNumber -and
        [string]$Left.requiredCheckContext -eq [string]$Right.requiredCheckContext -and
        [string]$Left.headSha -eq [string]$Right.headSha -and
        [string]$Left.checkRunId -eq [string]$Right.checkRunId -and
        [int]$Left.attempt -eq [int]$Right.attempt
    )
}

