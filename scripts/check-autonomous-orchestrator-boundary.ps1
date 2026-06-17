#requires -Version 5.1
<#
  CI drift guard for autonomous orchestrator spawn/git boundary (Issue #324).
#>
[CmdletBinding()]
param(
    [string]$RepoRoot = '',
    [string]$InventoryPath = ''
)

$ErrorActionPreference = 'Stop'
if (-not $RepoRoot) {
    $RepoRoot = Split-Path -Parent $PSScriptRoot
}
$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
if (-not $InventoryPath) {
    $InventoryPath = Join-Path $RepoRoot 'docs/autonomous-review-start-capabilities.json'
}

. (Join-Path $RepoRoot 'scripts/lib/Orchestrator-AutonomousReviewStartGate.ps1')

$inventory = Get-Content -LiteralPath $InventoryPath -Raw | ConvertFrom-Json
$repoInventory = @($inventory.capabilities)
$violations = @()

if ([string]$inventory.boundaryVersion -ne 'autonomous-orchestrator-boundary/v1') {
    $violations += "stale boundary marker: $($inventory.boundaryVersion)"
}

foreach ($row in $repoInventory) {
    $classification = [string]$row.classification
    if ($classification -ne 'gated' -and $classification -ne 'unavailable') {
        $violations += "unclassified capability: $($row.id)"
    }
    $path = [string]$row.path
    if ($path -like 'scripts/*' -and -not (Test-Path -LiteralPath (Join-Path $RepoRoot $path))) {
        if ($classification -eq 'gated') {
            $violations += "gated capability path missing: $path"
        }
    }
}

$requiredUnavailable = @('ao-spawn-raw', 'git-mutating-direct', 'turn-visible-real-binary-env')
foreach ($id in $requiredUnavailable) {
    $row = $repoInventory | Where-Object { [string]$_.id -eq $id } | Select-Object -First 1
    if (-not $row -or [string]$row.classification -ne 'unavailable') {
        $violations += "required unavailable capability missing or misclassified: $id"
    }
}

$requiredGated = @('git-shim', 'git-autonomous-guard', 'autonomous-real-binaries-config')
foreach ($id in $requiredGated) {
    $row = $repoInventory | Where-Object { [string]$_.id -eq $id } | Select-Object -First 1
    if (-not $row -or [string]$row.classification -ne 'gated') {
        $violations += "required gated capability missing or misclassified: $id"
    }
}

$boundaryCli = Join-Path $RepoRoot 'docs/autonomous-orchestrator-boundary.mjs'
if (-not (Test-Path -LiteralPath $boundaryCli)) {
    $violations += 'missing docs/autonomous-orchestrator-boundary.mjs'
}
else {
    $payload = @{
        liveCapabilities = @($repoInventory | ForEach-Object { @{ id = [string]$_.id; classification = [string]$_.classification } })
    } | ConvertTo-Json -Compress -Depth 5
    $boundaryValidation = $payload | node $boundaryCli evaluatePreflight 2>$null | ConvertFrom-Json
    if (-not $boundaryValidation.ok) {
        $violations += "boundary preflight validation failed: $($boundaryValidation.reason)"
    }
}

$validation = Invoke-OrchestratorClaimedReviewRunFilterCli -Subcommand 'evaluatePreflight' -Payload @{
    loadedGateVersion    = [string]$inventory.version
    atomicClaimPresent   = $true
    liveCapabilities     = @($repoInventory | ForEach-Object { @{ id = [string]$_.id; classification = [string]$_.classification } })
}
if (-not $validation.ok) {
    $violations += "inventory preflight validation failed: $($validation.reason)"
}

if ($violations.Count -gt 0) {
    Write-Host 'autonomous orchestrator boundary capability guard failed:'
    $violations | ForEach-Object { Write-Host " - $_" }
    exit 1
}

Write-Host '[PASS] autonomous orchestrator boundary capability inventory'
exit 0
