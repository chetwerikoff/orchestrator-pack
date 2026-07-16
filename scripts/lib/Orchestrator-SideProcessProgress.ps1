#requires -Version 5.1
<#
  Progress heartbeat files for orchestrator side-process supervision (Issues #205, #248, #853).
#>

$Script:OrchestratorSideProcessLivenessCli = Join-Path (Split-Path -Parent $PSScriptRoot) 'kernel/side-process-liveness.ts'

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

function Test-OrchestratorSideProcessProgressProperty {
    param(
        $Record,
        [string]$Name
    )

    return ($null -ne $Record -and $Record.PSObject.Properties.Name -contains $Name)
}

function Invoke-OrchestratorSideProcessLivenessCli {
    param([string[]]$Arguments)

    if (-not (Test-Path -LiteralPath $Script:OrchestratorSideProcessLivenessCli -PathType Leaf)) {
        throw "Missing side-process liveness runtime: $Script:OrchestratorSideProcessLivenessCli"
    }

    $raw = & node --no-warnings --experimental-strip-types $Script:OrchestratorSideProcessLivenessCli @Arguments 2>&1
    return @{
        exitCode = [int]$LASTEXITCODE
        output   = (($raw | ForEach-Object {
                    if ($_ -is [string]) { $_ }
                    elseif ($null -ne $_) { $_.ToString() }
                }) -join "`n").Trim()
    }
}

function Write-OrchestratorSideProcessLivenessCheckpoint {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ChildId,
        [Parameter(Mandatory = $true)]
        [string]$WorkStep,
        [string]$TickId = ''
    )

    $dir = Get-OrchestratorSideProcessProgressDir
    if (-not $dir) { return }

    $arguments = @(
        'checkpoint',
        '--child-id', $ChildId,
        '--owner-pid', [string]$PID,
        '--work-step', $WorkStep,
        '--progress-dir', $dir
    )
    if ($TickId) {
        $arguments += @('--tick-id', $TickId)
    }
    $result = Invoke-OrchestratorSideProcessLivenessCli -Arguments $arguments
    if ($result.exitCode -ne 0) {
        throw "side-process liveness checkpoint failed (exit $($result.exitCode)): $($result.output)"
    }
}

function Get-OrchestratorSideProcessPendingTimeoutMessage {
    param([Parameter(Mandatory = $true)][string]$ChildId)

    $dir = Get-OrchestratorSideProcessProgressDir
    if (-not $dir) { return '' }

    $result = Invoke-OrchestratorSideProcessLivenessCli -Arguments @(
        'consume-timeout',
        '--child-id', $ChildId,
        '--owner-pid', [string]$PID,
        '--progress-dir', $dir
    )
    if ($result.exitCode -eq 0) {
        return ''
    }
    if ($result.exitCode -eq 20) {
        return [string]$result.output
    }
    throw "side-process liveness timeout consume failed (exit $($result.exitCode)): $($result.output)"
}

