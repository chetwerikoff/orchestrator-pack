#requires -Version 5.1
<#
  CI drift guard for autonomous worker nudge capability inventory (Issue #384).
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

$raw = $inventory.capabilities | Where-Object { $_.id -eq 'ao-worker-send-raw' } | Select-Object -First 1
if (-not $raw -or [string]$raw.classification -ne 'unavailable') {
    $violations.Add('ao-worker-send-raw must be unavailable')
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
