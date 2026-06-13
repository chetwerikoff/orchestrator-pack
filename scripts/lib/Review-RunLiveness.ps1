# Utilities for Issue #287 reviewer-liveness sidecars.

function Get-ReviewRecoveryProjectDirFromRepoRoot {
    param([string]$RepoRoot)
    $resolved = (Resolve-Path -LiteralPath $RepoRoot).Path
    $dir = [System.IO.DirectoryInfo]::new($resolved)
    while ($dir -and $dir.Parent) {
        if ($dir.Parent.Name -eq 'workspaces' -and $dir.Parent.Parent -and $dir.Parent.Parent.Name -eq 'code-reviews') {
            return $dir.Parent.Parent.Parent.FullName
        }
        $dir = $dir.Parent
    }
    return $null
}

function Get-ReviewRecoveryStoreDirFromRepoRoot {
    param([string]$RepoRoot)
    $projectDir = Get-ReviewRecoveryProjectDirFromRepoRoot -RepoRoot $RepoRoot
    if (-not $projectDir) { return $null }
    return Join-Path $projectDir 'code-reviews'
}

function Get-ReviewRecoveryReviewerSessionIdFromRepoRoot {
    param([string]$RepoRoot)
    $resolved = (Resolve-Path -LiteralPath $RepoRoot).Path
    $dir = [System.IO.DirectoryInfo]::new($resolved)
    while ($dir -and $dir.Parent) {
        if ($dir.Parent.Name -eq 'workspaces' -and $dir.Parent.Parent -and $dir.Parent.Parent.Name -eq 'code-reviews') {
            return $dir.Name
        }
        $dir = $dir.Parent
    }
    return $null
}

function Get-ReviewRecoveryBootIdHash {
    $bootPath = '/proc/sys/kernel/random/boot_id'
    if (-not (Test-Path -LiteralPath $bootPath -PathType Leaf)) { return $null }
    $bootId = (Get-Content -LiteralPath $bootPath -Raw).Trim()
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($bootId)
        $hash = $sha.ComputeHash($bytes)
        return (($hash | ForEach-Object { $_.ToString('x2') }) -join '').Substring(0, 16)
    }
    finally { $sha.Dispose() }
}

function Get-ReviewRecoveryProcessStartTicks {
    param([int]$ProcessId)
    $statPath = "/proc/$ProcessId/stat"
    if (-not (Test-Path -LiteralPath $statPath -PathType Leaf)) { return $null }
    $stat = Get-Content -LiteralPath $statPath -Raw
    $end = $stat.LastIndexOf(')')
    if ($end -lt 0) { return $null }
    $rest = $stat.Substring($end + 2).Trim() -split '\s+'
    if ($rest.Count -lt 20) { return $null }
    return [string]$rest[19]
}

function Register-ReviewRunLivenessIdentity {
    [CmdletBinding()]
    param(
        [string]$RepoRoot,
        [string]$ProjectId = 'orchestrator-pack'
    )

    if (-not $IsLinux) { return @{ ok = $false; reason = 'unsupported_platform' } }
    $storeDir = Get-ReviewRecoveryStoreDirFromRepoRoot -RepoRoot $RepoRoot
    $reviewerSessionId = Get-ReviewRecoveryReviewerSessionIdFromRepoRoot -RepoRoot $RepoRoot
    if (-not $storeDir -or -not $reviewerSessionId) { return @{ ok = $false; reason = 'review_workspace_not_detected' } }
    $startTicks = Get-ReviewRecoveryProcessStartTicks -ProcessId $PID
    $bootHash = Get-ReviewRecoveryBootIdHash
    if (-not $startTicks -or -not $bootHash) { return @{ ok = $false; reason = 'process_identity_unverifiable' } }

    $packRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    $cli = Join-Path $packRoot 'docs/review-run-recovery.mjs'
    $payload = @{
        projectId          = $ProjectId
        storeDir           = $storeDir
        reviewerSessionId  = $reviewerSessionId
        pid                = $PID
        startTimeTicks     = $startTicks
        bootIdHash         = $bootHash
        windows            = @{}
    }
    $json = $payload | ConvertTo-Json -Depth 12 -Compress
    $output = $json | node $cli capture
    if ($LASTEXITCODE -ne 0) { return @{ ok = $false; reason = 'capture_cli_failed'; detail = $output } }
    return ($output | ConvertFrom-Json)
}
