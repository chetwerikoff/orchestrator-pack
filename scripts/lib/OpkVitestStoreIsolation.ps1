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

function Get-OpkVitestProductionHome {
    if ($env:OPK_VITEST_PRODUCTION_HOME) { return $env:OPK_VITEST_PRODUCTION_HOME }
    if ($env:HOME) { return $env:HOME }
    return [Environment]::GetFolderPath('UserProfile')
}

function Get-OpkVitestProductionTemp {
    if ($env:OPK_VITEST_PRODUCTION_TMP) { return $env:OPK_VITEST_PRODUCTION_TMP }
    if ($env:TMPDIR) { return $env:TMPDIR }
    if ($env:TEMP) { return $env:TEMP }
    if ($env:TMP) { return $env:TMP }
    return [System.IO.Path]::GetTempPath()
}

function Get-OpkVitestProductionAoBase {
    if ($env:OPK_VITEST_PRODUCTION_AO_BASE) { return $env:OPK_VITEST_PRODUCTION_AO_BASE }
    if ($env:AO_BASE_DIR) { return $env:AO_BASE_DIR }
    return Join-Path (Get-OpkVitestProductionHome) '.agent-orchestrator'
}

function Get-OpkVitestProductionWakeRoot {
    if ($env:OPK_VITEST_PRODUCTION_WAKE_ROOT) { return $env:OPK_VITEST_PRODUCTION_WAKE_ROOT }
    if ($env:AO_WAKE_SUPERVISOR_STATE_DIR) { return $env:AO_WAKE_SUPERVISOR_STATE_DIR }
    if ($env:ORCHESTRATOR_PACK_WAKE_SUPERVISOR_STATE_DIR) { return $env:ORCHESTRATOR_PACK_WAKE_SUPERVISOR_STATE_DIR }
    if ($env:XDG_STATE_HOME) { return Join-Path $env:XDG_STATE_HOME 'orchestrator-pack-wake-supervisor' }
    if ($env:LOCALAPPDATA) { return Join-Path $env:LOCALAPPDATA 'orchestrator-pack-wake-supervisor' }
    return Join-Path (Join-Path (Join-Path (Get-OpkVitestProductionHome) '.local') 'state') 'orchestrator-pack-wake-supervisor'
}

