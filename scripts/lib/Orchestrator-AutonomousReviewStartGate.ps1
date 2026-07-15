#requires -Version 5.1
<#
  Process-boundary helpers for autonomous orchestrator review-start gate (Issue #318).
#>

$Script:OrchestratorClaimedReviewRunGateVersion = 'orchestrator-claimed-review-run/v1'
$Script:AtomicReviewStartClaimCapability = 'review-start-claim-atomic/v1'
$Script:OrchestratorClaimedReviewRunFilterCli = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'docs/orchestrator-claimed-review-run.mjs'
$Script:AutonomousCapabilityInventory = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'docs/autonomous-review-start-capabilities.json'

. (Join-Path $PSScriptRoot 'MechanicalReconcileNode.ps1')
. (Join-Path $PSScriptRoot 'Orchestrator-AutonomousBoundary.ps1')
. (Join-Path $PSScriptRoot 'Autonomous-GateCommon.ps1')

function Test-OrchestratorAutonomousSurfaceActive {
    return -not [string]::IsNullOrEmpty([string]$env:AO_SESSION_ID)
}

function Test-OrchestratorClaimedReviewRunBypassActive {
    return [string]$env:AO_CLAIMED_REVIEW_RUN_BYPASS -eq '1'
}

function Get-OrchestratorClaimedReviewRunGateVersion {
    return $Script:OrchestratorClaimedReviewRunGateVersion
}

function Get-AutonomousReviewStartCapabilityInventory {
    return Get-MergedAutonomousCapabilityInventory `
        -InventoryPath $Script:AutonomousCapabilityInventory `
        -PackRoot (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
}

function Invoke-OrchestratorClaimedReviewRunFilterCli {
    param(
        [string]$Subcommand,
        [hashtable]$Payload
    )
    return Invoke-MechanicalNodeFilterCli -FilterCliPath $Script:OrchestratorClaimedReviewRunFilterCli `
        -Subcommand $Subcommand -Payload $Payload -Label 'orchestrator-claimed-review-run' -JsonDepth 30
}

function Test-AtomicReviewStartClaimCapabilityPresent {
    $helper = Join-Path $PSScriptRoot 'Review-StartClaim.ps1'
    if (-not (Test-Path -LiteralPath $helper)) { return $false }
    $text = Get-Content -LiteralPath $helper -Raw
    return $text -match 'Write-ReviewStartClaimAtomic' -and $text -match 'Enter-ReviewStartClaimMutex'
}

function Test-AutonomousRawReviewRunDenied {
    param([string[]]$Argv)

    if (-not (Test-OrchestratorAutonomousSurfaceActive)) {
        return @{ denied = $false; reason = 'manual_surface' }
    }
    if (Test-OrchestratorClaimedReviewRunBypassActive) {
        return @{ denied = $false; reason = 'claimed_bypass' }
    }
    $joined = ($Argv -join ' ').Trim()
    if ($joined -match '(?i)\breview\b' -and $joined -match '(?i)\brun\b') {
        return @{ denied = $true; reason = 'autonomous_raw_review_run_denied' }
    }
    return @{ denied = $false; reason = 'not_review_run' }
}

function Get-LiveAutonomousReviewStartCapabilities {
    param([string]$ConfiguredGateVersion = '')

    $inventory = Get-AutonomousReviewStartCapabilityInventory
    return Get-LiveAutonomousGateCapabilities -Inventory $inventory -ConfiguredGateVersion $ConfiguredGateVersion
}

function Test-OrchestratorReviewStartGatePreflight {
    param(
        [string]$ConfiguredGateVersion = '',
        [switch]$FixtureMode
    )

    $inventory = Get-AutonomousReviewStartCapabilityInventory
    $version = if ($ConfiguredGateVersion) { $ConfiguredGateVersion } else { [string]$inventory.version }
    $atomicPresent = if ($FixtureMode) { $true } else { Test-AtomicReviewStartClaimCapabilityPresent }
    $payload = @{
        loadedGateVersion  = $version
        atomicClaimPresent = [bool]$atomicPresent
        liveCapabilities = @(Get-LiveAutonomousReviewStartCapabilities -ConfiguredGateVersion $version | ForEach-Object {
                @{ id = $_.id; classification = $_.classification }
            })
    }
    return Invoke-OrchestratorClaimedReviewRunFilterCli -Subcommand 'evaluatePreflight' -Payload $payload
}
