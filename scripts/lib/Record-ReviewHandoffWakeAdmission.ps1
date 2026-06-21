#requires -Version 5.1
<#
.SYNOPSIS
  Durable ready_for_review hand-off admission records (Issue #381).
#>

. (Join-Path $PSScriptRoot 'MechanicalReconcileNode.ps1')

$Script:ReviewHandoffWakeAdmissionCli = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'docs/review-handoff-wake-admission.mjs'

function Get-ReviewHandoffWakeAdmissionPath {
    param([string]$StateRoot = '')

    if ($StateRoot) {
        return Join-Path $StateRoot 'review-handoff-wake-admission.json'
    }
    if ($env:AO_REVIEW_HANDOFF_WAKE_ADMISSION_STATE) {
        return $env:AO_REVIEW_HANDOFF_WAKE_ADMISSION_STATE
    }
    return Join-Path ([System.IO.Path]::GetTempPath()) 'orchestrator-review-handoff-wake-admission.json'
}

function Invoke-ReviewHandoffWakeAdmissionCli {
    param(
        [string]$Subcommand,
        [hashtable]$Payload
    )

    return Invoke-MechanicalNodeFilterCli -FilterCliPath $Script:ReviewHandoffWakeAdmissionCli `
        -Subcommand $Subcommand -Payload $Payload -Label 'review-handoff-wake-admission' -JsonDepth 30
}

function Get-ReviewHandoffWakeAdmissionState {
    param([string]$Path)

    $default = @{ records = @{}; lastUpdatedMs = $null }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $default
    }
    try {
        $parsed = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
        if (-not $parsed) { return $default }
        return @{
            records       = if ($parsed.records) { @{} + $parsed.records } else { @{} }
            lastUpdatedMs = $parsed.lastUpdatedMs
        }
    }
    catch {
        return $default
    }
}

function Set-ReviewHandoffWakeAdmissionState {
    param(
        [string]$Path,
        [hashtable]$State
    )

    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    $tmp = Join-Path $dir ".$(Split-Path -Leaf $Path).$PID.tmp"
    $json = ($State | ConvertTo-Json -Depth 30 -Compress)
    Set-Content -LiteralPath $tmp -Value $json -Encoding UTF8
    Move-Item -LiteralPath $tmp -Destination $Path -Force
}

function Record-ReviewHandoffWakeAdmission {
    param(
        [string]$StateRoot = '',
        [object]$FilterResult,
        [switch]$DryRun
    )

    if (-not $StateRoot) {
        return @{ recorded = $false; reason = 'missing_state_root' }
    }
    if (-not $FilterResult.handoffAdmission) {
        return @{ recorded = $false; reason = 'not_handoff_admission' }
    }

    $path = Get-ReviewHandoffWakeAdmissionPath -StateRoot $StateRoot
    $state = Get-ReviewHandoffWakeAdmissionState -Path $path
    $seed = Invoke-ReviewHandoffWakeAdmissionCli -Subcommand 'seed' -Payload @{
        existing = $state.records
        admission = @{
            subject = @{
                sessionId    = [string]$FilterResult.sessionId
                projectId    = [string]$FilterResult.projectId
                prNumber     = [int]$FilterResult.prNumber
                prUrl        = [string]$FilterResult.prUrl
                priority     = [string]$FilterResult.handoffAdmission.audit.priority
                receivedAtMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
            }
            admittedBaseRef = [string]$FilterResult.handoffAdmission.admittedBaseRef
            admittedHeadSha = [string]$FilterResult.handoffAdmission.admittedHeadSha
            outcome         = 'promoted'
        }
        nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }

    if (-not $seed.seeded) {
        return @{ recorded = $false; reason = [string]$seed.reason }
    }

    if (-not $DryRun) {
        Set-ReviewHandoffWakeAdmissionState -Path $path -State @{
            records       = $seed.records
            lastUpdatedMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        }
    }

    return @{
        recorded = $true
        key      = [string]$seed.key
        path     = $path
        record   = $seed.record
    }
}

function Get-ReviewHandoffWakeAdmissionReplay {
    param(
        [string]$StateRoot = '',
        [long]$ListenerReadyMs
    )

    if (-not $StateRoot) {
        return @{ replay = @(); listenerReadyMs = $ListenerReadyMs }
    }
    $path = Get-ReviewHandoffWakeAdmissionPath -StateRoot $StateRoot
    $state = Get-ReviewHandoffWakeAdmissionState -Path $path
    return Invoke-ReviewHandoffWakeAdmissionCli -Subcommand 'replay' -Payload @{
        records         = $state.records
        listenerReadyMs = $ListenerReadyMs
    }
}
