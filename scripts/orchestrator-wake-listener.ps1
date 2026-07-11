#requires -Version 5.1
<#
.SYNOPSIS
  Local loopback HTTP listener: AO webhook POST -> ao send orchestrator wake nudge.

.DESCRIPTION
  Accepts POSTs from AO's built-in webhook notifier (urgent/action routed events),
  filters to wake-relevant kinds, deduplicates within a short window, and runs
  `ao send <orchestrator-session-id> <message>` unless -DryRun is set.

  Defaults: port 17487, path /ao-wake, dedup window 30s.
  See docs/orchestrator-wake-runbook.md.
#>
[CmdletBinding()]
param(
    [int]$Port = 0,
    [string]$OrchestratorSessionId = '',
    [string]$ProjectId = '',
    [string]$Path = '/ao-wake',
    [int]$DedupWindowSeconds = 30,
    [string]$SideEffectStateDir = '',
    [string]$FixturePath = '',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'orchestrator-wake-common.ps1')
. (Join-Path $PSScriptRoot 'lib/Invoke-OrchestratorEscalationEmit.ps1')
. (Join-Path $PSScriptRoot 'lib/Invoke-AoCliJson.ps1')
. (Join-Path $PSScriptRoot 'lib/Gh-PrChecks.ps1')
. (Join-Path $PSScriptRoot 'lib/MechanicalReconcileNode.ps1')
. (Join-Path $PSScriptRoot 'lib/Review-MechanicalForbiddenCommand.ps1')
. (Join-Path $PSScriptRoot 'lib/Get-PackReviewCommand.ps1')
. (Join-Path $PSScriptRoot 'lib/Invoke-ReviewWakeTrigger.ps1')
. (Join-Path $PSScriptRoot 'lib/Record-ReviewHandoffWakeAdmission.ps1')
. (Join-Path $PSScriptRoot 'lib/Get-SupervisedRepoSlug.ps1')
. (Join-Path $PSScriptRoot 'lib/Orchestrator-SideProcessProgress.ps1')

$Script:DefaultPort = 17487
$Script:ListenerProgressPollSeconds = 60
$Script:HandoffPendingRetryPollSeconds = 10
$Script:GhPrChecksLogWriter = { param([string]$Message) Write-ListenerLog $Message }

function Get-ListenerPort {
    if ($Port -gt 0) { return $Port }
    $envPort = $env:AO_WAKE_LISTENER_PORT
    if ($envPort -and [int]::TryParse($envPort, [ref]$null)) {
        return [int]$envPort
    }
    return $Script:DefaultPort
}

function Write-ListenerLog {
    param([string]$Message)
    Write-OrchestratorWakeLog -Message $Message
}

function Get-ListenerHandoffStateRoot {
    param([string]$StateRoot = '', [string]$SideEffectLockPath = '')

    if ($StateRoot) { return $StateRoot }
    if ($SideEffectLockPath) { return Split-Path -Parent $SideEffectLockPath }
    return ''
}

function Invoke-HandoffWakeTriggerFromFilter {
    param(
        [object]$FilterResult,
        [long]$WakeReceivedMs,
        [string]$ProjectId,
        [string]$RepoRoot,
        [string]$ReviewCommand,
        [string]$SideEffectLockPath,
        [string]$StateRoot,
        [hashtable]$FixtureSnapshot,
        [switch]$DryRun,
        [string]$WakeMessage
    )

    $triggerResult = Invoke-ReviewWakeTriggerOnCompletionWake `
        -FilterResult $FilterResult `
        -ProjectId $ProjectId `
        -RepoRoot $RepoRoot `
        -ReviewCommand $ReviewCommand `
        -SideEffectLockPath $SideEffectLockPath `
        -StateRoot $StateRoot `
        -FixtureSnapshot $FixtureSnapshot `
        -WakeReceivedMs $WakeReceivedMs `
        -DryRun:($DryRun -or [bool]$FixtureSnapshot) `
        -LogWriter { param([string]$Message) Write-ListenerLog $Message }
    $resolvedWakeMessage = Resolve-ReviewWakeMergeMessage -WakeMessage $WakeMessage -MergeEval $triggerResult.mergeEval
    if ($triggerResult.triggered) {
        Write-ListenerLog "review-wake-trigger: run started PR #$($triggerResult.planned.prNumber) head=$($triggerResult.planned.headSha)"
    }
    return @{
        wakeMessage     = $resolvedWakeMessage
        triggerResult   = $triggerResult
    }
}

