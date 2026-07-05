#requires -Version 5.1
<#
  Supervised mandatory pre-launch gh transport for review-start (Issue #515).
#>

. (Join-Path $PSScriptRoot 'Review-StartClaim.ps1')
. (Join-Path $PSScriptRoot 'Review-StartClaimLifecycle.ps1')
. (Join-Path $PSScriptRoot 'Gh-PrChecks.ps1')

function Resolve-ReviewStartSupervisedGhCommand {
    $override = [string]$env:AO_REVIEW_START_SUPERVISED_GH_COMMAND
    if ($override) { return $override }
    $packGh = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'scripts/gh'
    if (Test-Path -LiteralPath $packGh) { return $packGh }
    return 'gh'
}

function Get-ReviewStartSupervisedGhDeadlineMs {
    param(
        [hashtable]$ClaimResult
    )
    $config = Get-ReviewStartClaimLifecycleConfig
    $ceilingMs = 300000
    if ($config -and $config.config -and $config.config.attemptCeilingMs) {
        $parsed = 0
        if ([int]::TryParse([string]$config.config.attemptCeilingMs, [ref]$parsed) -and $parsed -gt 0) {
            $ceilingMs = $parsed
        }
    }
    $read = if ($ClaimResult.path) { Read-ReviewStartClaimRecord -Path $ClaimResult.path } else { @{ ok = $false } }
    $mono = Get-ReviewStartMonotonicNowMs
    if ($read.ok -and $read.record.firstAttemptAtMonotonicMs) {
        $first = [int64]$read.record.firstAttemptAtMonotonicMs
        $remaining = [Math]::Max(1, $ceilingMs - ($mono - $first))
        return $remaining
    }
    return $ceilingMs
}

function Read-ReviewStartSupervisedGhProcessStreams {
    param(
        [System.Diagnostics.Process]$Process,
        [int]$WaitTimeoutMs,
        [int]$ChildPid = 0
    )

    $stdoutDrain = $Process.StandardOutput.ReadToEndAsync()
    $stderrDrain = $Process.StandardError.ReadToEndAsync()
    $timedOut = -not $Process.WaitForExit([Math]::Max(1, $WaitTimeoutMs))
    if ($timedOut) {
        try { $Process.Kill($true) } catch { }
        try { $Process.WaitForExit(2000) | Out-Null } catch { }
        if ($ChildPid -gt 0) {
            Stop-ReviewStartSupervisedGhChild -ProcessId $ChildPid | Out-Null
        }
    }
    try { $stdoutDrain.Wait(5000) | Out-Null } catch { }
    try { $stderrDrain.Wait(5000) | Out-Null } catch { }
    return @{
        Stdout   = [string]$stdoutDrain.Result
        Stderr   = [string]$stderrDrain.Result
        TimedOut = $timedOut
    }
}

function Invoke-ReviewStartSupervisedGh {
    param(
        [hashtable]$ClaimResult,
        [string[]]$GhArguments,
        [string]$RepoRoot = '',
        [int]$DeadlineMs = 0
    )

    if (-not $ClaimResult -or -not $ClaimResult.acquired) {
        throw 'Invoke-ReviewStartSupervisedGh requires an acquired claim'
    }

    $resolvedDeadline = if ($DeadlineMs -gt 0) { $DeadlineMs } else { Get-ReviewStartSupervisedGhDeadlineMs -ClaimResult $ClaimResult }
    $command = Resolve-ReviewStartSupervisedGhCommand
    if (-not (Test-ReviewStartGhCommandResolvable -Command $command)) {
        return @{
            ok           = $false
            reason       = 'gh_binary_missing'
            exitCode     = -1
            stderr       = "gh command not found: $command"
            stdout       = ''
            timedOut     = $false
            failureClass = 'infra_transport'
        }
    }
    $argString = ($GhArguments | ForEach-Object { [string]$_ }) -join ' '
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    if ($command -match '\.ps1$') {
        $psi.FileName = 'pwsh'
        $escapedArgs = ($GhArguments | ForEach-Object {
            $part = [string]$_
            if ($part -match '\s') { '"' + $part.Replace('"', '\"') + '"' } else { $part }
        }) -join ' '
        $psi.Arguments = "-NoProfile -File `"$command`" $escapedArgs"
    }
    else {
        $psi.FileName = $command
        $psi.Arguments = $argString
    }
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    if ($RepoRoot -and (Test-Path -LiteralPath $RepoRoot)) {
        $psi.WorkingDirectory = $RepoRoot
    }

    $pauseStart = Start-ReviewStartClaimInfraPause -ClaimResult $ClaimResult -SupervisedGhPid 0
    if (-not $pauseStart.ok) {
        return @{ ok = $false; reason = [string]$pauseStart.reason; failureClass = '' }
    }

    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi
    try {
        [void]$proc.Start()
    }
    catch {
        Complete-ReviewStartClaimInfraPause -ClaimResult $ClaimResult -Stderr "gh command not found: $command" | Out-Null
        return @{
            ok           = $false
            reason       = 'gh_binary_missing'
            exitCode     = -1
            stderr       = "gh command not found: $command"
            stdout       = ''
            timedOut     = $false
            failureClass = 'infra_transport'
        }
    }
    $childPid = $proc.Id
    $delayMs = 0
    if ([string]$env:AO_REVIEW_START_TEST_DELAY_BEFORE_PID_UPDATE_MS) {
        [void][int]::TryParse([string]$env:AO_REVIEW_START_TEST_DELAY_BEFORE_PID_UPDATE_MS, [ref]$delayMs)
    }
    if ($delayMs -gt 0) { Start-Sleep -Milliseconds $delayMs }
    $pidUpdate = Update-ReviewStartClaimRecordFields -ClaimResult $ClaimResult -Fields @{
        activeInfraPause = @{
            startedMonotonicMs = Get-ReviewStartMonotonicNowMs
            supervisedGhPid    = $childPid
            shape              = 'pending'
        }
    }
    if (-not $pidUpdate.ok) {
        try {
            if (-not $proc.HasExited) {
                $proc.Kill($true)
                $proc.WaitForExit(2000) | Out-Null
            }
        }
        catch { }
        Stop-ReviewStartSupervisedGhChild -ProcessId $childPid | Out-Null
        if ([string]$pidUpdate.reason -eq 'lost_ownership') {
            return @{
                ok           = $false
                reason       = 'claim_ownership_lost'
                exitCode     = -1
                stderr       = ''
                stdout       = ''
                timedOut     = $false
                failureClass = ''
            }
        }
        return @{ ok = $false; reason = [string]$pidUpdate.reason; failureClass = '' }
    }

    $streams = Read-ReviewStartSupervisedGhProcessStreams -Process $proc -WaitTimeoutMs $resolvedDeadline -ChildPid $childPid
    $timedOut = [bool]$streams.TimedOut
    $stderr = [string]$streams.Stderr
    $stdout = [string]$streams.Stdout
    $exitCode = if ($proc.HasExited) { $proc.ExitCode } else { -1 }

    $closed = Complete-ReviewStartClaimInfraPause -ClaimResult $ClaimResult -Stderr $stderr -TimedOut:$timedOut
    if (-not (Test-ReviewStartClaimOwnership -ClaimResult $ClaimResult)) {
        Invoke-ReviewStartClaimOwnershipLossCleanup -ClaimResult $ClaimResult
        return @{
            ok           = $false
            reason       = 'claim_ownership_lost'
            exitCode     = $exitCode
            stderr       = $stderr
            stdout       = $stdout
            timedOut     = $timedOut
            failureClass = [string]$closed.failureClass
        }
    }

    return @{
        ok             = ($exitCode -eq 0 -and -not $timedOut)
        exitCode       = $exitCode
        stderr         = $stderr
        stdout         = $stdout
        timedOut       = $timedOut
        failureClass   = [string]$closed.failureClass
        classification = $closed.classification
    }
}
