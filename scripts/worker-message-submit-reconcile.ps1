#requires -Version 5.1
<#
.SYNOPSIS
  Source-agnostic worker message submit reconciliation (Issue #232).

.DESCRIPTION
  Unified submit arbiter: presses Enter for AO-delivered pending-draft worker messages
  regardless of sender. Observes AO events, pack dispatch journal, and review-run
  state — never pane text. Folds in Issue #216 submit (review-finding path).

  Split-brain safe: observe and submit only; never spawn, kill, --claim-pr, or send.
  Runs under orchestrator-wake-supervisor (#205).

  See docs/migration_notes.md and docs/orchestrator-recovery-runbook.md.
#>
[CmdletBinding()]
param(
    [string]$ProjectId = 'orchestrator-pack',
    [int]$IntervalSeconds = 0,
    [int]$PollSeconds = 15,
    [string]$StateFile = '',
    [string]$DispatchJournalPath = '',
    [switch]$DryRun,
    [switch]$Once,
    [string]$FixturePath = '',
    [string]$YamlPath = ''
)

$ErrorActionPreference = 'Stop'
$Script:ReconcileLogPrefix = 'worker-message-submit-reconcile'

$PackRoot = Split-Path -Parent $PSScriptRoot
$SubmitFilterCli = Join-Path $PackRoot 'docs/worker-message-submit-reconcile.mjs'
$BusyDispatchSmokeMarkerPath = Join-Path $PackRoot 'docs/worker-message-submit-busy-dispatch-smoke-markers.json'
$Script:DefaultIntervalSeconds = 30

. (Join-Path $PSScriptRoot 'lib/Invoke-AoCliJson.ps1')
. (Join-Path $PSScriptRoot 'lib/Get-FloodActiveSessionMap.ps1')
. (Join-Path $PSScriptRoot 'lib/MechanicalReconcileNode.ps1')
. (Join-Path $PSScriptRoot 'lib/Orchestrator-SideProcessProgress.ps1')
. (Join-Path $PSScriptRoot 'lib/Invoke-OrchestratorEscalationEmit.ps1')
. (Join-Path $PSScriptRoot 'lib/Orchestrator-SideEffectFence.ps1')
. (Join-Path $PSScriptRoot 'lib/Submit-WorkerInputDraft.ps1')
. (Join-Path $PSScriptRoot 'lib/Record-WorkerMessageDispatch.ps1')
. (Join-Path $PSScriptRoot 'lib/Invoke-WorkerMessageSendAdoptionPreflight.ps1')
. (Join-Path $PSScriptRoot 'lib/Get-WorkerMessageAdoptionBinding.ps1')
. (Join-Path $PSScriptRoot 'lib/Get-ReactionMessagesFromYaml.ps1')

$Script:SubmitReconcileTerminalStates = @('submitted', 'escalated', 'noop')

function Get-SubmitReconcileActiveDeliveryCount {
    param([object]$Deliveries)

    $count = 0
    if (-not $Deliveries) { return 0 }
    $deliveryIds = @()
    if ($Deliveries -is [System.Collections.IDictionary]) {
        $deliveryIds = @($Deliveries.Keys)
    }
    else {
        $deliveryIds = @($Deliveries.PSObject.Properties.Name)
    }
    foreach ($deliveryId in $deliveryIds) {
        if (-not $deliveryId) { continue }
        $record = if ($Deliveries -is [System.Collections.IDictionary]) { $Deliveries[$deliveryId] } else { $Deliveries.$deliveryId }
        $terminal = [string]$record.terminalState
        if ($terminal -and $Script:SubmitReconcileTerminalStates -contains $terminal) { continue }
        $count++
    }
    return $count
}

function Get-SubmitReconcileStateDeliveries {
    param([object]$State)
    if (-not $State) { return $null }
    if ($State -is [System.Collections.IDictionary] -and $State.Contains('deliveries')) {
        return $State['deliveries']
    }
    if ($null -ne $State -and ($State.PSObject.Properties.Name -contains 'deliveries')) {
        return $State.deliveries
    }
    return $null
}


function Test-SubmitReconcileHasTerminalDeliveryEvidence {
    param([object]$State)

    $deliveries = Get-SubmitReconcileStateDeliveries -State $State
    if (-not $deliveries) { return $false }
    $deliveryIds = @()
    if ($deliveries -is [System.Collections.IDictionary]) {
        $deliveryIds = @($deliveries.Keys)
    }
    else {
        $deliveryIds = @($deliveries.PSObject.Properties.Name)
    }
    foreach ($deliveryId in $deliveryIds) {
        if (-not $deliveryId) { continue }
        $record = if ($deliveries -is [System.Collections.IDictionary]) { $deliveries[$deliveryId] } else { $deliveries.$deliveryId }
        $terminal = [string]$record.terminalState
        if ($terminal -and $Script:SubmitReconcileTerminalStates -contains $terminal) {
            return $true
        }
    }
    return $false
}

function Get-SubmitReconcileStateRootIdentity {
    param(
        [string]$StatePath = '',
        [string]$JournalPath = ''
    )

    $binding = Get-WorkerMessageAdoptionBinding -PackRoot $PackRoot
    $effectiveStatePath = if ($StatePath) {
        $StatePath
    }
    else {
        Get-SubmitReconcileStatePath -CliPath $StateFile
    }
    $effectiveJournalPath = if ($JournalPath) {
        $JournalPath
    }
    else {
        if ($DispatchJournalPath) { $DispatchJournalPath } else { Get-WorkerMessageDispatchJournalPath }
    }
    $parts = @(
        [string]$binding.ConfigPath
        [string]$binding.AoEpoch
        [string]$effectiveStatePath
        [string]$effectiveJournalPath
    ) | Where-Object { $_ }
    return (ConvertTo-WorkerMessageSafeIdComponent -Value ($parts -join '|'))
}


function Resolve-SubmitReconcileStatePathLiteral {
    param([string]$Path)
    if (-not $Path) { return '' }
    try {
        return (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
    }
    catch {
        return $Path
    }
}

function Get-SubmitReconcileStateRootAnchorPath {
    param([string]$JournalPath = '')
    if ($env:AO_SIDE_PROCESS_STATE_DIR) {
        return Join-Path $env:AO_SIDE_PROCESS_STATE_DIR.Trim() 'worker-message-submit-state-root.anchor.json'
    }
    $effectiveJournal = if ($JournalPath) {
        $JournalPath
    }
    elseif ($DispatchJournalPath) {
        $DispatchJournalPath
    }
    else {
        Get-WorkerMessageDispatchJournalPath
    }
    $dir = Split-Path -Parent $effectiveJournal
    if (-not $dir) {
        $dir = [System.IO.Path]::GetTempPath()
    }
    return Join-Path $dir 'worker-message-submit-state-root.anchor.json'
}

function Read-SubmitReconcileStateRootAnchor {
    param([string]$Path)
    if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $null
    }
    try {
        return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    }
    catch {
        return $null
    }
}

function Read-SubmitReconcileStateRootBackingState {
    param(
        [object]$Anchor,
        [string]$CurrentStatePath
    )

    if (-not $Anchor) { return $null }
    $anchorStatePath = [string]$Anchor.statePath
    if (-not $anchorStatePath) { return $null }
    $resolvedAnchorPath = Resolve-SubmitReconcileStatePathLiteral -Path $anchorStatePath
    $resolvedCurrentPath = Resolve-SubmitReconcileStatePathLiteral -Path $CurrentStatePath
    if ($resolvedAnchorPath -and $resolvedCurrentPath -and $resolvedAnchorPath -eq $resolvedCurrentPath) {
        return $null
    }
    if (-not (Test-Path -LiteralPath $anchorStatePath -PathType Leaf)) {
        return $null
    }
    try {
        return Get-Content -LiteralPath $anchorStatePath -Raw | ConvertFrom-Json
    }
    catch {
        return $null
    }
}

function Write-SubmitReconcileStateRootAnchor {
    param(
        [string]$Path,
        [string]$StatePath,
        [object]$State
    )
    if (-not $Path) { return }
    if (-not (Test-MechanicalJsonStateFencesTrusted -State $State)) { return }
    $identity = Get-SubmitReconcileStateRootIdentity -StatePath $StatePath
    $payload = @{
        stateRootIdentity   = $identity
        statePath           = (Resolve-SubmitReconcileStatePathLiteral -Path $StatePath)
        activeDeliveryCount = (Get-SubmitReconcileActiveDeliveryCount -Deliveries (Get-SubmitReconcileStateDeliveries -State $State))
        updatedAtMs         = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }
    $temp = "${Path}.tmp"
    $payload | ConvertTo-Json -Compress | Set-Content -LiteralPath $temp -Encoding utf8 -NoNewline
    Move-Item -LiteralPath $temp -Destination $Path -Force
}

function Invoke-SubmitReconcileStateRootReSeatIfEligible {
    param(
        [object]$State,
        [string]$Path,
        [string]$JournalPath,
        [string]$Identity
    )

    if (-not $State) { return $State }
    $reason = Get-MechanicalJsonStateRecoveryReason -State $State
    if ($reason -ne 'wrong_state_root_active_deliveries') {
        return $State
    }

    $journal = @{}
    if ($JournalPath -and (Test-Path -LiteralPath $JournalPath -PathType Leaf)) {
        $journal = Get-WorkerMessageDispatchJournal -Path $JournalPath
    }
    $anchor = Read-SubmitReconcileStateRootAnchor -Path (Get-SubmitReconcileStateRootAnchorPath -JournalPath $JournalPath)
    $anchorState = Read-SubmitReconcileStateRootBackingState -Anchor $anchor -CurrentStatePath $Path
    $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

    $result = Invoke-MechanicalNodeFilterCli -FilterCliPath $SubmitFilterCli -Subcommand 'stateRootReseat' `
        -Payload @{
            state       = $State
            journal     = $journal
            anchor      = $anchor
            anchorState = $anchorState
            identity    = $Identity
            nowMs       = $nowMs
        } -Label $Script:ReconcileLogPrefix -JsonDepth 30

    if (-not $result.eligible) {
        return $State
    }

    Write-SubmitReconcileLog "state-root re-seat: reason=$($result.reason) prior=$($result.priorRecoveryReason) evidence=$($result.evidence)"
    return (ConvertTo-MechanicalJsonStateHashtable -Value $result.state)
}

function Get-SubmitReconcileIntervalSeconds {
    if ($IntervalSeconds -gt 0) { return $IntervalSeconds }
    $envSeconds = $env:AO_WORKER_MESSAGE_SUBMIT_INTERVAL_SECONDS
    if ($envSeconds -and [int]::TryParse($envSeconds, [ref]$null)) {
        return [int]$envSeconds
    }
    return $Script:DefaultIntervalSeconds
}

function Get-SubmitReconcileStatePath {
    param([string]$CliPath)
    if ($CliPath) { return $CliPath }
    if ($env:AO_WORKER_MESSAGE_SUBMIT_STATE) { return $env:AO_WORKER_MESSAGE_SUBMIT_STATE }
    return Join-Path ([System.IO.Path]::GetTempPath()) 'orchestrator-worker-message-submit-state.json'
}

function Write-SubmitReconcileLog {
    param([string]$Message)
    $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    Write-Host "[$stamp] $($Script:ReconcileLogPrefix): $Message"
}

$Script:SubmitReconcileDefaultState = @{ deliveries = @{}; failedDeliveries = @{}; audit = @(); lastTickMs = $null }

function Get-SubmitReconcileState {
    param(
        [string]$Path,
        [string]$JournalPath = ''
    )

    $state = Get-MechanicalJsonStateFile -Path $Path -DefaultState $Script:SubmitReconcileDefaultState -ActionTracking
    $identity = Get-SubmitReconcileStateRootIdentity -StatePath $Path -JournalPath $JournalPath
    $storedIdentity = [string]$state.stateRootIdentity
    $activeDeliveryCount = Get-SubmitReconcileActiveDeliveryCount -Deliveries $state.deliveries
    if ($storedIdentity -and $storedIdentity -ne $identity) {
        if ($activeDeliveryCount -gt 0) {
            $state['_recovery'] = @{
                fenceTrusted = $false
                reason       = 'wrong_state_root_active_deliveries'
                quarantined  = $Path
            }
        }
        else {
            $state.stateRootIdentity = $identity
        }
    }
    elseif (-not $storedIdentity) {
        $anchor = Read-SubmitReconcileStateRootAnchor -Path (Get-SubmitReconcileStateRootAnchorPath -JournalPath $JournalPath)
        $anchorActive = if ($anchor) { [int]$anchor.activeDeliveryCount } else { 0 }
        if ($anchorActive -gt 0) {
            $anchorStatePath = Resolve-SubmitReconcileStatePathLiteral -Path ([string]$anchor.statePath)
            $currentStatePath = Resolve-SubmitReconcileStatePathLiteral -Path $Path
            $anchorIdentity = [string]$anchor.stateRootIdentity
            if (($anchorStatePath -and $currentStatePath -and $anchorStatePath -ne $currentStatePath) -or
                ($anchorIdentity -and $anchorIdentity -ne $identity)) {
                $state['_recovery'] = @{
                    fenceTrusted = $false
                    reason       = 'wrong_state_root_active_deliveries'
                    quarantined  = $Path
                }
            }
            else {
                $state.stateRootIdentity = $identity
            }
        }
        else {
            $state.stateRootIdentity = $identity
        }
    }
    return (Invoke-SubmitReconcileStateRootReSeatIfEligible -State $state -Path $Path -JournalPath $JournalPath -Identity $identity)
}


function Merge-SubmitAdoptionTrackingFields {
    param(
        [object]$Target,
        [object]$Source
    )

    foreach ($name in @('adoptionStatus', 'adoptionEpochHash', 'adoptionConfigPathHash', 'lastAdoptionEscalationKey', 'stateRootIdentity')) {
        $value = $null
        if ($Source -is [System.Collections.IDictionary] -and $Source.Contains($name)) {
            $value = $Source[$name]
        }
        elseif ($null -ne $Source -and ($Source.PSObject.Properties.Name -contains $name)) {
            $value = $Source.$name
        }
        if ($null -eq $value -or "$value" -eq '') { continue }
        if ($Target -is [System.Collections.IDictionary]) {
            $Target[$name] = $value
        }
        else {
            $Target | Add-Member -NotePropertyName $name -NotePropertyValue $value -Force
        }
    }
    return $Target
}

function Invoke-SubmitAdoptionPreflightObservation {
    param(
        [string]$JournalPath,
        [string]$StatePath,
        [object]$Tracking,
        [switch]$DryRunMode
    )

    if ($DryRunMode) {
        return @{ tracking = $Tracking; escalated = 0 }
    }

    $binding = Get-WorkerMessageAdoptionBinding -PackRoot $PackRoot
    $preflight = Test-WorkerMessageSendAdoptionPreflight `
        -JournalPath $JournalPath `
        -AoEpoch $binding.AoEpoch `
        -ConfigPath $binding.ConfigPath `
        -PersistState

    $nextTracking = if ($Tracking) { $Tracking } else { Get-SubmitReconcileState -Path $StatePath -JournalPath $JournalPath }
    if ($preflight.ok) {
        $nextTracking.adoptionEpochHash = [string]$preflight.aoEpochHash
        $nextTracking.adoptionConfigPathHash = [string]$preflight.configPathHash
        $nextTracking.adoptionStatus = 'adopted'
        return @{ tracking = $nextTracking; escalated = 0 }
    }

    $dedupeKey = "$($preflight.aoEpochHash):$($preflight.configPathHash):wrapper_not_adopted"
    $alreadyEscalated = [string]$nextTracking.lastAdoptionEscalationKey -eq $dedupeKey
    $escalated = 0
    if (-not $alreadyEscalated) {
        Write-SubmitReconcileLog $preflight.diagnosis
        $nextTracking.lastAdoptionEscalationKey = $dedupeKey
        $escalated = 1
    }
    $nextTracking.adoptionStatus = 'wrapper_not_adopted'
    $nextTracking.adoptionEpochHash = [string]$preflight.aoEpochHash
    $nextTracking.adoptionConfigPathHash = [string]$preflight.configPathHash

    return @{
        tracking   = $nextTracking
        escalated  = $escalated
        reason     = [string]$preflight.reason
        diagnosis  = [string]$preflight.diagnosis
    }
}

function Set-SubmitReconcileState {
    param(
        [string]$Path,
        [object]$State,
        [string]$JournalPath = ''
    )

    Set-MechanicalJsonStateFile -Path $Path -State $State -DefaultState $Script:SubmitReconcileDefaultState -JsonDepth 30
    Write-SubmitReconcileStateRootAnchor -Path (Get-SubmitReconcileStateRootAnchorPath -JournalPath $JournalPath) -StatePath $Path -State $State
}

function Set-SubmitReconcileHeartbeat {
    param(
        [string]$Path,
        [string]$JournalPath = '',
        [long]$NowMs = 0
    )

    if ($NowMs -le 0) {
        $NowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }
    $state = Get-SubmitReconcileState -Path $Path -JournalPath $JournalPath
    if (-not $state) { return $null }
    $state.lastTickMs = $NowMs
    Set-MechanicalJsonStateFile -Path $Path -State $state -DefaultState $Script:SubmitReconcileDefaultState -JsonDepth 30
    return $state
}

function Get-FixtureSubmitPayload {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Fixture not found: $Path"
    }
    return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
}

function Get-SubmitBusyDispatchConfig {
    param([string]$MarkerPath)

    if (-not (Test-Path -LiteralPath $MarkerPath -PathType Leaf)) {
        throw "Busy-dispatch smoke marker file not found: $MarkerPath"
    }

    $markerConfig = Get-Content -LiteralPath $MarkerPath -Raw | ConvertFrom-Json
    if ($null -eq $markerConfig.markers) {
        throw "Busy-dispatch smoke marker file must expose a markers array: $MarkerPath"
    }

    $busyDispatch = @{
        markers = @($markerConfig.markers)
    }
    if ($markerConfig.environment -and $markerConfig.environment -is [psobject]) {
        $busyDispatch.environment = $markerConfig.environment
    }

    return @{
        busyDispatch = $busyDispatch
    }
}

function Invoke-SubmitReconcileTick {
    param(
        [string]$Project,
        [string]$StatePath,
        [string]$JournalPath,
        [switch]$DryRunMode,
        [string]$Fixture,
        [long]$NowMs,
        [string]$ConfigYaml = ''
    )

    if ($Fixture) {
        $fixture = Get-FixtureSubmitPayload -Path $Fixture
        $sessions = @($fixture.sessions)
        $aoEvents = @($fixture.aoEvents)
        $reviewRuns = @($fixture.reviewRuns)
        $dispatchJournal = @{}
        if ($fixture.dispatchJournal) {
            foreach ($prop in $fixture.dispatchJournal.PSObject.Properties) {
                $dispatchJournal[$prop.Name] = $prop.Value
            }
        }
        $tracking = if ($fixture.tracking) { $fixture.tracking } else { Get-SubmitReconcileState -Path $StatePath -JournalPath $JournalPath }
        $now = if ($fixture.nowMs) { [long]$fixture.nowMs } else { $NowMs }
        $tickConfig = if ($fixture.config) { $fixture.config } else { @{} }
        $reactionMessages = @{}
        if ($fixture.reactionMessages) {
            foreach ($prop in $fixture.reactionMessages.PSObject.Properties) {
                $reactionMessages[$prop.Name] = [string]$prop.Value
            }
        }
        $reactionConfigUnavailable = [bool]$fixture.reactionConfigUnavailable
        if ($fixture.floodActiveSessions) {
            $floodActiveSessions = @{}
            foreach ($prop in $fixture.floodActiveSessions.PSObject.Properties) {
                $floodActiveSessions[$prop.Name] = [bool]$prop.Value
            }
        }
        else {
            $floodActiveSessions = Get-FloodActiveSessionMap -Events $aoEvents -NowMs $now
        }
    }
    else {
        $sessions = Get-AoStatusSessions
        $aoEvents = Get-AoEventsSince -SinceMinutes 30
        $reviewRuns = Get-AoReviewRuns -Project $Project
        $dispatchJournal = Get-WorkerMessageDispatchJournal -Path $JournalPath
        $tracking = Get-SubmitReconcileState -Path $StatePath -JournalPath $JournalPath
        Assert-MechanicalJsonStateFencesTrusted -State $tracking -Context 'side effects'
        $now = $NowMs
        $tickConfig = Get-SubmitBusyDispatchConfig -MarkerPath $BusyDispatchSmokeMarkerPath
        $operatorYamlPath = if ($ConfigYaml) { $ConfigYaml } else { Resolve-OperatorOrchestratorYamlPath -PackRoot $PackRoot }
        $reactionConfig = Get-ReactionMessagesFromYaml -PackRoot $PackRoot -YamlPath $operatorYamlPath
        $reactionMessages = @{}
        $reactionConfigUnavailable = $false
        if ($reactionConfig.ok) {
            foreach ($entry in $reactionConfig.messages.GetEnumerator()) {
                $reactionMessages[$entry.Key] = [string]$entry.Value
            }
        }
        else {
            $reactionConfigUnavailable = $true
        }
        $floodActiveSessions = Get-FloodActiveSessionMap -Events $aoEvents -NowMs $now
    }

    if ($reactionConfigUnavailable) {
        $reactionEvents = @($aoEvents | Where-Object {
                $_.kind -eq 'reaction.action_succeeded' -and
                $_.data -and $_.data.action -eq 'send-to-agent'
            })
        if ($reactionEvents.Count -gt 0) {
            Write-SubmitReconcileLog "deferred: reason=reaction_config_unavailable reactionEventCount=$($reactionEvents.Count)"
            return @{
                submitted = 0
                escalated = 0
                noop      = 0
                deferred  = 1
                tracking  = $tracking
            }
        }
    }

    $plan = Invoke-MechanicalNodeFilterCli -FilterCliPath $SubmitFilterCli -Subcommand 'plan' `
        -Payload @{
            sessions            = @($sessions)
            aoEvents            = @($aoEvents)
            reviewRuns          = @($reviewRuns)
            dispatchJournal     = $dispatchJournal
            reactionMessages    = $reactionMessages
            tracking            = $tracking
            floodActiveSessions = $floodActiveSessions
            nowMs               = $now
            config              = $tickConfig
        } -Label $Script:ReconcileLogPrefix -JsonDepth 30

    $submitted = 0
    $escalated = 0
    $noop = 0
    $submitOutcomes = @()
    $tracking = $plan.tracking

    if ($plan.PSObject.Properties.Name -contains 'dispatchJournal' -and $null -ne $plan.dispatchJournal) {
        if (-not $DryRunMode -and -not $Fixture) {
            $compactResult = Compact-WorkerMessageDispatchJournal -JournalPath $JournalPath -NowMs $now
            if (-not $compactResult.ok) {
                Write-SubmitReconcileLog "dispatch journal compaction skipped: reason=$($compactResult.reason)"
            }
        }
    }

    $reactionObservation = Invoke-MechanicalNodeFilterCli -FilterCliPath (Join-Path $PackRoot 'docs/worker-message-dispatch-observe.mjs') -Subcommand 'observe' `
        -Payload @{
            aoEvents         = @($aoEvents)
            dispatchJournal  = $dispatchJournal
            reviewRuns       = @($reviewRuns)
            reactionMessages = $reactionMessages
            nowMs            = $now
        } -Label $Script:ReconcileLogPrefix -JsonDepth 10
    foreach ($audit in @($reactionObservation.reactionAudits)) {
        $reactionKey = [string]$audit.reactionKey
        $reason = [string]$audit.reason
        if ($reason) {
            Write-SubmitReconcileLog "reaction observation: reason=$reason reactionKey=$reactionKey"
        }
    }

    foreach ($action in @($plan.actions)) {
        switch ($action.type) {
            'submit' {
                if (-not $DryRunMode -and -not $Fixture) {
                    Set-SubmitReconcileState -Path $StatePath -State $tracking
                }
                if ($DryRunMode -or $Fixture) {
                    $submitResult = Invoke-WorkerInputDraftSubmit `
                        -SessionId $action.sessionId `
                        -ExpectedSessionId $action.sessionId `
                        -DryRun
                }
                else {
                    $lockPath = Get-OrchestratorSideEffectLockPath -LockFileName 'worker-message-submit-side-effect.lock'
                    Write-OrchestratorSideProcessProgress -ChildId 'worker-message-submit-reconcile' -Phase 'side_effect'
                    $submitHolder = @{ result = $null }
                    $fenced = Invoke-OrchestratorSideEffectFenced -LockPath $lockPath -Action {
                        $submitHolder.result = Invoke-WorkerInputDraftSubmit `
                            -SessionId $action.sessionId `
                            -ExpectedSessionId $action.sessionId
                    }
                    if (-not $fenced.ok) {
                        Write-SubmitReconcileLog "submit skipped (side-effect busy): delivery=$($action.deliveryId) session=$($action.sessionId)"
                        $submitResult = @{ submitted = $false; reason = 'side_effect_busy' }
                    }
                    elseif (-not $submitHolder.result) {
                        $submitResult = @{ submitted = $false; reason = 'submit_result_missing' }
                    }
                    else {
                        $submitResult = $submitHolder.result
                    }
                }
                if ($submitResult.submitted) {
                    Write-SubmitReconcileLog "submitted: delivery=$($action.deliveryId) session=$($action.sessionId) attempt=$($action.attempt) claim=$($action.claimKey)"
                    $submitted++
                    $submitOutcomes += @{
                        deliveryId = [string]$action.deliveryId
                        claimKey   = [string]$action.claimKey
                        outcome    = 'confirmed'
                    }
                }
                else {
                    Write-SubmitReconcileLog "submit failed (fail-closed): delivery=$($action.deliveryId) reason=$($submitResult.reason)"
                    $noop++
                    $submitOutcomes += @{
                        deliveryId = [string]$action.deliveryId
                        claimKey   = [string]$action.claimKey
                        outcome    = 'released'
                        reason     = [string]$submitResult.reason
                    }
                }
            }
            'escalate' {
                Write-SubmitReconcileLog $action.diagnosis
                $deliveryId = [string]$action.deliveryId
                $corr = "corr:submit:$deliveryId"
                $dedupe = "dedupe:submit:$deliveryId`:adoption"
                Invoke-OrchestratorEscalationEmit -EscalationClassId 'escalation-submit-adoption' `
                    -SourceProcess 'worker-message-submit-reconcile' -CorrelationKey $corr -DedupeKey $dedupe `
                    -Diagnosis @{ deliveryId = $deliveryId; diagnosis = $action.diagnosis; reason = $action.reason } | Out-Null
                $escalated++
            }
            'mark_consumed' {
                Write-SubmitReconcileLog "consumed: delivery=$($action.deliveryId) session=$($action.sessionId)"
            }
            'defer' {
                Write-SubmitReconcileLog "deferred: delivery=$($action.deliveryId) reason=$($action.reason)"
            }
            default {
                Write-SubmitReconcileLog "noop: delivery=$($action.deliveryId) reason=$($action.reason)"
                $noop++
            }
        }
    }

    if ($submitOutcomes.Count -gt 0) {
        $outcomeResult = Invoke-MechanicalNodeFilterCli -FilterCliPath $SubmitFilterCli -Subcommand 'outcome' `
            -Payload @{
                tracking = $tracking
                outcomes = @($submitOutcomes)
                nowMs    = $now
            } -Label $Script:ReconcileLogPrefix -JsonDepth 30
        $tracking = $outcomeResult.tracking
    }

    return @{
        tracking  = $tracking
        submitted = $submitted
        escalated = $escalated
        noop      = $noop
    }
}

$configYaml = Resolve-OperatorOrchestratorYamlPath -YamlPathOverride $YamlPath -PackRoot $PackRoot

$intervalSeconds = Get-SubmitReconcileIntervalSeconds
$intervalMs = [Math]::Max(1, $intervalSeconds) * 1000
$pollMs = [Math]::Max(5, $PollSeconds) * 1000
$statePath = Get-SubmitReconcileStatePath -CliPath $StateFile
$journalPath = if ($DispatchJournalPath) { $DispatchJournalPath } else { Get-WorkerMessageDispatchJournalPath }

Write-SubmitReconcileLog "starting (project=$ProjectId, interval=${intervalSeconds}s, state=$statePath, journal=$journalPath, dryRun=$DryRun, once=$Once, fixture=$FixturePath)"

if ($FixturePath) {
    if (-not $DryRun) {
        Write-SubmitReconcileLog 'fixture mode: enforcing dry-run (no live submit side effects)'
    }
    $result = Invoke-SubmitReconcileTick -Project $ProjectId -StatePath $statePath -JournalPath $journalPath `
        -DryRunMode -Fixture $FixturePath -NowMs ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) -ConfigYaml $configYaml
    Write-SubmitReconcileLog "fixture tick complete (submitted=$($result.submitted) escalated=$($result.escalated) noop=$($result.noop))"
    exit 0
}

