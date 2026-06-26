#requires -Version 5.1
<#
  Deterministic liveness fixture runner for review-ready-report-state-seed (Issue #473).
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$FixturePath
)

$ErrorActionPreference = 'Stop'
$PackRoot = Split-Path -Parent $PSScriptRoot
$LibDir = Join-Path $PSScriptRoot 'lib'

. (Join-Path $LibDir 'Orchestrator-SideProcessHealth.ps1')
. (Join-Path $LibDir 'Orchestrator-SideProcessSupervisor.ps1')
. (Join-Path $LibDir 'Orchestrator-SideEffectFence.ps1')
. (Join-Path $LibDir 'Review-ReadyReportStateSeedProgress.ps1')
. (Join-Path $LibDir 'Invoke-ReviewReadyReportStateSeed.ps1')

$fixture = Get-Content -LiteralPath $FixturePath -Raw | ConvertFrom-Json
$expected = [string]$fixture.expected
$stallThresholdMs = if ($fixture.stallThresholdMs) { [int]$fixture.stallThresholdMs } else { 20000 }
$childPid = if ($fixture.childPid) { [int]$fixture.childPid } else { 4242 }
$childAlive = if ($null -ne $fixture.childAlive) { [bool]$fixture.childAlive } else { $true }
$nowMs = if ($fixture.nowMs) { [long]$fixture.nowMs } else { 1700000000000 }
$env:AO_SIDE_PROCESS_NOW_MS = "$nowMs"

$result = @{
    expected = $expected
    ok       = $false
    detail   = ''
}

function Write-LivenessResult {
    param($Payload)
    $Payload | ConvertTo-Json -Compress -Depth 12
}

