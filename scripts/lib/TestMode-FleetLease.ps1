#requires -Version 5.1
<#
  TestMode fleet lane lease records, stale predicates, and process identity (Issue #710).
#>

. (Join-Path $PSScriptRoot 'Orchestrator-ProcessAlive.ps1')

function Normalize-TestModeFleetPath {
    param([string]$PathValue)
    if ([string]::IsNullOrWhiteSpace($PathValue)) { return '' }
    try { return [System.IO.Path]::GetFullPath($PathValue) }
    catch { return $PathValue.Trim() }
}

function Get-TestModeFleetLeaseRoot {
    if ($env:OPK_TESTMODE_LEASE_ROOT) { return $env:OPK_TESTMODE_LEASE_ROOT.Trim() }
    $userHome = if ($env:HOME) { $env:HOME } else { [Environment]::GetFolderPath('UserProfile') }
    $stateBase = if ($env:XDG_STATE_HOME) { $env:XDG_STATE_HOME }
    elseif ($env:LOCALAPPDATA) { $env:LOCALAPPDATA }
    else { Join-Path $userHome '.local' 'state' }
    return Join-Path $stateBase 'opk-testmode-fleet-leases'
}

function Get-TestModeFleetLeaseIndexPath { Join-Path (Get-TestModeFleetLeaseRoot) 'index.json' }
function Get-TestModeFleetLeaseRecordPath {
    param([string]$LeaseId)
    Join-Path (Get-TestModeFleetLeaseRoot) "leases/$LeaseId.json"
}

function Get-TestModeFleetLeaseTtlSeconds {
    $parsed = 0
    if ($env:AO_TESTMODE_FLEET_LEASE_TTL_SECONDS -and [int]::TryParse($env:AO_TESTMODE_FLEET_LEASE_TTL_SECONDS, [ref]$parsed) -and $parsed -gt 0) { return $parsed }
    return 120
}
function Get-TestModeFleetLeaseHeartbeatGraceSeconds {
    $parsed = 0
    if ($env:AO_TESTMODE_FLEET_HEARTBEAT_GRACE_SECONDS -and [int]::TryParse($env:AO_TESTMODE_FLEET_HEARTBEAT_GRACE_SECONDS, [ref]$parsed) -and $parsed -gt 0) { return $parsed }
    return 20
}
function Get-TestModeFleetLeaseNoProgressSeconds {
    $parsed = 0
    if ($env:AO_TESTMODE_FLEET_NO_PROGRESS_SECONDS -and [int]::TryParse($env:AO_TESTMODE_FLEET_NO_PROGRESS_SECONDS, [ref]$parsed) -and $parsed -gt 0) { return $parsed }
    return 60
}

function Get-ProcessStartTimeIdentity {
    param([int]$ProcessId)
    if ($ProcessId -le 0) { return '' }
    if ($IsLinux) {
        $statPath = "/proc/$ProcessId/stat"
        if (-not (Test-Path -LiteralPath $statPath)) { return '' }
        try { $stat = [System.IO.File]::ReadAllText($statPath) } catch { return '' }
        $close = $stat.LastIndexOf(')')
        if ($close -lt 0) { return '' }
        $fields = ($stat.Substring($close + 2)).Trim() -split '\s+'
        if ($fields.Count -lt 20) { return '' }
        return [string]$fields[19]
    }
    if ($IsMacOS) {
        try {
            $out = & ps -p $ProcessId -o lstart= 2>$null
            return (($out | ForEach-Object { $_.ToString() }) -join ' ').Trim()
        } catch { return '' }
    }
    try { return (Get-Process -Id $ProcessId -ErrorAction Stop).StartTime.ToFileTimeUtc().ToString() }
    catch { return '' }
}

function Test-ProcessOwnerIdentityAlive {
    param([int]$OwnerPid, [string]$OwnerStartTime)
    if ($OwnerPid -le 0 -or -not (Test-ProcessAlive -ProcessId $OwnerPid)) { return $false }
    if ([string]::IsNullOrWhiteSpace($OwnerStartTime)) { return $false }
    $current = Get-ProcessStartTimeIdentity -ProcessId $OwnerPid
    return [bool]$current -and ($current -eq $OwnerStartTime)
}

function New-TestModeFleetLaneLeaseRecord {
    param([string]$RunId, [string]$LaneId, [int]$OwnerPid, [string]$OwnerStartTime, [string]$WorkspaceRoot = '')
    $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    return @{
        leaseId = [guid]::NewGuid().ToString('n'); runId = $RunId; laneId = $LaneId
        ownerPid = $OwnerPid; ownerStartTime = $OwnerStartTime
        heartbeatMs = $nowMs; progressCounter = 0; progressUpdatedMs = $nowMs
        createdMs = $nowMs; workspaceRoot = $WorkspaceRoot; stateRoots = @()
    }
}

function Write-TestModeFleetLeaseRecordAtomic {
    param([hashtable]$Record, [switch]$RegisterIndex)
    $root = Get-TestModeFleetLeaseRoot
    $leasesDir = Join-Path $root 'leases'
    if (-not (Test-Path -LiteralPath $leasesDir)) { New-Item -ItemType Directory -Path $leasesDir -Force | Out-Null }
    $leaseId = [string]$Record.leaseId
    if (-not $leaseId) { throw 'lease record missing leaseId' }
    $target = Get-TestModeFleetLeaseRecordPath -LeaseId $leaseId
    $temp = "$target.tmp"
    [System.IO.File]::WriteAllText($temp, ($Record | ConvertTo-Json -Depth 8 -Compress), [System.Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temp -Destination $target -Force
    if ($RegisterIndex) { Register-TestModeFleetLeaseInIndex -LeaseId $leaseId }
}

function Register-TestModeFleetLeaseInIndex {
    param([string]$LeaseId)
    $indexPath = Get-TestModeFleetLeaseIndexPath
    $indexDir = Split-Path -Parent $indexPath
    if (-not (Test-Path -LiteralPath $indexDir)) { New-Item -ItemType Directory -Path $indexDir -Force | Out-Null }
    $ids = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    if (Test-Path -LiteralPath $indexPath) {
        try {
            foreach ($entry in @((Get-Content -LiteralPath $indexPath -Raw | ConvertFrom-Json).leaseIds)) {
                if ($entry) { [void]$ids.Add([string]$entry) }
            }
        } catch { }
    }
    [void]$ids.Add($LeaseId)
    $temp = "$indexPath.tmp"
    [System.IO.File]::WriteAllText($temp, (@{ leaseIds = @($ids | Sort-Object) } | ConvertTo-Json -Compress), [System.Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temp -Destination $indexPath -Force
}

function Read-TestModeFleetLeaseRecord {
    param([string]$LeaseId)
    $path = Get-TestModeFleetLeaseRecordPath -LeaseId $LeaseId
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    try {
        $raw = (Get-Content -LiteralPath $path -Raw).Trim()
        if (-not $raw) { return $null }
        return $raw | ConvertFrom-Json
    } catch { return $null }
}

function Get-TestModeFleetLeaseRecordsFromIndex {
    $indexPath = Get-TestModeFleetLeaseIndexPath
    if (-not (Test-Path -LiteralPath $indexPath)) { return @() }
    try { $index = Get-Content -LiteralPath $indexPath -Raw | ConvertFrom-Json } catch { return @() }
    $records = [System.Collections.Generic.List[object]]::new()
    foreach ($leaseId in @($index.leaseIds)) {
        if (-not $leaseId) { continue }
        $record = Read-TestModeFleetLeaseRecord -LeaseId ([string]$leaseId)
        if ($record) { $records.Add($record) | Out-Null }
    }
    return @($records)
}


function Get-TestModeFleetIndexedLeaseIds {
    $indexPath = Get-TestModeFleetLeaseIndexPath
    if (-not (Test-Path -LiteralPath $indexPath)) { return @() }
    try { $index = Get-Content -LiteralPath $indexPath -Raw | ConvertFrom-Json } catch { return @() }
    $ids = [System.Collections.Generic.List[string]]::new()
    foreach ($leaseId in @($index.leaseIds)) {
        if ($leaseId) { $ids.Add([string]$leaseId) | Out-Null }
    }
    return @($ids)
}

function Get-TestModeVitestLaneContextFileName {
    param(
        [string]$Shard = '',
        [string]$LightLane = ''
    )

    if ($Shard) { return "vitest-lane-context-shard-$Shard.json" }
    if ($LightLane -eq '1') { return 'vitest-lane-context-light.json' }
    return 'vitest-lane-context.json'
}

function Get-TestModeVitestLaneContextPath {
    param(
        [string]$LeaseRoot = '',
        [string]$Shard = '',
        [string]$LightLane = ''
    )

    if (-not $LeaseRoot) { $LeaseRoot = Get-TestModeFleetLeaseRoot }
    $name = Get-TestModeVitestLaneContextFileName -Shard $Shard -LightLane $LightLane
    return Join-Path $LeaseRoot $name
}

function Read-TestModeVitestLaneLeaseContext {
    param(
        [string]$LeaseRoot = '',
        [string]$Shard = ''
    )

    $contexts = @(Get-TestModeVitestLaneLeaseContexts -Shard $Shard -LeaseRoot $LeaseRoot)
    if ($contexts.Count -eq 0) { return $null }

    $latest = $contexts[0]
    foreach ($ctx in $contexts) {
        $candidateMs = 0
        $latestMs = 0
        if ($ctx.PSObject.Properties.Name -contains 'writtenMs') {
            [void][long]::TryParse([string]$ctx.writtenMs, [ref]$candidateMs)
        }
        if ($latest.PSObject.Properties.Name -contains 'writtenMs') {
            [void][long]::TryParse([string]$latest.writtenMs, [ref]$latestMs)
        }
        if ($candidateMs -ge $latestMs) { $latest = $ctx }
    }
    return $latest
}


function Add-TestModeVitestLaneLeaseContextFromFile {
    param(
        [string]$Path,
        [System.Collections.Generic.HashSet[string]]$SeenLeaseIds,
        [System.Collections.Generic.List[object]]$Contexts
    )

    if (-not (Test-Path -LiteralPath $Path)) { return }
    try {
        $ctx = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
        $leaseId = [string]$ctx.leaseId
        if (-not $leaseId) { return }
        if ($SeenLeaseIds.Contains($leaseId)) { return }
        [void]$SeenLeaseIds.Add($leaseId)
        $Contexts.Add($ctx) | Out-Null
    }
    catch {
        return
    }
}

function Get-TestModeVitestLaneLeaseContexts {
    param(
        [string]$Shard = '',
        [string]$LeaseRoot = ''
    )

    $contexts = [System.Collections.Generic.List[object]]::new()
    $seenLeaseIds = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)

    $roots = [System.Collections.Generic.List[string]]::new()
    if ($LeaseRoot) { [void]$roots.Add($LeaseRoot) }
    $defaultRoot = Get-TestModeFleetLeaseRoot
    if ($defaultRoot -and -not $roots.Contains($defaultRoot)) { [void]$roots.Add($defaultRoot) }

    foreach ($root in @($roots | Select-Object -Unique)) {
        if (-not (Test-Path -LiteralPath $root)) { continue }

        if ($Shard) {
            $perLeasePattern = "vitest-lane-context-shard-$Shard-*.json"
            foreach ($file in @(Get-ChildItem -LiteralPath $root -Filter $perLeasePattern -File -ErrorAction SilentlyContinue)) {
                Add-TestModeVitestLaneLeaseContextFromFile -Path $file.FullName -SeenLeaseIds $seenLeaseIds -Contexts $contexts
            }
            Add-TestModeVitestLaneLeaseContextFromFile -Path (Join-Path $root (Get-TestModeVitestLaneContextFileName -Shard $Shard)) `
                -SeenLeaseIds $seenLeaseIds -Contexts $contexts
        }
        elseif ($env:VITEST_CI_LIGHT_LANE -eq '1') {
            foreach ($file in @(Get-ChildItem -LiteralPath $root -Filter 'vitest-lane-context-light-*.json' -File -ErrorAction SilentlyContinue)) {
                Add-TestModeVitestLaneLeaseContextFromFile -Path $file.FullName -SeenLeaseIds $seenLeaseIds -Contexts $contexts
            }
            Add-TestModeVitestLaneLeaseContextFromFile -Path (Join-Path $root (Get-TestModeVitestLaneContextFileName -LightLane '1')) `
                -SeenLeaseIds $seenLeaseIds -Contexts $contexts
        }
        else {
            foreach ($file in @(Get-ChildItem -LiteralPath $root -Filter 'vitest-lane-context-*.json' -File -ErrorAction SilentlyContinue)) {
                $name = [string]$file.Name
                if ($name -eq 'vitest-lane-context.json') { continue }
                if ($name -like 'vitest-lane-context-shard-*') { continue }
                if ($name -like 'vitest-lane-context-light*') { continue }
                Add-TestModeVitestLaneLeaseContextFromFile -Path $file.FullName -SeenLeaseIds $seenLeaseIds -Contexts $contexts
            }
            Add-TestModeVitestLaneLeaseContextFromFile -Path (Join-Path $root (Get-TestModeVitestLaneContextFileName)) `
                -SeenLeaseIds $seenLeaseIds -Contexts $contexts
        }
    }

    return @($contexts)
}

function Import-TestModeVitestLaneLeaseContext {
    param(
        [string]$Shard = '',
        [switch]$FailIfMissing
    )

    $ctx = Read-TestModeVitestLaneLeaseContext -Shard $Shard
    if (-not $ctx) {
        if ($FailIfMissing) { throw 'TestMode vitest lane lease context is missing' }
        return $null
    }

    if ($ctx.leaseRoot) { $env:OPK_TESTMODE_LEASE_ROOT = [string]$ctx.leaseRoot }
    if ($ctx.leaseId) { $env:AO_TESTMODE_FLEET_LANE_LEASE_ID = [string]$ctx.leaseId }
    return $ctx
}

function ConvertTo-TestModeFleetLeaseHashtable {
    param([object]$Record)
    $hash = @{}
    foreach ($prop in $Record.PSObject.Properties) { $hash[$prop.Name] = $prop.Value }
    return $hash
}

function Update-TestModeFleetLeaseHeartbeat {
    param([string]$LeaseId)
    $record = Read-TestModeFleetLeaseRecord -LeaseId $LeaseId
    if (-not $record) { return $false }
    $hash = ConvertTo-TestModeFleetLeaseHashtable -Record $record
    $hash.heartbeatMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    Write-TestModeFleetLeaseRecordAtomic -Record $hash
    return $true
}

function Update-TestModeFleetLeaseProgress {
    param([string]$LeaseId)
    $record = Read-TestModeFleetLeaseRecord -LeaseId $LeaseId
    if (-not $record) { return $false }
    $hash = ConvertTo-TestModeFleetLeaseHashtable -Record $record
    $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $hash.progressCounter = [int]$hash.progressCounter + 1
    $hash.progressUpdatedMs = $nowMs
    $hash.heartbeatMs = $nowMs
    Write-TestModeFleetLeaseRecordAtomic -Record $hash
    return $true
}

function Add-TestModeFleetLeaseStateRoot {
    param([string]$LeaseId, [string]$StateRoot)
    if (-not $StateRoot) { return $false }
    $record = Read-TestModeFleetLeaseRecord -LeaseId $LeaseId
    if (-not $record) { return $false }
    $normalized = Normalize-TestModeFleetPath -PathValue $StateRoot
    $roots = [System.Collections.Generic.List[string]]::new()
    foreach ($entry in @($record.stateRoots)) { if ($entry) { $roots.Add([string]$entry) | Out-Null } }
    if (-not ($roots -contains $normalized)) { $roots.Add($normalized) | Out-Null }
    $hash = ConvertTo-TestModeFleetLeaseHashtable -Record $record
    $hash.stateRoots = @($roots)
    Write-TestModeFleetLeaseRecordAtomic -Record $hash
    return $true
}

function Test-TestModeFleetLeaseStale {
    param([object]$Record, [string]$CurrentLeaseId = '', [switch]$TreatCorruptAsStale)
    if (-not $Record) { return @{ stale = [bool]$TreatCorruptAsStale; reason = 'corrupt_record' } }
    $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $graceMs = (Get-TestModeFleetLeaseHeartbeatGraceSeconds) * 1000
    $noProgressMs = (Get-TestModeFleetLeaseNoProgressSeconds) * 1000
    $ttlMs = (Get-TestModeFleetLeaseTtlSeconds) * 1000
    $ownerAlive = Test-ProcessOwnerIdentityAlive -OwnerPid ([int]$Record.ownerPid) -OwnerStartTime ([string]$Record.ownerStartTime)
    if (-not $ownerAlive) { return @{ stale = $true; reason = 'owner_dead' } }
    $heartbeatAge = $nowMs - [long]$Record.heartbeatMs
    if ($heartbeatAge -gt $graceMs) { return @{ stale = $true; reason = 'hung_owner' } }
    $progressAge = $nowMs - [long]$Record.progressUpdatedMs
    if ($progressAge -gt $noProgressMs) { return @{ stale = $true; reason = 'no_progress' } }
    if (($nowMs - [long]$Record.createdMs) -gt $ttlMs -and $heartbeatAge -gt $graceMs) {
        return @{ stale = $true; reason = 'lease_ttl' }
    }
    if ($CurrentLeaseId -and [string]$Record.leaseId -eq $CurrentLeaseId) {
        return @{ stale = $false; reason = 'current_lane_live' }
    }
    return @{ stale = $false; reason = 'live_heartbeat' }
}

function Write-TestModeFleetLaneLeaseLink {
    param([string]$StateRoot, [string]$LeaseId)
    if (-not $StateRoot -or -not $LeaseId) { return }
    $linkPath = Join-Path $StateRoot 'testmode-lane-lease.id'
    $dir = Split-Path -Parent $linkPath
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    Set-Content -LiteralPath $linkPath -Value $LeaseId -Encoding ascii -NoNewline
}

function Get-TestModeFleetLaneLeaseIdFromStateRoot {
    param([string]$StateRoot)
    if (-not $StateRoot) { return '' }
    $linkPath = Join-Path $StateRoot 'testmode-lane-lease.id'
    if (-not (Test-Path -LiteralPath $linkPath)) { return '' }
    return (Get-Content -LiteralPath $linkPath -Raw).Trim()
}

function Test-TestModeFleetSupervisorLeaseExpired {
    param([hashtable]$Paths)
    $laneLeaseId = Get-TestModeFleetLaneLeaseIdFromStateRoot -StateRoot $Paths.Root
    if (-not $laneLeaseId) { return @{ expired = $false; reason = 'no_lane_lease' } }
    $stale = Test-TestModeFleetLeaseStale -Record (Read-TestModeFleetLeaseRecord -LeaseId $laneLeaseId)
    return @{ expired = [bool]$stale.stale; reason = [string]$stale.reason }
}

function Register-TestModeFleetSupervisorStart {
    param([string]$StateRoot)

    $leaseId = $env:AO_TESTMODE_FLEET_LANE_LEASE_ID
    if (-not $leaseId) { return }
    Write-TestModeFleetLaneLeaseLink -StateRoot $StateRoot -LeaseId $leaseId
    Add-TestModeFleetLeaseStateRoot -LeaseId $leaseId -StateRoot $StateRoot | Out-Null
}
