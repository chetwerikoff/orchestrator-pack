#requires -Version 5.1
<#
  Seed tick progress emission and overlap guard (Issue #473).
#>

. (Join-Path $PSScriptRoot 'Orchestrator-ProcessAlive.ps1')
. (Join-Path $PSScriptRoot 'Orchestrator-SideProcessProgress.ps1')
. (Join-Path $PSScriptRoot 'Orchestrator-SideProcessProgressEvidence.ps1')

$Script:ReviewReadyReportStateSeedChildId = 'review-ready-report-state-seed'
$Script:ReviewReadyReportStateSeedWorkPlan = @(
    'poll_start',
    'load_status',
    'load_review_runs',
    'refresh_github',
    'plan_seed',
    'apply_seed',
    'plan_reeval',
    'tick_finish'
)

function Get-ReviewReadyReportStateSeedWorkTotal {
    return @($Script:ReviewReadyReportStateSeedWorkPlan).Count
}

function New-ReviewReadyReportStateSeedTickId {
    return "seed-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())-$PID"
}

function New-ReviewReadyReportStateSeedProgressWriter {
    param(
        [string]$TickId = '',
        [string]$ChildId = $Script:ReviewReadyReportStateSeedChildId
    )

    $resolvedChildId = if ($ChildId) { $ChildId } else { $Script:ReviewReadyReportStateSeedChildId }
    if (-not $TickId) {
        $TickId = New-ReviewReadyReportStateSeedTickId
    }
    $resolvedTickId = $TickId

    $total = Get-ReviewReadyReportStateSeedWorkTotal
    $workPlan = @($Script:ReviewReadyReportStateSeedWorkPlan)
    $writeBlock = {
        param([string]$WorkStep)

        $index = [array]::IndexOf($workPlan, $WorkStep)
        if ($index -lt 0) {
            $index = 0
        }
        $cursor = $index + 1

        Write-OrchestratorSideProcessWorkHeartbeat -ChildId $resolvedChildId -Phase 'poll' `
            -WorkStep $WorkStep -WorkCursor $cursor -WorkTotal $total -TickId $resolvedTickId

        if ($env:AO_REPORT_STATE_SEED_FIXTURE_STEP_DELAY_MS -and [int]::TryParse($env:AO_REPORT_STATE_SEED_FIXTURE_STEP_DELAY_MS, [ref]$null)) {
            Start-Sleep -Milliseconds ([Math]::Max(0, [int]$env:AO_REPORT_STATE_SEED_FIXTURE_STEP_DELAY_MS))
        }
    }.GetNewClosure()

    return @{
        TickId = $resolvedTickId
        Write  = $writeBlock
    }
}

function Test-ReviewReadyReportStateSeedTickInFlight {
    param([string]$StateRoot = '')

    $root = $StateRoot
    if (-not $root -and $env:AO_SIDE_PROCESS_STATE_DIR) {
        $root = $env:AO_SIDE_PROCESS_STATE_DIR.Trim()
    }
    if (-not $root) {
        return $false
    }

    $lockPath = Join-Path $root 'review-ready-report-state-seed-tick.lock'
    if (-not (Test-Path -LiteralPath $lockPath -PathType Leaf)) {
        return $false
    }

    try {
        $raw = Get-Content -LiteralPath $lockPath -Raw -ErrorAction Stop
        $record = $raw | ConvertFrom-Json
        $ownerPid = [int]$record.pid
        if ($ownerPid -gt 0 -and -not (Test-ProcessAlive -ProcessId $ownerPid)) {
            return $false
        }
        return $true
    }
    catch {
        return $false
    }
}

function Enter-ReviewReadyReportStateSeedTick {
    param(
        [string]$StateRoot = '',
        [string]$TickId = ''
    )

    if (-not $TickId) {
        $TickId = New-ReviewReadyReportStateSeedTickId
    }

    $root = $StateRoot
    if (-not $root -and $env:AO_SIDE_PROCESS_STATE_DIR) {
        $root = $env:AO_SIDE_PROCESS_STATE_DIR.Trim()
    }
    if (-not $root) {
        return @{ acquired = $true; tickId = $TickId }
    }

    $lockPath = Join-Path $root 'review-ready-report-state-seed-tick.lock'
    $payload = @{
        pid    = $PID
        tickId = $TickId
        atMs   = Get-OrchestratorSideProcessNowMs
    } | ConvertTo-Json -Compress

    try {
        $fs = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        try {
            $bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
            $fs.Write($bytes, 0, $bytes.Length)
        }
        finally {
            $fs.Dispose()
        }
        return @{ acquired = $true; tickId = $TickId }
    }
    catch [System.IO.IOException] {
        return @{ acquired = $false; tickId = $TickId }
    }
}

function Exit-ReviewReadyReportStateSeedTick {
    param([string]$StateRoot = '')

    $root = $StateRoot
    if (-not $root -and $env:AO_SIDE_PROCESS_STATE_DIR) {
        $root = $env:AO_SIDE_PROCESS_STATE_DIR.Trim()
    }
    if (-not $root) {
        return
    }

    $lockPath = Join-Path $root 'review-ready-report-state-seed-tick.lock'
    if (Test-Path -LiteralPath $lockPath -PathType Leaf) {
        Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
    }
}
