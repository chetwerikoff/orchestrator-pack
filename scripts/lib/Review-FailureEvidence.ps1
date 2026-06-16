# Utilities for Issue #312 reviewer failure evidence artifacts.

. (Join-Path $PSScriptRoot 'QuotedProcessArguments.ps1')

function Invoke-ReviewerFailureEvidenceCli {
    param(
        [Parameter(Mandatory = $true)][string]$Subcommand,
        [hashtable]$Payload = @{}
    )
    $packRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    $cli = Join-Path $packRoot 'docs/reviewer-failure-evidence.mjs'
    $json = $Payload | ConvertTo-Json -Depth 20 -Compress
    $output = $json | node $cli $Subcommand
    if ($LASTEXITCODE -ne 0) {
        return @{ ok = $false; reason = 'failure_evidence_cli_failed'; detail = $output }
    }
    return ($output | ConvertFrom-Json)
}

function Initialize-ReviewFailureEvidence {
    param(
        [string]$RepoRoot,
        [string]$WrapperKind
    )
    $storeDir = Get-ReviewRecoveryStoreDirFromRepoRoot -RepoRoot $RepoRoot
    $reviewerSessionId = Get-ReviewRecoveryReviewerSessionIdFromRepoRoot -RepoRoot $RepoRoot
    if (-not $storeDir -or -not $reviewerSessionId) {
        return @{ ok = $false; reason = 'review_workspace_not_detected' }
    }
    $result = Invoke-ReviewerFailureEvidenceCli -Subcommand 'ensure' -Payload @{
        storeDir           = $storeDir
        reviewerSessionId  = $reviewerSessionId
        wrapperKind        = $WrapperKind
    }
    if (-not $result.ok) { return $result }
    return @{
        ok                 = $true
        path               = $result.path
        storeDir           = $storeDir
        reviewerSessionId  = $reviewerSessionId
    }
}

function Update-ReviewFailureEvidencePhase {
    param(
        [hashtable]$Handle,
        [string]$Phase
    )
    if (-not $Handle -or -not $Handle.path) { return @{ ok = $false; reason = 'handle_missing' } }
    return Invoke-ReviewerFailureEvidenceCli -Subcommand 'record-phase' -Payload @{
        path  = $Handle.path
        phase = $Phase
    }
}

function Update-ReviewFailureEvidenceOutput {
    param(
        [hashtable]$Handle,
        [string]$Stdout,
        [string]$Stderr
    )
    if (-not $Handle -or -not $Handle.path) { return @{ ok = $false; reason = 'handle_missing' } }
    return Invoke-ReviewerFailureEvidenceCli -Subcommand 'record-output' -Payload @{
        path   = $Handle.path
        stdout = $Stdout
        stderr = $Stderr
    }
}

function Complete-ReviewFailureEvidence {
    param(
        [hashtable]$Handle,
        [int]$ExitCode,
        [string]$Signal,
        [string]$SignalDetail,
        [string]$Stdout,
        [string]$Stderr,
        [string]$CompletionStatus
    )
    if (-not $Handle -or -not $Handle.path) { return @{ ok = $false; reason = 'handle_missing' } }
    $payload = @{
        path = $Handle.path
    }
    if ($null -ne $ExitCode) { $payload.exitCode = $ExitCode }
    if ($Signal) { $payload.signal = $Signal }
    if ($SignalDetail) { $payload.signalDetail = $SignalDetail }
    if ($Stdout) { $payload.stdout = $Stdout }
    if ($Stderr) { $payload.stderr = $Stderr }
    if ($CompletionStatus) { $payload.completionStatus = $CompletionStatus }
    return Invoke-ReviewerFailureEvidenceCli -Subcommand 'record-terminal' -Payload $payload
}

