#requires -Version 5.1
<#
  CI drift guard for autonomous worker nudge capability inventory (Issue #384 / #821).
#>
[CmdletBinding()]
param(
    [string]$RepoRoot = '',
    [string]$InventoryPath = ''
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/Autonomous-GateCommon.ps1')
$RepoRoot = Resolve-PackGateRepoRoot -RepoRoot $RepoRoot -CallerScriptRoot $PSScriptRoot
$inventoryPath = if ($InventoryPath) { $InventoryPath } else { Join-Path $RepoRoot 'docs/autonomous-worker-nudge-capabilities.json' }
$inventory = Get-Content -LiteralPath $inventoryPath -Raw | ConvertFrom-Json
$violations = [System.Collections.Generic.List[string]]::new()
foreach ($row in @($inventory.capabilities)) {
    $classification = [string]$row.classification
    if ($classification -ne 'gated' -and $classification -ne 'unavailable') {
        $violations.Add("unclassified capability: $($row.id)")
    }
    $path = [string]$row.path
    if ($path -like 'scripts/*' -and -not (Test-Path -LiteralPath (Join-Path $RepoRoot $path))) {
        if ($classification -eq 'gated') {
            $violations.Add("gated capability path missing: $path")
        }
    }
}

$requiredGatedIds = @(
    'worker-nudge-claim-atomic',
    'invoke-gated-worker-nudge',
    'journaled-worker-send-gated',
    'worker-nudge-gate-preflight'
)
foreach ($requiredId in $requiredGatedIds) {
    $row = @($inventory.capabilities | Where-Object { [string]$_.id -eq $requiredId }) | Select-Object -First 1
    if (-not $row -or [string]$row.classification -ne 'gated') {
        $violations.Add("required gated capability missing: $requiredId")
    }
}
if (@($inventory.capabilities | Where-Object { [string]$_.id -eq 'ao-worker-send-raw' }).Count -gt 0) {
    $violations.Add('retired ao-worker-send-raw capability must not remain in the live inventory')
}

. (Join-Path $PSScriptRoot 'lib/Worker-AutonomousNudgeGate.ps1')
$validation = Test-WorkerNudgeGatePreflight -ConfiguredGateVersion ([string]$inventory.version) -FixtureMode
if (-not $validation.ok) {
    $violations.Add("inventory preflight validation failed: $($validation.reason)")
}

if ($violations.Count -gt 0) {
    Write-Host 'autonomous worker-nudge capability guard failed:'
    $violations | ForEach-Object { Write-Host " - $_" }
    exit 1
}

Write-Host '[PASS] autonomous worker-nudge capability inventory'
exit 0
