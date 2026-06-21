#requires -Version 5.1
<#
  Process-boundary helpers for autonomous orchestrator worker-nudge gate (Issue #384).
#>

$Script:WorkerNudgeGateVersion = 'worker-nudge-gate/v1'
$Script:AtomicWorkerNudgeClaimCapability = 'worker-nudge-claim-atomic/v1'
$Script:WorkerNudgeGateFilterCli = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'docs/worker-nudge-gate.mjs'
$Script:AutonomousWorkerNudgeCapabilityInventory = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'docs/autonomous-worker-nudge-capabilities.json'

. (Join-Path $PSScriptRoot 'MechanicalReconcileNode.ps1')
. (Join-Path $PSScriptRoot 'Orchestrator-AutonomousReviewStartGate.ps1')
. (Join-Path $PSScriptRoot 'Autonomous-GateCommon.ps1')

function Get-WorkerNudgeGateVersion {
    return $Script:WorkerNudgeGateVersion
}

function Get-AutonomousWorkerNudgeCapabilityInventory {
    if (-not (Test-Path -LiteralPath $Script:AutonomousWorkerNudgeCapabilityInventory)) {
        throw "missing capability inventory: $Script:AutonomousWorkerNudgeCapabilityInventory"
    }
    $inventory = Get-Content -LiteralPath $Script:AutonomousWorkerNudgeCapabilityInventory -Raw | ConvertFrom-Json
    $sharedPath = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'docs/autonomous-shared-capabilities.json'
    if (-not (Test-Path -LiteralPath $sharedPath)) { return $inventory }
    $shared = Get-Content -LiteralPath $sharedPath -Raw | ConvertFrom-Json
    $byId = @{}
    foreach ($row in @($shared.capabilities)) { $byId[[string]$row.id] = $row }
    foreach ($row in @($inventory.capabilities)) { $byId[[string]$row.id] = $row }
    $inventory.capabilities = @($byId.Values)
    return $inventory
}

function Invoke-WorkerNudgeFilterCli {
    param(
        [string]$Subcommand,
        [hashtable]$Payload
    )
    return Invoke-MechanicalNodeFilterCli -FilterCliPath $Script:WorkerNudgeGateFilterCli `
        -Subcommand $Subcommand -Payload $Payload -Label 'worker-nudge-gate' -JsonDepth 30
}

function Test-AtomicWorkerNudgeClaimCapabilityPresent {
    $helper = Join-Path $PSScriptRoot 'Worker-NudgeClaim.ps1'
    if (-not (Test-Path -LiteralPath $helper)) { return $false }
    $text = Get-Content -LiteralPath $helper -Raw
    return $text -match 'Write-WorkerNudgeClaimAtomic' -and $text -match 'Enter-WorkerNudgeClaimMutex'
}

function Test-AutonomousRawWorkerSendDenied {
    param([string[]]$Argv)

    if (-not (Test-OrchestratorAutonomousSurfaceActive)) {
        return @{ denied = $false; reason = 'manual_surface' }
    }
    if ([string]$env:AO_GATED_WORKER_NUDGE_BYPASS -eq '1') {
        return @{ denied = $false; reason = 'gated_bypass' }
    }
    $joined = ($Argv -join ' ').Trim()
    if ($joined -match '(?i)^send\s+\S+') {
        return @{ denied = $true; reason = 'autonomous_raw_worker_send_denied' }
    }
    return @{ denied = $false; reason = 'not_worker_send' }
}

function Get-LiveAutonomousWorkerNudgeCapabilities {
    param([string]$ConfiguredGateVersion = '')

    $inventory = Get-AutonomousWorkerNudgeCapabilityInventory
    return Get-LiveAutonomousGateCapabilities -Inventory $inventory -ConfiguredGateVersion $ConfiguredGateVersion
}

function Test-WorkerNudgeGatePreflight {
    param(
        [string]$ConfiguredGateVersion = '',
        [switch]$FixtureMode
    )

    $inventory = Get-AutonomousWorkerNudgeCapabilityInventory
    $version = if ($ConfiguredGateVersion) { $ConfiguredGateVersion } else { [string]$inventory.version }
    $atomicPresent = if ($FixtureMode) { $true } else { Test-AtomicWorkerNudgeClaimCapabilityPresent }
    $payload = @{
        loadedGateVersion  = $version
        atomicClaimPresent = [bool]$atomicPresent
        liveCapabilities   = @(Get-LiveAutonomousWorkerNudgeCapabilities -ConfiguredGateVersion $version | ForEach-Object {
                @{ id = $_.id; classification = $_.classification }
            })
    }
    return Invoke-WorkerNudgeFilterCli -Subcommand 'evaluatePreflight' -Payload $payload
}

function Test-WorkerNudgeGateAdoption {
    param(
        [string]$OrchestratorRules = '',
        [switch]$FixtureMode
    )

    $gatedCommandPresent = $FixtureMode -or ($OrchestratorRules -match 'invoke-gated-worker-nudge\.ps1')
    $rawDenied = $FixtureMode -or (Test-AutonomousRawWorkerSendDenied -Argv @('send', 'opk-worker')).denied
    return Invoke-WorkerNudgeFilterCli -Subcommand 'evaluateAdoption' -Payload @{
        gatedCommandPresent = [bool]$gatedCommandPresent
        rawWorkerSendDenied = [bool]$rawDenied
    }
}
