#requires -Version 5.1
<#
  Process-boundary helpers for autonomous orchestrator review-start gate (Issue #318).
#>

$Script:OrchestratorClaimedReviewRunGateVersion = 'orchestrator-claimed-review-run/v1'
$Script:AtomicReviewStartClaimCapability = 'review-start-claim-atomic/v1'
$Script:OrchestratorClaimedReviewRunFilterCli = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'docs/orchestrator-claimed-review-run.mjs'
$Script:AutonomousCapabilityInventory = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'docs/autonomous-review-start-capabilities.json'

. (Join-Path $PSScriptRoot 'MechanicalReconcileNode.ps1')

function Test-OrchestratorAutonomousSurfaceActive {
    return [string]$env:AO_AUTONOMOUS_ORCHESTRATOR_SURFACE -eq '1'
}

function Test-OrchestratorClaimedReviewRunBypassActive {
    return [string]$env:AO_CLAIMED_REVIEW_RUN_BYPASS -eq '1'
}

function Get-OrchestratorClaimedReviewRunGateVersion {
    return $Script:OrchestratorClaimedReviewRunGateVersion
}

function Get-AutonomousReviewStartCapabilityInventory {
    if (-not (Test-Path -LiteralPath $Script:AutonomousCapabilityInventory)) {
        throw "missing capability inventory: $Script:AutonomousCapabilityInventory"
    }
    return (Get-Content -LiteralPath $Script:AutonomousCapabilityInventory -Raw | ConvertFrom-Json)
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
    $configured = if ($ConfiguredGateVersion) { $ConfiguredGateVersion } else { [string]$inventory.version }
    return @(
        foreach ($row in @($inventory.capabilities)) {
            [pscustomobject]@{
                id             = [string]$row.id
                classification = [string]$row.classification
                gateVersion    = $configured
            }
        }
    )
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

function Test-IsPackAoShimPath {
  param([string]$CandidatePath)

  if (-not $CandidatePath) { return $false }
  if ($CandidatePath -like '*ao-autonomous-guard.ps1') { return $true }
  $packScripts = (Resolve-Path -LiteralPath (Split-Path -Parent $PSScriptRoot)).Path
  try {
    $resolved = (Get-Item -LiteralPath $CandidatePath -ErrorAction Stop).FullName
  }
  catch {
    return $false
  }
  return $resolved -eq (Join-Path $packScripts 'ao')
}

function Resolve-RealAoExecutable {
  $packScripts = (Resolve-Path -LiteralPath (Split-Path -Parent $PSScriptRoot)).Path

  if ($env:AO_REAL_BINARY -and $env:AO_REAL_BINARY -ne 'ao') {
    if (Test-Path -LiteralPath $env:AO_REAL_BINARY -ErrorAction SilentlyContinue) {
      $resolved = (Resolve-Path -LiteralPath $env:AO_REAL_BINARY).Path
      if (-not (Test-IsPackAoShimPath -CandidatePath $resolved)) { return $resolved }
    }
    $configured = Get-Command $env:AO_REAL_BINARY -ErrorAction SilentlyContinue
    if ($configured -and -not (Test-IsPackAoShimPath -CandidatePath $configured.Source)) {
      return $configured.Source
    }
  }

  foreach ($dir in ($env:PATH -split [IO.Path]::PathSeparator)) {
    if (-not $dir -or $dir -eq $packScripts) { continue }
    $candidate = Join-Path $dir 'ao'
    if (-not (Test-Path -LiteralPath $candidate)) { continue }
    if (Test-IsPackAoShimPath -CandidatePath $candidate) { continue }
    return (Get-Item -LiteralPath $candidate).FullName
  }

  foreach ($fallback in @(
      (Join-Path $HOME '.local/bin/ao'),
      (Join-Path $HOME '.npm-global/bin/ao'),
      (Join-Path $HOME '.ao/bin/ao')
    )) {
    if (Test-Path -LiteralPath $fallback) {
      return (Resolve-Path -LiteralPath $fallback).Path
    }
  }

  $cmd = Get-Command ao -ErrorAction SilentlyContinue
  if ($cmd -and -not (Test-IsPackAoShimPath -CandidatePath $cmd.Source)) {
    return $cmd.Source
  }
  return 'ao'
}
