#requires -Version 5.1
<#
.SYNOPSIS
  Pack fallback watchdog for CI-red worker-message delivery (Issue #755).

.DESCRIPTION
  Builds head/run-bound failing-check episodes from GitHub truth, requires fresh
  inactivity plus a live/quiescent worker, extracts and sanitizes the first
  failing-step diagnostic, and sends only after an atomic durable episode claim.
  Delivery is verified later from worker-message-submit-reconcile terminal
  `submitted`; transport success alone never marks an episode delivered.
#>

$Script:CiRedWatchdogCli = Join-Path $PSScriptRoot 'ci-red-watchdog.mjs'
$Script:CiRedWatchdogSource = 'ci-failure-notification-reconcile'
$Script:CiRedWatchdogDefaultInactivityMs = 10 * 60 * 1000
$Script:CiRedWatchdogPerWorkerTickCap = 1

function Write-CiRedWatchdogLog {
    param([string]$Message)
    if (Get-Command Write-CiFailureNotificationLog -ErrorAction SilentlyContinue) {
        Write-CiFailureNotificationLog -Prefix 'ci-red-watchdog' -Message $Message
        return
    }
    $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    Write-Host "[$stamp] ci-red-watchdog: $Message"
}

function Get-CiRedWatchdogStateDir {
    if ($env:AO_CI_RED_WATCHDOG_STATE_DIR) {
        return $env:AO_CI_RED_WATCHDOG_STATE_DIR.Trim()
    }
    if ($env:AO_SIDE_PROCESS_STATE_DIR) {
        return Join-Path $env:AO_SIDE_PROCESS_STATE_DIR.Trim() 'ci-red-watchdog'
    }
    return Join-Path ([System.IO.Path]::GetTempPath()) 'orchestrator-ci-red-watchdog'
}

function Get-CiRedWatchdogConfig {
    $inactivityMs = $Script:CiRedWatchdogDefaultInactivityMs
    $parsed = 0L
    if ($env:AO_CI_RED_WATCHDOG_INACTIVITY_MS -and [long]::TryParse($env:AO_CI_RED_WATCHDOG_INACTIVITY_MS, [ref]$parsed) -and $parsed -ge 30000) {
        $inactivityMs = $parsed
    }
    $attempts = 3
    $parsedAttempts = 0
    if ($env:AO_CI_RED_WATCHDOG_MAX_ATTEMPTS -and [int]::TryParse($env:AO_CI_RED_WATCHDOG_MAX_ATTEMPTS, [ref]$parsedAttempts) -and $parsedAttempts -ge 1) {
        $attempts = [Math]::Min(20, $parsedAttempts)
    }
    return @{
        inactivityThresholdMs          = $inactivityMs
        activityObservationFreshnessMs = 2 * 60 * 1000
        leaseMs                        = 2 * 60 * 1000
        submitProofTimeoutMs           = 5 * 60 * 1000
        maxAttempts                    = $attempts
        episodeLifetimeMs              = 2 * 60 * 60 * 1000
        backoffMs                      = @((5 * 60 * 1000), (10 * 60 * 1000), (20 * 60 * 1000))
        maxDiagnosticChars             = 6000
        lookupResolvedRetentionMs      = 24 * 60 * 60 * 1000
        lookupParkedRetentionMs        = 7 * 24 * 60 * 60 * 1000
        lookupHistoryMaxEntries        = 512
    }
}

function Invoke-CiRedWatchdogCli {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Command,
        [Parameter(Mandatory = $true)]
        [hashtable]$Payload
    )

    $inputPath = Join-Path ([System.IO.Path]::GetTempPath()) ("ci-red-watchdog-input-{0}.json" -f [guid]::NewGuid().ToString('n'))
    $outputPath = Join-Path ([System.IO.Path]::GetTempPath()) ("ci-red-watchdog-output-{0}.json" -f [guid]::NewGuid().ToString('n'))
    try {
        $json = $Payload | ConvertTo-Json -Depth 40 -Compress
        if (Get-Command Write-MechanicalTransportPrivateFile -ErrorAction SilentlyContinue) {
            Write-MechanicalTransportPrivateFile -Path $inputPath -Content $json
        }
        else {
            [System.IO.File]::WriteAllText($inputPath, $json, [System.Text.UTF8Encoding]::new($false))
        }
        $stderr = & node $Script:CiRedWatchdogCli $Command --input-file $inputPath --output-file $outputPath 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "ci-red-watchdog $Command failed: $stderr"
        }
        if (-not (Test-Path -LiteralPath $outputPath -PathType Leaf)) {
            throw "ci-red-watchdog $Command produced no output"
        }
        return Get-Content -LiteralPath $outputPath -Raw | ConvertFrom-Json
    }
    finally {
        Remove-Item -LiteralPath $inputPath, $outputPath -Force -ErrorAction SilentlyContinue
    }
}

. (Join-Path $PSScriptRoot 'Gh-SignalDispatch.ps1')
. (Join-Path $PSScriptRoot 'Ci-Red-Watchdog-GitHub.ps1')
. (Join-Path $PSScriptRoot 'Ci-Red-Watchdog-Worker.ps1')
. (Join-Path $PSScriptRoot 'Ci-Red-Watchdog-Boundary.ps1')
. (Join-Path $PSScriptRoot 'Ci-Red-Watchdog-Tick.ps1')

function Invoke-CiRedWatchdogLookupRetention {
    param(
        [string]$RepoRoot,
        [object]$WorkerState,
        [switch]$DryRunMode
    )

    if ($DryRunMode) {
        return @{ ok = $true; skipped = $true; reason = 'dry_run' }
    }

    try {
        $repoSlug = Get-CiRedWatchdogRepoSlug -RepoRoot $RepoRoot
        $hasOpenPrSnapshot = $false
        if ($null -ne $WorkerState) {
            if ($WorkerState -is [hashtable]) {
                $hasOpenPrSnapshot = $WorkerState.ContainsKey('openPrs') -and $null -ne $WorkerState.openPrs
            }
            else {
                $hasOpenPrSnapshot = $null -ne $WorkerState.PSObject.Properties['openPrs'] -and $null -ne $WorkerState.openPrs
            }
        }
        $snapshotAvailable = [bool]($repoSlug -and $hasOpenPrSnapshot)
        $rows = @()
        if ($snapshotAvailable) {
            $rows = @($WorkerState.openPrs | ForEach-Object {
                @{
                    repo = $repoSlug
                    prNumber = [int](Get-CiRedWatchdogProperty -Object $_ -Names @('number', 'prNumber'))
                    headSha = [string](Get-CiRedWatchdogProperty -Object $_ -Names @('headRefOid', 'headSha'))
                }
            })
        }
        return Invoke-CiRedWatchdogCli -Command 'prune-lookup-failures' -Payload @{
            storeDir = Get-CiRedWatchdogStateDir
            snapshot = @{ available = $snapshotAvailable; repo = [string]$repoSlug; openPrs = @($rows) }
            nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
            actor = $Script:CiRedWatchdogSource
            config = Get-CiRedWatchdogConfig
        }
    }
    catch {
        Write-CiRedWatchdogLog "lookup retention skipped reason=cleanup_failed detail=$($_.Exception.Message)"
        return @{ ok = $false; skipped = $true; reason = 'cleanup_failed'; detail = $_.Exception.Message }
    }
}