function Install-OrchestratorSideProcessAoLivenessShim {
    if (-not $env:AO_SIDE_PROCESS_CHILD_ID) { return }
    if (-not (Get-OrchestratorSideProcessProgressDir)) { return }
    if ($env:AO_SIDE_PROCESS_AO_LIVENESS_SHIM_DISABLED -eq '1') { return }

    if (-not $env:AO_SIDE_PROCESS_OWNER_PID) {
        $env:AO_SIDE_PROCESS_OWNER_PID = [string]$PID
    }
    $env:AO_SIDE_PROCESS_LIVENESS_CLI = $Script:OrchestratorSideProcessLivenessCli
    function global:ao {
        $forwardArgs = @($args | ForEach-Object { [string]$_ })
        $callParts = @($forwardArgs | Select-Object -First 2)
        $callName = if ($callParts.Count -gt 0) {
            'ao:' + ($callParts -join ':')
        }
        else {
            'ao:command'
        }
        & node --no-warnings --experimental-strip-types $env:AO_SIDE_PROCESS_LIVENESS_CLI call `
            --call-name $callName `
            --child-id $env:AO_SIDE_PROCESS_CHILD_ID `
            --owner-pid $env:AO_SIDE_PROCESS_OWNER_PID `
            --progress-dir $env:AO_SIDE_PROCESS_PROGRESS_DIR `
            -- ao @forwardArgs
    }
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
    $existing = $null
    $existingOutcomes = @()
    $existingPid = 0
    if (Test-Path -LiteralPath $path -PathType Leaf) {
        try {
            $existing = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
            if ($existing.pid) {
                $existingPid = [int]$existing.pid
            }
            if ($existingPid -eq $PID -and $existing.recentOutcomes) {
                $existingOutcomes = @($existing.recentOutcomes)
            }
        }
        catch {
            $existing = $null
            $existingOutcomes = @()
            $existingPid = 0
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

    $nowMs = if ($env:AO_SIDE_PROCESS_NOW_MS -and [long]::TryParse($env:AO_SIDE_PROCESS_NOW_MS, [ref]$null)) {
        [long]$env:AO_SIDE_PROCESS_NOW_MS
    }
    else {
        [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }
    $payload = @{
        childId        = $ChildId
        lastProgressMs = $nowMs
        phase          = $Phase
        pid            = $PID
    }
    if ($Extra.progressSchemaVersion) {
        $payload.progressSchemaVersion = $Extra.progressSchemaVersion
    }
    if ($resolvedOutcome) {
        $payload.tickOutcome = $resolvedOutcome
        $payload.recentOutcomes = Add-OrchestratorSideProcessRecentOutcome -Existing $existingOutcomes -Outcome $resolvedOutcome
    }
    elseif ($existingPid -eq $PID -and $existingOutcomes.Count -gt 0) {
        $payload.recentOutcomes = $existingOutcomes
    }
    if ($LastError) {
        $payload.lastError = $LastError
    }
    foreach ($key in $Extra.Keys) {
        $payload[$key] = $Extra[$key]
    }

    if ($existingPid -eq $PID -and $Phase -ne 'tick_success') {
        foreach ($key in @(
                'progressSchemaVersion',
                'tickId',
                'workStep',
                'workCursor',
                'workTotal',
                'boundedExternalCall',
                'boundedExternalCallPending',
                'failureClass',
                'reason'
            )) {
            if (-not $payload.ContainsKey($key) -and (Test-OrchestratorSideProcessProgressProperty -Record $existing -Name $key)) {
                $payload[$key] = $existing.$key
            }
        }
        if (-not $payload.ContainsKey('lastError') -and
            (Test-OrchestratorSideProcessProgressProperty -Record $existing -Name 'lastError')) {
            $payload.lastError = $existing.lastError
        }
    }

    $temp = "${path}.$PID.$([Guid]::NewGuid().ToString('N')).tmp"
    try {
        $payload | ConvertTo-Json -Compress -Depth 20 | Set-Content -LiteralPath $temp -Encoding utf8 -NoNewline
        Move-Item -LiteralPath $temp -Destination $path -Force
    }
    finally {
        Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
    }
}

function Write-OrchestratorSideProcessTickSuccess {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ChildId,
        [hashtable]$Extra = @{}
    )

    $timeoutMessage = Get-OrchestratorSideProcessPendingTimeoutMessage -ChildId $ChildId
    if ($timeoutMessage) {
        Write-OrchestratorSideProcessProgress -ChildId $ChildId -Phase 'tick_error' -TickOutcome 'error' `
            -LastError $timeoutMessage -Extra $Extra
        return
    }

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

    $timeoutMessage = Get-OrchestratorSideProcessPendingTimeoutMessage -ChildId $ChildId
    if ($timeoutMessage) {
        $ErrorMessage = $timeoutMessage
    }
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

Install-OrchestratorSideProcessAoLivenessShim
