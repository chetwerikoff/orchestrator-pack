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
. (Join-Path $PSScriptRoot 'lib/Invoke-AoCliJson.ps1')
. (Join-Path $PSScriptRoot 'lib/Gh-PrChecks.ps1')
. (Join-Path $PSScriptRoot 'lib/MechanicalReconcileNode.ps1')
. (Join-Path $PSScriptRoot 'lib/Review-MechanicalForbiddenCommand.ps1')
. (Join-Path $PSScriptRoot 'lib/Get-PackReviewCommand.ps1')
. (Join-Path $PSScriptRoot 'lib/Invoke-ReviewWakeTrigger.ps1')
. (Join-Path $PSScriptRoot 'lib/Record-ReviewHandoffWakeAdmission.ps1')
. (Join-Path $PSScriptRoot 'lib/Orchestrator-SideProcessProgress.ps1')

$Script:DefaultPort = 17487
$Script:ListenerProgressPollSeconds = 60
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

function Get-SupervisedRepoSlug {
    param([string]$RepoRoot)

    Push-Location -LiteralPath $RepoRoot
    try {
        $remote = git remote get-url origin 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $remote) { return '' }
        if ($remote -match 'github\.com[:/](?<slug>[^/]+/[^/.]+)') {
            return $Matches['slug'].ToLower()
        }
        return ''
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
        [array]$OpenPrs = @(),
        [bool]$OpenPrLookupFailed = $false
    )

    $payload = @{
        body = ($BodyJson | ConvertFrom-Json)
        admissionContext = @{
            supervisedProjectId = $SupervisedProjectId
            supervisedRepoSlug  = $SupervisedRepoSlug
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
$script:SupervisedRepoSlug = Get-SupervisedRepoSlug -RepoRoot $Script:OrchestratorWakeRepoRoot

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
if ($listenerHandoffStateRoot) {
    try {
        Invoke-ReviewHandoffWakeAdmissionRecovery `
            -StateRoot $listenerHandoffStateRoot `
            -ListenerReadyMs $listenerReadyMs `
            -ProjectId $projectId `
            -RepoRoot $Script:OrchestratorWakeRepoRoot `
            -ReviewCommand $reviewCommand `
            -SideEffectLockPath $sideEffectLockPath `
            -FixtureSnapshot $fixtureSnapshot `
            -DryRun:$DryRun `
            -InvokeWakeFilter {
                param($BodyJson, $OpenPrs, $OpenPrLookupFailed)
                Invoke-WakeFilter -BodyJson $BodyJson `
                    -SupervisedProjectId $projectId `
                    -SupervisedRepoSlug $script:SupervisedRepoSlug `
                    -OpenPrs $OpenPrs `
                    -OpenPrLookupFailed:$OpenPrLookupFailed
            } `
            -ResolveOpenPrs {
                Invoke-GhOpenPrList -RepoRoot $Script:OrchestratorWakeRepoRoot
            } `
            -InvokeTrigger {
                param($FilterResult, $WakeReceivedMs)
                Invoke-HandoffWakeTriggerFromFilter `
                    -FilterResult $FilterResult `
                    -WakeReceivedMs $WakeReceivedMs `
                    -ProjectId $projectId `
                    -RepoRoot $Script:OrchestratorWakeRepoRoot `
                    -ReviewCommand $reviewCommand `
                    -SideEffectLockPath $sideEffectLockPath `
                    -StateRoot $listenerHandoffStateRoot `
                    -FixtureSnapshot $fixtureSnapshot `
                    -DryRun:$DryRun `
                    -WakeMessage $FilterResult.wakeMessage | Out-Null
            } `
            -LogWriter { param([string]$Message) Write-ListenerLog $Message }
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

                $openPrLookupFailed = $false
                $openPrsForAdmission = @()
                try {
                    $openPrsForAdmission = @(Invoke-GhOpenPrList -RepoRoot $Script:OrchestratorWakeRepoRoot)
                }
                catch {
                    $openPrLookupFailed = $true
                }
                $filterResult = Invoke-WakeFilter -BodyJson $body `
                    -SupervisedProjectId $projectId `
                    -SupervisedRepoSlug $script:SupervisedRepoSlug `
                    -OpenPrs $openPrsForAdmission `
                    -OpenPrLookupFailed:$openPrLookupFailed

                if (-not $filterResult.ok) {
                    $reason = $filterResult.reason
                    $detail = $filterResult.detail
                    if ($filterResult.retryable -and $reason -eq 'admission_lookup_unknown' -and $listenerHandoffStateRoot) {
                        $retryRecord = Record-ReviewHandoffWakePendingRetry -StateRoot $listenerHandoffStateRoot -BodyJson $body -DryRun:$DryRun
                        if ($retryRecord.recorded) {
                            Write-ListenerLog "review-handoff-wake: retained retryable admission_lookup_unknown key=$($retryRecord.key)"
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
                        $handoffTrigger = Invoke-HandoffWakeTriggerFromFilter `
                            -FilterResult $filterResult `
                            -WakeReceivedMs $wakeReceivedMs `
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

                Send-OrchestratorWakeMessage -OrchestratorId $orchestratorId -Message $wakeMessage -DryRun:$DryRun
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
