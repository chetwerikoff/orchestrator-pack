#requires -Version 5.1
<#
.SYNOPSIS
  CLI entry for TestMode fleet reaper and lane lease helpers (Issue #710).
#>
# CI sync trigger: noop comment to re-run scope-guard.
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('bootstrap', 'teardown', 'observe', 'cleanup', 'heartbeat', 'progress', 'register-lane')]
    [string]$Action = 'bootstrap',

    [string]$LeaseId = '',
    [string]$RunId = '',
    [string]$LaneId = '',
    [string]$WorkspaceRoot = '',
    [string]$StateRoot = '',
    [int]$OwnerPid = 0,
    [string]$OwnerStartTime = ''
)

$ErrorActionPreference = 'Stop'
$PackRoot = Split-Path -Parent $PSScriptRoot

. (Join-Path $PSScriptRoot 'lib/Orchestrator-ProcessAlive.ps1')
. (Join-Path $PSScriptRoot 'lib/Get-ProcessCommandLine.ps1')
. (Join-Path $PSScriptRoot 'lib/Orchestrator-SideProcessSupervisor.ps1')
. (Join-Path $PSScriptRoot 'lib/TestMode-FleetLease.ps1')
. (Join-Path $PSScriptRoot 'lib/Invoke-TestModeFleetReaper.ps1')

switch ($Action) {
    'register-lane' {
        if ($OwnerPid -le 0) { $OwnerPid = $PID }
        if (-not $OwnerStartTime) {
            $OwnerStartTime = Get-ProcessStartTimeIdentity -ProcessId $OwnerPid
        }
        if (-not $RunId) {
            $RunId = [guid]::NewGuid().ToString('n')
        }
        if (-not $LaneId) {
            $LaneId = 'lane-0'
        }
        if (-not $WorkspaceRoot) {
            $WorkspaceRoot = $PackRoot
        }

        $record = New-TestModeFleetLaneLeaseRecord -RunId $RunId -LaneId $LaneId `
            -OwnerPid $OwnerPid -OwnerStartTime $OwnerStartTime -WorkspaceRoot $WorkspaceRoot
        Write-TestModeFleetLeaseRecordAtomic -Record $record -RegisterIndex
        @{
            leaseId        = $record.leaseId
            runId          = $record.runId
            laneId         = $record.laneId
            ownerPid       = $record.ownerPid
            ownerStartTime = $record.ownerStartTime
            leaseRoot      = (Get-TestModeFleetLeaseRoot)
        } | ConvertTo-Json -Compress
        exit 0
    }

    'heartbeat' {
        if (-not $LeaseId) { throw 'LeaseId required for heartbeat' }
        $ok = Update-TestModeFleetLeaseHeartbeat -LeaseId $LeaseId
        if (-not $ok) { exit 1 }
        exit 0
    }

    'progress' {
        if (-not $LeaseId) { throw 'LeaseId required for progress' }
        $ok = Update-TestModeFleetLeaseProgress -LeaseId $LeaseId
        if (-not $ok) { exit 1 }
        exit 0
    }

    'bootstrap' {
        $current = $LeaseId
        if (-not $current -and $env:AO_TESTMODE_FLEET_LANE_LEASE_ID) {
            $current = $env:AO_TESTMODE_FLEET_LANE_LEASE_ID
        }
        try {
            $stats = Invoke-TestModeFleetReaper -ScopeMode 'bootstrap' -CurrentLeaseId $current -AllowKill
            try {
                Write-Output ($stats | ConvertTo-Json -Depth 6 -Compress)
            }
            catch {
                Write-Output (@{
                    scope    = 'bootstrap'
                    matched  = [int]$stats.matched
                    skipped  = [int]$stats.skipped
                    killed   = [int]$stats.killed
                    failed   = [int]$stats.failed
                    jsonError = $true
                } | ConvertTo-Json -Compress)
            }
            exit 0
        }
        catch {
            Write-Output (@{ scope = 'bootstrap'; error = $_.Exception.Message } | ConvertTo-Json -Compress)
            exit 1
        }
    }

    'teardown' {
        if (-not $LeaseId -and $env:AO_TESTMODE_FLEET_LANE_LEASE_ID) {
            $LeaseId = $env:AO_TESTMODE_FLEET_LANE_LEASE_ID
        }
        if (-not $LeaseId) { throw 'LeaseId required for teardown' }
        $stats = Invoke-TestModeFleetReaper -ScopeMode 'teardown' -CurrentLeaseId $LeaseId -AllowKill
        try {
            Write-Output ($stats | ConvertTo-Json -Depth 6 -Compress)
        }
        catch {
            Write-Output (@{
                scope     = 'teardown'
                matched   = [int]$stats.matched
                skipped   = [int]$stats.skipped
                killed    = [int]$stats.killed
                failed    = [int]$stats.failed
                jsonError = $true
            } | ConvertTo-Json -Compress)
        }
        if ([int]$stats.failed -gt 0) {
            exit 1
        }
        exit 0
    }

    'observe' {
        if (-not $LeaseId -and $env:AO_TESTMODE_FLEET_LANE_LEASE_ID) {
            $LeaseId = $env:AO_TESTMODE_FLEET_LANE_LEASE_ID
        }
        $result = Test-TestModeFleetHeavyLaneHygiene -CurrentLeaseId $LeaseId
        $result | ConvertTo-Json -Depth 6 -Compress
        if (-not $result.ok) { exit 2 }
        exit 0
    }

    'cleanup' {
        if (-not $LeaseId -and $env:AO_TESTMODE_FLEET_LANE_LEASE_ID) {
            $LeaseId = $env:AO_TESTMODE_FLEET_LANE_LEASE_ID
        }
        $observe = Test-TestModeFleetHeavyLaneHygiene -CurrentLeaseId $LeaseId
        if ($observe.ok) {
            $observe | ConvertTo-Json -Depth 6 -Compress
            exit 0
        }
        $stats = Invoke-TestModeFleetReaper -ScopeMode 'teardown' -CurrentLeaseId $LeaseId -AllowKill
        $after = Test-TestModeFleetHeavyLaneHygiene -CurrentLeaseId $LeaseId
        @{
            observeBefore = $observe
            cleanup       = $stats
            observeAfter  = $after
            maskedLeak    = (-not $observe.ok -and $after.ok)
        } | ConvertTo-Json -Depth 8 -Compress
        exit 2
    }
}
