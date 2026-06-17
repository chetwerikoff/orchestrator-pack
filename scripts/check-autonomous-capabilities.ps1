#requires -Version 5.1
<#
  CI drift guard for autonomous capability inventories (#318 / #324).
#>
[CmdletBinding()]
param(
    [switch]$Boundary,
    [switch]$ReviewStart,
    [string]$RepoRoot = '',
    [string]$InventoryPath = ''
)

$ErrorActionPreference = 'Stop'
if (-not $Boundary -and -not $ReviewStart) {
    $ReviewStart = $true
}
if ($Boundary -and $ReviewStart) {
    throw 'Specify only one of -Boundary or -ReviewStart.'
}

. (Join-Path $PSScriptRoot 'lib/Get-AutonomousCapabilityInventoryContext.ps1')
. (Join-Path $PSScriptRoot 'lib/Test-AutonomousCapabilityInventory.ps1')

$context = Get-AutonomousCapabilityInventoryContext -RepoRoot $RepoRoot -InventoryPath $InventoryPath
$violations = [System.Collections.Generic.List[string]]::new()
foreach ($violation in @(Get-AutonomousCapabilityInventoryViolations -Inventory $context.Inventory -RepoRoot $context.RepoRoot -IncludeBoundaryChecks:$Boundary)) {
    $violations.Add($violation)
}
if ($ReviewStart) {
    foreach ($violation in @(Get-UnclassifiedReviewStartHelperViolations -Inventory $context.Inventory -RepoRoot $context.RepoRoot)) {
        $violations.Add($violation)
    }
}
$validation = Test-AutonomousReviewStartPreflightInventory -Inventory $context.Inventory
if (-not $validation.ok) {
    $violations.Add("inventory preflight validation failed: $($validation.reason)")
}

if ($violations.Count -gt 0) {
    $label = if ($Boundary) {
        'autonomous orchestrator boundary capability guard failed:'
    }
    else {
        'autonomous review-start capability guard failed:'
    }
    Write-Host $label
    $violations | ForEach-Object { Write-Host " - $_" }
    exit 1
}

$passLabel = if ($Boundary) {
    '[PASS] autonomous orchestrator boundary capability inventory'
}
else {
    '[PASS] autonomous review-start capability inventory'
}
Write-Host $passLabel
exit 0