function Resolve-ReviewWrapperTerminationSignal {
    param([int]$ExitCode)
    if ($IsLinux) {
        if ($ExitCode -gt 128 -and $ExitCode -lt 256) {
            $signalNumber = $ExitCode - 128
            return @{ signal = [string]$signalNumber; signalDetail = "terminated_by_signal_$signalNumber" }
        }
        if ($ExitCode -lt 0) {
            return @{ signal = [string][Math]::Abs($ExitCode); signalDetail = "negative_exit_$ExitCode" }
        }
        return @{ signal = 'signal_unavailable'; signalDetail = 'clean_or_non_signal_exit' }
    }
    return @{ signal = 'signal_unavailable'; signalDetail = 'windows_exit_code_only' }
}

function Test-PackReviewProcessStartInfoSupportsArgumentList {
    return [bool]([System.Diagnostics.ProcessStartInfo].GetProperty(
        'ArgumentList',
        [System.Reflection.BindingFlags]'Public,Instance'
    ))
}

function Get-PackReviewWrapperProcessStartInfo {
    param(
        [string]$PwshPath,
        [string]$WrapperPath,
        [string[]]$WrapperArgs
    )

    $psi = [System.Diagnostics.ProcessStartInfo]::new($PwshPath)
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $argv = @('-NoProfile', '-File', $WrapperPath) + @($WrapperArgs | ForEach-Object { [string]$_ })
    if (Test-PackReviewProcessStartInfoSupportsArgumentList) {
        foreach ($arg in $argv) {
            [void]$psi.ArgumentList.Add($arg)
        }
    }
    else {
        $psi.Arguments = Join-QuotedProcessArguments -Arguments $argv
    }
    return $psi
}

function Read-PackReviewProcessStreams {
    param(
        [System.Diagnostics.Process]$Process
    )

    $stdoutDrain = $Process.StandardOutput.ReadToEndAsync()
    $stderrDrain = $Process.StandardError.ReadToEndAsync()
    $Process.WaitForExit() | Out-Null
    try { $stdoutDrain.Wait() | Out-Null } catch { }
    try { $stderrDrain.Wait() | Out-Null } catch { }
    return @{
        Stdout = [string]$stdoutDrain.Result
        Stderr = [string]$stderrDrain.Result
    }
}

function Invoke-PackReviewWrapperWithFailureEvidence {
    param(
        [string]$WrapperPath,
        [string[]]$WrapperArgs,
        [hashtable]$EvidenceHandle
    )

    Update-ReviewFailureEvidencePhase -Handle $EvidenceHandle -Phase 'wrapper_started' | Out-Null

    $process = $null
    try {
        $pwsh = (Get-Command pwsh -ErrorAction Stop).Source
        $psi = Get-PackReviewWrapperProcessStartInfo -PwshPath $pwsh -WrapperPath $WrapperPath -WrapperArgs $WrapperArgs
        $process = [System.Diagnostics.Process]::Start($psi)
        if (-not $process) {
            throw 'Failed to start pack review wrapper process'
        }
        $streams = Read-PackReviewProcessStreams -Process $process
        $stdout = $streams.Stdout
        $stderr = $streams.Stderr
        $exitCode = $process.ExitCode

        Update-ReviewFailureEvidenceOutput -Handle $EvidenceHandle -Stdout $stdout -Stderr $stderr | Out-Null
        Update-ReviewFailureEvidencePhase -Handle $EvidenceHandle -Phase 'reviewer_output_observed' | Out-Null

        $termination = Resolve-ReviewWrapperTerminationSignal -ExitCode $exitCode
        $completionStatus = if ($exitCode -eq 0) { 'normal' } else { 'abnormal' }
        Complete-ReviewFailureEvidence -Handle $EvidenceHandle -ExitCode $exitCode -Signal $termination.signal -SignalDetail $termination.signalDetail -Stdout $stdout -Stderr $stderr -CompletionStatus $completionStatus | Out-Null
        Update-ReviewFailureEvidencePhase -Handle $EvidenceHandle -Phase 'wrapper_exited' | Out-Null

        if ($stdout) { [Console]::Out.Write($stdout) }
        if ($stderr) { [Console]::Error.Write($stderr) }

        return [int]$exitCode
    }
    finally {
        if ($process -and -not $process.HasExited) {
            try { $process.Kill() } catch { }
        }
        if ($process) { $process.Dispose() }
    }
}
