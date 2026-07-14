#requires -Version 5.1
<# Candidate construction and TOCTOU boundaries for the CI-red watchdog (Issue #755). #>

function New-CiRedWatchdogCandidate {
    param(
        [string]$RepoSlug,
        [int]$PrNumber,
        [string]$HeadSha,
        [hashtable]$Context,
        [object]$CheckRow,
        [object]$Authoritative,
        [object]$Worker,
        [long]$NowMs,
        [hashtable]$Config
    )

    $episode = @{
        repo                 = $RepoSlug
        prNumber             = $PrNumber
        requiredCheckContext = [string]$Context.Identity
        headSha              = $HeadSha
        checkRunId           = [string]$Authoritative.checkRunId
        attempt              = [int]$Authoritative.attempt
    }
    $diagnostic = @{
        available  = $false
        reason     = if ($Authoritative.reason) { [string]$Authoritative.reason } else { [string]$Authoritative.diagnosticReason }
        fingerprint = ''
        headSha    = $HeadSha
        checkRunId = [string]$Authoritative.checkRunId
        attempt    = [int]$Authoritative.attempt
    }
    $message = ''
    if ($Authoritative.ok -and $Authoritative.diagnosticOk -and $Authoritative.diagnosticRaw) {
        $framed = Invoke-CiRedWatchdogCli -Command 'frame-message' -Payload @{
            episode           = $episode
            stepName          = [string]$Authoritative.stepName
            diagnostic        = [string]$Authoritative.diagnosticRaw
            maxDiagnosticChars = [int]$Config.maxDiagnosticChars
        }
        if ($framed.ok) {
            $diagnostic.available = $true
            $diagnostic.reason = ''
            $diagnostic.fingerprint = [string]$framed.diagnosticFingerprint
            $message = [string]$framed.message
        }
        else {
            $diagnostic.reason = [string]$framed.reason
        }
    }

    return @{
        episode    = $episode
        github     = @{
            prOpen           = $true
            currentHeadSha   = $HeadSha
            checkRequired    = $true
            checkConclusion  = [string]$Authoritative.conclusion
            latestCheckRunId = [string]$Authoritative.checkRunId
            latestAttempt    = [int]$Authoritative.attempt
        }
        worker     = @{
            sessionId            = [string]$Worker.sessionId
            sessionGeneration    = [string]$Worker.sessionGeneration
            alive                = [bool]$Worker.alive
            quiescent            = [bool]$Worker.quiescent
            lastActivityAtMs     = $Worker.lastActivityAtMs
            activityObservedAtMs = $Worker.activityObservedAtMs
        }
        diagnostic = $diagnostic
        message    = $message
        checkRow   = $CheckRow
    }
}

function Get-CiRedWatchdogPullSnapshot {
    param(
        [string]$RepoRoot,
        [string]$RepoSlug,
        [int]$PrNumber
    )
    $result = Invoke-CiRedWatchdogGhJson -RepoRoot $RepoRoot -Arguments @('api', "repos/$RepoSlug/pulls/$PrNumber")
    if (-not $result.ok) { return @{ ok = $false; reason = 'pr_snapshot_unavailable' } }
    $pull = $result.value
    return @{
        ok         = $true
        state      = [string]$pull.state
        headSha    = [string]$pull.head.sha
        baseRefName = [string]$pull.base.ref
    }
}