try {
    switch ($fixture.scenario) {
        'health-verdict' {
            $progress = $fixture.progress
            if ($fixture.priorProgress) {
                $env:AO_SIDE_PROCESS_PRIOR_PROGRESS_JSON = ($fixture.priorProgress | ConvertTo-Json -Compress -Depth 8)
            }
            $verdict = Get-OrchestratorSideProcessHealthVerdict `
                -ChildEntry @{ RequiresOrchestratorSession = $false; Id = 'review-ready-report-state-seed' } `
                -Paths @{} -SupervisorPhase 'running' -ChildAlive $childAlive -Progress $progress `
                -ChildPid $childPid -StallThresholdMs $stallThresholdMs `
                -ChildStartedMs $(if ($fixture.childStartedMs) { [long]$fixture.childStartedMs } else { $nowMs - $stallThresholdMs - 1000 })
            $expectStatus = [string]$fixture.expectVerdict.status
            $result.ok = ($verdict.Status -eq $expectStatus)
            if ($fixture.expectVerdict.reason) {
                $result.ok = $result.ok -and ([string]$fixture.expectVerdict.reason -eq [string]$verdict.Reason)
            }
            $result.detail = "status=$($verdict.Status) reason=$($verdict.Reason)"
        }
        'freshness-verdict' {
            $freshness = Get-OrchestratorSideProcessProgressFreshnessVerdict `
                -Progress $fixture.progress -ChildPid $childPid -StallThresholdMs $stallThresholdMs `
                -NowMs $nowMs -TickId $(if ($fixture.tickId) { [string]$fixture.tickId } else { '' }) `
                -PriorProgress $(if ($fixture.priorProgress) { $fixture.priorProgress } else { $null })
            $expectStatus = [string]$fixture.expectFreshness.status
            $result.ok = ($freshness.Status -eq $expectStatus)
            $result.detail = "freshness=$($freshness.Status)"
        }
        'heartbeat-sequence' {
            $tickId = 'seed-tick-long'
            $baseNow = $nowMs
            $livePid = $PID
            $progressDir = Join-Path ([System.IO.Path]::GetTempPath()) ("seed-heartbeat-$([guid]::NewGuid())")
            New-Item -ItemType Directory -Path $progressDir -Force | Out-Null
            $env:AO_SIDE_PROCESS_PROGRESS_DIR = $progressDir
            try {
                foreach ($step in @($fixture.heartbeatSteps)) {
                    $env:AO_SIDE_PROCESS_NOW_MS = [string]($baseNow + [long]$step.atElapsedMs)
                    Write-OrchestratorSideProcessWorkHeartbeat -ChildId 'review-ready-report-state-seed' -Phase 'poll' `
                        -WorkStep ([string]$step.workStep) -WorkCursor ([int]$step.workCursor) `
                        -WorkTotal ([int]$step.workTotal) -TickId $tickId
                }
                $checkNow = $baseNow + [long]$fixture.checkAtElapsedMs
                $env:AO_SIDE_PROCESS_NOW_MS = [string]$checkNow
                $progress = Read-OrchestratorSideProcessProgress -ChildId 'review-ready-report-state-seed'
                $freshness = Get-OrchestratorSideProcessProgressFreshnessVerdict `
                    -Progress $progress -ChildPid $livePid -StallThresholdMs $stallThresholdMs -NowMs $checkNow -TickId $tickId
                $result.ok = [bool]$freshness.Fresh
                $result.detail = "checkAt=${checkNow} freshness=$($freshness.Status)"
            }
            finally {
                Remove-Item -LiteralPath $progressDir -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
        'overlap-guard' {
            $stateDir = Join-Path ([System.IO.Path]::GetTempPath()) ("seed-overlap-$([guid]::NewGuid())")
            New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
            $env:AO_SIDE_PROCESS_STATE_DIR = $stateDir
            try {
                $first = Enter-ReviewReadyReportStateSeedTick -StateRoot $stateDir -TickId 'tick-a'
                $second = Enter-ReviewReadyReportStateSeedTick -StateRoot $stateDir -TickId 'tick-b'
                $result.ok = $first.acquired -and -not $second.acquired
                Exit-ReviewReadyReportStateSeedTick -StateRoot $stateDir
                $third = Enter-ReviewReadyReportStateSeedTick -StateRoot $stateDir -TickId 'tick-c'
                $result.ok = $result.ok -and $third.acquired
                $result.detail = "first=$($first.acquired) second=$($second.acquired) third=$($third.acquired)"
            }
            finally {
                Exit-ReviewReadyReportStateSeedTick -StateRoot $stateDir
                Remove-Item -LiteralPath $stateDir -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
        'side-effect-drain' {
            $stateRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("seed-sidefx-$([guid]::NewGuid())")
            New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null
            $paths = Get-OrchestratorWakeSupervisorPaths -StateRoot $stateRoot
            New-Item -ItemType Directory -Path $paths.ProgressDir -Force | Out-Null
            $livePid = $PID
            $oldMs = $nowMs - $stallThresholdMs - 5000
            $progress = @{
                childId               = 'review-ready-report-state-seed'
                phase                 = 'poll'
                pid                   = $livePid
                lastProgressMs        = $oldMs
                progressSchemaVersion = 2
                workStep              = 'refresh_github'
                workCursor            = 4
                workTotal             = 8
                tickId                = 'tick-sidefx'
            }
            $progressPath = Join-Path $paths.ProgressDir 'review-ready-report-state-seed.progress.json'
            $progress | ConvertTo-Json -Compress | Set-Content -LiteralPath $progressPath -Encoding utf8 -NoNewline
            $lockPath = $paths['review-ready-report-state-seedLock']
            (@{ pid = $livePid; startedAt = (Get-Date).ToString('o') } | ConvertTo-Json -Compress) |
                Set-Content -LiteralPath $lockPath -Encoding utf8 -NoNewline
            $entry = Get-OrchestratorWakeSupervisorChildEntry -ChildId 'review-ready-report-state-seed'
            $health = Get-OrchestratorSideProcessHealthVerdict -ChildEntry $entry -Paths $paths -ChildAlive $true `
                -Progress $progress -ChildPid $livePid -StallThresholdMs $stallThresholdMs -ChildStartedMs $oldMs
            if ($health.Status -eq 'stalled' -and (Test-OrchestratorWakeSupervisorSideEffectInFlight -Paths $paths -ChildId 'review-ready-report-state-seed')) {
                $health.Status = 'working'
            }
            $result.ok = ($health.Status -eq 'working')
            $result.detail = "health=$($health.Status)"
            Remove-Item -LiteralPath $stateRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
        'stale-lock' {
            $stateRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("seed-lock-$([guid]::NewGuid())")
            New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null
            $paths = Get-OrchestratorWakeSupervisorPaths -StateRoot $stateRoot
            $lockPath = Join-Path $stateRoot 'review-ready-report-state-seed-side-effect.lock'
            $staleStarted = (Get-Date).AddHours(-5).ToString('o')
            (@{ pid = 1; startedAt = $staleStarted } | ConvertTo-Json -Compress) |
                Set-Content -LiteralPath $lockPath -Encoding utf8 -NoNewline
            $env:AO_SIDE_EFFECT_LOCK_MAX_AGE_MINUTES = '1'
            $stale = Test-OrchestratorSideEffectLockStale -LockPath $lockPath -MaxAgeSeconds 60
            $result.ok = $stale
            $result.detail = "staleLock=$stale"
            Remove-Item Env:AO_SIDE_EFFECT_LOCK_MAX_AGE_MINUTES -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath $stateRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
        'atomic-progress-read' {
            $dir = Join-Path ([System.IO.Path]::GetTempPath()) ("seed-atomic-$([guid]::NewGuid())")
            New-Item -ItemType Directory -Path $dir -Force | Out-Null
            $env:AO_SIDE_PROCESS_PROGRESS_DIR = $dir
            $path = Join-Path $dir 'review-ready-report-state-seed.progress.json'
            '{"childId":"review-ready-report-state-seed","phase":"poll","pid":42,"lastProgressMs":' | Set-Content -LiteralPath $path -NoNewline
            $resolved = Resolve-OrchestratorSideProcessProgressForFreshness -Progress (Read-OrchestratorSideProcessProgress -ChildId 'review-ready-report-state-seed') -ChildPid 42 -NowMs $nowMs
            $result.ok = ($null -eq $resolved)
            $result.detail = 'corrupt-progress-ignored'
            Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
        }
        'large-payload-tick' {
            $stateDir = Join-Path ([System.IO.Path]::GetTempPath()) ("seed-large-$([guid]::NewGuid())")
            New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
            $progressDir = Join-Path $stateDir 'progress'
            New-Item -ItemType Directory -Path $progressDir -Force | Out-Null
            $env:AO_SIDE_PROCESS_STATE_DIR = $stateDir
            $env:AO_SIDE_PROCESS_PROGRESS_DIR = $progressDir
            $grownStatus = Get-Content -LiteralPath (Join-Path $PackRoot $fixture.grownStatusRel) -Raw | ConvertFrom-Json
            $grownReview = Get-Content -LiteralPath (Join-Path $PackRoot $fixture.grownReviewRel) -Raw | ConvertFrom-Json
            $hash = @{
                openPrs    = @()
                sessions   = @($grownStatus.sessions)
                reviewRuns = @($grownReview.runs)
                nowMs      = $nowMs
                tickCapacity = 5
            }
            $progressBundle = New-ReviewReadyReportStateSeedProgressWriter
            $null = Invoke-ReviewReadyReportStateSeedTick -StateRoot $stateDir -FixturePayload $hash -DryRun `
                -ProgressWriter $progressBundle.Write -TickId $progressBundle.TickId `
                -LogWriter { param([string]$Message) }
            $progressPath = Join-Path $progressDir 'review-ready-report-state-seed.progress.json'
            $raw = Get-Content -LiteralPath $progressPath -Raw
            $result.ok = ($raw -match 'workCursor') -and ($raw -notmatch 'api[_-]?key|Bearer\s|ghp_')
            $result.detail = "progressBytes=$($raw.Length)"
            Remove-Item -LiteralPath $stateDir -Recurse -Force -ErrorAction SilentlyContinue
        }
        default {
            throw "Unknown scenario: $($fixture.scenario)"
        }
    }
}
catch {
    $result.ok = $false
    $result.detail = $_.Exception.Message
}
finally {
    Remove-Item Env:AO_SIDE_PROCESS_NOW_MS -ErrorAction SilentlyContinue
    Remove-Item Env:AO_SIDE_PROCESS_PRIOR_PROGRESS_JSON -ErrorAction SilentlyContinue
}

Write-LivenessResult $result
if (-not $result.ok) { exit 1 }
exit 0
