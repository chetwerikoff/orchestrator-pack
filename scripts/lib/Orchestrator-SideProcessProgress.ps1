#requires -Version 5.1
<#
  Progress heartbeat files for orchestrator side-process supervision (Issues #205, #248).
#>

function Get-OrchestratorSideProcessProgressDir {
    if ($env:AO_SIDE_PROCESS_PROGRESS_DIR) {
        return $env:AO_SIDE_PROCESS_PROGRESS_DIR.Trim()
    }
    return ''
}

function Get-OrchestratorSideProcessProgressRecentLimit {
    return 5
}

function Add-OrchestratorSideProcessRecentOutcome {
    param(
        [string[]]$Existing,
        [string]$Outcome
    )

    $next = @($Existing) + @($Outcome)
    $limit = Get-OrchestratorSideProcessProgressRecentLimit
    if ($next.Count -gt $limit) {
        return @($next | Select-Object -Last $limit)
    }
    return $next
}

function Write-OrchestratorSideProcessProgress {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ChildId,
        [string]$Phase = 'tick',
        [string]$TickOutcome = '',
        [string]$LastError = '',
        [hashtable]$Extra = @{}
    )

    $dir = Get-OrchestratorSideProcessProgressDir
    if (-not $dir) { return }

    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }

    $path = Join-Path $dir "$ChildId.progress.json"
    $existingOutcomes = @()
    if (Test-Path -LiteralPath $path -PathType Leaf) {
        try {
            $existing = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
            $existingPid = 0
            if ($existing.pid) {
                $existingPid = [int]$existing.pid
            }
            if ($existingPid -eq $PID -and $existing.recentOutcomes) {
                $existingOutcomes = @($existing.recentOutcomes)
            }
        }
        catch {
            $existingOutcomes = @()
        }
    }

    $resolvedOutcome = $TickOutcome
    if (-not $resolvedOutcome) {
        switch ($Phase) {
            'tick_success' { $resolvedOutcome = 'success' }
            'tick_error' { $resolvedOutcome = 'error' }
            'tick_skipped' { $resolvedOutcome = 'skipped' }
            default { $resolvedOutcome = '' }
        }
    }

    $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $payload = @{
        childId        = $ChildId
        lastProgressMs = $nowMs
        phase          = $Phase
        pid            = $PID
    }
    if ($resolvedOutcome) {
        $payload.tickOutcome = $resolvedOutcome
        $payload.recentOutcomes = Add-OrchestratorSideProcessRecentOutcome -Existing $existingOutcomes -Outcome $resolvedOutcome
    }
    elseif ($existingOutcomes.Count -gt 0) {
        $payload.recentOutcomes = $existingOutcomes
    }
    if ($LastError) {
        $payload.lastError = $LastError
    }
    foreach ($key in $Extra.Keys) {
        $payload[$key] = $Extra[$key]
    }

    $temp = "${path}.tmp"
    $payload | ConvertTo-Json -Compress | Set-Content -LiteralPath $temp -Encoding utf8 -NoNewline
    Move-Item -LiteralPath $temp -Destination $path -Force
}

function Write-OrchestratorSideProcessTickSuccess {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ChildId,
        [hashtable]$Extra = @{}
    )

    Write-OrchestratorSideProcessProgress -ChildId $ChildId -Phase 'tick_success' -TickOutcome 'success' -Extra $Extra
}

function Write-OrchestratorSideProcessTickError {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ChildId,
        [Parameter(Mandatory = $true)]
        [string]$ErrorMessage,
        [hashtable]$Extra = @{}
    )

    Write-OrchestratorSideProcessProgress -ChildId $ChildId -Phase 'tick_error' -TickOutcome 'error' `
        -LastError $ErrorMessage -Extra $Extra
}

function Read-OrchestratorSideProcessProgress {
    param([string]$ChildId)

    $dir = Get-OrchestratorSideProcessProgressDir
    if (-not $dir) { return $null }

    $path = Join-Path $dir "$ChildId.progress.json"
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        return $null
    }

    try {
        return Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    }
    catch {
        return $null
    }
}