function Test-CiRedWatchdogEligibilityBoundary {
    param(
        [object]$Episode,
        [string]$RepoRoot,
        [string]$RepoSlug,
        [object]$CheckRow = $null
    )
    $prNumber = [int]$Episode.prNumber
    $pull = Get-CiRedWatchdogPullSnapshot -RepoRoot $RepoRoot -RepoSlug $RepoSlug -PrNumber $prNumber
    if (-not $pull.ok) { return $pull }
    if ([string]$pull.state -ne 'open') { return @{ ok = $false; reason = 'pr_not_open' } }
    if ([string]$pull.headSha -ne [string]$Episode.headSha) { return @{ ok = $false; reason = 'head_changed' } }

    if (-not (Get-Command Get-ReconcileChecksByPr -ErrorAction SilentlyContinue)) {
        return @{ ok = $false; reason = 'required_check_lookup_unavailable' }
    }
    $openPr = @{
        number      = $prNumber
        headRefOid  = [string]$pull.headSha
        baseRefName = [string]$pull.baseRefName
    }
    try {
        $bundle = Get-ReconcileChecksByPr -RepoRoot $RepoRoot -OpenPrs @($openPr)
    }
    catch {
        return @{ ok = $false; reason = 'required_check_lookup_failed' }
    }
    $required = @(Get-CiRedWatchdogRequiredContextsForPr -ChecksBundle $bundle -PrNumber $prNumber | ForEach-Object {
        Resolve-CiRedWatchdogRequiredContext -Value $_
    } | Where-Object { $null -ne $_ })
    $requiredIdentity = [string]$Episode.requiredCheckContext
    $requiredMatch = $required | Where-Object { [string]$_.Identity -eq $requiredIdentity } | Select-Object -First 1
    if (-not $requiredMatch) { return @{ ok = $false; reason = 'check_not_required' } }

    $current = Get-CiRedWatchdogAuthoritativeCheck -RepoRoot $RepoRoot -RepoSlug $RepoSlug `
        -PrNumber $prNumber -HeadSha ([string]$Episode.headSha) `
        -RequiredContext ([string]$requiredMatch.MatchName) -RequiredAppId ([string]$requiredMatch.AppId) `
        -CheckRow $CheckRow -MetadataOnly
    if (-not $current.ok) { return @{ ok = $false; reason = [string]$current.reason } }
    if ([string]$current.checkRunId -ne [string]$Episode.checkRunId -or [int]$current.attempt -ne [int]$Episode.attempt) {
        return @{ ok = $false; reason = 'check_run_changed' }
    }
    if (-not (Test-CiRedWatchdogFailureConclusion -Check $current)) {
        return @{ ok = $false; reason = 'check_not_failing' }
    }
    return @{ ok = $true; pull = $pull; current = $current; checksBundle = $bundle }
}

function Test-CiRedWatchdogDeliveryAttemptId {
    param([string]$DeliveryId)
    return ([string]$DeliveryId).StartsWith('ci-red-watchdog:', [System.StringComparison]::Ordinal)
}

function Test-CiRedWatchdogSubmitBoundary {
    param(
        [string]$DeliveryId,
        [string]$SessionId,
        [string]$RepoRoot,
        [string]$ProjectId,
        [object[]]$Sessions
    )
    if (-not (Test-CiRedWatchdogDeliveryAttemptId -DeliveryId $DeliveryId)) {
        return @{ ok = $true; reason = 'not_watchdog_delivery' }
    }
    $inspect = Invoke-CiRedWatchdogCli -Command 'inspect-attempt' -Payload @{
        storeDir  = Get-CiRedWatchdogStateDir
        attemptId = $DeliveryId
    }
    if (-not $inspect.found -or -not $inspect.record.currentAttempt) {
        return @{ ok = $false; reason = 'watchdog_attempt_not_current' }
    }
    $record = $inspect.record
    $attempt = $record.currentAttempt
    if ([string]$attempt.attemptId -ne $DeliveryId) { return @{ ok = $false; reason = 'watchdog_attempt_mismatch' } }
    if ([string]$attempt.sessionId -ne $SessionId) { return @{ ok = $false; reason = 'watchdog_session_changed' } }
    $repoSlug = Get-CiRedWatchdogRepoSlug -RepoRoot $RepoRoot
    if (-not $repoSlug) { return @{ ok = $false; reason = 'repo_slug_unresolved' } }
    $eligibility = Test-CiRedWatchdogEligibilityBoundary -Episode $record.identity -RepoRoot $RepoRoot -RepoSlug $repoSlug
    if (-not $eligibility.ok) { return $eligibility }
    $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $freshSessions = @(Get-CiRedWatchdogDecisionSessions -FallbackSessions $Sessions)
    $boundaryOpenPrs = @(@{
        number = [int]$record.identity.prNumber
        headRefOid = [string]$eligibility.pull.headSha
        baseRefName = [string]$eligibility.pull.baseRefName
    })
    $worker = Resolve-CiRedWatchdogCurrentAttemptWorker -Sessions $freshSessions -OpenPrs $boundaryOpenPrs `
        -PrNumber ([int]$record.identity.prNumber) -HeadSha ([string]$record.identity.headSha) `
        -ExpectedSessionId ([string]$attempt.sessionId) -ExpectedGeneration ([string]$attempt.sessionGeneration) `
        -ProjectId $ProjectId -NowMs $nowMs
    if (-not $worker.ok) { return @{ ok = $false; reason = [string]$worker.reason } }
    if (-not $worker.alive) { return @{ ok = $false; reason = 'worker_not_live' } }
    if (-not $worker.quiescent) { return @{ ok = $false; reason = 'worker_not_quiescent' } }
    return @{ ok = $true; reason = 'submit_boundary_current'; episode = $record.identity; worker = $worker }
}

