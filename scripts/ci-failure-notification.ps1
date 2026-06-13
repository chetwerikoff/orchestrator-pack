#requires -Version 7.0
<#!
.SYNOPSIS
  Tracked wrapper for the CI FAILURE DISCIPLINE episode predicate (Issue #283).
.DESCRIPTION
  Reads a JSON object from stdin, resolves the repository root from this script path,
  invokes docs/ci-failure-notification.mjs with a bounded timeout, and writes one JSON
  verdict/result to stdout. Predicate terminal actions are SEND or SUPPRESS only.
!#>
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)]
    [ValidateSet('decide','claim','mark-send-failure','append-audit','helper-error','adoption-artifact')]
    [string]$Mode,
    [int]$TimeoutSeconds = 20
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$helper = Join-Path $repoRoot 'docs/ci-failure-notification.mjs'
if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) { throw "Missing helper: $helper" }
$stdin = [Console]::In.ReadToEnd()
try {
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
        [pscustomobject]@{ terminal_action='SUPPRESS'; reason='helper_timeout'; diagnostic=@{ error_kind='helper_error' } } | ConvertTo-Json -Compress -Depth 20
        exit 0
    }
    $out = $p.StandardOutput.ReadToEnd()
    $err = $p.StandardError.ReadToEnd()
    if ($p.ExitCode -ne 0) {
        [pscustomobject]@{ terminal_action='SUPPRESS'; reason='helper_error'; diagnostic=@{ error_kind='helper_error'; detail=$err.Trim() } } | ConvertTo-Json -Compress -Depth 20
        exit 0
    }
    $json = $out.Trim()
    if (-not $json) { throw 'helper returned empty output' }
    $obj = $json | ConvertFrom-Json
    $action = if ($obj.terminal_action) { [string]$obj.terminal_action } elseif ($obj.audit -and $obj.audit.terminal_action) { [string]$obj.audit.terminal_action } else { $null }
    if ($action -and $action -notin @('SEND','SUPPRESS')) { throw "invalid terminal_action from helper: $action" }
    $json
} catch {
    [pscustomobject]@{ terminal_action='SUPPRESS'; reason='wrapper_error'; diagnostic=@{ error_kind='helper_error'; detail=$_.Exception.Message } } | ConvertTo-Json -Compress -Depth 20
    exit 0
}
