#requires -Version 5.1
<# Tick planner and delivery integration for the CI-red watchdog (Issue #755). #>

function Invoke-CiRedWatchdogTick {
    param(
        [string]$RepoRoot,
        [string]$ProjectId,
        [hashtable]$WorkerState,
        [object]$ChecksBundle,
        [switch]$DryRunMode
    )

    if (-not $ChecksBundle) { return @{ evaluated = 0; sent = 0; deferred = 0; verified = 0 } }
    $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $config = Get-CiRedWatchdogConfig
    $storeDir = Get-CiRedWatchdogStateDir
    $repoSlug = Get-CiRedWatchdogRepoSlug -RepoRoot $RepoRoot
    if (-not $repoSlug) {
        Write-CiRedWatchdogLog 'defer all: repo_slug_unresolved'
        return @{ evaluated = 0; sent = 0; deferred = 1; verified = 0 }
    }

    $sessions = @(Get-CiRedWatchdogDecisionSessions -FallbackSessions @($WorkerState.sessions))
    $openPrs = @($WorkerState.openPrs)
    $submitState = if ($DryRunMode) { @{} } else { Get-CiRedWatchdogSubmitState }
    $candidates = @()
    foreach ($pr in $openPrs) {
        $prNumber = [int](Get-CiRedWatchdogProperty -Object $pr -Names @('number', 'prNumber'))
        $headSha = [string](Get-CiRedWatchdogProperty -Object $pr -Names @('headRefOid', 'headSha'))
        if ($prNumber -le 0 -or $headSha -notmatch '^[0-9a-fA-F]{40}$') { continue }
        $worker = Resolve-CiRedWatchdogWorkerBinding -Sessions $sessions -OpenPrs $openPrs `
            -PrNumber $prNumber -HeadSha $headSha -ProjectId $ProjectId -NowMs $nowMs -SubmitState $submitState
        $requiredContexts = @(Get-CiRedWatchdogRequiredContextsForPr -ChecksBundle $ChecksBundle -PrNumber $prNumber)
        $checks = @(Get-CiRedWatchdogChecksForPr -ChecksBundle $ChecksBundle -PrNumber $prNumber)
        foreach ($rawContext in $requiredContexts) {
            $context = Resolve-CiRedWatchdogRequiredContext -Value $rawContext
            if (-not $context) { continue }
            $matching = @($checks | Where-Object { [string](Get-CiRedWatchdogProperty -Object $_ -Names @('name', 'context')) -eq [string]$context.MatchName })
            if ($matching.Count -eq 0) { continue }
            $check = $matching | Where-Object { Test-CiRedWatchdogFailureConclusion -Check $_ } | Select-Object -First 1
            if (-not $check) { continue }
            $authoritative = Get-CiRedWatchdogAuthoritativeCheck -RepoRoot $RepoRoot -RepoSlug $repoSlug `
                -PrNumber $prNumber -HeadSha $headSha.ToLowerInvariant() -RequiredContext ([string]$context.MatchName) `
                -RequiredAppId ([string]$context.AppId) -CheckRow $check
            if (-not $authoritative.ok) {
                $authoritative = @{
                    ok = $false; reason = [string]$authoritative.reason; diagnosticReason = [string]$authoritative.reason
                    checkRunId = [string](Get-CiRedWatchdogProperty -Object $check -Names @('checkRunId', 'databaseId'))
                    attempt = [int](Get-CiRedWatchdogProperty -Object $check -Names @('attempt', 'runAttempt'))
                    conclusion = [string](Get-CiRedWatchdogProperty -Object $check -Names @('conclusion', 'state', 'bucket'))
                }
                if (-not $authoritative.checkRunId -or $authoritative.attempt -le 0) {
                    Write-CiRedWatchdogLog "defer pr=$prNumber check=$($context.Identity) reason=$($authoritative.reason)"
                    continue
                }
            }
            if (-not $worker.ok) {
                $worker = @{
                    ok = $false; reason = [string]$worker.reason; sessionId = ''; sessionGeneration = ''
                    alive = $false; quiescent = $false; lastActivityAtMs = $null; activityObservedAtMs = $nowMs
                }
            }
            $candidates += New-CiRedWatchdogCandidate -RepoSlug $repoSlug -PrNumber $prNumber `
                -HeadSha $headSha.ToLowerInvariant() -Context $context -CheckRow $check `
                -Authoritative $authoritative -Worker $worker -NowMs $nowMs -Config $config
        }
    }

    $verified = 0
    if (-not $DryRunMode) {
        $ledgerSnapshot = Invoke-CiRedWatchdogCli -Command 'inspect-ledger' -Payload @{ storeDir = $storeDir }
        $awaitingRecords = @(Get-CiRedWatchdogMapValues -Map $ledgerSnapshot.episodes | Where-Object {
            [string]$_.state -eq 'awaiting-submit' -and $null -ne $_.currentAttempt
        })
        $proofCandidates = @()
        foreach ($candidate in $candidates) {
            $awaiting = $awaitingRecords | Where-Object {
                Test-CiRedWatchdogEpisodeIdentityEqual -Left $_.identity -Right $candidate.episode
            } | Select-Object -First 1
            if (-not $awaiting) { continue }
            $boundary = Test-CiRedWatchdogCandidateStillCurrent -Candidate $candidate -RepoRoot $RepoRoot `
                -RepoSlug $repoSlug -Sessions $sessions -ProjectId $ProjectId -NowMs ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
            if (-not $boundary.ok) {
                Write-CiRedWatchdogLog "verified commit deferred pr=$($candidate.episode.prNumber) check=$($candidate.episode.requiredCheckContext) reason=$($boundary.reason)"
                continue
            }
            $proofCandidates += @{
                episode    = $candidate.episode
                github     = $candidate.github
                worker     = $boundary.worker
                diagnostic = $candidate.diagnostic
            }
        }
        $proofResult = Invoke-CiRedWatchdogCli -Command 'reconcile-submit' -Payload @{
            storeDir          = $storeDir
            submitState       = $submitState
            currentCandidates = @($proofCandidates)
            nowMs             = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
            actor             = $Script:CiRedWatchdogSource
            config            = $config
        }
        $verified = @($proofResult.results | Where-Object { $_.verified }).Count
    }

    $sent = 0
    $deferred = 0
    $perWorker = @{}
    foreach ($candidate in $candidates) {
        $sessionId = [string]$candidate.worker.sessionId
        if (-not $perWorker.ContainsKey($sessionId)) { $perWorker[$sessionId] = 0 }
        $claimPayload = @{
            storeDir = $storeDir
            candidate = @{ episode = $candidate.episode; github = $candidate.github; worker = $candidate.worker; diagnostic = $candidate.diagnostic }
            nowMs = $nowMs
            owner = $Script:CiRedWatchdogSource
            config = $config
        }
        if ($DryRunMode) {
            $decision = Invoke-CiRedWatchdogCli -Command 'evaluate' -Payload @{
                candidate = $claimPayload.candidate
                nowMs = $nowMs
                config = $config
            }
            Write-CiRedWatchdogLog "dry-run pr=$($candidate.episode.prNumber) check=$($candidate.episode.requiredCheckContext) action=$($decision.action) reason=$($decision.reason)"
            if ($decision.action -ne 'send') { $deferred++ }
            continue
        }
        if ($perWorker[$sessionId] -ge $Script:CiRedWatchdogPerWorkerTickCap) {
            Write-CiRedWatchdogLog "defer pr=$($candidate.episode.prNumber) check=$($candidate.episode.requiredCheckContext) reason=per_worker_tick_cap"
            $deferred++
            continue
        }
        $claim = Invoke-CiRedWatchdogCli -Command 'claim' -Payload $claimPayload
        if ($claim.action -ne 'send') {
            Write-CiRedWatchdogLog "decision pr=$($candidate.episode.prNumber) check=$($candidate.episode.requiredCheckContext) action=$($claim.action) reason=$($claim.reason)"
            $deferred++
            continue
        }
        $attemptId = [string]$claim.attemptId
        $current = Test-CiRedWatchdogCandidateStillCurrent -Candidate $candidate -RepoRoot $RepoRoot -RepoSlug $repoSlug -Sessions $sessions -ProjectId $ProjectId -NowMs ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
        if (-not $current.ok) {
            $null = Invoke-CiRedWatchdogCli -Command 'release' -Payload @{
                storeDir = $storeDir; episode = $candidate.episode; attemptId = $attemptId
                reason = "pre_send_$($current.reason)"; nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
                actor = $Script:CiRedWatchdogSource; config = $config
            }
            Write-CiRedWatchdogLog "abort pr=$($candidate.episode.prNumber) check=$($candidate.episode.requiredCheckContext) reason=$($current.reason)"
            $deferred++
            continue
        }

        $sourceKey = "ci-red-watchdog:$($claim.key)"
        $register = Register-WorkerMessageDispatch -SessionId $sessionId -Message ([string]$candidate.message) `
            -Source $Script:CiRedWatchdogSource -SourceKey $sourceKey -DeliveryPath 'pending-draft' `
            -DispatchOutcome 'dispatch_in_flight' -DraftState 'unknown' -DeliveryId $attemptId
        if (-not $register.recorded) {
            $null = Invoke-CiRedWatchdogCli -Command 'release' -Payload @{
                storeDir = $storeDir; episode = $candidate.episode; attemptId = $attemptId
                reason = 'dispatch_journal_register_failed'; nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
                actor = $Script:CiRedWatchdogSource; config = $config
            }
            Write-CiRedWatchdogLog "defer pr=$($candidate.episode.prNumber) check=$($candidate.episode.requiredCheckContext) reason=dispatch_journal_register_failed"
            $deferred++
            continue
        }

        $outboundEpisode = @{
            prNumber        = [int]$candidate.episode.prNumber
            headSha         = [string]$candidate.episode.headSha
            targetId        = $sessionId
            targetGeneration = [string]$candidate.worker.sessionGeneration
            redPeriod       = "watchdog:$($candidate.episode.checkRunId):$($candidate.episode.attempt):$attemptId"
        }
        try {
            $sendResult = Invoke-PlannedCiFailureReconcileSend -Episode $outboundEpisode `
                -Message ([string]$candidate.message) -IdempotencyKey $sourceKey -ProjectId $ProjectId `
                -SendSnapshot @{ openPrs = @($WorkerState.openPrs) } -DeliveryId $attemptId
            if (-not $sendResult.ok) { throw "send rejected: $($sendResult.reason)" }
            $issued = Invoke-CiRedWatchdogCli -Command 'transport-issued' -Payload @{
                storeDir = $storeDir; episode = $candidate.episode; attemptId = $attemptId
                nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); actor = $Script:CiRedWatchdogSource; config = $config
            }
            if (-not $issued.accepted) { throw "transport state rejected: $($issued.reason)" }
            $perWorker[$sessionId]++
            $sent++
            Write-CiRedWatchdogLog "sent fallback pr=$($candidate.episode.prNumber) check=$($candidate.episode.requiredCheckContext) attempt=$($candidate.episode.attempt)"
        }
        catch {
            try { Update-WorkerMessageDispatchOutcome -DeliveryId $attemptId -DispatchOutcome 'send_failed' -DraftState 'unknown' | Out-Null } catch { }
            $null = Invoke-CiRedWatchdogCli -Command 'release' -Payload @{
                storeDir = $storeDir; episode = $candidate.episode; attemptId = $attemptId
                reason = 'transport_failed'; nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
                actor = $Script:CiRedWatchdogSource; config = $config
            }
            Write-CiRedWatchdogLog "send failed pr=$($candidate.episode.prNumber) check=$($candidate.episode.requiredCheckContext) reason=transport_failed"
            $deferred++
        }
    }

    return @{ evaluated = $candidates.Count; sent = $sent; deferred = $deferred; verified = $verified }
}
