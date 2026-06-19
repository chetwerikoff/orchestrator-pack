#requires -Version 7.0
<#!
.SYNOPSIS
  Tracked wrapper for CI failure notification predicate and episode lifecycle (Issues #283 / #342).
.DESCRIPTION
  Reads JSON from stdin (or -InputPath for large captures), invokes docs/ci-failure-notification.mjs,
  and writes one JSON result to stdout. Predicate terminal actions are SEND or SUPPRESS only;
  hard failures emit phase=diagnostic without terminal_action.
!#>
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)]
    [ValidateSet(
        'decide','evaluate','record','claim-preflight','preflight-revalidate','reserve-intent',
        'mark-submitted','mark-send-issued','mark-send-delivered','release-submit-intent','resolve-delivery','terminalize','expire-scan','expire','reconcile-plan',
        'health','init-gate','claim','mark-send-failure','append-audit','helper-error','adoption-artifact',
        'sync-red-period-trackers','reaction-record-plan','list-intent-tokens','pre-send-recheck'
    )]
    [string]$Mode,
    [string]$InputPath = '',
    [int]$TimeoutSeconds = 20
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$helper = Join-Path $repoRoot 'docs/ci-failure-notification.mjs'
$DecisionModes = @('decide', 'evaluate')
function New-CiFailureWrapperHardFailure {
    param(
        [string]$Reason,
        [hashtable]$Diagnostic,
        [string]$Mode
    )
    $payload = [ordered]@{
        hard_failure = $true
        reason       = $Reason
        diagnostic   = $Diagnostic
    }
    if ($Mode -notin $DecisionModes) {
        $payload.action = 'hard_failure'
    }
    [pscustomobject]$payload | ConvertTo-Json -Compress -Depth 20
}
try {
    if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) { throw "Missing helper: $helper" }
    if ($InputPath) {
        if (-not (Test-Path -LiteralPath $InputPath -PathType Leaf)) { throw "Missing input path: $InputPath" }
        $stdin = Get-Content -LiteralPath $InputPath -Raw -Encoding utf8
    }
    else {
        $stdin = [Console]::In.ReadToEnd()
    }
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'node'
    $psi.WorkingDirectory = $repoRoot
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.ArgumentList.Add($helper)
    $psi.ArgumentList.Add($Mode)
    $p = [System.Diagnostics.Process]::Start($psi)
    $p.StandardInput.Write($stdin)
    $p.StandardInput.Close()
    if (-not $p.WaitForExit($TimeoutSeconds * 1000)) {
        try { $p.Kill($true) } catch {}
        New-CiFailureWrapperHardFailure -Reason 'helper_timeout' -Mode $Mode -Diagnostic @{
            error_kind = 'helper_error'
            phase      = 'diagnostic'
        }
        exit 0
    }
    $out = $p.StandardOutput.ReadToEnd()
    $err = $p.StandardError.ReadToEnd()
    if ($p.ExitCode -ne 0) {
        New-CiFailureWrapperHardFailure -Reason 'helper_error' -Mode $Mode -Diagnostic @{
            error_kind = 'helper_error'
            detail     = $err.Trim()
            phase      = 'diagnostic'
        }
        exit 0
    }
    $json = $out.Trim()
    if (-not $json) { throw 'helper returned empty output' }
    $obj = $json | ConvertFrom-Json
    if ($obj.hard_failure) {
        $json
        exit 0
    }
    $action = if ($obj.terminal_action) { [string]$obj.terminal_action } elseif ($obj.audit -and $obj.audit.terminal_action) { [string]$obj.audit.terminal_action } else { $null }
    if ($action -and $action -notin @('SEND','SUPPRESS')) { throw "invalid terminal_action from helper: $action" }
    $json
}
catch {
    New-CiFailureWrapperHardFailure -Reason 'wrapper_error' -Mode $Mode -Diagnostic @{
        error_kind = 'helper_error'
        detail     = $_.Exception.Message
        phase      = 'diagnostic'
    }
    exit 0
}