function Resolve-SupervisedRepoForAdmission {
    param(
        [hashtable]$FixtureSnapshot,
        [string]$RepoRoot
    )

    if ($FixtureSnapshot -and $FixtureSnapshot.supervisedRepoSlug) {
        return @{
            repoSlug     = [string]$FixtureSnapshot.supervisedRepoSlug
            lookupFailed = $false
        }
    }
    $slug = Get-SupervisedRepoSlug -RepoRoot $RepoRoot
    if ($slug) {
        return @{ repoSlug = $slug; lookupFailed = $false }
    }
    return @{ repoSlug = ''; lookupFailed = $true }
}


function Resolve-SupervisedSessionsForAdmission {
    param([hashtable]$FixtureSnapshot)

    if ($FixtureSnapshot -and $FixtureSnapshot.sessions) {
        return @{ sessions = @($FixtureSnapshot.sessions); lookupFailed = $false }
    }
    try {
        $sessions = @(Get-AoStatusSessions)
        return @{ sessions = $sessions; lookupFailed = $false }
    }
    catch {
        return @{ sessions = @(); lookupFailed = $true }
    }
}

function Test-ReadyForReviewHandoffEnvelope {
    param([string]$BodyJson)

    if (-not $BodyJson) { return $false }
    Push-Location $Script:OrchestratorWakeRepoRoot
    try {
        $output = $BodyJson | node $Script:OrchestratorWakeFilterCli probe-handoff 2>&1
        if ($LASTEXITCODE -ne 0) { return $false }
        $result = ($output | Out-String).Trim() | ConvertFrom-Json
        return [bool]$result.handoffEnvelope
    }
    catch {
        return $false
    }
    finally {
        Pop-Location
    }
}

function Invoke-WakeFilter {
    param(
        [string]$BodyJson,
        [string]$SupervisedProjectId = '',
        [string]$SupervisedRepoSlug = '',
        [bool]$SupervisedRepoLookupFailed = $false,
        [array]$SupervisedSessions = @(),
        [bool]$SessionLookupFailed = $false,
        [array]$OpenPrs = @(),
        [bool]$OpenPrLookupFailed = $false
    )

    $payload = @{
        bodyJson = $BodyJson
        admissionContext = @{
            supervisedProjectId = $SupervisedProjectId
            supervisedRepoSlug  = $SupervisedRepoSlug
            supervisedRepoLookupFailed = $SupervisedRepoLookupFailed
            supervisedSessions  = @($SupervisedSessions)
            sessionLookupFailed = $SessionLookupFailed
            openPrs             = @($OpenPrs)
            openPrLookupFailed  = $OpenPrLookupFailed
        }
    } | ConvertTo-Json -Depth 30 -Compress

    Push-Location $Script:OrchestratorWakeRepoRoot
    try {
        $output = $payload | node $Script:OrchestratorWakeFilterCli evaluate 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "wake filter exited ${LASTEXITCODE}: $output"
        }
        return ($output | Out-String).Trim() | ConvertFrom-Json
    }
    finally {
        Pop-Location
    }
}

function Test-LoopbackRemoteEndPoint {
    param($Request)

    $remote = $Request.RemoteEndPoint
    if (-not $remote) { return $false }
    $addr = $remote.Address
    if ($addr.IsIPv4MappedToIPv6) {
        $addr = $addr.MapToIPv4()
    }
    if ([System.Net.IPAddress]::IsLoopback($addr)) { return $true }
    if ($addr.ToString() -eq '127.0.0.1') { return $true }
    return $false
}