function Release-CiRedWatchdogSubmitBoundaryAttempt {
    param(
        [string]$DeliveryId,
        [string]$Reason
    )
    $inspect = Invoke-CiRedWatchdogCli -Command 'inspect-attempt' -Payload @{
        storeDir  = Get-CiRedWatchdogStateDir
        attemptId = $DeliveryId
    }
    if (-not $inspect.found -or -not $inspect.record.currentAttempt) { return @{ ok = $false; reason = 'watchdog_attempt_not_current' } }
    return Invoke-CiRedWatchdogCli -Command 'release' -Payload @{
        storeDir  = Get-CiRedWatchdogStateDir
        episode   = $inspect.record.identity
        attemptId = $DeliveryId
        reason    = "submit_boundary_$Reason"
        nowMs     = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        actor     = 'worker-message-submit-reconcile'
        config    = Get-CiRedWatchdogConfig
    }
}

function Test-CiRedWatchdogCandidateStillCurrent {
    param(
        [hashtable]$Candidate,
        [string]$RepoRoot,
        [string]$RepoSlug,
        [object[]]$Sessions,
        [string]$ProjectId,
        [long]$NowMs
    )
    $episode = $Candidate.episode
    $eligibility = Test-CiRedWatchdogEligibilityBoundary -Episode $episode -RepoRoot $RepoRoot -RepoSlug $RepoSlug -CheckRow $Candidate.checkRow
    if (-not $eligibility.ok) { return $eligibility }
    $freshSessions = @(Get-CiRedWatchdogDecisionSessions -FallbackSessions $Sessions)
    $boundaryOpenPrs = @(@{
        number = [int]$episode.prNumber
        headRefOid = [string]$eligibility.pull.headSha
        baseRefName = [string]$eligibility.pull.baseRefName
    })
    $worker = Resolve-CiRedWatchdogCurrentAttemptWorker -Sessions $freshSessions -OpenPrs $boundaryOpenPrs `
        -PrNumber ([int]$episode.prNumber) -HeadSha ([string]$episode.headSha) `
        -ExpectedSessionId ([string]$Candidate.worker.sessionId) `
        -ExpectedGeneration ([string]$Candidate.worker.sessionGeneration) `
        -ProjectId $ProjectId -NowMs $NowMs
    if (-not $worker.ok) { return @{ ok = $false; reason = [string]$worker.reason } }
    if ([string]$worker.sessionGeneration -ne [string]$Candidate.worker.sessionGeneration) {
        return @{ ok = $false; reason = 'session_generation_changed' }
    }
    if (-not $worker.alive) { return @{ ok = $false; reason = 'worker_not_live' } }
    if (-not $worker.quiescent) { return @{ ok = $false; reason = 'worker_not_quiescent' } }
    return @{ ok = $true; worker = $worker }
}

