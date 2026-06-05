#requires -Version 5.1
<#
  Progress heartbeat files for orchestrator side-process supervision (Issue #205).
#>

function Get-OrchestratorSideProcessProgressDir {
    if ($env:AO_SIDE_PROCESS_PROGRESS_DIR) {
        return $env:AO_SIDE_PROCESS_PROGRESS_DIR.Trim()
    }
    return ''
}

function Write-OrchestratorSideProcessProgress {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ChildId,
        [string]$Phase = 'tick',
        [hashtable]$Extra = @{}
    )

    $dir = Get-OrchestratorSideProcessProgressDir
    if (-not $dir) { return }

    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }

    $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $payload = @{
        childId         = $ChildId
        lastProgressMs  = $nowMs
        phase           = $Phase
        pid             = $PID
    }
    foreach ($key in $Extra.Keys) {
        $payload[$key] = $Extra[$key]
    }

    $path = Join-Path $dir "$ChildId.progress.json"
    $temp = "${path}.tmp"
    $payload | ConvertTo-Json -Compress | Set-Content -LiteralPath $temp -Encoding utf8 -NoNewline
    Move-Item -LiteralPath $temp -Destination $path -Force
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