function Test-AndRecordWakeDedup {
    param([string]$DedupeKey)

    $dedupFile = Get-OrchestratorWakeDedupStatePath
    $windowMs = $script:dedupWindowMs
    return Invoke-OrchestratorWakeFilterCli -NodeArguments @(
        'dedup', 'try', '--file', $dedupFile, '--key', $DedupeKey, '--window-ms', $windowMs
    )
}

$listenerPort = Get-ListenerPort
$orchestratorId = Get-OrchestratorSessionId -CliValue $OrchestratorSessionId
$projectId = if ($ProjectId) {
    $ProjectId.Trim()
}
elseif ($env:AO_WAKE_LISTENER_PROJECT_ID) {
    $env:AO_WAKE_LISTENER_PROJECT_ID.Trim()
}
else {
    'orchestrator-pack'
}
$normalizedPath = if ($Path.StartsWith('/')) { $Path } else { "/$Path" }
$prefix = "http://127.0.0.1:${listenerPort}/"
$script:dedupWindowMs = [Math]::Max(1, $DedupWindowSeconds) * 1000
$lastAcceptedAt = $null
$quietCheckSeconds = 300
$sideEffectLockPath = Get-ReviewWakeTriggerSideEffectLockPath -StateRoot $SideEffectStateDir
$claimNamespace = Resolve-ReviewStartClaimNamespace -ProjectId $projectId
Get-ReviewStartClaimStaleMinutes -LogWriter { param($m) Write-ListenerLog $m } | Out-Null
$fixtureSnapshot = $null
if ($FixturePath) {
    $fixture = Get-Content -LiteralPath $FixturePath -Raw | ConvertFrom-Json
    $fixtureSnapshot = @{
        openPrs                       = @($fixture.openPrs)
        reviewRuns                    = @($fixture.reviewRuns)
        sessions                      = @($fixture.sessions)
        ciChecksByPr                  = @{}
        requiredCheckNamesByPr        = @{}
        requiredCheckLookupFailedByPr = @{}
    }
    if ($fixture.ciChecksByPr) {
        foreach ($prop in $fixture.ciChecksByPr.PSObject.Properties) {
            $fixtureSnapshot.ciChecksByPr[$prop.Name] = $prop.Value
        }
    }
    if ($fixture.requiredCheckNamesByPr) {
        foreach ($prop in $fixture.requiredCheckNamesByPr.PSObject.Properties) {
            $fixtureSnapshot.requiredCheckNamesByPr[$prop.Name] = $prop.Value
        }
    }
    if ($fixture.requiredCheckLookupFailedByPr) {
        foreach ($prop in $fixture.requiredCheckLookupFailedByPr.PSObject.Properties) {
            $fixtureSnapshot.requiredCheckLookupFailedByPr[$prop.Name] = $prop.Value
        }
    }
}
$configYaml = Join-Path $Script:OrchestratorWakeRepoRoot 'agent-orchestrator.yaml'
if (-not (Test-Path -LiteralPath $configYaml -PathType Leaf)) {
    $configYaml = Join-Path $Script:OrchestratorWakeRepoRoot 'agent-orchestrator.yaml.example'
}
$reviewCommand = Get-PackReviewCommandFromYaml -YamlPath $configYaml
$script:SupervisedRepoAdmission = Resolve-SupervisedRepoForAdmission -FixtureSnapshot $fixtureSnapshot -RepoRoot $Script:OrchestratorWakeRepoRoot
$script:SupervisedRepoSlug = [string]$script:SupervisedRepoAdmission.repoSlug


