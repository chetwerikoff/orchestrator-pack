#requires -Version 5.1
<#
  CI drift guard for autonomous review-start capability inventory (Issue #318).
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

$roots = @('scripts', 'docs', 'prompts', 'plugins')
$files = foreach ($root in $roots) {
    $full = Join-Path $RepoRoot $root
    if (Test-Path -LiteralPath $full) {
        Get-ChildItem -LiteralPath $full -Recurse -File -Include *.ps1,*.psm1,*.mjs,*.js,*.ts | Where-Object {
            $_.Name -match 'review' -and $_.Name -match 'run|start'
        }
    }
}
$knownIds = @{}
foreach ($row in $repoInventory) { $knownIds[[string]$row.id] = $true }
foreach ($file in @($files)) {
    $rel = [System.IO.Path]::GetRelativePath($RepoRoot, $file.FullName).Replace('\', '/')
    if ($rel -match 'invoke-orchestrator-claimed-review-run|invoke-manual-review-run|ao-autonomous-guard|git-autonomous-guard|scripts/ao$|scripts/git$|Invoke-OrchestratorClaimedReviewRun') {
        continue
    }
    $text = Get-Content -LiteralPath $file.FullName -Raw
    if ($text -match 'function\s+Invoke-.*ReviewRun' -and $text -notmatch 'Invoke-OrchestratorClaimedReviewRun|Invoke-PlannedReviewRun|Invoke-ReviewWakeTrigger|Invoke-ReviewTriggerReeval') {
        $violations += "unclassified review-start helper: $rel"
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
    Write-Host 'autonomous review-start capability guard failed:'
    $violations | ForEach-Object { Write-Host " - $_" }
    exit 1
}

Write-Host '[PASS] autonomous review-start capability inventory'
exit 0
