#requires -Version 5.1
<#
.SYNOPSIS
  Inventory-driven fail-closed protection for live-default pack stores (Issue #752).
#>

$Script:OpkVitestStoreInventoryPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'vitest-live-store-inventory.json'
$Script:OpkVitestStoreBreakpoints = @()
$Script:OpkVitestStoreInventory = $null

function Test-OpkVitestHarnessMarkerActive {
    return $env:OPK_VITEST_HARNESS -eq '1'
}

function Expand-OpkVitestStoreTemplate {
    param([string]$Template)

    $homeRoot = if ($env:OPK_VITEST_PRODUCTION_HOME) { $env:OPK_VITEST_PRODUCTION_HOME } elseif ($env:HOME) { $env:HOME } else { [Environment]::GetFolderPath('UserProfile') }
    $tempRoot = if ($env:OPK_VITEST_PRODUCTION_TMP) { $env:OPK_VITEST_PRODUCTION_TMP } elseif ($env:TMPDIR) { $env:TMPDIR } elseif ($env:TEMP) { $env:TEMP } elseif ($env:TMP) { $env:TMP } else { [System.IO.Path]::GetTempPath() }
    return ([string]$Template).Replace('${HOME}', $homeRoot).Replace('${TMP}', $tempRoot)
}

function Resolve-OpkVitestCanonicalPath {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) { return '' }
    $expanded = [Environment]::ExpandEnvironmentVariables(([string]$Path).Trim())
    if ($expanded -eq '~' -or $expanded.StartsWith('~/') -or $expanded.StartsWith('~\')) {
        $homeRoot = if ($env:HOME) { $env:HOME } else { [Environment]::GetFolderPath('UserProfile') }
        $expanded = Join-Path $homeRoot $expanded.Substring(1).TrimStart('/', '\')
    }
    $absolute = [System.IO.Path]::GetFullPath($expanded)
    $cursor = $absolute
    $suffix = New-Object System.Collections.Generic.List[string]
    while (-not (Test-Path -LiteralPath $cursor)) {
        $leaf = Split-Path -Leaf $cursor
        if ($leaf) { $suffix.Insert(0, $leaf) }
        $parent = Split-Path -Parent $cursor
        if (-not $parent -or $parent -eq $cursor) { break }
        $cursor = $parent
    }
    if (Test-Path -LiteralPath $cursor) {
        try { $cursor = (Resolve-Path -LiteralPath $cursor -ErrorAction Stop).Path } catch { }
    }
    foreach ($part in $suffix) { $cursor = Join-Path $cursor $part }
    if ($IsWindows -or $env:OS -eq 'Windows_NT') { return $cursor.ToLowerInvariant() }
    return $cursor
}

function Test-OpkVitestPathWithin {
    param([string]$Candidate, [string]$Root)

    if (-not $Candidate -or -not $Root) { return $false }
    if ($Candidate -eq $Root) { return $true }
    $separator = [System.IO.Path]::DirectorySeparatorChar
    return $Candidate.StartsWith($Root.TrimEnd('/', '\') + $separator, $(if ($IsWindows -or $env:OS -eq 'Windows_NT') { [System.StringComparison]::OrdinalIgnoreCase } else { [System.StringComparison]::Ordinal }))
}

function ConvertTo-OpkVitestGlobRegex {
    param([string]$Pattern)

    $escaped = [regex]::Escape(([string]$Pattern).Replace('\', '/'))
    $escaped = $escaped.Replace('\*\*', '.*').Replace('\*', '[^/]*')
    return '^' + $escaped + '$'
}

function Get-OpkVitestStoreInventory {
    if ($Script:OpkVitestStoreInventory) { return $Script:OpkVitestStoreInventory }
    if (-not (Test-Path -LiteralPath $Script:OpkVitestStoreInventoryPath -PathType Leaf)) {
        throw "vitest live-store inventory missing: $Script:OpkVitestStoreInventoryPath"
    }
    $Script:OpkVitestStoreInventory = Get-Content -LiteralPath $Script:OpkVitestStoreInventoryPath -Raw | ConvertFrom-Json
    return $Script:OpkVitestStoreInventory
}

function Find-OpkVitestLiveStoreMatch {
    param([string]$Path)

    $candidate = Resolve-OpkVitestCanonicalPath -Path $Path
    if (-not $candidate) { return $null }
    $inventory = Get-OpkVitestStoreInventory
    foreach ($store in @($inventory.stores)) {
        if ($store.excluded) { continue }
        $defaultPath = Resolve-OpkVitestCanonicalPath -Path (Expand-OpkVitestStoreTemplate -Template ([string]$store.canonicalDefault))
        if ([string]$store.kind -eq 'directory' -and (Test-OpkVitestPathWithin -Candidate $candidate -Root $defaultPath)) {
            return @{ storeId = [string]$store.id; reason = 'live_store_directory' }
        }
        if ($candidate -eq $defaultPath) {
            return @{ storeId = [string]$store.id; reason = 'live_store_default' }
        }
        $candidateParent = Split-Path -Parent $candidate
        $defaultParent = Split-Path -Parent $defaultPath
        if ($candidateParent -eq $defaultParent) {
            $leaf = (Split-Path -Leaf $candidate).Replace('\', '/')
            foreach ($pattern in @($store.sidecars)) {
                if ($leaf -match (ConvertTo-OpkVitestGlobRegex -Pattern ([string]$pattern))) {
                    return @{ storeId = [string]$store.id; reason = 'live_store_sidecar' }
                }
            }
        }
    }
    foreach ($root in @($inventory.liveRoots)) {
        $defaultRoot = Resolve-OpkVitestCanonicalPath -Path (Expand-OpkVitestStoreTemplate -Template ([string]$root.defaultTemplate))
        if (Test-OpkVitestPathWithin -Candidate $candidate -Root $defaultRoot) {
            return @{ storeId = [string]$root.id; reason = 'live_store_root' }
        }
    }
    return $null
}

function Assert-OpkVitestStorePathSafe {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [string]$Operation = 'write'
    )

    if (-not (Test-OpkVitestHarnessMarkerActive)) { return }
    $match = Find-OpkVitestLiveStoreMatch -Path $Path
    if (-not $match) { return }
    throw "OPK_VITEST_LIVE_STORE_BLOCKED operation=$Operation store=$($match.storeId)"
}

function Get-OpkVitestWakeDefaultRoot {
    if ($env:ORCHESTRATOR_PACK_WAKE_SUPERVISOR_STATE_DIR) { return $env:ORCHESTRATOR_PACK_WAKE_SUPERVISOR_STATE_DIR }
    $homeRoot = if ($env:HOME) { $env:HOME } else { [Environment]::GetFolderPath('UserProfile') }
    return Join-Path $homeRoot '.local/state/orchestrator-pack-wake-supervisor'
}

function Get-OpkVitestBoundValue {
    param([object]$BoundParameters, [string[]]$Names)
    foreach ($name in $Names) {
        if ($BoundParameters -and $BoundParameters.ContainsKey($name)) {
            $value = [string]$BoundParameters[$name]
            if ($value) { return $value }
        }
    }
    return ''
}

function Resolve-OpkVitestBreakpointCandidate {
    param([string]$CommandName, [object]$BoundParameters)

    $explicitPath = Get-OpkVitestBoundValue -BoundParameters $BoundParameters -Names @('LiteralPath', 'Path', 'FilePath', 'StatePath', 'StorePath', 'JournalPath', 'WatchPath')
    switch ($CommandName) {
        'Move-Item' {
            $source = Get-OpkVitestBoundValue -BoundParameters $BoundParameters -Names @('LiteralPath', 'Path')
            $destination = Get-OpkVitestBoundValue -BoundParameters $BoundParameters -Names @('Destination')
            return @($source, $destination) | Where-Object { $_ }
        }
        'Copy-Item' {
            $destination = Get-OpkVitestBoundValue -BoundParameters $BoundParameters -Names @('Destination')
            return @($destination) | Where-Object { $_ }
        }
        'New-Item' {
            $parent = Get-OpkVitestBoundValue -BoundParameters $BoundParameters -Names @('Path', 'LiteralPath')
            $nameValue = Get-OpkVitestBoundValue -BoundParameters $BoundParameters -Names @('Name')
            if ($parent -and $nameValue) { return @($parent, (Join-Path $parent $nameValue)) }
            return $parent
        }
        'Rename-Item' {
            return Get-OpkVitestBoundValue -BoundParameters $BoundParameters -Names @('LiteralPath', 'Path')
        }
        'Get-OrchestratorEscalationStatePath' {
            $explicit = Get-OpkVitestBoundValue -BoundParameters $BoundParameters -Names @('StatePath')
            if ($explicit) { return $explicit }
            if ($env:AO_ORCHESTRATOR_ESCALATION_STATE) { return $env:AO_ORCHESTRATOR_ESCALATION_STATE }
            return Join-Path ([System.IO.Path]::GetTempPath()) 'orchestrator-escalation-state.json'
        }
        'Get-OrchestratorEscalationOperatorInboxDir' {
            $explicit = Get-OpkVitestBoundValue -BoundParameters $BoundParameters -Names @('OperatorInboxDir')
            if ($explicit) { return $explicit }
            if ($env:AO_OPERATOR_ESCALATION_INBOX) { return $env:AO_OPERATOR_ESCALATION_INBOX }
            return Join-Path ([System.IO.Path]::GetTempPath()) 'orchestrator-operator-inbox'
        }
        'Get-OrchestratorEscalationHealthSpoolDir' {
            $explicit = Get-OpkVitestBoundValue -BoundParameters $BoundParameters -Names @('HealthSpoolDir')
            if ($explicit) { return $explicit }
            if ($env:AO_ESCALATION_HEALTH_SPOOL) { return $env:AO_ESCALATION_HEALTH_SPOOL }
            return Join-Path ([System.IO.Path]::GetTempPath()) 'orchestrator-escalation-health'
        }
        'Get-WorkerMessageDispatchJournalPath' {
            if ($env:AO_WORKER_MESSAGE_DISPATCH_JOURNAL) { return $env:AO_WORKER_MESSAGE_DISPATCH_JOURNAL }
            return Join-Path (Get-OpkVitestWakeDefaultRoot) 'worker-message-dispatch-journal.json'
        }
        'Get-SubmitReconcileStatePath' {
            $explicit = Get-OpkVitestBoundValue -BoundParameters $BoundParameters -Names @('CliPath')
            if ($explicit) { return $explicit }
            if ($env:AO_WORKER_MESSAGE_SUBMIT_STATE) { return $env:AO_WORKER_MESSAGE_SUBMIT_STATE }
            return Join-Path ([System.IO.Path]::GetTempPath()) 'orchestrator-worker-message-submit-state.json'
        }
        'Get-SubmitReconcileStateRootAnchorPath' {
            if ($env:AO_SIDE_PROCESS_STATE_DIR) { return Join-Path $env:AO_SIDE_PROCESS_STATE_DIR 'worker-message-submit-state-root.anchor.json' }
            return Join-Path (Get-OpkVitestWakeDefaultRoot) 'worker-message-submit-state-root.anchor.json'
        }
        'Get-WorkerStatusStorePath' {
            if ($env:AO_WORKER_STATUS_STORE) { return $env:AO_WORKER_STATUS_STORE }
            return Join-Path (Get-OpkVitestWakeDefaultRoot) 'worker-status-store.json'
        }
        'Get-ReviewDeliveryLifecycleStorePath' { return Join-Path (Get-OpkVitestWakeDefaultRoot) 'review-delivery-lifecycle.json' }
        'Get-ReviewHandoffWakeAdmissionPath' {
            $root = Get-OpkVitestBoundValue -BoundParameters $BoundParameters -Names @('StateRoot')
            if ($root) { return Join-Path $root 'review-handoff-wake-admission.json' }
            if ($env:AO_REVIEW_HANDOFF_WAKE_ADMISSION_STATE) { return $env:AO_REVIEW_HANDOFF_WAKE_ADMISSION_STATE }
            return Join-Path ([System.IO.Path]::GetTempPath()) 'orchestrator-review-handoff-wake-admission.json'
        }
        'Get-ReviewReadyReportStateSeedStatePath' {
            $root = Get-OpkVitestBoundValue -BoundParameters $BoundParameters -Names @('StateRoot')
            if ($root) { return Join-Path $root 'review-ready-report-state-seed-state.json' }
            if ($env:AO_REPORT_STATE_SEED_STATE) { return $env:AO_REPORT_STATE_SEED_STATE }
            return Join-Path ([System.IO.Path]::GetTempPath()) 'orchestrator-review-ready-report-state-seed-state.json'
        }
        'Get-ReviewTriggerReevalWatchPath' {
            $root = Get-OpkVitestBoundValue -BoundParameters $BoundParameters -Names @('StateRoot')
            if ($root) { return Join-Path $root 'review-trigger-reeval-watch.json' }
            if ($env:AO_REVIEW_TRIGGER_REEVAL_WATCH_STATE) { return $env:AO_REVIEW_TRIGGER_REEVAL_WATCH_STATE }
            return Join-Path ([System.IO.Path]::GetTempPath()) 'orchestrator-review-trigger-reeval-watch.json'
        }
        'Resolve-ReviewStartClaimNamespace' {
            $namespace = Get-OpkVitestBoundValue -BoundParameters $BoundParameters -Names @('Namespace')
            if ($namespace) { return $namespace }
            if ($env:AO_REVIEW_CLAIM_DIR) { return $env:AO_REVIEW_CLAIM_DIR }
            $base = if ($env:AO_BASE_DIR) { $env:AO_BASE_DIR } else { Join-Path $HOME '.agent-orchestrator' }
            return Join-Path $base 'projects/orchestrator-pack/review-start-claims'
        }
        'Resolve-WorkerNudgeClaimNamespace' {
            $namespace = Get-OpkVitestBoundValue -BoundParameters $BoundParameters -Names @('Namespace')
            if ($namespace) { return $namespace }
            if ($env:AO_WORKER_NUDGE_CLAIM_DIR) { return $env:AO_WORKER_NUDGE_CLAIM_DIR }
            $base = if ($env:AO_BASE_DIR) { $env:AO_BASE_DIR } else { Join-Path $HOME '.agent-orchestrator' }
            return Join-Path $base 'projects/orchestrator-pack/worker-nudge-claims'
        }
        'Get-MechanicalTransportTempRoot' {
            if ($env:AO_MECHANICAL_TRANSPORT_TEMP) { return $env:AO_MECHANICAL_TRANSPORT_TEMP }
            return Join-Path $HOME '.orchestrator-mechanical-transport'
        }
        default { return $explicitPath }
    }
}

function Enable-OpkVitestStoreIsolation {
    if (-not (Test-OpkVitestHarnessMarkerActive)) { return }
    if ($Script:OpkVitestStoreBreakpoints.Count -gt 0) { return }

    $commands = @(
        'Set-Content',
        'Add-Content',
        'Out-File',
        'Clear-Content',
        'New-Item',
        'Remove-Item',
        'Move-Item',
        'Copy-Item',
        'Rename-Item',
        'Set-Acl',
        'Get-OrchestratorEscalationStatePath',
        'Get-OrchestratorEscalationOperatorInboxDir',
        'Get-OrchestratorEscalationHealthSpoolDir',
        'Get-WorkerMessageDispatchJournalPath',
        'Get-SubmitReconcileStatePath',
        'Get-SubmitReconcileStateRootAnchorPath',
        'Get-WorkerStatusStorePath',
        'Get-ReviewDeliveryLifecycleStorePath',
        'Get-ReviewHandoffWakeAdmissionPath',
        'Get-ReviewReadyReportStateSeedStatePath',
        'Get-ReviewTriggerReevalWatchPath',
        'Resolve-ReviewStartClaimNamespace',
        'Resolve-WorkerNudgeClaimNamespace',
        'Set-MechanicalJsonStateFile',
        'Set-WorkerMessageDispatchJournal',
        'Set-SubmitReconcileState',
        'Set-SubmitReconcileHeartbeat',
        'Write-SubmitReconcileStateRootAnchor',
        'Set-WorkerStatusStoreState',
        'Set-ReviewDeliveryLifecycleEntry',
        'Set-ReviewHandoffWakeAdmissionState',
        'Set-ReviewReadyReportStateSeedState',
        'Set-ReviewTriggerReevalWatchState',
        'Get-MechanicalTransportTempRoot',
        'Initialize-MechanicalTransportTempRoot',
        'Write-MechanicalTransportPrivateFile',
        'Write-MechanicalWorkerMessagePayloadFile',
        'Remove-StaleMechanicalTransportFiles'
    )

    foreach ($command in $commands) {
        $name = $command
        $action = {
            $bound = $PSDebugContext.InvocationInfo.BoundParameters
            $candidates = @(Resolve-OpkVitestBreakpointCandidate -CommandName $name -BoundParameters $bound)
            foreach ($candidate in $candidates) {
                if ($candidate) { Assert-OpkVitestStorePathSafe -Path ([string]$candidate) -Operation $name }
            }
        }.GetNewClosure()
        try {
            $Script:OpkVitestStoreBreakpoints += Set-PSBreakpoint -Command $command -Action $action
        }
        catch {
            throw "failed to install vitest live-store breakpoint for $command`: $_"
        }
    }
}