function Invoke-ListenerHandoffAdmissionRecovery {
    param(
        [string]$StateRoot,
        [long]$ListenerReadyMs,
        [switch]$PendingRetriesOnly
    )

    if (-not $StateRoot) { return }

    $sessionAdmission = Resolve-SupervisedSessionsForAdmission -FixtureSnapshot $fixtureSnapshot
    Invoke-ReviewHandoffWakeAdmissionRecovery `
        -StateRoot $StateRoot `
        -ListenerReadyMs $ListenerReadyMs `
        -ProjectId $projectId `
        -RepoRoot $Script:OrchestratorWakeRepoRoot `
        -ReviewCommand $reviewCommand `
        -SideEffectLockPath $sideEffectLockPath `
        -FixtureSnapshot $fixtureSnapshot `
        -DryRun:$DryRun `
        -PendingRetriesOnly:$PendingRetriesOnly `
        -InvokeWakeFilter {
            param($BodyJson, $OpenPrs, $OpenPrLookupFailed)
            $sessions = Resolve-SupervisedSessionsForAdmission -FixtureSnapshot $fixtureSnapshot
            Invoke-WakeFilter -BodyJson $BodyJson `
                -SupervisedProjectId $projectId `
                -SupervisedRepoSlug $script:SupervisedRepoSlug `
                -SupervisedRepoLookupFailed:$($script:SupervisedRepoAdmission.lookupFailed) `
                -SupervisedSessions $sessions.sessions `
                -SessionLookupFailed:$sessions.lookupFailed `
                -OpenPrs $OpenPrs `
                -OpenPrLookupFailed:$OpenPrLookupFailed
        } `
        -ResolveOpenPrs { ConvertTo-GhOpenPrArray -OpenPrs (Invoke-GhOpenPrList -RepoRoot $Script:OrchestratorWakeRepoRoot) } `
        -InvokeTrigger {
            param($FilterResult, $WakeReceivedMs)
            return Invoke-HandoffWakeTriggerFromFilter `
                -FilterResult $FilterResult `
                -WakeReceivedMs $WakeReceivedMs `
                -ProjectId $projectId `
                -RepoRoot $Script:OrchestratorWakeRepoRoot `
                -ReviewCommand $reviewCommand `
                -SideEffectLockPath $sideEffectLockPath `
                -StateRoot $StateRoot `
                -FixtureSnapshot $fixtureSnapshot `
                -DryRun:$DryRun `
                -WakeMessage $FilterResult.wakeMessage
        } `
        -LogWriter { param([string]$Message) Write-ListenerLog $Message }
}

Write-ListenerLog "orchestrator-wake-listener starting on $prefix (path $normalizedPath, orchestrator=$orchestratorId, project=$projectId, dedup=${DedupWindowSeconds}s, claimNamespace=$claimNamespace, dryRun=$DryRun, reviewWakeTrigger=on)"

$httpListener = New-Object System.Net.HttpListener
$httpListener.Prefixes.Add($prefix)

try {
    $httpListener.Start()
}
catch {
    throw "Failed to bind $prefix : $_"
}

Write-ListenerLog "listening (loopback only via 127.0.0.1 prefix)"
Write-OrchestratorSideProcessProgress -ChildId 'listener' -Phase 'listening'
$lastProgressAt = Get-Date
$listenerHandoffStateRoot = Get-ListenerHandoffStateRoot -StateRoot $SideEffectStateDir -SideEffectLockPath $sideEffectLockPath
$listenerReadyMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$lastPendingRetryPollAt = Get-Date
if ($listenerHandoffStateRoot) {
    try {
        Invoke-ListenerHandoffAdmissionRecovery -StateRoot $listenerHandoffStateRoot -ListenerReadyMs $listenerReadyMs
    }
    catch {
        Write-ListenerLog "review-handoff-wake: startup recovery failed ($_)"
    }
}

Register-OrchestratorWakeCancelHandler

try {
    while (-not (Test-OrchestratorWakeCancelled)) {
        if ($httpListener.IsListening) {
            $async = $httpListener.BeginGetContext($null, $null)
            while (-not $async.IsCompleted) {
                if (Test-OrchestratorWakeCancelled) { break }
                Start-Sleep -Milliseconds 100
                if (((Get-Date) - $lastProgressAt).TotalSeconds -ge $Script:ListenerProgressPollSeconds) {
                    Write-OrchestratorSideProcessProgress -ChildId 'listener' -Phase 'idle'
                    $lastProgressAt = Get-Date
                }
                if ($lastAcceptedAt -and ((Get-Date) - $lastAcceptedAt).TotalSeconds -ge $quietCheckSeconds) {
                    Write-ListenerLog "quiet-period: no accepted wake events in ${quietCheckSeconds}s (AO may not be POSTing)"
                    $lastAcceptedAt = Get-Date
                }
                if ($listenerHandoffStateRoot -and ((Get-Date) - $lastPendingRetryPollAt).TotalSeconds -ge $Script:HandoffPendingRetryPollSeconds) {
                    $lastPendingRetryPollAt = Get-Date
                    try {
                        Invoke-ListenerHandoffAdmissionRecovery `
                            -StateRoot $listenerHandoffStateRoot `
                            -ListenerReadyMs $listenerReadyMs `
                            -PendingRetriesOnly
                    }
                    catch {
                        Write-ListenerLog "review-handoff-wake: pending retry poll failed ($_)"
                    }
                }
            }
            if (Test-OrchestratorWakeCancelled) { break }

            $context = $httpListener.EndGetContext($async)
            $request = $context.Request
            $response = $context.Response

            try {
                if (-not (Test-LoopbackRemoteEndPoint -Request $request)) {
                    Write-ListenerLog "rejected non-loopback connection from $($request.RemoteEndPoint)"
                    $response.StatusCode = 403
                    $response.Close()
                    continue
                }

                $reqPath = $request.Url.AbsolutePath
                if ($request.HttpMethod -ne 'POST' -or $reqPath -ne $normalizedPath) {
                    $response.StatusCode = 404
                    $response.Close()
                    continue
                }

                $reader = New-Object System.IO.StreamReader($request.InputStream, $request.ContentEncoding)
                $body = $reader.ReadToEnd()
                $reader.Close()
                $wakeReceivedMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

                $needsHandoffAdmissionLookups = Test-ReadyForReviewHandoffEnvelope -BodyJson $body
                $openPrLookupFailed = $false
                $openPrsForAdmission = @()
                $sessionAdmission = @{ sessions = @(); lookupFailed = $false }
                if ($needsHandoffAdmissionLookups) {
                    try {
                        $openPrsForAdmission = ConvertTo-GhOpenPrArray -OpenPrs (Invoke-GhOpenPrList -RepoRoot $Script:OrchestratorWakeRepoRoot)
                    }
                    catch {
                        $openPrLookupFailed = $true
                    }
                    $sessionAdmission = Resolve-SupervisedSessionsForAdmission -FixtureSnapshot $fixtureSnapshot
                }
                $filterResult = Invoke-WakeFilter -BodyJson $body `
                    -SupervisedProjectId $projectId `
                    -SupervisedRepoSlug $script:SupervisedRepoSlug `
                    -SupervisedRepoLookupFailed:$($script:SupervisedRepoAdmission.lookupFailed) `
                    -SupervisedSessions $sessionAdmission.sessions `
                    -SessionLookupFailed:$sessionAdmission.lookupFailed `
                    -OpenPrs $openPrsForAdmission `
                    -OpenPrLookupFailed:$openPrLookupFailed

                if (-not $filterResult.ok) {
                    $reason = $filterResult.reason
                    $detail = $filterResult.detail
                    if ($filterResult.retryable -and $reason -eq 'admission_lookup_unknown' -and $listenerHandoffStateRoot) {
                        $lookupDimension = ''
                        if ($filterResult.audit -and $filterResult.audit.lookupDimension) {
                            $lookupDimension = [string]$filterResult.audit.lookupDimension
                        }
                        $retryRecord = Record-ReviewHandoffWakePendingRetry -StateRoot $listenerHandoffStateRoot -BodyJson $body `
                            -LookupDimension $lookupDimension -DryRun:$DryRun
                        if ($retryRecord.recorded) {
                            $dimSuffix = if ($lookupDimension) { " lookupDimension=$lookupDimension" } else { '' }
                            Write-ListenerLog "review-handoff-wake: retained retryable admission_lookup_unknown key=$($retryRecord.key)$dimSuffix"
                        }
                    }
                    if ($reason -eq 'missing_session_id') {
                        Write-ListenerLog 'rejected: missing session id in payload'
                    }
                    elseif ($reason -eq 'malformed_payload') {
                        Write-ListenerLog "rejected: malformed payload ($detail)"
                    }
                    elseif ($filterResult.auditLine) {
                        Write-ListenerLog ([string]$filterResult.auditLine)
                        Write-ListenerLog "dropped: $reason$(if ($detail) { " ($detail)" })"
                    }
                    else {
                        Write-ListenerLog "dropped: $reason$(if ($detail) { " ($detail)" })"
                    }
                    $response.StatusCode = 204
                    $response.Close()
                    continue
                }

                # Event-driven review trigger must run before wake dedup so burst
                # handoffs within the dedup window still start the first review run.
                $wakeMessage = $filterResult.wakeMessage
                if ($filterResult.wakeKind -eq 'merge.ready' -or $filterResult.wakeKind -eq 'ready_for_review') {
                    Write-OrchestratorSideProcessProgress -ChildId 'listener' -Phase 'wake_received'
                    try {
                        $triggerWakeReceivedMs = if ($filterResult.wakeKind -eq 'ready_for_review') { $wakeReceivedMs } else { 0 }
                        $envelopeKey = if ($filterResult.dedupeKey) { [string]$filterResult.dedupeKey } else { [string]$filterResult.sessionId }
                        Invoke-OrchestratorEscalationEmit -EscalationClassId 'escalation-handoff-envelope' `
                            -SourceProcess 'listener' -CorrelationKey ("corr:handoff:$envelopeKey") `
                            -DedupeKey ("dedupe:handoff:$envelopeKey") `
                            -Diagnosis @{ wakeKind = $filterResult.wakeKind; sessionId = $filterResult.sessionId; prNumber = $filterResult.prNumber } | Out-Null
                        $handoffTrigger = Invoke-HandoffWakeTriggerFromFilter `
                            -FilterResult $filterResult `
                            -WakeReceivedMs $triggerWakeReceivedMs `
                            -ProjectId $projectId `
                            -RepoRoot $Script:OrchestratorWakeRepoRoot `
                            -ReviewCommand $reviewCommand `
                            -SideEffectLockPath $sideEffectLockPath `
                            -StateRoot $listenerHandoffStateRoot `
                            -FixtureSnapshot $fixtureSnapshot `
                            -DryRun:($DryRun -or [bool]$FixturePath) `
                            -WakeMessage $wakeMessage
                        $wakeMessage = $handoffTrigger.wakeMessage
                    }
                    catch {
                        Write-ListenerLog "review-wake-trigger: failed ($_); forwarding merge wake as non-mergeable"
                        $wakeMessage = Resolve-ReviewWakeMergeMessage -WakeMessage $wakeMessage -MergeEval @{
                            mergeable = $false
                            reason    = 'review_trigger_failed'
                        }
                    }
                }

                $dedupDecision = Test-AndRecordWakeDedup -DedupeKey $filterResult.dedupeKey
                if (-not $dedupDecision.ok) {
                    Write-ListenerLog "deduped ($($dedupDecision.reason)): $($filterResult.wakeKind) $($filterResult.sessionId)"
                    $response.StatusCode = 204
                    $response.Close()
                    continue
                }

                $lastAcceptedAt = Get-Date
                $lastProgressAt = Get-Date
                Write-OrchestratorSideProcessProgress -ChildId 'listener' -Phase 'accepted'
                Write-ListenerLog "accepted: $($filterResult.wakeKind) worker=$($filterResult.sessionId)"
                $response.StatusCode = 204
                $response.Close()
            }
            catch {
                Write-ListenerLog "error handling request: $_"
                try {
                    $response.StatusCode = 500
                    $response.Close()
                }
                catch {
                    # ignore close failures
                }
            }
        }
    }
}
finally {
    Unregister-OrchestratorWakeCancelHandler
    if ($httpListener.IsListening) {
        $httpListener.Stop()
    }
    $httpListener.Close()
    Write-ListenerLog 'stopped'
}