function Expand-OpkVitestStoreTemplate {
    param([string]$Template)

    $expanded = [string]$Template
    $expanded = $expanded.Replace('${HOME}', (Get-OpkVitestProductionHome))
    $expanded = $expanded.Replace('${TMP}', (Get-OpkVitestProductionTemp))
    $expanded = $expanded.Replace('${AO_BASE}', (Get-OpkVitestProductionAoBase))
    $expanded = $expanded.Replace('${WAKE_STATE}', (Get-OpkVitestProductionWakeRoot))
    return $expanded
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
    $comparison = if ($IsWindows -or $env:OS -eq 'Windows_NT') {
        [System.StringComparison]::OrdinalIgnoreCase
    }
    else {
        [System.StringComparison]::Ordinal
    }
    return $Candidate.StartsWith($Root.TrimEnd('/', '\') + $separator, $comparison)
}

function ConvertTo-OpkVitestGlobRegex {
    param([string]$Pattern)

    $escaped = [regex]::Escape(([string]$Pattern).Replace('\', '/'))
    $escaped = $escaped.Replace('\*\*', '.*').Replace('\*', '[^/]*')
    return '^' + $escaped + '$'
}

function Test-OpkVitestPatternPath {
    param([string]$Candidate, [string]$Root, [string[]]$Patterns)

    if ((Split-Path -Parent $Candidate) -ne $Root) { return $false }
    $leaf = (Split-Path -Leaf $Candidate).Replace('\', '/')
    foreach ($pattern in @($Patterns)) {
        if ($leaf -match (ConvertTo-OpkVitestGlobRegex -Pattern ([string]$pattern))) { return $true }
    }
    return $false
}

function Get-OpkVitestStoreInventory {
    if ($Script:OpkVitestStoreInventory) { return $Script:OpkVitestStoreInventory }
    if (-not (Test-Path -LiteralPath $Script:OpkVitestStoreInventoryPath -PathType Leaf)) {
        throw "vitest live-store inventory missing: $Script:OpkVitestStoreInventoryPath"
    }
    $Script:OpkVitestStoreInventory = Get-Content -LiteralPath $Script:OpkVitestStoreInventoryPath -Raw | ConvertFrom-Json
    return $Script:OpkVitestStoreInventory
}

function Get-OpkVitestOrderedStores {
    $inventory = Get-OpkVitestStoreInventory
    $nonDirectories = @($inventory.stores | Where-Object { -not $_.excluded -and [string]$_.kind -ne 'directory' })
    $directories = @($inventory.stores | Where-Object { -not $_.excluded -and [string]$_.kind -eq 'directory' } | Sort-Object { ([string]$_.canonicalDefault).Length } -Descending)
    return @($nonDirectories) + @($directories)
}

function Find-OpkVitestLiveStoreMatch {
    param([string]$Path)

    $candidate = Resolve-OpkVitestCanonicalPath -Path $Path
    if (-not $candidate) { return $null }
    $inventory = Get-OpkVitestStoreInventory
    foreach ($store in @(Get-OpkVitestOrderedStores)) {
        $defaultPath = Resolve-OpkVitestCanonicalPath -Path (Expand-OpkVitestStoreTemplate -Template ([string]$store.canonicalDefault))
        if ([string]$store.kind -eq 'directory') {
            if (Test-OpkVitestPathWithin -Candidate $candidate -Root $defaultPath) {
                return @{ storeId = [string]$store.id; reason = 'live_store_directory' }
            }
            continue
        }
        if ([string]$store.kind -eq 'pattern') {
            $patterns = @([string]$store.basenamePattern) + @($store.sidecars | ForEach-Object { [string]$_ })
            if (Test-OpkVitestPatternPath -Candidate $candidate -Root $defaultPath -Patterns $patterns) {
                return @{ storeId = [string]$store.id; reason = 'live_store_pattern' }
            }
            continue
        }
        if ($candidate -eq $defaultPath) {
            return @{ storeId = [string]$store.id; reason = 'live_store_default' }
        }
        if ((Split-Path -Parent $candidate) -eq (Split-Path -Parent $defaultPath)) {
            $leaf = (Split-Path -Leaf $candidate).Replace('\', '/')
            foreach ($pattern in @($store.sidecars)) {
                if ($leaf -match (ConvertTo-OpkVitestGlobRegex -Pattern ([string]$pattern))) {
                    return @{ storeId = [string]$store.id; reason = 'live_store_sidecar' }
                }
            }
        }
    }
    foreach ($fence in @($inventory.classFences)) {
        $rootPath = Resolve-OpkVitestCanonicalPath -Path (Expand-OpkVitestStoreTemplate -Template ([string]$fence.rootTemplate))
        if (Test-OpkVitestPatternPath -Candidate $candidate -Root $rootPath -Patterns @($fence.basenamePatterns)) {
            return @{ storeId = [string]$fence.id; reason = 'live_store_class_fence' }
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
    param([Parameter(Mandatory = $true)][string]$Path, [string]$Operation = 'write')

    if (-not (Test-OpkVitestHarnessMarkerActive)) { return }
    $match = Find-OpkVitestLiveStoreMatch -Path $Path
    if ($match) { throw "OPK_VITEST_LIVE_STORE_BLOCKED operation=$Operation store=$($match.storeId)" }
}

function Get-OpkVitestBoundValues {
    param([object]$BoundParameters, [string[]]$Names)

    $values = @()
    foreach ($name in $Names) {
        if ($BoundParameters -and $BoundParameters.ContainsKey($name)) {
            $value = [string]$BoundParameters[$name]
            if ($value) { $values += $value }
        }
    }
    return @($values)
}

function Get-OpkVitestResolverStores {
    param([string]$CommandName)

    $matches = @()
    foreach ($store in @((Get-OpkVitestStoreInventory).stores)) {
        $names = @([string]$store.resolver) + @($store.resolverAliases | ForEach-Object { [string]$_ })
        if ($names -contains $CommandName) { $matches += $store }
    }
    return @($matches)
}

function Resolve-OpkVitestBreakpointCandidates {
    param([string]$CommandName, [object]$BoundParameters)

    $pathNames = @(
        'LiteralPath', 'Path', 'FilePath', 'StatePath', 'StorePath', 'JournalPath',
        'WatchPath', 'LockPath', 'StateFile', 'CliPath', 'AuditRoot', 'Namespace',
        'StateRoot', 'RootDir', 'StoreDir', 'Directory', 'OperatorInboxDir',
        'HealthSpoolDir', 'CliOverride'
    )
    $explicit = @(Get-OpkVitestBoundValues -BoundParameters $BoundParameters -Names $pathNames)
    switch ($CommandName) {
        'Move-Item' {
            return @($explicit) + @(Get-OpkVitestBoundValues -BoundParameters $BoundParameters -Names @('Destination'))
        }
        'Copy-Item' {
            return @(Get-OpkVitestBoundValues -BoundParameters $BoundParameters -Names @('Destination'))
        }
        'New-Item' {
            $parent = @(Get-OpkVitestBoundValues -BoundParameters $BoundParameters -Names @('Path', 'LiteralPath')) | Select-Object -First 1
            $nameValue = @(Get-OpkVitestBoundValues -BoundParameters $BoundParameters -Names @('Name')) | Select-Object -First 1
            if ($parent -and $nameValue) { return @($parent, (Join-Path $parent $nameValue)) }
            return @($parent)
        }
        'Rename-Item' { return @($explicit) }
    }

    if ($explicit.Count -gt 0) { return $explicit }
    $resolverStores = @(Get-OpkVitestResolverStores -CommandName $CommandName)
    if ($resolverStores.Count -eq 0) { return @() }
    $candidates = @()
    foreach ($store in $resolverStores) {
        foreach ($envName in @($store.envOverrides)) {
            $value = [Environment]::GetEnvironmentVariable([string]$envName, 'Process')
            if (-not [string]::IsNullOrWhiteSpace($value)) { $candidates += $value }
        }
        if ($candidates.Count -eq 0) {
            $candidates += Expand-OpkVitestStoreTemplate -Template ([string]$store.canonicalDefault)
        }
    }
    return @($candidates | Select-Object -Unique)
}

function Enable-OpkVitestStoreIsolation {
    if (-not (Test-OpkVitestHarnessMarkerActive)) { return }
    if ($Script:OpkVitestStoreBreakpoints.Count -gt 0) { return }

    $writeCommands = @(
        'Set-Content', 'Add-Content', 'Out-File', 'Clear-Content', 'New-Item',
        'Remove-Item', 'Move-Item', 'Copy-Item', 'Rename-Item', 'Set-Acl',
        'Set-MechanicalJsonStateFile', 'Set-WorkerMessageDispatchJournal',
        'Set-SubmitReconcileState', 'Set-SubmitReconcileHeartbeat',
        'Write-SubmitReconcileStateRootAnchor', 'Set-WorkerStatusStoreState',
        'Set-ReviewDeliveryLifecycleEntry', 'Set-ReviewHandoffWakeAdmissionState',
        'Set-ReviewReadyReportStateSeedState', 'Set-ReviewTriggerReevalWatchState',
        'Set-CiGreenWakeState', 'Save-PartialCiGreenWakeTracking',
        'Set-DeadWorkerState', 'Set-ReconcileState',
        'New-OrchestratorSideEffectLockFile', 'Enter-OrchestratorSideEffectFence',
        'Write-OrchestratorReviewStartDenialAudit',
        'Write-OrchestratorReviewStartPreflightRefusal',
        'Write-ReviewStartPreflightShieldAudit', 'Write-WorkerNudgeGateAudit',
        'Initialize-MechanicalTransportTempRoot', 'Write-MechanicalTransportPrivateFile',
        'Write-MechanicalWorkerMessagePayloadFile', 'Remove-StaleMechanicalTransportFiles'
    )
    $resolverCommands = @()
    foreach ($store in @((Get-OpkVitestStoreInventory).stores)) {
        $resolverCommands += [string]$store.resolver
        $resolverCommands += @($store.resolverAliases | ForEach-Object { [string]$_ })
    }
    $commands = @($writeCommands + $resolverCommands | Where-Object { $_ } | Select-Object -Unique)

    foreach ($command in $commands) {
        $name = $command
        $action = {
            $bound = $PSDebugContext.InvocationInfo.BoundParameters
            foreach ($candidate in @(Resolve-OpkVitestBreakpointCandidates -CommandName $name -BoundParameters $bound)) {
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