$tickFailed = $false

try {
    do {
        $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        $state = Get-SubmitReconcileState -Path $statePath -JournalPath $journalPath
        if (-not $DryRun) {
            Set-SubmitReconcileState -Path $statePath -State $state -JournalPath $journalPath
        }
        $lastTickMs = $null
        if ($state.lastTickMs) {
            $lastTickMs = [long]$state.lastTickMs
        }

        $gate = Invoke-MechanicalNodeFilterCli -FilterCliPath $SubmitFilterCli -Subcommand 'interval' `
            -Payload @{
                nowMs      = $nowMs
                lastTickMs = $lastTickMs
                intervalMs = $intervalMs
            } -Label $Script:ReconcileLogPrefix

        Write-OrchestratorSideProcessProgress -ChildId 'worker-message-submit-reconcile' -Phase 'poll'
        if (-not $gate.ok) {
            Write-SubmitReconcileLog "tick skipped: $($gate.reason)"
        }
        else {
            try {
                $adoptionTickError = ''
                $adoptionObservation = Invoke-SubmitAdoptionPreflightObservation `
                    -JournalPath $journalPath `
                    -StatePath $statePath `
                    -Tracking $state `
                    -DryRunMode:$DryRun
                if ($adoptionObservation.escalated -gt 0 -and $adoptionObservation.diagnosis) {
                    $adoptionTickError = [string]$adoptionObservation.diagnosis
                    $corr = 'corr:submit:adoption-preflight'
                    $dedupe = "dedupe:submit:adoption:$($adoptionObservation.reason)"
                    Invoke-OrchestratorEscalationEmit -EscalationClassId 'escalation-submit-adoption' `
                        -SourceProcess 'worker-message-submit-reconcile' -CorrelationKey $corr -DedupeKey $dedupe `
                        -Diagnosis @{ diagnosis = $adoptionObservation.diagnosis; reason = $adoptionObservation.reason } | Out-Null
                }
                $state = $adoptionObservation.tracking
                if (-not $DryRun) {
                    Set-SubmitReconcileState -Path $statePath -State $state -JournalPath $journalPath
                }
                $result = Invoke-SubmitReconcileTick -Project $ProjectId -StatePath $statePath `
                    -JournalPath $journalPath -DryRunMode:$DryRun -NowMs $nowMs -ConfigYaml $configYaml
                $result.tracking = Merge-SubmitAdoptionTrackingFields -Target $result.tracking -Source $state
                if (-not $DryRun) {
                    Set-SubmitReconcileState -Path $statePath -State $result.tracking -JournalPath $journalPath
                }
                $totalEscalated = $result.escalated + $adoptionObservation.escalated
                Write-SubmitReconcileLog "tick complete (submitted=$($result.submitted) escalated=$totalEscalated noop=$($result.noop) adoption=$($adoptionObservation.reason))"
                if ($adoptionObservation.escalated -gt 0 -and $adoptionObservation.diagnosis) {
                    Write-OrchestratorSideProcessTickError -ChildId 'worker-message-submit-reconcile' -ErrorMessage $adoptionObservation.diagnosis
                }
                else {
                    Write-OrchestratorSideProcessTickSuccess -ChildId 'worker-message-submit-reconcile'
                }
            }
            catch {
                $tickFailed = $true
                Write-SubmitReconcileLog "tick failed: $_"
                if (-not $DryRun) {
                    Set-SubmitReconcileHeartbeat -Path $statePath -JournalPath $journalPath -NowMs $nowMs | Out-Null
                }
                $tickError = if ($adoptionTickError) { $adoptionTickError } else { "$_" }
                Write-OrchestratorSideProcessTickError -ChildId 'worker-message-submit-reconcile' -ErrorMessage $tickError
                if ($Once) { throw }
            }
        }
        if ($Once) { break }
        Start-Sleep -Milliseconds $pollMs
    } while ($true)
}
finally {
    if ($Once -and $tickFailed) {
        exit 1
    }
}
