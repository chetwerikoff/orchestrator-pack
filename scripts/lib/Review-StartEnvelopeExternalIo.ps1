#requires -Version 5.1
<#
  CLI bridge for review-start envelope external I/O accounting (Issue #515).
#>

. (Join-Path $PSScriptRoot 'MechanicalReconcileNode.ps1')

$Script:ReviewStartEnvelopeExternalIoCli = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'docs/review-start-envelope-external-io.mjs'

function Invoke-ReviewStartEnvelopeExternalIoCli {
    param(
        [string]$Subcommand,
        [hashtable]$Payload
    )
    return Invoke-MechanicalNodeFilterCli -FilterCliPath $Script:ReviewStartEnvelopeExternalIoCli `
        -Subcommand $Subcommand -Payload $Payload -Label 'review-start-envelope-external-io' -JsonDepth 30
}

function Get-ReviewStartMonotonicNowMs {
    $injected = [string]$env:AO_REVIEW_START_MONOTONIC_NOW_MS
    $parsed = 0L
    if ($injected -and [int64]::TryParse($injected, [ref]$parsed)) {
        return $parsed
    }
    $result = Invoke-ReviewStartEnvelopeExternalIoCli -Subcommand 'monotonic-now' -Payload @{}
    return [int64]$result.nowMonotonicMs
}

function Get-ReviewStartClaimLifecycleMonotonicPayload {
    param([hashtable]$Base = @{})
    $mono = Get-ReviewStartMonotonicNowMs
    $payload = @{}
    foreach ($key in $Base.Keys) { $payload[$key] = $Base[$key] }
    $payload.nowMonotonicMs = $mono
    if (-not $payload.nowMs) {
        $payload.nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }
    return $payload
}

function Classify-ReviewStartInfraTransportFailure {
    param(
        [string]$Stderr = '',
        [switch]$TimedOut
    )
    return Invoke-ReviewStartEnvelopeExternalIoCli -Subcommand 'classify' -Payload @{
        stderr   = $Stderr
        timedOut = [bool]$TimedOut
    }
}
